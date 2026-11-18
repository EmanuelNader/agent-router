import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { OperationJournal } from '../../cli/src/journal.js';
import { evaluateOciPaygGuardrails, type OciGuardrailReport } from '../../cloud-readiness/src/oci-guardrails.js';
import type { DeploymentRequest, OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { encodeWorkerCloudInitBase64 } from './cloud-init.js';

export const workspaceKeySchema = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);

export type OciInstanceLifecycle =
  | 'PROVISIONING'
  | 'RUNNING'
  | 'STARTING'
  | 'STOPPING'
  | 'STOPPED'
  | 'TERMINATING'
  | 'TERMINATED';

export interface OciInstanceRecord {
  instanceId: string;
  lifecycleState: OciInstanceLifecycle;
  shape: string;
  availabilityDomain: string;
  freeformTags: Record<string, string>;
}

export interface SubnetSecurityInspection {
  subnetAvailable: boolean;
  ingressRuleCount: number;
}

export interface LaunchOciWorkerParams {
  availabilityDomain: string;
  displayName: string;
  shape: 'VM.Standard.A1.Flex';
  ocpus: number;
  memoryInGBs: number;
  bootVolumeSizeInGBs: number;
  bootVolumeVpusPerGB: 10;
  assignPublicIp: false;
  subnetRef: string;
  imageRef: string;
  userDataBase64: string;
  opcRetryToken: string;
  freeformTags: Record<string, string>;
}

export interface TerminateOciWorkerParams {
  instanceId: string;
  preserveBootVolume: false;
  preserveDataVolumesCreatedAtLaunch: false;
}

export interface WorkspaceRemnantCounts {
  instances: number;
  bootVolumes: number;
  blockVolumes: number;
  reservedPublicIps: number;
}

export interface OciComputeGateway {
  selectRegion(region: string): void;
  inspectSubnetSecurity(subnetRef: string): Promise<SubnetSecurityInspection>;
  listInstances(filter: { workspaceKey?: string; operationId?: string }): Promise<OciInstanceRecord[]>;
  launchInstance(params: LaunchOciWorkerParams): Promise<OciInstanceRecord>;
  stopInstance(instanceId: string): Promise<OciInstanceRecord>;
  terminateInstance(params: TerminateOciWorkerParams): Promise<void>;
  listWorkspaceRemnants(workspaceKey: string): Promise<WorkspaceRemnantCounts>;
}

export function fingerprintInstanceId(instanceId: string): string {
  return `inst_${createHash('sha256').update(instanceId).digest('hex').slice(0, 16)}`;
}

export function isOutOfCapacityError(err: unknown): boolean {
  const code = String((err as { serviceCode?: unknown; code?: unknown })?.serviceCode ?? (err as { code?: unknown })?.code ?? '');
  const message = err instanceof Error ? err.message : String(err);
  return /OutOfHostCapacity|Out of host capacity/i.test(`${code} ${message}`);
}

export interface ProvisionOciWorkerInput {
  workspaceKey: string;
  inspection: OciInspection;
  guardrails: OciGuardrailReport;
  request: DeploymentRequest;
  subnetRef: string;
  imageRef: string;
  sshAuthorizedKey: string;
  opencodeVersion?: string;
  now?: Date;
}

export type ProvisionOciWorkerResult =
  | {
      status: 'PROVISIONED';
      operationId: string;
      workspaceKey: string;
      instanceFingerprint: string;
      region: string;
      availabilityDomain: string;
      shape: 'VM.Standard.A1.Flex';
      ocpus: number;
      memoryGb: number;
      bootGb: number;
      bootVolumeVpusPerGB: 10;
      assignPublicIp: false;
    }
  | {
      status: 'OUT_OF_CAPACITY';
      workspaceKey: string;
      fallbackRecommended: true;
    };

export class OciWorkerProvisioner {
  private readonly journal: OperationJournal;
  private readonly gateway: OciComputeGateway;

  constructor(deps: { journal: OperationJournal; gateway: OciComputeGateway }) {
    this.journal = deps.journal;
    this.gateway = deps.gateway;
  }

  async provision(input: ProvisionOciWorkerInput): Promise<ProvisionOciWorkerResult> {
    const workspaceKey = workspaceKeySchema.parse(input.workspaceKey);
    const now = input.now ?? new Date();

    if (input.request.additionalInstances !== 1) {
      throw new Error('OciWorkerProvisioner launches exactly 1 single-writer worker per workspace');
    }

    const guardrailCheck = evaluateOciPaygGuardrails(input.inspection, input.guardrails, input.request, now);
    if (guardrailCheck.source !== 'OCI_API') {
      throw new Error('DEMO_EVIDENCE_FORBIDDEN: live OCI provisioning requires fresh OCI_API evidence');
    }
    if (guardrailCheck.status !== 'GUARDED_QUOTA_FITS') {
      throw new Error(`GUARDRAILS_BLOCKED: ${guardrailCheck.blockers.join(', ')}`);
    }
    const region = guardrailCheck.candidate.region;
    const availabilityDomain = guardrailCheck.candidate.availabilityDomain;
    if (!region || !availabilityDomain) {
      throw new Error('GUARDRAILS_BLOCKED: missing verified home region or availability domain');
    }

    this.gateway.selectRegion(region);

    const subnetSecurity = await this.gateway.inspectSubnetSecurity(input.subnetRef);
    if (!subnetSecurity.subnetAvailable) {
      throw new Error('SUBNET_UNAVAILABLE: worker subnet is not in AVAILABLE state');
    }
    if (subnetSecurity.ingressRuleCount > 0) {
      throw new Error(
        `UNSAFE_SUBNET_INGRESS_RULES: expected 0 inbound security rules on worker subnet, found ${subnetSecurity.ingressRuleCount}`,
      );
    }

    const userDataBase64 = encodeWorkerCloudInitBase64({
      sshAuthorizedKey: input.sshAuthorizedKey,
      ...(input.opencodeVersion ? { opencodeVersion: input.opencodeVersion } : {}),
    });

    const operation = await this.journal.begin({
      kind: 'PROVISION',
      workspaceKey,
      summary: `Provisioning OCI VM.Standard.A1.Flex (${input.request.ocpus} OCPU / ${input.request.memoryGb} GB) in ${region}`,
    });

    const existingActive = (await this.gateway.listInstances({ workspaceKey })).filter(
      inst => inst.lifecycleState !== 'TERMINATED' && inst.lifecycleState !== 'TERMINATING',
    );
    if (existingActive.length > 0) {
      await this.journal.abortUnfenced(operation.operationId);
      throw new Error(`WORKSPACE_INSTANCE_ALREADY_EXISTS: workspace "${workspaceKey}" already has an active OCI worker`);
    }

    try {
      const created = await this.gateway.launchInstance({
        availabilityDomain,
        displayName: `agent-router-${workspaceKey}`,
        shape: 'VM.Standard.A1.Flex',
        ocpus: input.request.ocpus,
        memoryInGBs: input.request.memoryGb,
        bootVolumeSizeInGBs: input.request.bootGb,
        bootVolumeVpusPerGB: 10,
        assignPublicIp: false,
        subnetRef: input.subnetRef,
        imageRef: input.imageRef,
        userDataBase64,
        opcRetryToken: operation.retryToken,
        freeformTags: {
          'agent-router-managed': 'true',
          'agent-router-workspace': workspaceKey,
          'agent-router-operation-id': operation.operationId,
        },
      });

      const fingerprint = fingerprintInstanceId(created.instanceId);
      await this.journal.complete(
        operation.operationId,
        `Provisioned OCI worker ${fingerprint} for workspace ${workspaceKey}`,
      );

      return {
        status: 'PROVISIONED',
        operationId: operation.operationId,
        workspaceKey,
        instanceFingerprint: fingerprint,
        region,
        availabilityDomain,
        shape: 'VM.Standard.A1.Flex',
        ocpus: input.request.ocpus,
        memoryGb: input.request.memoryGb,
        bootGb: input.request.bootGb,
        bootVolumeVpusPerGB: 10,
        assignPublicIp: false,
      };
    } catch (err) {
      if (isOutOfCapacityError(err)) {
        const checkCreated = (await this.gateway.listInstances({ operationId: operation.operationId })).filter(
          inst => inst.lifecycleState !== 'TERMINATED',
        );
        if (checkCreated.length === 0) {
          await this.journal.abortUnfenced(operation.operationId);
          return {
            status: 'OUT_OF_CAPACITY',
            workspaceKey,
            fallbackRecommended: true,
          };
        }
      }

      await this.journal.markNeedsReconcile(
        operation.operationId,
        `OCI provision interrupted for ${workspaceKey}; reconcile via operation tag before retrying`,
      );
      throw err;
    }
  }

  async status(workspaceKeyInput: string): Promise<{
    workspaceKey: string;
    instances: { instanceFingerprint: string; lifecycleState: OciInstanceLifecycle; shape: string }[];
  }> {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const matches = (await this.gateway.listInstances({ workspaceKey })).filter(
      inst => inst.lifecycleState !== 'TERMINATED',
    );
    return {
      workspaceKey,
      instances: matches.map(inst => ({
        instanceFingerprint: fingerprintInstanceId(inst.instanceId),
        lifecycleState: inst.lifecycleState,
        shape: inst.shape,
      })),
    };
  }

  async reconcile(workspaceKeyInput: string): Promise<
    | {
        outcome: 'ADOPTED_EXISTING_INSTANCE';
        operationId: string;
        workspaceKey: string;
        instanceFingerprint: string;
      }
    | {
        outcome: 'CONFIRMED_ABSENT';
        operationId: string;
        workspaceKey: string;
      }
  > {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const records = await this.journal.list();
    const pending = records.find(
      record =>
        record.workspaceKey === workspaceKey &&
        record.kind === 'PROVISION' &&
        (record.status === 'NEEDS_RECONCILE' || record.status === 'PENDING'),
    );
    if (!pending) {
      throw new Error(`No interrupted PROVISION operation found for workspace "${workspaceKey}"`);
    }

    const matchedByOp = (await this.gateway.listInstances({ operationId: pending.operationId })).filter(
      inst => inst.lifecycleState !== 'TERMINATED',
    );
    if (matchedByOp.length > 1) {
      throw new Error(`AMBIGUOUS_RECONCILE: multiple instances matched operation ${pending.operationId}`);
    }

    if (matchedByOp.length === 1) {
      const fingerprint = fingerprintInstanceId(matchedByOp[0]!.instanceId);
      await this.journal.reconcile(
        pending.operationId,
        `Reconciled and adopted existing OCI worker ${fingerprint} for ${workspaceKey}`,
      );
      return {
        outcome: 'ADOPTED_EXISTING_INSTANCE',
        operationId: pending.operationId,
        workspaceKey,
        instanceFingerprint: fingerprint,
      };
    }

    const remnants = await this.gateway.listWorkspaceRemnants(workspaceKey);
    if (remnants.bootVolumes > 0 || remnants.blockVolumes > 0 || remnants.reservedPublicIps > 0) {
      throw new Error('LEAKED_RESOURCES_DETECTED during reconciliation; clean up orphaned compartment storage/IPs');
    }

    await this.journal.reconcile(
      pending.operationId,
      `Reconciled interrupted OCI provision for ${workspaceKey}: confirmed zero cloud resources created`,
    );
    return {
      outcome: 'CONFIRMED_ABSENT',
      operationId: pending.operationId,
      workspaceKey,
    };
  }

  async fence(workspaceKeyInput: string): Promise<{
    workspaceKey: string;
    fenced: true;
    stoppedCount: number;
  }> {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const active = (await this.gateway.listInstances({ workspaceKey })).filter(
      inst => inst.lifecycleState !== 'TERMINATED' && inst.lifecycleState !== 'TERMINATING',
    );

    let stoppedCount = 0;
    for (const inst of active) {
      if (inst.lifecycleState === 'STOPPED') continue;
      const updated = await this.gateway.stopInstance(inst.instanceId);
      if (updated.lifecycleState !== 'STOPPED') {
        throw new Error(`FENCE_INCOMPLETE: worker ${fingerprintInstanceId(inst.instanceId)} is ${updated.lifecycleState}`);
      }
      stoppedCount += 1;
    }

    return {
      workspaceKey,
      fenced: true,
      stoppedCount,
    };
  }

  async teardown(workspaceKeyInput: string): Promise<{
    workspaceKey: string;
    terminatedCount: number;
    remnants: WorkspaceRemnantCounts;
  }> {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const existing = (await this.gateway.listInstances({ workspaceKey })).filter(
      inst => inst.lifecycleState !== 'TERMINATED' && inst.lifecycleState !== 'TERMINATING',
    );

    let terminatedCount = 0;
    for (const inst of existing) {
      await this.gateway.terminateInstance({
        instanceId: inst.instanceId,
        preserveBootVolume: false,
        preserveDataVolumesCreatedAtLaunch: false,
      });
      terminatedCount += 1;
    }

    const remnants = await this.gateway.listWorkspaceRemnants(workspaceKey);
    if (
      remnants.instances > 0 ||
      remnants.bootVolumes > 0 ||
      remnants.blockVolumes > 0 ||
      remnants.reservedPublicIps > 0
    ) {
      throw new Error(
        `LEAKED_RESOURCES_DETECTED: instances=${remnants.instances}, bootVolumes=${remnants.bootVolumes}, blockVolumes=${remnants.blockVolumes}, reservedPublicIps=${remnants.reservedPublicIps}`,
      );
    }

    return {
      workspaceKey,
      terminatedCount,
      remnants,
    };
  }
}

export type FaultInjectionMode = 'NONE' | 'CRASH_AFTER_CREATE' | 'OUT_OF_CAPACITY';

/**
 * Deterministic in-memory OCI compute gateway for local TDD and `router oci:simulate-lifecycle`.
 * Never makes network calls or touches real cloud infrastructure.
 */
export class InMemoryOciComputeGateway implements OciComputeGateway {
  private ingressRuleCount: number;
  private faultMode: FaultInjectionMode;
  private readonly instances = new Map<string, OciInstanceRecord>();
  private readonly retryTokens = new Map<string, string>();
  private readonly bootVolumesByWorkspace = new Map<string, number>();
  private readonly orphanBootVolumesByWorkspace = new Map<string, number>();
  public launchCount = 0;
  public lastTerminateOptions: Omit<TerminateOciWorkerParams, 'instanceId'> | null = null;
  public selectedRegion: string | null = null;

  constructor(options: { ingressRuleCount?: number; faultMode?: FaultInjectionMode } = {}) {
    this.ingressRuleCount = options.ingressRuleCount ?? 0;
    this.faultMode = options.faultMode ?? 'NONE';
  }

  setFaultMode(mode: FaultInjectionMode): void {
    this.faultMode = mode;
  }

  expireRetryTokens(): void {
    this.retryTokens.clear();
  }

  injectOrphanBootVolume(workspaceKey: string): void {
    this.orphanBootVolumesByWorkspace.set(
      workspaceKey,
      (this.orphanBootVolumesByWorkspace.get(workspaceKey) ?? 0) + 1,
    );
  }

  clearOrphanBootVolumes(workspaceKey: string): void {
    this.orphanBootVolumesByWorkspace.delete(workspaceKey);
  }

  selectRegion(region: string): void {
    this.selectedRegion = region;
  }

  async inspectSubnetSecurity(_subnetRef: string): Promise<SubnetSecurityInspection> {
    return {
      subnetAvailable: true,
      ingressRuleCount: this.ingressRuleCount,
    };
  }

  async listInstances(filter: { workspaceKey?: string; operationId?: string }): Promise<OciInstanceRecord[]> {
    const all = [...this.instances.values()];
    return all.filter(inst => {
      if (filter.workspaceKey && inst.freeformTags['agent-router-workspace'] !== filter.workspaceKey) {
        return false;
      }
      if (filter.operationId && inst.freeformTags['agent-router-operation-id'] !== filter.operationId) {
        return false;
      }
      return true;
    });
  }

  async launchInstance(params: LaunchOciWorkerParams): Promise<OciInstanceRecord> {
    if (this.faultMode === 'OUT_OF_CAPACITY') {
      const error = new Error('Out of host capacity for shape VM.Standard.A1.Flex') as Error & { serviceCode?: string };
      error.serviceCode = 'OutOfHostCapacity';
      throw error;
    }

    const idempotentInstanceId = this.retryTokens.get(params.opcRetryToken);
    if (idempotentInstanceId) {
      const existing = this.instances.get(idempotentInstanceId);
      if (existing) return existing;
    }

    this.launchCount += 1;
    const instanceId = `ocid1.instance.oc1.iad.simulated${randomBytes(8).toString('hex')}`;
    const record: OciInstanceRecord = {
      instanceId,
      lifecycleState: 'RUNNING',
      shape: params.shape,
      availabilityDomain: params.availabilityDomain,
      freeformTags: { ...params.freeformTags },
    };
    this.instances.set(instanceId, record);
    this.retryTokens.set(params.opcRetryToken, instanceId);

    const ws = params.freeformTags['agent-router-workspace'];
    if (ws) {
      this.bootVolumesByWorkspace.set(ws, (this.bootVolumesByWorkspace.get(ws) ?? 0) + 1);
    }

    if (this.faultMode === 'CRASH_AFTER_CREATE') {
      throw new Error('Simulated post-launch transport crash before journal completion');
    }

    return record;
  }

  async stopInstance(instanceId: string): Promise<OciInstanceRecord> {
    const record = this.instances.get(instanceId);
    if (!record) throw new Error('Instance not found');
    const updated: OciInstanceRecord = { ...record, lifecycleState: 'STOPPED' };
    this.instances.set(instanceId, updated);
    return updated;
  }

  async terminateInstance(params: TerminateOciWorkerParams): Promise<void> {
    this.lastTerminateOptions = {
      preserveBootVolume: params.preserveBootVolume,
      preserveDataVolumesCreatedAtLaunch: params.preserveDataVolumesCreatedAtLaunch,
    };
    const record = this.instances.get(params.instanceId);
    if (!record) return;
    this.instances.set(params.instanceId, { ...record, lifecycleState: 'TERMINATED' });
    const ws = record.freeformTags['agent-router-workspace'];
    if (ws && !params.preserveBootVolume) {
      const current = this.bootVolumesByWorkspace.get(ws) ?? 0;
      this.bootVolumesByWorkspace.set(ws, Math.max(0, current - 1));
    }
  }

  async listWorkspaceRemnants(workspaceKey: string): Promise<WorkspaceRemnantCounts> {
    const activeInstances = [...this.instances.values()].filter(
      inst =>
        inst.freeformTags['agent-router-workspace'] === workspaceKey &&
        inst.lifecycleState !== 'TERMINATED',
    ).length;
    const attachedBoot = this.bootVolumesByWorkspace.get(workspaceKey) ?? 0;
    const orphanBoot = this.orphanBootVolumesByWorkspace.get(workspaceKey) ?? 0;
    return {
      instances: activeInstances,
      bootVolumes: attachedBoot + orphanBoot,
      blockVolumes: 0,
      reservedPublicIps: 0,
    };
  }
}

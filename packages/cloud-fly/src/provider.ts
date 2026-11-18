import { OperationJournal } from '../../cli/src/journal.js';
import { evaluateFlyGuardrails, flyEvidenceSchema } from './guard.js';
import { FlyMachinesApi } from './api.js';

export type FlyState = 'started' | 'suspended' | 'stopped' | 'destroyed' | 'starting' | 'stopping' | 'suspending' | 'created' | 'destroying' | 'replacing' | 'launch_failed';
export type FlyAction = 'suspend' | 'start' | 'delete';
export interface FlyMachine { id: string; workspaceKey: string; state: FlyState }
export interface FlyGateway {
  readonly mode: 'SIMULATED' | 'API';
  inspect(machineId: string): Promise<FlyMachine>;
  mutate(machineId: string, action: FlyAction, retryToken: string, evidence?: unknown): Promise<void>;
  wait(machineId: string, state: FlyState): Promise<void>;
  validateStart?(machineId: string, evidence: unknown): Promise<void>;
}
const desired: Record<FlyAction, FlyState> = { suspend: 'suspended', start: 'started', delete: 'destroyed' };
const machinePattern = /^[a-f0-9]{8,32}$/;
const workspacePattern = /^[A-Za-z0-9_-]{1,64}$/;

/** Operates on an existing dedicated Machine. Provisioning is a separate gate. */
export class FlyMachineLifecycle {
  constructor(private readonly deps: { journal: OperationJournal; gateway: FlyGateway }) {}

  async transition(workspaceKey: string, machineId: string, action: FlyAction, evidence?: unknown): Promise<void> {
    if (!['SIMULATED', 'API'].includes(this.deps.gateway.mode)) throw new Error('FLY_INVALID_GATEWAY');
    if (action === 'start' && evaluateFlyGuardrails(evidence).status !== 'GUARDED_PAID_TARGET') throw new Error('FLY_START_BLOCKED_BY_EVIDENCE');
    if (action === 'start' && this.deps.gateway.mode === 'API') {
      if (!this.deps.gateway.validateStart) throw new Error('FLY_START_EVIDENCE_NOT_BOUND');
      await this.deps.gateway.validateStart(machineId, evidence);
    }
    if (!workspacePattern.test(workspaceKey) || !machinePattern.test(machineId) || !Object.hasOwn(desired, action)) throw new Error('FLY_INVALID_TARGET');
    const machine = await this.deps.gateway.inspect(machineId);
    if (machine.id !== machineId || machine.workspaceKey !== workspaceKey) throw new Error('FLY_OWNERSHIP_MISMATCH');
    const operation = await this.deps.journal.begin({
      kind: 'PROVISION', workspaceKey, summary: `Fly ${action} ${machineId}`,
    });
    try {
      if (machine.state !== desired[action]) {
        if ((action === 'suspend' && machine.state !== 'started')
          || (action === 'start' && !['stopped', 'suspended'].includes(machine.state))) throw new Error('FLY_INVALID_STATE');
        await this.deps.gateway.mutate(machineId, action, operation.retryToken, evidence);
      }
      await this.deps.gateway.wait(machineId, desired[action]);
      const observed = await this.deps.gateway.inspect(machineId);
      if (observed.id !== machineId || observed.workspaceKey !== workspaceKey || observed.state !== desired[action]) throw new Error('FLY_STATE_MISMATCH');
      if (action === 'start' && this.deps.gateway.mode === 'API') await this.deps.gateway.validateStart!(machineId, evidence);
      await this.deps.journal.complete(operation.operationId, 'Fly lifecycle state verified');
    } catch {
      const current = await this.deps.journal.read(operation.operationId);
      if (current.status === 'PENDING') await this.deps.journal.markNeedsReconcile(operation.operationId, operation.summary);
      throw new Error('FLY_ACTION_UNCERTAIN');
    }
  }

  async reconcile(operationId: string): Promise<'RECONCILED' | 'BLOCKED'> {
    const operation = await this.deps.journal.read(operationId);
    if (operation.kind !== 'PROVISION' || !operation.summary.startsWith('Fly ')) throw new Error('FLY_INVALID_OPERATION');
    if (operation.status === 'COMPLETED') return 'RECONCILED';
    const match = /^Fly (suspend|start|delete) ([a-f0-9]{8,32})$/.exec(operation.summary);
    if (!match || operation.kind !== 'PROVISION') throw new Error('FLY_INVALID_OPERATION');
    const observed = await this.deps.gateway.inspect(match[2]!);
    if (observed.id !== match[2] || observed.workspaceKey !== operation.workspaceKey) throw new Error('FLY_OWNERSHIP_MISMATCH');
    if (observed.state !== desired[match[1] as FlyAction]) return 'BLOCKED';
    await this.deps.journal.reconcile(operationId, 'Fly lifecycle reconciled from observed state');
    return 'RECONCILED';
  }
}

/** Existing-Machine adapter; no creation API and no implicit retries. */
export class ApiFlyGateway implements FlyGateway {
  readonly mode = 'API' as const;
  constructor(private readonly api: FlyMachinesApi, private readonly workspaceKey: string) {
    if (!workspacePattern.test(workspaceKey)) throw new Error('FLY_INVALID_TARGET');
  }
  private scope(machineId: string): void {
    if (machineId !== this.api.machineId) throw new Error('FLY_OWNERSHIP_MISMATCH');
  }
  async inspect(machineId: string): Promise<FlyMachine> {
    this.scope(machineId);
    try {
      const machine = await this.api.inspect();
      if (machine.config.metadata['agent-router-workspace'] !== this.workspaceKey) throw new Error('FLY_OWNERSHIP_MISMATCH');
      return { id: machine.id, workspaceKey: this.workspaceKey, state: machine.state };
    } catch (error) {
      if (error instanceof Error && error.message === 'FLY_MACHINE_NOT_FOUND') return { id: machineId, workspaceKey: this.workspaceKey, state: 'destroyed' };
      throw error;
    }
  }
  async mutate(machineId: string, action: FlyAction, retryToken: string, evidence?: unknown): Promise<void> {
    this.scope(machineId);
    const before = await this.api.inspect();
    if (before.config.metadata['agent-router-workspace'] !== this.workspaceKey) throw new Error('FLY_OWNERSHIP_MISMATCH');
    if (action === 'start') {
      await this.validateStart(machineId, evidence);
    }
    const lease = await this.api.createLease(retryToken);
    try {
      const locked = await this.api.inspect();
      if (locked.instance_id !== before.instance_id || locked.config.metadata['agent-router-workspace'] !== this.workspaceKey) throw new Error('FLY_MACHINE_CHANGED');
      if (lease.expiresAt <= Date.now()) throw new Error('FLY_LEASE_EXPIRED');
      if (action === 'start') await this.api.start(lease.nonce);
      else if (action === 'suspend') await this.api.suspend(lease.nonce);
      else await this.api.destroy(lease.nonce);
    } finally {
      try { await this.api.releaseLease(lease.nonce); }
      catch (error) { if (!(error instanceof Error) || error.message !== 'FLY_MACHINE_NOT_FOUND') throw error; }
    }
  }
  async validateStart(machineId: string, evidence: unknown): Promise<void> {
    this.scope(machineId);
    const before = await this.api.inspect();
    const report = flyEvidenceSchema.safeParse(evidence);
    if (!report.success || report.data.source !== 'READ_ONLY_INSPECTION'
      || evaluateFlyGuardrails(report.data).status !== 'GUARDED_PAID_TARGET'
      || report.data.target?.appName !== this.api.appName || report.data.target.machineId !== machineId
      || report.data.target.instanceId !== before.instance_id || report.data.memoryMb !== before.config.guest?.memory_mb
      || (before.config.init?.swap_size_mb ?? 0) !== 0 || Boolean(before.config.schedule)
      || before.config.metadata['agent-router-workspace'] !== this.workspaceKey) throw new Error('FLY_START_EVIDENCE_NOT_BOUND');
  }
  async wait(machineId: string, state: FlyState): Promise<void> {
    this.scope(machineId);
    if (!['started', 'stopped', 'suspended', 'destroyed'].includes(state)) throw new Error('FLY_INVALID_STATE');
    try {
      const current = await this.api.inspect();
      await this.api.wait(state as 'started' | 'stopped' | 'suspended' | 'destroyed', current.instance_id);
    } catch (error) {
      if (state === 'destroyed' && error instanceof Error && error.message === 'FLY_MACHINE_NOT_FOUND') return;
      throw error;
    }
  }
}

/** Deterministic local test gateway. It performs no network or cloud calls. */
export class InMemoryFlyGateway implements FlyGateway {
  readonly mode = 'SIMULATED' as const;
  private readonly machine: FlyMachine;
  private readonly accepted = new Map<string, string>();
  mutations = 0;
  failAfterMutation = false;
  constructor(workspaceKey: string, state: FlyState = 'started') {
    this.machine = { id: 'abcd1234', workspaceKey, state };
  }
  async inspect(machineId: string): Promise<FlyMachine> {
    if (machineId !== this.machine.id) throw new Error('FLY_MACHINE_UNKNOWN');
    return { ...this.machine };
  }
  async mutate(machineId: string, action: FlyAction, retryToken: string): Promise<void> {
    await this.inspect(machineId);
    const intent = `${machineId}:${action}`;
    const previous = this.accepted.get(retryToken);
    if (previous && previous !== intent) throw new Error('FLY_RETRY_TOKEN_CONFLICT');
    if (!previous) {
      this.accepted.set(retryToken, intent);
      this.mutations++;
      this.machine.state = desired[action];
    }
    if (this.failAfterMutation) { this.failAfterMutation = false; throw new Error('Simulated lost response'); }
  }
  async wait(machineId: string, state: FlyState): Promise<void> {
    if ((await this.inspect(machineId)).state !== state) throw new Error('FLY_WAIT_TIMEOUT');
  }
  remnants(): number { return this.machine.state === 'destroyed' ? 0 : 1; }
}

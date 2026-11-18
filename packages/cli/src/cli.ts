import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  HetznerWorkerProvisioner,
  hetznerLocationSchema,
  HttpHetznerCloudGateway,
  InMemoryHetznerCloudGateway,
} from '../../cloud-hetzner/src/provider.js';
import { createOciComputeSdkGateway } from '../../cloud-oci/src/oci-compute-sdk.js';
import { InMemoryOciComputeGateway, OciWorkerProvisioner } from '../../cloud-oci/src/provider.js';
import {
  awsAllowanceSnapshotSchema,
  evaluateAwsFreePlanAllowance,
} from '../../cloud-readiness/src/aws-allowance.js';
import { inspectOciGuardrails, type OciGuardrailReport } from '../../cloud-readiness/src/oci-guardrails.js';
import { inspectOci } from '../../cloud-readiness/src/oci-inspect.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { createOciGuardrailSdkReader, createOciSdkReader } from '../../cloud-readiness/src/oci-sdk.js';
import { LoopbackHostTransport } from '../../host-ssh/src/transport.js';
import { captureCheckpoint, restoreCheckpoint } from '../../snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { OperationJournal } from './journal.js';
import { migrateWorkspace } from './migrate.js';

export const ROUTER_CLI_VERSION = '0.1.0';

export interface RouterCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: RouterCliIo = {
  stdout: line => console.log(line),
  stderr: line => console.error(line),
};

const helpText = `Usage: agent-router <subcommand> [options]

General:
  --version | version     Print Agent Router CLI version (${ROUTER_CLI_VERSION})
  --help | help           Show this command reference

Local journal, portable checkpoints & cross-host migration:
  status                  [--journal-dir .work/router-journal]
  reconcile               --operation op_<hex> --summary "<reason>" [--journal-dir .work/router-journal]
  checkpoint              --workspace <dir> --store <dir> --key-file <0600-path> [--workspace-key <name>]
  restore                 --checkpoint chk_<hex> --target <dir> --store <dir> --key-file <0600-path>
  migrate:simulate        [--workspace-key ws-sim]

Cloud allowance & worker lifecycle commands:
  aws:allowance           (--demo | --report <path>) [--min-credit-usd 5] [--min-days 7]
  oci:simulate-lifecycle  [--workspace-key ws-sim]
  oci:up                  --workspace-key <name> --config <path> --compartment-id <OCID> --compartment-name <name> --subnet-id <OCID> --image-id <OCID> --ssh-pubkey-file <path> [--ocpus 1] [--memory-gb 4] [--boot-gb 50]
  oci:status              --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  oci:reconcile           --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  oci:fence               --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  oci:down                --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  hetzner:simulate-lifecycle [--workspace-key ws-hsim]
  hetzner:up              --workspace-key <name> --token-file <0600-path> --location <fsn1|nbg1|hel1|sin|ash|hil> --firewall-id <id> --ssh-pubkey-file <path>
  hetzner:reconcile       --workspace-key <name> --token-file <0600-path>
  hetzner:fence           --workspace-key <name> --token-file <0600-path>
  hetzner:down            --workspace-key <name> --token-file <0600-path>`;

async function readOwnerOnlySecretFile(filePath: string, label: string): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be an owner-only (0600) regular file`);
  }
  return await readFile(resolved);
}

async function loadOwnerOnlyMasterKey(keyFilePath: string): Promise<Buffer> {
  const raw = await readOwnerOnlySecretFile(keyFilePath, 'Encryption key file');
  const text = raw.toString('utf8').trim();
  if (/^[a-fA-F0-9]{64}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  if (raw.byteLength === 32) {
    return raw;
  }
  throw new Error('Encryption key file must contain 32 raw bytes or 64 hex characters');
}

async function loadOwnerOnlyApiToken(tokenFilePath: string): Promise<string> {
  const raw = (await readOwnerOnlySecretFile(tokenFilePath, 'API token file')).toString('utf8').trim();
  if (!raw || /[\s\r\n\0]/.test(raw)) {
    throw new Error('API token file must contain a single non-empty token');
  }
  return raw;
}

function scrubMessage(message: string): string {
  return message.replace(/ocid1\.[a-z0-9._-]+/gi, '[REDACTED_OCID]');
}

export async function runRouterCli(argv: string[], io: RouterCliIo = defaultIo): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    io.stdout(helpText);
    return 0;
  }
  if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v') {
    io.stdout(ROUTER_CLI_VERSION);
    return 0;
  }

  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        'journal-dir': { type: 'string', default: '.work/router-journal' },
        operation: { type: 'string' },
        summary: { type: 'string' },
        workspace: { type: 'string' },
        target: { type: 'string' },
        store: { type: 'string' },
        'key-file': { type: 'string' },
        'token-file': { type: 'string' },
        checkpoint: { type: 'string' },
        'workspace-key': { type: 'string' },
        report: { type: 'string' },
        demo: { type: 'boolean' },
        'min-credit-usd': { type: 'string', default: '5' },
        'min-days': { type: 'string', default: '7' },
        config: { type: 'string' },
        profile: { type: 'string', default: 'DEFAULT' },
        'compartment-id': { type: 'string' },
        'compartment-name': { type: 'string' },
        region: { type: 'string' },
        'availability-domain': { type: 'string' },
        'subnet-id': { type: 'string' },
        'image-id': { type: 'string' },
        'ssh-pubkey-file': { type: 'string' },
        ocpus: { type: 'string', default: '1' },
        'memory-gb': { type: 'string', default: '4' },
        'boot-gb': { type: 'string', default: '50' },
        location: { type: 'string' },
        'firewall-id': { type: 'string' },
        'enable-ipv4': { type: 'boolean' },
      },
    });

    const journal = new OperationJournal(values['journal-dir']);

    if (subcommand === 'status') {
      const operations = await journal.list();
      const blockingCount = operations.filter(
        op => op.status === 'PENDING' || op.status === 'NEEDS_RECONCILE',
      ).length;
      io.stdout(
        JSON.stringify(
          {
            totalOperations: operations.length,
            blockingCount,
            operations,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (subcommand === 'reconcile') {
      if (!values.operation || !values.summary) {
        throw new Error('reconcile requires --operation and --summary');
      }
      const record = await journal.reconcile(values.operation, values.summary);
      io.stdout(JSON.stringify(record, null, 2));
      return 0;
    }

    if (subcommand === 'checkpoint') {
      if (!values.workspace || !values.store || !values['key-file']) {
        throw new Error('checkpoint requires --workspace, --store, and --key-file');
      }
      const key = await loadOwnerOnlyMasterKey(values['key-file']);
      const wsKey = values['workspace-key'] ?? path.basename(path.resolve(values.workspace));
      const op = await journal.begin({
        kind: 'CHECKPOINT',
        workspaceKey: wsKey,
        summary: `Capturing encrypted checkpoint for ${wsKey}`,
      });
      try {
        const store = new LocalEncryptedStore(values.store, key);
        const manifest = await captureCheckpoint({
          workspace: values.workspace,
          store,
          exportSessions: async () => [],
          quiesceSource: async () => {},
        });
        await journal.complete(op.operationId, `Captured checkpoint ${manifest.checkpointId}`);
        io.stdout(JSON.stringify({ operationId: op.operationId, ...manifest }, null, 2));
        return 0;
      } catch (err) {
        await journal.abortUnfenced(op.operationId).catch(() => undefined);
        throw err;
      }
    }

    if (subcommand === 'restore') {
      if (!values.checkpoint || !values.target || !values.store || !values['key-file']) {
        throw new Error('restore requires --checkpoint, --target, --store, and --key-file');
      }
      const key = await loadOwnerOnlyMasterKey(values['key-file']);
      const wsKey = values['workspace-key'] ?? path.basename(path.resolve(values.target));
      const op = await journal.begin({
        kind: 'RESTORE',
        workspaceKey: wsKey,
        summary: `Restoring encrypted checkpoint ${values.checkpoint}`,
      });
      try {
        const store = new LocalEncryptedStore(values.store, key);
        const manifest = await restoreCheckpoint({
          checkpointId: values.checkpoint,
          targetWorkspace: values.target,
          store,
          importSession: async transfer => transfer.info.id,
        });
        await journal.complete(op.operationId, `Restored checkpoint ${manifest.checkpointId}`);
        io.stdout(JSON.stringify({ operationId: op.operationId, ...manifest }, null, 2));
        return 0;
      } catch (err) {
        await journal.abortUnfenced(op.operationId).catch(() => undefined);
        throw err;
      }
    }

    if (subcommand === 'aws:allowance') {
      const now = new Date();
      const snapshot = values.demo
        ? awsAllowanceSnapshotSchema.parse({
            observedAt: now.toISOString(),
            accountPlanType: 'FREE',
            accountPlanStatus: 'ACTIVE',
            remainingCreditAmount: 82.0,
            creditCurrency: 'USD',
            expiresAt: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
          })
        : values.report
          ? awsAllowanceSnapshotSchema.parse(JSON.parse(await readFile(path.resolve(values.report), 'utf8')))
          : null;

      if (!snapshot) {
        throw new Error('aws:allowance requires --demo or --report <path>');
      }
      const evaluation = evaluateAwsFreePlanAllowance(snapshot, {
        minCreditFloorUsd: Number(values['min-credit-usd']),
        minDaysRemaining: Number(values['min-days']),
        now,
      });
      io.stdout(JSON.stringify(evaluation, null, 2));
      return evaluation.decision === 'HEALTHY' ? 0 : 2;
    }

    if (subcommand === 'oci:simulate-lifecycle') {
      const workspaceKey = values['workspace-key'] ?? 'ws-sim-lifecycle';
      const scratch = await mkdtemp(path.join(tmpdir(), 'router-oci-sim-'));
      try {
        const simJournal = new OperationJournal(path.join(scratch, 'journal'));
        const gateway = new InMemoryOciComputeGateway({
          ingressRuleCount: 0,
          faultMode: 'CRASH_AFTER_CREATE',
        });
        const provisioner = new OciWorkerProvisioner({ journal: simJournal, gateway });
        const now = new Date();
        const observedAt = new Date(now.getTime() - 30_000).toISOString();

        const simulatedInspection: OciInspection = {
          schemaVersion: 1,
          source: 'OCI_API',
          observedAt,
          homeRegion: 'us-ashburn-1',
          region: 'us-ashburn-1',
          availabilityDomain: 'AD-1',
          metrics: {
            a1RegionalOcpus: { status: 'KNOWN', limit: 4, used: 0, available: 4 },
            a1RegionalMemoryGb: { status: 'KNOWN', limit: 24, used: 0, available: 24 },
            a1AdOcpus: { status: 'KNOWN', limit: 4, used: 0, available: 4 },
            a1AdMemoryGb: { status: 'KNOWN', limit: 24, used: 0, available: 24 },
            microInstances: { status: 'KNOWN', limit: 2, used: 0, available: 2 },
            freeStorageGb: { status: 'KNOWN', limit: 200, used: 0, available: 200 },
          },
          issues: [],
        };

        const simulatedGuardrails: OciGuardrailReport = {
          schemaVersion: 1,
          source: 'OCI_API',
          observedAt,
          compartmentName: 'agent-router-workers',
          compartmentQuota: {
            status: 'VERIFIED',
            zeroedOtherComputeShapes: true,
            maxA1Ocpus: 4,
            maxA1MemoryGb: 24,
            maxStorageGb: 200,
          },
          budgetAlert: {
            status: 'VERIFIED',
            lowestTripwireAmount: 1,
          },
        };

        let crashIntercepted = false;
        try {
          await provisioner.provision({
            workspaceKey,
            inspection: simulatedInspection,
            guardrails: simulatedGuardrails,
            request: { ocpus: 2, memoryGb: 12, bootGb: 50, additionalInstances: 1 },
            subnetRef: 'subnet-zero-ingress',
            imageRef: 'image-ubuntu-2404-arm64',
            sshAuthorizedKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9exampleKeyMaterial0123456789abcdef router@simulation',
            now,
          });
        } catch {
          crashIntercepted = true;
        }

        gateway.expireRetryTokens();
        gateway.setFaultMode('NONE');
        const reconciled = await provisioner.reconcile(workspaceKey);
        const fenced = await provisioner.fence(workspaceKey);
        const tornDown = await provisioner.teardown(workspaceKey);

        io.stdout(
          JSON.stringify(
            {
              status: 'SIMULATION_VERIFIED',
              mode: 'LOCAL_IN_MEMORY_FAULT_INJECTION',
              workspaceKey,
              crashIntercepted,
              launchCount: gateway.launchCount,
              reconcileOutcome: reconciled.outcome,
              instanceFingerprint:
                reconciled.outcome === 'ADOPTED_EXISTING_INSTANCE' ? reconciled.instanceFingerprint : null,
              fenced: fenced.fenced,
              terminateOptions: gateway.lastTerminateOptions,
              remnants: tornDown.remnants,
            },
            null,
            2,
          ),
        );
        return 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    if (subcommand === 'hetzner:simulate-lifecycle') {
      const workspaceKey = values['workspace-key'] ?? 'ws-hetzner-sim';
      const scratch = await mkdtemp(path.join(tmpdir(), 'router-hetzner-sim-'));
      try {
        const simJournal = new OperationJournal(path.join(scratch, 'journal'));
        const gateway = new InMemoryHetznerCloudGateway({
          firewallIngressRules: 0,
          crashAfterCreate: true,
        });
        const provisioner = new HetznerWorkerProvisioner({ journal: simJournal, gateway });

        let crashIntercepted = false;
        try {
          await provisioner.provision({
            workspaceKey,
            location: 'nbg1',
            firewallId: 1001,
            sshAuthorizedKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9exampleKeyMaterial0123456789abcdef router@simulation',
          });
        } catch {
          crashIntercepted = true;
        }

        gateway.setCrashAfterCreate(false);
        const reconciled = await provisioner.reconcile(workspaceKey);
        const fenced = await provisioner.fence(workspaceKey);
        const tornDown = await provisioner.teardown(workspaceKey);

        io.stdout(
          JSON.stringify(
            {
              status: 'SIMULATION_VERIFIED',
              mode: 'LOCAL_IN_MEMORY_FAULT_INJECTION',
              workspaceKey,
              crashIntercepted,
              createCount: gateway.createCount,
              reconcileOutcome: reconciled.outcome,
              serverFingerprint:
                reconciled.outcome === 'ADOPTED_EXISTING_SERVER' ? reconciled.serverFingerprint : null,
              fenced: fenced.fenced,
              remnants: tornDown.remnants,
            },
            null,
            2,
          ),
        );
        return 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    if (subcommand === 'migrate:simulate') {
      const workspaceKey = values['workspace-key'] ?? 'ws-migrate-sim';
      const scratch = await mkdtemp(path.join(tmpdir(), 'router-migrate-sim-'));
      try {
        const srcWs = path.join(scratch, 'src-ws');
        await mkdir(srcWs, { recursive: true, mode: 0o700 });
        await writeFile(path.join(srcWs, 'state.txt'), 'portable-state\n', { mode: 0o600 });
        const now = new Date();
        const observedAt = new Date(now.getTime() - 10_000).toISOString();

        const result = await migrateWorkspace({
          workspaceKey,
          journal: new OperationJournal(path.join(scratch, 'journal')),
          encryptionKey: randomBytes(32),
          trigger: {
            kind: 'AWS_FREE_PLAN',
            snapshot: {
              observedAt,
              accountPlanType: 'FREE',
              accountPlanStatus: 'ACTIVE',
              remainingCreditAmount: 3.1,
              creditCurrency: 'USD',
              expiresAt: new Date(now.getTime() + 20 * 86_400_000).toISOString(),
            },
            minCreditFloorUsd: 5,
            now,
          },
          source: {
            workspacePath: srcWs,
            stagingDir: path.join(scratch, 'stage'),
            exportSessions: async () => [{ info: { id: 'ses_sim_01' }, messages: [] }],
            fenceAgent: async () => {},
            teardownCompute: async () => {},
          },
          candidates: [
            {
              name: 'oci-a1-primary',
              targetWorkspace: path.join(scratch, 'dst-oci'),
              transport: new LoopbackHostTransport(path.join(scratch, 'spool-oci')),
              prepareCompute: async () => ({ status: 'OUT_OF_CAPACITY' }),
              activateAndImportSession: async t => t.info.id,
            },
            {
              name: 'hetzner-cax11-fallback',
              targetWorkspace: path.join(scratch, 'dst-hetzner'),
              transport: new LoopbackHostTransport(path.join(scratch, 'spool-hetzner')),
              prepareCompute: async () => ({ status: 'READY', targetFingerprint: 'hcloud_sim0123456789ab' }),
              activateAndImportSession: async t => t.info.id,
            },
          ],
        });

        io.stdout(
          JSON.stringify(
            result.status === 'MIGRATED'
              ? {
                  status: result.status,
                  workspaceKey,
                  selectedTarget: result.selectedTarget,
                  targetFingerprint: result.targetFingerprint,
                  triggerReasons: result.triggerReasons,
                  skippedTargets: result.skippedTargets,
                  sourceTornDown: result.sourceTornDown,
                }
              : result,
            null,
            2,
          ),
        );
        return 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    if (
      subcommand === 'hetzner:up' ||
      subcommand === 'hetzner:reconcile' ||
      subcommand === 'hetzner:fence' ||
      subcommand === 'hetzner:down'
    ) {
      if (!values['workspace-key'] || !values['token-file']) {
        throw new Error(`${subcommand} requires --workspace-key and --token-file`);
      }
      const token = await loadOwnerOnlyApiToken(values['token-file']);
      const gateway = new HttpHetznerCloudGateway(token);
      const provisioner = new HetznerWorkerProvisioner({ journal, gateway });

      if (subcommand === 'hetzner:up') {
        if (!values.location || !values['firewall-id'] || !values['ssh-pubkey-file']) {
          throw new Error('hetzner:up requires --location, --firewall-id, and --ssh-pubkey-file');
        }
        const sshPubKey = (await readFile(path.resolve(values['ssh-pubkey-file']), 'utf8')).trim();
        const created = await provisioner.provision({
          workspaceKey: values['workspace-key'],
          location: hetznerLocationSchema.parse(values.location),
          firewallId: Number(values['firewall-id']),
          sshAuthorizedKey: sshPubKey,
          ...(values['enable-ipv4'] !== undefined ? { enableIpv4: values['enable-ipv4'] } : {}),
        });
        io.stdout(JSON.stringify(created, null, 2));
        return 0;
      }

      if (subcommand === 'hetzner:reconcile') {
        io.stdout(JSON.stringify(await provisioner.reconcile(values['workspace-key']), null, 2));
        return 0;
      }
      if (subcommand === 'hetzner:fence') {
        io.stdout(JSON.stringify(await provisioner.fence(values['workspace-key']), null, 2));
        return 0;
      }
      io.stdout(JSON.stringify(await provisioner.teardown(values['workspace-key']), null, 2));
      return 0;
    }

    if (
      subcommand === 'oci:up' ||
      subcommand === 'oci:status' ||
      subcommand === 'oci:reconcile' ||
      subcommand === 'oci:fence' ||
      subcommand === 'oci:down'
    ) {
      if (!values['workspace-key'] || !values.config || !values['compartment-id']) {
        throw new Error(`${subcommand} requires --workspace-key, --config, and --compartment-id`);
      }

      const computeConn = createOciComputeSdkGateway(
        values.config,
        values['compartment-id'],
        values.profile,
      );
      try {
        const provisioner = new OciWorkerProvisioner({
          journal,
          gateway: computeConn.gateway,
        });

        if (subcommand === 'oci:up') {
          if (!values['compartment-name'] || !values['subnet-id'] || !values['image-id'] || !values['ssh-pubkey-file']) {
            throw new Error(
              'oci:up requires --compartment-name, --subnet-id, --image-id, and --ssh-pubkey-file',
            );
          }
          const sshPubKey = (await readFile(path.resolve(values['ssh-pubkey-file']), 'utf8')).trim();
          const baseConn = createOciSdkReader(values.config, values.profile);
          const guardConn = createOciGuardrailSdkReader(
            values.config,
            values['compartment-id'],
            values.profile,
          );
          try {
            const now = new Date();
            const [inspection, guardrails] = await Promise.all([
              inspectOci(baseConn.reader, {
                ...(values['availability-domain'] ? { availabilityDomain: values['availability-domain'] } : {}),
              }),
              inspectOciGuardrails(guardConn.reader, values['compartment-name'], now),
            ]);
            const result = await provisioner.provision({
              workspaceKey: values['workspace-key'],
              inspection,
              guardrails,
              request: {
                ocpus: Number(values.ocpus),
                memoryGb: Number(values['memory-gb']),
                bootGb: Number(values['boot-gb']),
                additionalInstances: 1,
              },
              subnetRef: values['subnet-id'],
              imageRef: values['image-id'],
              sshAuthorizedKey: sshPubKey,
              now,
            });
            io.stdout(JSON.stringify(result, null, 2));
            return result.status === 'PROVISIONED' ? 0 : 2;
          } finally {
            baseConn.close();
            guardConn.close();
          }
        }

        if (!values.region) {
          throw new Error(`${subcommand} requires --region`);
        }
        computeConn.gateway.selectRegion(values.region);

        if (subcommand === 'oci:status') {
          io.stdout(JSON.stringify(await provisioner.status(values['workspace-key']), null, 2));
          return 0;
        }
        if (subcommand === 'oci:reconcile') {
          io.stdout(JSON.stringify(await provisioner.reconcile(values['workspace-key']), null, 2));
          return 0;
        }
        if (subcommand === 'oci:fence') {
          io.stdout(JSON.stringify(await provisioner.fence(values['workspace-key']), null, 2));
          return 0;
        }
        io.stdout(JSON.stringify(await provisioner.teardown(values['workspace-key']), null, 2));
        return 0;
      } finally {
        computeConn.close();
      }
    }

    throw new Error(`Unknown router subcommand: ${subcommand}`);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : 'Router command failed';
    io.stderr(scrubMessage(rawMessage));
    return 1;
  }
}

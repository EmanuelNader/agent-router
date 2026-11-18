import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createOciComputeSdkGateway } from '../../cloud-oci/src/oci-compute-sdk.js';
import { InMemoryOciComputeGateway, OciWorkerProvisioner } from '../../cloud-oci/src/provider.js';
import { inspectOciGuardrails, type OciGuardrailReport } from '../../cloud-readiness/src/oci-guardrails.js';
import { inspectOci } from '../../cloud-readiness/src/oci-inspect.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { createOciGuardrailSdkReader, createOciSdkReader } from '../../cloud-readiness/src/oci-sdk.js';
import { captureCheckpoint, restoreCheckpoint } from '../../snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { OperationJournal } from './journal.js';

export interface RouterCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: RouterCliIo = {
  stdout: line => console.log(line),
  stderr: line => console.error(line),
};

const helpText = `Usage: pnpm router <subcommand> [options]

Local journal & portable checkpoint commands:
  status      [--journal-dir .work/router-journal]
  reconcile   --operation op_<hex> --summary "<reason>" [--journal-dir .work/router-journal]
  checkpoint  --workspace <dir> --store <dir> --key-file <0600-path> [--workspace-key <name>] [--journal-dir .work/router-journal]
  restore     --checkpoint chk_<hex> --target <dir> --store <dir> --key-file <0600-path> [--workspace-key <name>] [--journal-dir .work/router-journal]

Guarded OCI worker lifecycle commands:
  oci:simulate-lifecycle [--workspace-key ws-sim]
  oci:up        --workspace-key <name> --config <path> --compartment-id <OCID> --compartment-name <name> --subnet-id <OCID> --image-id <OCID> --ssh-pubkey-file <path> [--ocpus 1] [--memory-gb 4] [--boot-gb 50]
  oci:status    --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  oci:reconcile --workspace-key <name> --config <path> --compartment-id <OCID> --region <region> [--journal-dir .work/router-journal]
  oci:fence     --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>
  oci:down      --workspace-key <name> --config <path> --compartment-id <OCID> --region <region>`;

async function loadOwnerOnlyMasterKey(keyFilePath: string): Promise<Buffer> {
  const resolved = path.resolve(keyFilePath);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Encryption key file must be an owner-only (0600) regular file');
  }
  const raw = await readFile(resolved);
  const text = raw.toString('utf8').trim();
  if (/^[a-fA-F0-9]{64}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  if (raw.byteLength === 32) {
    return raw;
  }
  throw new Error('Encryption key file must contain 32 raw bytes or 64 hex characters');
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
        checkpoint: { type: 'string' },
        'workspace-key': { type: 'string' },
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

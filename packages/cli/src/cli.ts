import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { OpenCodeClient } from '../../agent-opencode/src/client.js';
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
import {
  codespacesAllowanceSnapshotSchema,
  evaluateCodespacesAllowance,
} from '../../cloud-readiness/src/codespaces-allowance.js';
import {
  evaluateGcpAlwaysFreeGuardrails,
  gcpFreeTierSnapshotSchema,
} from '../../cloud-readiness/src/gcp-free-tier.js';
import { parseGitHubCodespacesBillingUsage } from '../../cloud-readiness/src/github-billing-api.js';
import { inspectOciGuardrails, type OciGuardrailReport } from '../../cloud-readiness/src/oci-guardrails.js';
import { inspectOci } from '../../cloud-readiness/src/oci-inspect.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { createOciGuardrailSdkReader, createOciSdkReader } from '../../cloud-readiness/src/oci-sdk.js';
import {
  evaluateR2FreeTierGuardrails,
  r2FreeTierSnapshotSchema,
} from '../../cloud-readiness/src/r2-free-tier.js';
import {
  prepareIsolatedCodespaceSshConfig,
  type PreparedCodespaceSshConfig,
} from '../../host-ssh/src/codespaces-ssh.js';
import { pairingAgentKindSchema, runRemotePairingOverSsh } from '../../host-ssh/src/pairing.js';
import { discoverTailscalePeers } from '../../host-ssh/src/tailscale.js';
import { LoopbackHostTransport, SshCliTransport } from '../../host-ssh/src/transport.js';
import {
  captureAgentCheckpoint,
  restoreAgentCheckpoint,
  type CaptureAgentSpec,
  type RestoreAgentSpec,
} from '../../snapshots/src/checkpoint.js';
import { pruneLocalCheckpoints } from '../../snapshots/src/prune.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { OperationJournal } from './journal.js';
import { migrateWorkspace } from './migrate.js';
import { renderLaunchdPlist, renderSystemdUserUnits } from './service-units.js';
import { runAllowanceWatchLoop } from './watch.js';

export const ROUTER_CLI_VERSION = '0.3.0';

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

Local journal, Tailscale peers, pairing, checkpoints & handoffs:
  status                  [--journal-dir .work/router-journal]
  reconcile               --operation op_<hex> --summary "<reason>" [--journal-dir .work/router-journal]
  peers                   [--status-file <json>] [--include-offline] [--ssh-user agentrouter]
  pair                    (--ssh-target <user@host> | --codespace <name>) --agent <opencode|codex-cli|claude-code> [--ssh-port <p>] [--identity-file <path>] [--known-hosts-file <path>] [--session-name <name>]
  checkpoint              --workspace <dir> --store <dir> --key-file <0600-path> [--agent <none|opencode|codex-cli|claude-code>] [--opencode-url <url> --opencode-password-file <0600-path> --session-id <id>] [--codex-home <dir>] [--claude-config-dir <dir>]
  restore                 --checkpoint chk_<hex> --target <dir> --store <dir> --key-file <0600-path> [--agent <none|opencode|codex-cli|claude-code>] [--opencode-url <url> --opencode-password-file <0600-path>] [--codex-home <dir>] [--claude-config-dir <dir>]
  handoff                 --workspace <dir> --target-workspace <dir> (--ssh-target <user@host> | --codespace <name>) --remote-spool <posix-dir> --key-file <0600-path> [--agent <none|opencode|codex-cli|claude-code>]
  prune                   --store <dir> --keep-last <int> [--journal-dir .work/router-journal]
  migrate:simulate        [--workspace-key ws-sim]
  watch:simulate          [--workspace-key ws-watch-sim] [--max-ticks 3]
  service:emit            --platform <systemd|launchd> --work-dir <abs-dir> [--interval-sec 300] [--service-name agent-router-watch]

Cloud allowance & worker lifecycle commands:
  aws:allowance           (--demo | --report <path>) [--min-credit-usd 5] [--min-days 7]
  gcp:guard               (--demo | --report <path>)
  r2:guard                (--demo | --report <path>)
  codespaces:allowance    (--demo | --report <path>)
  codespaces:parse-billing --usage-file <path> [--cores <2|4|8|16|32>]
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
        'target-workspace': { type: 'string' },
        store: { type: 'string' },
        'key-file': { type: 'string' },
        'token-file': { type: 'string' },
        checkpoint: { type: 'string' },
        'workspace-key': { type: 'string' },
        agent: { type: 'string', default: 'none' },
        'opencode-url': { type: 'string' },
        'opencode-password-file': { type: 'string' },
        'target-opencode-url': { type: 'string' },
        'target-opencode-password-file': { type: 'string' },
        'session-id': { type: 'string' },
        'codex-home': { type: 'string' },
        'target-codex-home': { type: 'string' },
        'claude-config-dir': { type: 'string' },
        'target-claude-config-dir': { type: 'string' },
        'status-file': { type: 'string' },
        'include-offline': { type: 'boolean' },
        'ssh-user': { type: 'string' },
        'ssh-target': { type: 'string' },
        codespace: { type: 'string' },
        'ssh-port': { type: 'string' },
        'identity-file': { type: 'string' },
        'known-hosts-file': { type: 'string' },
        'remote-spool': { type: 'string' },
        'session-name': { type: 'string' },
        'keep-last': { type: 'string' },
        'usage-file': { type: 'string' },
        cores: { type: 'string', default: '2' },
        platform: { type: 'string' },
        'work-dir': { type: 'string' },
        'interval-sec': { type: 'string', default: '300' },
        'service-name': { type: 'string' },
        'max-ticks': { type: 'string', default: '3' },
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

    const resolveCaptureAgent = async (agentFlag: string): Promise<CaptureAgentSpec> => {
      if (agentFlag === 'none') return { kind: 'none' };
      if (agentFlag === 'opencode') {
        if (!values['opencode-url'] || !values['opencode-password-file'] || !values['session-id']) {
          throw new Error(
            '--agent opencode capture requires --opencode-url, --opencode-password-file, and --session-id',
          );
        }
        const password = await loadOwnerOnlyApiToken(values['opencode-password-file']);
        const client = new OpenCodeClient(values['opencode-url'], password);
        const sessionId = values['session-id'];
        return {
          kind: 'opencode',
          exportSessions: async () => [await client.exportSession(sessionId)],
        };
      }
      if (agentFlag === 'codex-cli') {
        if (!values['codex-home']) throw new Error('--agent codex-cli requires --codex-home');
        return { kind: 'codex-cli', codexHome: values['codex-home'] };
      }
      if (agentFlag === 'claude-code') {
        if (!values['claude-config-dir']) throw new Error('--agent claude-code requires --claude-config-dir');
        return { kind: 'claude-code', claudeConfigDir: values['claude-config-dir'] };
      }
      throw new Error(
        `Unsupported CLI checkpoint agent "${agentFlag}" (expected none, opencode, codex-cli, or claude-code)`,
      );
    };

    const resolveRestoreAgent = async (agentFlag: string, forHandoff = false): Promise<RestoreAgentSpec> => {
      if (agentFlag === 'none') return { kind: 'none' };
      if (agentFlag === 'opencode') {
        const url = forHandoff ? values['target-opencode-url'] : values['opencode-url'];
        const pwFile = forHandoff ? values['target-opencode-password-file'] : values['opencode-password-file'];
        if (!url || !pwFile) {
          throw new Error(
            forHandoff
              ? '--agent opencode handoff requires --target-opencode-url and --target-opencode-password-file'
              : '--agent opencode restore requires --opencode-url and --opencode-password-file',
          );
        }
        const password = await loadOwnerOnlyApiToken(pwFile);
        const client = new OpenCodeClient(url, password);
        return {
          kind: 'opencode',
          importSession: async (transfer, directory) => await client.importSession(transfer, directory),
        };
      }
      if (agentFlag === 'codex-cli') {
        const dstHome = forHandoff ? values['target-codex-home'] : values['codex-home'];
        if (!dstHome) {
          throw new Error(
            forHandoff
              ? '--agent codex-cli handoff requires --target-codex-home'
              : '--agent codex-cli restore requires --codex-home',
          );
        }
        return { kind: 'codex-cli', targetCodexHome: dstHome };
      }
      if (agentFlag === 'claude-code') {
        const dstCfg = forHandoff ? values['target-claude-config-dir'] : values['claude-config-dir'];
        if (!dstCfg) {
          throw new Error(
            forHandoff
              ? '--agent claude-code handoff requires --target-claude-config-dir'
              : '--agent claude-code restore requires --claude-config-dir',
          );
        }
        return { kind: 'claude-code', targetClaudeConfigDir: dstCfg };
      }
      throw new Error(
        `Unsupported CLI restore agent "${agentFlag}" (expected none, opencode, codex-cli, or claude-code)`,
      );
    };

    if (subcommand === 'peers') {
      const peers = await discoverTailscalePeers({
        ...(values['include-offline'] !== undefined ? { includeOffline: values['include-offline'] } : {}),
        ...(values['ssh-user'] !== undefined ? { sshUser: values['ssh-user'] } : {}),
        ...(values['status-file'] !== undefined
          ? { runStatusJson: async () => await readFile(path.resolve(values['status-file']!), 'utf8') }
          : {}),
      });
      io.stdout(JSON.stringify({ peerCount: peers.length, peers }, null, 2));
      return 0;
    }

    if (subcommand === 'pair') {
      const parsedAgent = pairingAgentKindSchema.safeParse(values.agent);
      if ((!values['ssh-target'] && !values.codespace) || !parsedAgent.success) {
        throw new Error('pair requires (--ssh-target or --codespace) and --agent <opencode|codex-cli|claude-code>');
      }
      if (values['ssh-target'] && values.codespace) {
        throw new Error('pair accepts either --ssh-target or --codespace, not both');
      }
      const pairingAgent = parsedAgent.data;
      let preparedCs: PreparedCodespaceSshConfig | undefined;
      try {
        if (values.codespace) {
          preparedCs = await prepareIsolatedCodespaceSshConfig({ codespaceName: values.codespace });
        }
        const transport = new SshCliTransport({
          target: preparedCs ? preparedCs.sshTarget : values['ssh-target']!,
          remoteSpoolDirectory: values['remote-spool'] ?? '/var/lib/agent-router/spool',
          ...(preparedCs
            ? {
                configFile: preparedCs.configFile,
                knownHostsFile: preparedCs.knownHostsFile,
                strictHostKeyChecking: preparedCs.strictHostKeyChecking,
              }
            : {
                ...(values['ssh-port'] !== undefined ? { port: Number(values['ssh-port']) } : {}),
                ...(values['identity-file'] !== undefined
                  ? { identityFile: path.resolve(values['identity-file']) }
                  : {}),
                ...(values['known-hosts-file'] !== undefined
                  ? { knownHostsFile: path.resolve(values['known-hosts-file']) }
                  : {}),
              }),
        });
        const paired = await runRemotePairingOverSsh(transport, pairingAgent, {
          ...(values['session-name'] !== undefined ? { sessionName: values['session-name'] } : {}),
        });
        io.stdout(JSON.stringify(paired, null, 2));
        return 0;
      } finally {
        if (preparedCs) await preparedCs.cleanup();
      }
    }

    if (subcommand === 'checkpoint') {
      if (!values.workspace || !values.store || !values['key-file']) {
        throw new Error('checkpoint requires --workspace, --store, and --key-file');
      }
      const key = await loadOwnerOnlyMasterKey(values['key-file']);
      const captureAgent = await resolveCaptureAgent(values.agent);
      const wsKey = values['workspace-key'] ?? path.basename(path.resolve(values.workspace));
      const op = await journal.begin({
        kind: 'CHECKPOINT',
        workspaceKey: wsKey,
        summary: `Capturing encrypted checkpoint (${captureAgent.kind}) for ${wsKey}`,
      });
      try {
        const store = new LocalEncryptedStore(values.store, key);
        const manifest = await captureAgentCheckpoint({
          workspace: values.workspace,
          store,
          agent: captureAgent,
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
      const restoreAgent = await resolveRestoreAgent(values.agent, false);
      const wsKey = values['workspace-key'] ?? path.basename(path.resolve(values.target));
      const op = await journal.begin({
        kind: 'RESTORE',
        workspaceKey: wsKey,
        summary: `Restoring encrypted checkpoint ${values.checkpoint}`,
      });
      try {
        const store = new LocalEncryptedStore(values.store, key);
        const manifest = await restoreAgentCheckpoint({
          checkpointId: values.checkpoint,
          targetWorkspace: values.target,
          store,
          agent: restoreAgent,
        });
        await journal.complete(op.operationId, `Restored checkpoint ${manifest.checkpointId}`);
        io.stdout(JSON.stringify({ operationId: op.operationId, ...manifest }, null, 2));
        return 0;
      } catch (err) {
        await journal.abortUnfenced(op.operationId).catch(() => undefined);
        throw err;
      }
    }

    if (subcommand === 'handoff') {
      if (
        !values.workspace ||
        !values['target-workspace'] ||
        (!values['ssh-target'] && !values.codespace) ||
        !values['remote-spool'] ||
        !values['key-file']
      ) {
        throw new Error(
          'handoff requires --workspace, --target-workspace, (--ssh-target or --codespace), --remote-spool, and --key-file',
        );
      }
      if (values['ssh-target'] && values.codespace) {
        throw new Error('handoff accepts either --ssh-target or --codespace, not both');
      }
      const key = await loadOwnerOnlyMasterKey(values['key-file']);
      const captureAgent = await resolveCaptureAgent(values.agent);
      const restoreAgent = await resolveRestoreAgent(values.agent, true);
      const resolvedTargetWs = path.resolve(values['target-workspace']);
      try {
        await access(resolvedTargetWs);
        throw new Error(`Target workspace already exists: ${resolvedTargetWs}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const wsKey = values['workspace-key'] ?? path.basename(path.resolve(values.workspace));
      let preparedCs: PreparedCodespaceSshConfig | undefined;
      try {
        if (values.codespace) {
          preparedCs = await prepareIsolatedCodespaceSshConfig({ codespaceName: values.codespace });
        }

        const transport = new SshCliTransport({
          target: preparedCs ? preparedCs.sshTarget : values['ssh-target']!,
          remoteSpoolDirectory: values['remote-spool'],
          ...(preparedCs
            ? {
                configFile: preparedCs.configFile,
                knownHostsFile: preparedCs.knownHostsFile,
                strictHostKeyChecking: preparedCs.strictHostKeyChecking,
              }
            : {
                ...(values['ssh-port'] !== undefined ? { port: Number(values['ssh-port']) } : {}),
                ...(values['identity-file'] !== undefined
                  ? { identityFile: path.resolve(values['identity-file']) }
                  : {}),
                ...(values['known-hosts-file'] !== undefined
                  ? { knownHostsFile: path.resolve(values['known-hosts-file']) }
                  : {}),
              }),
        });

        const op = await journal.begin({
          kind: 'HANDOFF',
          workspaceKey: wsKey,
          summary: `Handoff (${captureAgent.kind}) for ${wsKey}`,
        });
        const scratch = await mkdtemp(path.join(tmpdir(), 'router-cli-handoff-'));
        let transferredToRemote = false;
        let capturedId: string | undefined;
        try {
          const stageStoreDir = path.join(scratch, 'stage-store');
          const recvStoreDir = path.join(scratch, 'recv-store');
          await mkdir(stageStoreDir, { recursive: true, mode: 0o700 });
          await mkdir(recvStoreDir, { recursive: true, mode: 0o700 });

          const stageStore = new LocalEncryptedStore(stageStoreDir, key);
          const manifest = await captureAgentCheckpoint({
            workspace: values.workspace,
            store: stageStore,
            agent: captureAgent,
          });
          capturedId = manifest.checkpointId;

          const ciphertext = await readFile(path.join(stageStoreDir, `${manifest.checkpointId}.enc`));
          await transport.transferEncryptedCheckpoint(manifest.checkpointId, ciphertext);
          transferredToRemote = true;

          const downloaded = await transport.readTransferredCheckpoint(manifest.checkpointId);
          await writeFile(path.join(recvStoreDir, `${manifest.checkpointId}.enc`), downloaded, {
            mode: 0o600,
            flag: 'wx',
          });

          const recvStore = new LocalEncryptedStore(recvStoreDir, key);
          await restoreAgentCheckpoint({
            checkpointId: manifest.checkpointId,
            targetWorkspace: resolvedTargetWs,
            store: recvStore,
            agent: restoreAgent,
          });

          const completed = await journal.complete(op.operationId, `Completed handoff ${manifest.checkpointId}`);
          io.stdout(JSON.stringify({ operation: completed, manifest }, null, 2));
          return 0;
        } catch (err) {
          if (transferredToRemote) {
            await journal
              .markNeedsReconcile(
                op.operationId,
                `CLI handoff failed after remote spool transfer${capturedId ? ` (${capturedId})` : ''}; reconcile before retry`,
              )
              .catch(() => undefined);
          } else {
            await journal.abortUnfenced(op.operationId).catch(() => undefined);
          }
          throw err;
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      } finally {
        if (preparedCs) await preparedCs.cleanup();
      }
    }

    if (subcommand === 'prune') {
      if (!values.store || !values['keep-last']) {
        throw new Error('prune requires --store and --keep-last <int>');
      }
      const protectedCheckpointIds = await journal.collectProtectedCheckpointIds();
      const result = await pruneLocalCheckpoints({
        storeDirectory: values.store,
        keepLast: Number(values['keep-last']),
        protectedCheckpointIds,
      });
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    if (subcommand === 'service:emit') {
      if (!values.platform || !values['work-dir']) {
        throw new Error('service:emit requires --platform <systemd|launchd> and --work-dir <abs-dir>');
      }
      const spec = {
        ...(values['service-name'] !== undefined ? { serviceName: values['service-name'] } : {}),
        cliEntrypoint: path.resolve('bin/agent-router.mjs'),
        workingDirectory: values['work-dir'],
        routerArgs: ['watch:simulate', '--workspace-key', values['workspace-key'] ?? 'ws-daemon'],
        intervalSec: Number(values['interval-sec']),
      };
      if (values.platform === 'systemd') {
        io.stdout(JSON.stringify(renderSystemdUserUnits(spec), null, 2));
        return 0;
      }
      if (values.platform === 'launchd') {
        io.stdout(JSON.stringify(renderLaunchdPlist(spec), null, 2));
        return 0;
      }
      throw new Error('service:emit --platform must be "systemd" or "launchd"');
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

    if (subcommand === 'gcp:guard') {
      const now = new Date();
      const snapshot = values.demo
        ? gcpFreeTierSnapshotSchema.parse({
            observedAt: now.toISOString(),
            region: 'us-west1',
            machineType: 'e2-micro',
            provisioningModel: 'STANDARD',
            bootDiskType: 'pd-standard',
            totalStandardDiskGb: 30,
            gpuCount: 0,
            monthlyNorthAmericaEgressGb: 0.2,
            allowPremiumOrChinaAustraliaEgress: false,
            hasBudgetAlertUpTo5Usd: true,
          })
        : values.report
          ? gcpFreeTierSnapshotSchema.parse(JSON.parse(await readFile(path.resolve(values.report), 'utf8')))
          : null;

      if (!snapshot) throw new Error('gcp:guard requires --demo or --report <path>');
      const evaluation = evaluateGcpAlwaysFreeGuardrails(snapshot, { now });
      io.stdout(JSON.stringify(evaluation, null, 2));
      return evaluation.status === 'GUARDED_FREE_ELIGIBLE' ? 0 : 2;
    }

    if (subcommand === 'r2:guard') {
      const now = new Date();
      const snapshot = values.demo
        ? r2FreeTierSnapshotSchema.parse({
            observedAt: now.toISOString(),
            storageClass: 'STANDARD',
            storedGbMonth: 2.5,
            monthlyClassAOps: 12_000,
            monthlyClassBOps: 85_000,
            publicDevelopmentUrlEnabled: false,
          })
        : values.report
          ? r2FreeTierSnapshotSchema.parse(JSON.parse(await readFile(path.resolve(values.report), 'utf8')))
          : null;

      if (!snapshot) throw new Error('r2:guard requires --demo or --report <path>');
      const evaluation = evaluateR2FreeTierGuardrails(snapshot, { now });
      io.stdout(JSON.stringify(evaluation, null, 2));
      return evaluation.status === 'GUARDED_FREE_ELIGIBLE' ? 0 : 2;
    }

    if (subcommand === 'codespaces:allowance') {
      const now = new Date();
      const snapshot = values.demo
        ? codespacesAllowanceSnapshotSchema.parse({
            observedAt: now.toISOString(),
            usedCoreHours: 36,
            usedStorageGbMonth: 4.5,
            activeMachineCores: 2,
          })
        : values.report
          ? codespacesAllowanceSnapshotSchema.parse(
              JSON.parse(await readFile(path.resolve(values.report), 'utf8')),
            )
          : null;

      if (!snapshot) throw new Error('codespaces:allowance requires --demo or --report <path>');
      const evaluation = evaluateCodespacesAllowance(snapshot, { now });
      io.stdout(JSON.stringify(evaluation, null, 2));
      return evaluation.decision === 'HEALTHY' ? 0 : 2;
    }

    if (subcommand === 'codespaces:parse-billing') {
      if (!values['usage-file']) {
        throw new Error('codespaces:parse-billing requires --usage-file <path>');
      }
      const rawCores = Number(values.cores);
      if (rawCores !== 2 && rawCores !== 4 && rawCores !== 8 && rawCores !== 16 && rawCores !== 32) {
        throw new Error('codespaces:parse-billing --cores must be 2, 4, 8, 16, or 32');
      }
      const now = new Date();
      const payload = JSON.parse(await readFile(path.resolve(values['usage-file']), 'utf8')) as unknown;
      const snapshot = parseGitHubCodespacesBillingUsage(payload, {
        observedAt: now.toISOString(),
        activeMachineCores: rawCores,
      });
      const evaluation = evaluateCodespacesAllowance(snapshot, { now });
      io.stdout(JSON.stringify({ snapshot, evaluation }, null, 2));
      return evaluation.decision === 'HEALTHY' ? 0 : 2;
    }

    if (subcommand === 'watch:simulate') {
      const workspaceKey = values['workspace-key'] ?? 'ws-watch-sim';
      const maxTicks = Number(values['max-ticks']);
      const scratch = await mkdtemp(path.join(tmpdir(), 'router-watch-sim-'));
      try {
        const srcWs = path.join(scratch, 'src-ws');
        await mkdir(srcWs, { recursive: true, mode: 0o700 });
        await writeFile(path.join(srcWs, 'state.txt'), 'watch-portable-state\n', { mode: 0o600 });
        const simJournal = new OperationJournal(path.join(scratch, 'journal'));
        const key = randomBytes(32);
        const now = new Date();
        const observedAt = new Date(now.getTime() - 10_000).toISOString();

        const watchResult = await runAllowanceWatchLoop({
          workspaceKey,
          journal: simJournal,
          maxTicks,
          pollAllowance: async tick => ({
            kind: 'GITHUB_BILLING_USAGE',
            observedAt,
            activeMachineCores: 4,
            now,
            payload: {
              usageItems: [
                {
                  product: 'codespaces',
                  sku: 'codespaces_compute_d4',
                  unitType: 'hours',
                  grossQuantity: tick === 1 ? 10 : 28.5,
                },
              ],
            },
          }),
          executeMigration: async trigger =>
            await migrateWorkspace({
              workspaceKey,
              journal: simJournal,
              encryptionKey: key,
              trigger,
              source: {
                workspacePath: srcWs,
                stagingDir: path.join(scratch, 'stage'),
                exportSessions: async () => [{ info: { id: 'ses_watch_sim' }, messages: [] }],
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
                  prepareCompute: async () => ({ status: 'READY', targetFingerprint: 'hcloud_watch01234567' }),
                  activateAndImportSession: async t => t.info.id,
                },
              ],
            }),
        });

        io.stdout(
          JSON.stringify(
            watchResult.outcome === 'EVACUATED'
              ? {
                  outcome: watchResult.outcome,
                  workspaceKey,
                  ticksRun: watchResult.ticksRun,
                  triggerReasons: watchResult.triggerReasons,
                  selectedTarget: watchResult.migration.selectedTarget,
                  skippedTargets: watchResult.migration.skippedTargets,
                  sourceTornDown: watchResult.migration.sourceTornDown,
                }
              : watchResult,
            null,
            2,
          ),
        );
        return watchResult.outcome === 'EVACUATED' || watchResult.outcome === 'HEALTHY_MAX_TICKS_REACHED' ? 0 : 2;
      } finally {
        await rm(scratch, { recursive: true, force: true });
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

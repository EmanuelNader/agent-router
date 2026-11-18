import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import {
  encodeClaudeProjectSlug,
  exportClaudeProjectBundle,
  importClaudeProjectBundle,
  isClaudeCodeAvailable,
  verifyClaudeProjectRecognition,
} from '../packages/agent-claude-code/src/adapter.js';
import {
  exportCodexRolloutBundle,
  importCodexRolloutBundle,
  isCodexCliAvailable,
  startIsolatedCodexAppServer,
} from '../packages/agent-codex/src/adapter.js';
import { OperationJournal } from '../packages/cli/src/journal.js';
import { migrateWorkspace } from '../packages/cli/src/migrate.js';
import {
  HetznerWorkerProvisioner,
  InMemoryHetznerCloudGateway,
} from '../packages/cloud-hetzner/src/provider.js';
import {
  InMemoryOciComputeGateway,
  OciWorkerProvisioner,
} from '../packages/cloud-oci/src/provider.js';
import { evaluateOciPaygGuardrails, guardrailReportSchema } from '../packages/cloud-readiness/src/oci-guardrails.js';
import { inspectionSchema } from '../packages/cloud-readiness/src/oci-report.js';
import { startEphemeralSshd } from '../packages/host-ssh/src/ephemeral-sshd.js';
import { SshCliTransport } from '../packages/host-ssh/src/transport.js';
import { captureCheckpoint, restoreCheckpoint } from '../packages/snapshots/src/checkpoint.js';
import { buildResticRemoteConfig, isResticAvailable, ResticRepositoryStore } from '../packages/snapshots/src/restic.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/e2e-full-'));

const git = (directory: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: run,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });

type RunningServer = Awaited<ReturnType<typeof startIsolatedServer>>;
let activeServer: RunningServer | undefined;
let activeCount = 0;
let maxConcurrentServers = 0;

async function spawnTrackedServer(workspace: string, stateDir: string): Promise<RunningServer> {
  const instance = await startIsolatedServer(workspace, stateDir);
  activeCount += 1;
  maxConcurrentServers = Math.max(maxConcurrentServers, activeCount);
  activeServer = instance;
  return instance;
}

async function fenceTrackedServer(): Promise<void> {
  if (!activeServer) return;
  const current = activeServer;
  activeServer = undefined;
  await current.stop();
  activeCount -= 1;
}

const sshd = await startEphemeralSshd(join(run, 'sshd'));

try {
  const now = new Date();
  const observedAt = new Date(now.getTime() - 15_000).toISOString();

  // Phase 1: PAYG Guardrail & OCI Crash-Reconciliation Gate
  const inspection = inspectionSchema.parse(
    JSON.parse(await readFile(new URL('../fixtures/oci/readiness-demo.json', import.meta.url), 'utf8')),
  );
  const guardrails = guardrailReportSchema.parse(
    JSON.parse(await readFile(new URL('../fixtures/oci/guardrails-payg-demo.json', import.meta.url), 'utf8')),
  );
  inspection.source = 'OCI_API';
  inspection.observedAt = observedAt;
  guardrails.source = 'OCI_API';
  guardrails.observedAt = observedAt;

  const guardrailEval = evaluateOciPaygGuardrails(
    inspection,
    guardrails,
    { ocpus: 1, memoryGb: 4, bootGb: 50, additionalInstances: 1 },
    now,
  );
  assert.equal(guardrailEval.status, 'GUARDED_QUOTA_FITS');

  const clientPublicKey = (await readFile(sshd.clientPublicKeyPath, 'utf8')).trim();

  // Phase 2: Start active OpenCode 2.2.7 session + dirty Git workspace on an expiring AWS Free Plan worker
  const awsSourceWorkspace = join(run, 'aws-source-ws');
  await cp(resolve('fixtures/workspace'), awsSourceWorkspace, { recursive: true });
  git(awsSourceWorkspace, ['init', '--quiet']);
  git(awsSourceWorkspace, ['add', '.']);
  git(awsSourceWorkspace, [
    '-c', 'user.name=E2E',
    '-c', 'user.email=e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Initial fixture',
  ]);
  await writeFile(join(awsSourceWorkspace, 'src/message.txt'), 'uncommitted aws worker progress\n');
  await writeFile(join(awsSourceWorkspace, '.env.example'), 'SAFE_PLACEHOLDER=1\n');
  await rename(join(awsSourceWorkspace, 'README.md'), join(awsSourceWorkspace, 'ARCHITECTURE.md'));

  const awsServer = await spawnTrackedServer(awsSourceWorkspace, join(run, 'state-aws'));
  const sessionId = await awsServer.client.createSession(awsSourceWorkspace, 'End-to-end multi-cloud migration');
  await awsServer.client.runShellCommand(sessionId, "printf 'e2e-turn-1-aws-source\\n'");

  // Phase 3: AWS Free Plan hits low-credit threshold ($3.20 <= $5.00 floor).
  // Primary candidate (OCI A1) returns OUT_OF_CAPACITY -> automatically falls back to Hetzner CAX11 ARM64
  // over REAL OpenSSH (/usr/sbin/sshd + /usr/bin/ssh + /usr/bin/scp)!
  const migrationJournal = new OperationJournal(join(run, 'migration-journal'));
  const ociJournal = new OperationJournal(join(run, 'oci-journal'));
  const hetznerJournal = new OperationJournal(join(run, 'hetzner-journal'));

  const ociCapacityFullGateway = new InMemoryOciComputeGateway({
    ingressRuleCount: 0,
    faultMode: 'OUT_OF_CAPACITY',
  });
  const ociProvisioner = new OciWorkerProvisioner({ journal: ociJournal, gateway: ociCapacityFullGateway });

  const hetznerGateway = new InMemoryHetznerCloudGateway({ firewallIngressRules: 0 });
  const hetznerProvisioner = new HetznerWorkerProvisioner({ journal: hetznerJournal, gateway: hetznerGateway });

  const realSshTransport = new SshCliTransport({
    target: `${sshd.username}@127.0.0.1`,
    port: sshd.port,
    remoteSpoolDirectory: join(run, 'sshd-remote-spool'),
    identityFile: sshd.clientPrivateKeyPath,
    knownHostsFile: sshd.knownHostsPath,
  });

  const hetznerWorkspace = join(run, 'hetzner-cax11-ws');
  let hetznerServer: RunningServer | undefined;
  let awsSourceCleanedUp = false;

  const migrationResult = await migrateWorkspace({
    workspaceKey: 'ws-e2e',
    journal: migrationJournal,
    encryptionKey: randomBytes(32),
    trigger: {
      kind: 'AWS_FREE_PLAN',
      snapshot: {
        observedAt,
        accountPlanType: 'FREE',
        accountPlanStatus: 'ACTIVE',
        remainingCreditAmount: 3.2,
        creditCurrency: 'USD',
        expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      },
      minCreditFloorUsd: 5,
      now,
    },
    source: {
      workspacePath: awsSourceWorkspace,
      stagingDir: join(run, 'stage-aws'),
      exportSessions: async () => [await awsServer.client.exportSession(sessionId)],
      fenceAgent: fenceTrackedServer,
      teardownCompute: async () => {
        awsSourceCleanedUp = true;
      },
    },
    candidates: [
      {
        name: 'oci-a1-primary',
        targetWorkspace: join(run, 'unused-oci-ws'),
        transport: realSshTransport,
        prepareCompute: async () => {
          const res = await ociProvisioner.provision({
            workspaceKey: 'ws-e2e',
            inspection,
            guardrails,
            request: { ocpus: 1, memoryGb: 4, bootGb: 50, additionalInstances: 1 },
            subnetRef: 'subnet-zero-ingress',
            imageRef: 'image-ubuntu-2404-arm64',
            sshAuthorizedKey: clientPublicKey,
            now,
          });
          return res.status === 'OUT_OF_CAPACITY'
            ? { status: 'OUT_OF_CAPACITY' }
            : { status: 'READY', targetFingerprint: res.instanceFingerprint };
        },
        activateAndImportSession: async t => t.info.id,
      },
      {
        name: 'hetzner-cax11-fallback',
        targetWorkspace: hetznerWorkspace,
        transport: realSshTransport,
        prepareCompute: async () => {
          const res = await hetznerProvisioner.provision({
            workspaceKey: 'ws-e2e',
            location: 'nbg1',
            firewallId: 9001,
            sshAuthorizedKey: clientPublicKey,
          });
          return { status: 'READY', targetFingerprint: res.serverFingerprint };
        },
        activateAndImportSession: async (transfer, directory) => {
          assert.equal(activeCount, 0, 'AWS source agent must be fenced before Hetzner agent starts');
          hetznerServer = await spawnTrackedServer(directory, join(run, 'state-hetzner'));
          return await hetznerServer.client.importSession(transfer, directory);
        },
      },
    ],
  });

  assert.equal(migrationResult.status, 'MIGRATED');
  assert.equal(migrationResult.selectedTarget, 'hetzner-cax11-fallback');
  assert.deepEqual(migrationResult.skippedTargets, [{ name: 'oci-a1-primary', reason: 'OUT_OF_CAPACITY' }]);
  assert.equal(awsSourceCleanedUp, true);
  assert.ok(hetznerServer);

  // Phase 4: Continue work on Hetzner CAX11, then archive via REAL restic SFTP (if installed) and restore to Laptop
  await hetznerServer.client.runShellCommand(sessionId, "printf 'e2e-turn-2-hetzner-cax11\\n'");
  await writeFile(join(hetznerWorkspace, 'hetzner-artifact.txt'), 'built on arm64 fallback\n');
  const expectedFinalHashes = await hashWorkspace(hetznerWorkspace);

  const laptopFinalWorkspace = join(run, 'laptop-final-ws');
  let storageBackendUsed = 'AES_256_GCM_OVER_LIVE_SCP';

  if (isResticAvailable()) {
    storageBackendUsed = 'RESTIC_OVER_LIVE_SFTP';
    const sftpConfig = buildResticRemoteConfig({
      kind: 'sftp',
      target: `${sshd.username}@127.0.0.1`,
      port: sshd.port,
      path: join(run, 'sshd-restic-repo'),
      identityFile: sshd.clientPrivateKeyPath,
      knownHostsFile: sshd.knownHostsPath,
    });
    const resticStore = ResticRepositoryStore.fromRemoteConfig(
      sftpConfig,
      randomBytes(32).toString('hex'),
    );

    const manifest = await captureCheckpoint({
      workspace: hetznerWorkspace,
      store: resticStore,
      exportSessions: async () => [await hetznerServer!.client.exportSession(sessionId)],
      quiesceSource: async () => {
        await fenceTrackedServer();
        await hetznerProvisioner.fence('ws-e2e');
      },
    });

    await resticStore.verifyIntegrity();

    const laptopServer = await spawnTrackedServer(run, join(run, 'state-laptop-bootstrap'));
    await laptopServer.stop();
    activeCount -= 1;
    activeServer = undefined;

    let restoredLaptopServer: RunningServer | undefined;
    await restoreCheckpoint({
      checkpointId: manifest.checkpointId,
      targetWorkspace: laptopFinalWorkspace,
      store: resticStore,
      importSession: async (transfer, directory) => {
        assert.equal(activeCount, 0, 'Hetzner worker must be fenced before Laptop starts');
        restoredLaptopServer = await spawnTrackedServer(directory, join(run, 'state-laptop-final'));
        return await restoredLaptopServer.client.importSession(transfer, directory);
      },
    });

    assert.ok(restoredLaptopServer);
    const finalExport = await restoredLaptopServer.client.exportSession(sessionId);
    requireCompletedShellOutput(finalExport.messages, 'e2e-turn-1-aws-source\n');
    requireCompletedShellOutput(finalExport.messages, 'e2e-turn-2-hetzner-cax11\n');
  } else {
    throw new Error('Expected restic to be available for full E2E proof');
  }

  assert.deepEqual(await hashWorkspace(laptopFinalWorkspace), expectedFinalHashes);
  assert.equal(maxConcurrentServers, 1);

  // Phase 5: Tear down Hetzner CAX11 fallback worker and verify zero cloud remnants
  const hetznerTeardown = await hetznerProvisioner.teardown('ws-e2e');
  assert.deepEqual(hetznerTeardown.remnants, { servers: 0, volumes: 0, primaryIps: 0 });

  // Phase 6: Verify additional coding-agent CLI adapters (Codex CLI & Claude Code) when installed locally
  const verifiedAgentAdapters = ['opencode@2.2.7'];
  const realRunRoot = await realpath(run);

  if (isCodexCliAvailable()) {
    const codexSrc = join(realRunRoot, 'codex-ws-src');
    const codexDst = join(realRunRoot, 'codex-ws-dst');
    await mkdir(codexSrc, { recursive: true, mode: 0o700 });
    await mkdir(codexDst, { recursive: true, mode: 0o700 });

    const codexSrvA = await startIsolatedCodexAppServer({
      isolatedHome: join(realRunRoot, 'codex-home-user-a'),
      codexHome: join(realRunRoot, 'codex-state-a'),
    });
    let codexThreadId: string;
    try {
      codexThreadId = await codexSrvA.startThread(codexSrc);
      await codexSrvA.runShellCommand(codexThreadId, "printf 'e2e-codex-ok\\n'");
    } finally {
      await codexSrvA.stop();
    }

    const codexBundle = await exportCodexRolloutBundle(join(realRunRoot, 'codex-state-a'), codexSrc);
    await importCodexRolloutBundle(codexBundle, join(realRunRoot, 'codex-state-b'), codexDst);

    const codexSrvB = await startIsolatedCodexAppServer({
      isolatedHome: join(realRunRoot, 'codex-home-user-b'),
      codexHome: join(realRunRoot, 'codex-state-b'),
    });
    try {
      const resumed = await codexSrvB.resumeThread(codexThreadId, codexDst);
      assert.equal(resumed.cwd, codexDst);
      const readThread = await codexSrvB.readThread(codexThreadId);
      assert.ok(JSON.stringify(readThread.turns).includes('e2e-codex-ok'));
    } finally {
      await codexSrvB.stop();
    }
    verifiedAgentAdapters.push('codex-cli');
  }

  if (isClaudeCodeAvailable()) {
    const claudeSrc = join(realRunRoot, 'claude.ws_src');
    const claudeDst = join(realRunRoot, 'claude.ws_dst');
    await mkdir(claudeSrc, { recursive: true, mode: 0o700 });
    await mkdir(claudeDst, { recursive: true, mode: 0o700 });

    const claudeCfgA = join(realRunRoot, 'claude-cfg-a');
    const claudeCfgB = join(realRunRoot, 'claude-cfg-b');
    const slugDirA = join(claudeCfgA, 'projects', encodeClaudeProjectSlug(claudeSrc));
    await mkdir(slugDirA, { recursive: true, mode: 0o700 });
    const claudeSessionId = '12345678-1234-4234-8234-123456789abc';
    await writeFile(
      join(slugDirA, `${claudeSessionId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: claudeSessionId, cwd: claudeSrc, message: { role: 'user', content: 'e2e' } })}\n`,
      { mode: 0o600 },
    );

    const claudeBundle = await exportClaudeProjectBundle(claudeCfgA, claudeSrc);
    await importClaudeProjectBundle(claudeBundle, claudeCfgB, claudeDst);
    const recognition = await verifyClaudeProjectRecognition({
      isolatedHome: join(realRunRoot, 'claude-home-b'),
      claudeConfigDir: claudeCfgB,
      workspace: claudeDst,
    });
    assert.equal(recognition.recognized, true);
    verifiedAgentAdapters.push('claude-code');
  }

  console.log(
    JSON.stringify(
      {
        status: 'E2E_VERIFIED',
        verifiedAgentAdapters,
        daemonsExercised: ['opencode@2.2.7', 'git', 'openssh-sshd', 'ssh', 'scp', 'restic-sftp'],
        allowanceTrigger: migrationResult.triggerReasons,
        skippedCapacityTargets: migrationResult.skippedTargets,
        selectedFallbackTarget: migrationResult.selectedTarget,
        returnTransport: storageBackendUsed,
        maxConcurrentAgents: maxConcurrentServers,
        multiHopSessionAndDirtyGit: 'PRESERVED',
        finalCloudRemnants: hetznerTeardown.remnants,
      },
      null,
      2,
    ),
  );
} finally {
  await fenceTrackedServer();
  await sshd.close();
  await rm(run, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { verifyOpenCodeAcp } from '../packages/agent-acp/src/opencode-proof.js';
import { verifyMcpLoaders } from './lib/mcp-proof.js';
import { translateMcpConfig } from '../packages/workspace/src/mcp-portability.js';
import { verifyLinuxCheckpoint } from './lib/linux-checkpoint-proof.js';
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
import { runAllowanceWatchLoop } from '../packages/cli/src/watch.js';
import {
  HetznerWorkerProvisioner,
  InMemoryHetznerCloudGateway,
} from '../packages/cloud-hetzner/src/provider.js';
import {
  InMemoryOciComputeGateway,
  OciWorkerProvisioner,
} from '../packages/cloud-oci/src/provider.js';
import { buildWorkerBootstrapScript } from '../packages/cloud-oci/src/cloud-init.js';
import { isDockerImageAvailable, runLinuxWorkerContainerCheck } from '../packages/cloud-oci/src/linux-guest.js';
import { evaluateOciPaygGuardrails, guardrailReportSchema } from '../packages/cloud-readiness/src/oci-guardrails.js';
import { inspectionSchema } from '../packages/cloud-readiness/src/oci-report.js';
import { evaluateR2FreeTierGuardrails } from '../packages/cloud-readiness/src/r2-free-tier.js';
import { prepareIsolatedCodespaceSshConfig } from '../packages/host-ssh/src/codespaces-ssh.js';
import { startEphemeralSshd } from '../packages/host-ssh/src/ephemeral-sshd.js';
import { SshCliTransport } from '../packages/host-ssh/src/transport.js';
import { captureCheckpoint, restoreCheckpoint } from '../packages/snapshots/src/checkpoint.js';
import { pruneLocalCheckpoints } from '../packages/snapshots/src/prune.js';
import { buildResticRemoteConfig, isResticAvailable, ResticRepositoryStore } from '../packages/snapshots/src/restic.js';
import { LocalEncryptedStore } from '../packages/snapshots/src/store.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';

process.umask(0o077);
const acpReceipt = await verifyOpenCodeAcp();
const mcpLoaderReceipt = await verifyMcpLoaders();
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

  const r2Guard = evaluateR2FreeTierGuardrails(
    {
      observedAt,
      storageClass: 'STANDARD',
      storedGbMonth: 2.4,
      monthlyClassAOps: 15_000,
      monthlyClassBOps: 90_000,
      publicDevelopmentUrlEnabled: false,
    },
    { now },
  );
  assert.equal(r2Guard.status, 'GUARDED_FREE_ELIGIBLE');

  const codespaceSsh = await prepareIsolatedCodespaceSshConfig({
    codespaceName: 'e2e-codespace-01',
    homeDir: join(run, 'isolated-cs-home'),
    parentTempDir: run,
    runGhConfig: async () =>
      [
        'Host cs.e2e-codespace-01.main',
        '  User codespace',
        '  ProxyCommand /usr/local/bin/gh cs ssh -c e2e-codespace-01 --stdio -- -i ~/.ssh/codespaces.auto',
        '  StrictHostKeyChecking no',
        '  IdentityFile ~/.ssh/codespaces.auto',
      ].join('\n'),
  });
  await codespaceSsh.cleanup();

  const clientPublicKey = (await readFile(sshd.clientPublicKeyPath, 'utf8')).trim();

  // Phase 2: Start active OpenCode 2.3.2 session + dirty Git workspace on an expiring AWS Free Plan worker
  const awsSourceWorkspace = join(run, 'aws-source-ws');
  const awsRepository = join(run, 'aws-repository');
  await cp(resolve('fixtures/workspace'), awsRepository, { recursive: true });
  git(awsRepository, ['init', '--quiet']);
  git(awsRepository, ['add', '.']);
  git(awsRepository, [
    '-c', 'user.name=E2E',
    '-c', 'user.email=e2e@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Initial fixture',
  ]);
  git(awsRepository, ['worktree', 'add', '--quiet', '--detach', awsSourceWorkspace]);
  assert.ok((await readFile(join(awsSourceWorkspace, '.git'), 'utf8')).startsWith('gitdir: '));
  await writeFile(join(awsSourceWorkspace, 'src/message.txt'), 'staged aws worker progress\n');
  git(awsSourceWorkspace, ['add', 'src/message.txt']);
  await writeFile(join(awsSourceWorkspace, 'src/message.txt'), 'uncommitted aws worker progress\n');
  await writeFile(join(awsSourceWorkspace, '.env.example'), 'SAFE_PLACEHOLDER=1\n');
  await rename(join(awsSourceWorkspace, 'README.md'), join(awsSourceWorkspace, 'ARCHITECTURE.md'));
  await writeFile(join(awsSourceWorkspace, '.mcp.json'), translateMcpConfig([{
    name: 'e2e_fixture', transport: 'stdio', command: ['node', '--version'],
    env: {}, headers: {}, enabled: true,
  }], 'claude-code'));
  const doctor = JSON.parse(execFileSync(process.execPath, [
    '--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('scripts/router.ts'),
    'mcp:doctor', '--workspace', awsSourceWorkspace,
  ], { env: { PATH: process.env.PATH, HOME: run }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }));
  assert.equal(doctor.status, 'MCP_PORTABLE');
  assert.equal(doctor.serversChecked, 1);

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

  const watchResult = await runAllowanceWatchLoop({
    workspaceKey: 'ws-e2e',
    journal: migrationJournal,
    maxTicks: 4,
    pollAllowance: async tick => ({
      kind: 'AWS_FREE_PLAN',
      snapshot: {
        observedAt,
        accountPlanType: 'FREE',
        accountPlanStatus: 'ACTIVE',
        remainingCreditAmount: tick === 1 ? 42.0 : 3.2,
        creditCurrency: 'USD',
        expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
      },
      minCreditFloorUsd: 5,
      now,
    }),
    executeMigration: async trigger =>
      await migrateWorkspace({
        workspaceKey: 'ws-e2e',
        journal: migrationJournal,
        encryptionKey: randomBytes(32),
        trigger,
        source: {
          workspacePath: awsSourceWorkspace,
          stagingDir: join(run, 'stage-aws'),
          exportSessions: async () => [await awsServer.client.exportSessionForCheckpoint(sessionId)],
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
      }),
  });

  assert.equal(watchResult.outcome, 'EVACUATED');
  assert.equal(watchResult.ticksRun, 2);
  const migrationResult = watchResult.migration;

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
      exportSessions: async () => [await hetznerServer!.client.exportSessionForCheckpoint(sessionId)],
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
  await fenceTrackedServer();
  assert.equal(activeCount, 0);

  // Phase 5: Tear down Hetzner CAX11 fallback worker and verify zero cloud remnants
  const hetznerTeardown = await hetznerProvisioner.teardown('ws-e2e');
  assert.deepEqual(hetznerTeardown.remnants, { servers: 0, volumes: 0, primaryIps: 0 });

  // Phase 6: Verify additional coding-agent CLI adapters (Codex CLI & Claude Code) when installed locally
  const verifiedAgentAdapters = ['opencode@2.3.2'];
  const realRunRoot = await realpath(run);

  assert.ok(isCodexCliAvailable(), 'Codex CLI is mandatory for master E2E');
  if (isCodexCliAvailable()) {
    const codexSrc = join(realRunRoot, 'codex-ws-src');
    const codexDst = join(realRunRoot, 'codex-ws-dst');
    await mkdir(codexSrc, { recursive: true, mode: 0o700 });
    await mkdir(codexDst, { recursive: true, mode: 0o700 });

    assert.equal(activeCount, 0);
    const codexSrvA = await startIsolatedCodexAppServer({
      isolatedHome: join(realRunRoot, 'codex-home-user-a'),
      codexHome: join(realRunRoot, 'codex-state-a'),
    });
    activeCount++;
    maxConcurrentServers = Math.max(maxConcurrentServers, activeCount);
    let codexThreadId: string;
    try {
      codexThreadId = await codexSrvA.startThread(codexSrc);
      await codexSrvA.runShellCommand(codexThreadId, "printf 'e2e-codex-ok\\n'");
    } finally {
      await codexSrvA.stop();
      activeCount--;
    }

    const codexBundle = await exportCodexRolloutBundle(join(realRunRoot, 'codex-state-a'), codexSrc);
    await importCodexRolloutBundle(codexBundle, join(realRunRoot, 'codex-state-b'), codexDst);

    assert.equal(activeCount, 0);
    const codexSrvB = await startIsolatedCodexAppServer({
      isolatedHome: join(realRunRoot, 'codex-home-user-b'),
      codexHome: join(realRunRoot, 'codex-state-b'),
    });
    activeCount++;
    maxConcurrentServers = Math.max(maxConcurrentServers, activeCount);
    try {
      const resumed = await codexSrvB.resumeThread(codexThreadId, codexDst);
      assert.equal(resumed.cwd, codexDst);
      const readThread = await codexSrvB.readThread(codexThreadId);
      assert.ok(JSON.stringify(readThread.turns).includes('e2e-codex-ok'));
    } finally {
      await codexSrvB.stop();
      activeCount--;
    }
    verifiedAgentAdapters.push('codex-cli');
  }

  assert.ok(isClaudeCodeAvailable(), 'Claude Code is mandatory for master E2E');
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
    assert.equal(activeCount, 0);
    activeCount++;
    maxConcurrentServers = Math.max(maxConcurrentServers, activeCount);
    const recognition = await verifyClaudeProjectRecognition({
      isolatedHome: join(realRunRoot, 'claude-home-b'),
      claudeConfigDir: claudeCfgB,
      workspace: claudeDst,
    });
    activeCount--;
    assert.equal(recognition.recognized, true);
    verifiedAgentAdapters.push('claude-code');
  }

  let linuxGuestVerified: string | null = null;
  assert.ok(isDockerImageAvailable('ubuntu:24.04'), 'Ubuntu 24.04 Linux proof is mandatory for master E2E');
  const linuxCheckpointReceipt = await verifyLinuxCheckpoint();
  {
    const linuxCheckWs = join(realRunRoot, 'linux-guest-ws');
    await mkdir(join(linuxCheckWs, 'scripts'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(linuxCheckWs, 'scripts/probe.sh'),
      '#!/bin/sh\nset -eu\nprintf "%s/%s\\n" "$(uname -s)" "$(uname -m)" > linux-output.txt\n',
      { mode: 0o755 },
    );
    const linuxRes = await runLinuxWorkerContainerCheck({
      image: 'ubuntu:24.04',
      bootstrapScript: buildWorkerBootstrapScript('2.3.2'),
      hostWorkspaceDir: linuxCheckWs,
    });
    assert.equal(linuxRes.spoolStat, '700:agentrouter:agentrouter');
    assert.equal(linuxRes.sha256VerifiedInGuest, true);
    linuxGuestVerified = linuxRes.probeOutput;
  }

  // Verify journal-protected local checkpoint pruning
  const pruneStoreDir = join(realRunRoot, 'prune-store');
  const pruneStore = new LocalEncryptedStore(pruneStoreDir, randomBytes(32));
  await pruneStore.put('chk_0000000000000010', [{ path: 'a.txt', executable: false, data: Buffer.from('1') }]);
  await pruneStore.put('chk_0000000000000020', [{ path: 'a.txt', executable: false, data: Buffer.from('2') }]);
  const pruned = await pruneLocalCheckpoints({ storeDirectory: pruneStoreDir, keepLast: 1 });
  assert.equal(pruned.deletedIds.length + pruned.keptIds.length, 2);
  assert.equal((await migrationJournal.listBlocking()).length, 0);

  assert.equal(activeCount, 0);
  assert.equal(maxConcurrentServers, 1);
  console.log(
    JSON.stringify(
      {
        status: 'E2E_VERIFIED',
        acp: acpReceipt,
        mcpLoaders: mcpLoaderReceipt,
        mcpDoctor: doctor.status,
        version: '1.0.0',
        watchOutcome: watchResult.outcome,
        watchTicksRun: watchResult.ticksRun,
        verifiedAgentAdapters,
        linuxGuestVerified,
        linuxCheckpoint: linuxCheckpointReceipt,
        r2FreeTierGuardrail: r2Guard.status,
        daemonsExercised: ['opencode@2.3.2', 'git', 'openssh-sshd', 'ssh', 'scp', 'restic-sftp'],
        allowanceTrigger: migrationResult.triggerReasons,
        skippedCapacityTargets: migrationResult.skippedTargets,
        selectedFallbackTarget: migrationResult.selectedTarget,
        returnTransport: storageBackendUsed,
        maxConcurrentAgents: maxConcurrentServers,
        multiHopSessionAndDirtyGit: 'PRESERVED',
        linkedWorktreeSource: true,
        blockingJournalEntries: (await migrationJournal.listBlocking()).length,
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

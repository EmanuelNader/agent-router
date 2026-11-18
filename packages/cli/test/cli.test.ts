import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runRouterCli } from '../src/cli.js';
import { OperationJournal } from '../src/journal.js';
import { encodeClaudeProjectSlug } from '../../agent-claude-code/src/adapter.js';
import { isLocalSshdAvailable, startEphemeralSshd } from '../../host-ssh/src/ephemeral-sshd.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

test('router CLI checkpoints and restores a workspace with an owner-only key file and records journal status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-test-'));
  tempDirs.push(root);

  const workspace = join(root, 'ws-src');
  const restored = join(root, 'ws-dst');
  const storeDir = join(root, 'store');
  const journalDir = join(root, 'journal');
  const keyFile = join(root, 'master.key');

  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, 'hello.txt'), 'cli-portable-payload\n', { mode: 0o600 });

  // World-readable key file must fail closed
  await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o644 });
  await chmod(keyFile, 0o644);
  const badCapture = captureIo();
  const badExit = await runRouterCli(
    ['checkpoint', '--workspace', workspace, '--store', storeDir, '--key-file', keyFile, '--journal-dir', journalDir],
    badCapture.io,
  );
  expect(badExit).toBe(1);
  expect(badCapture.err.join('\n')).toMatch(/owner-only|0600/i);

  // Tighten to 0600 and run checkpoint -> restore -> status
  await chmod(keyFile, 0o600);
  const cpIo = captureIo();
  expect(
    await runRouterCli(
      ['checkpoint', '--workspace', workspace, '--store', storeDir, '--key-file', keyFile, '--journal-dir', journalDir],
      cpIo.io,
    ),
  ).toBe(0);
  const cpJson = JSON.parse(cpIo.out.join('\n')) as { checkpointId: string };
  expect(cpJson.checkpointId).toMatch(/^chk_[a-f0-9]{32}$/);

  const rsIo = captureIo();
  expect(
    await runRouterCli(
      [
        'restore',
        '--checkpoint',
        cpJson.checkpointId,
        '--target',
        restored,
        '--store',
        storeDir,
        '--key-file',
        keyFile,
        '--journal-dir',
        journalDir,
      ],
      rsIo.io,
    ),
  ).toBe(0);
  expect(await readFile(join(restored, 'hello.txt'), 'utf8')).toBe('cli-portable-payload\n');

  const stIo = captureIo();
  expect(await runRouterCli(['status', '--journal-dir', journalDir], stIo.io)).toBe(0);
  const stJson = JSON.parse(stIo.out.join('\n')) as { totalOperations: number; blockingCount: number };
  expect(stJson.totalOperations).toBe(2);
  expect(stJson.blockingCount).toBe(0);
});

test('router CLI reconciles blocking journal entries and runs oci:simulate-lifecycle with zero OCID leakage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-reconcile-'));
  tempDirs.push(root);
  const journalDir = join(root, 'journal');
  const journal = new OperationJournal(journalDir);
  const op = await journal.begin({
    kind: 'HANDOFF',
    workspaceKey: 'ws-manual',
    summary: 'Interrupted handoff test',
  });
  await journal.markNeedsReconcile(op.operationId, 'Interrupted after source fence');

  const recIo = captureIo();
  expect(
    await runRouterCli(
      ['reconcile', '--operation', op.operationId, '--summary', 'Verified target clean', '--journal-dir', journalDir],
      recIo.io,
    ),
  ).toBe(0);
  const recJson = JSON.parse(recIo.out.join('\n')) as { status: string };
  expect(recJson.status).toBe('COMPLETED');

  const simIo = captureIo();
  expect(await runRouterCli(['oci:simulate-lifecycle', '--workspace-key', 'ws-sim-01'], simIo.io)).toBe(0);
  const rawSim = simIo.out.join('\n');
  expect(rawSim).not.toContain('ocid1.');
  const simJson = JSON.parse(rawSim) as {
    status: string;
    launchCount: number;
    reconcileOutcome: string;
    fenced: boolean;
    remnants: { instances: number; bootVolumes: number; blockVolumes: number; reservedPublicIps: number };
  };
  expect(simJson).toMatchObject({
    status: 'SIMULATION_VERIFIED',
    launchCount: 1,
    reconcileOutcome: 'ADOPTED_EXISTING_INSTANCE',
    fenced: true,
    remnants: {
      instances: 0,
      bootVolumes: 0,
      blockVolumes: 0,
      reservedPublicIps: 0,
    },
  });
});

test('router CLI supports --version, aws:allowance, hetzner:simulate-lifecycle, migrate:simulate, and 0600 token-file checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-v01-'));
  tempDirs.push(root);

  const verIo = captureIo();
  expect(await runRouterCli(['--version'], verIo.io)).toBe(0);
  expect(verIo.out.join('\n').trim()).toBe('0.2.0');

  const awsReportPath = join(root, 'aws-low.json');
  await writeFile(
    awsReportPath,
    JSON.stringify({
      observedAt: new Date().toISOString(),
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      remainingCreditAmount: 2.5,
      creditCurrency: 'USD',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    }),
    { mode: 0o600 },
  );
  const awsIo = captureIo();
  expect(await runRouterCli(['aws:allowance', '--report', awsReportPath], awsIo.io)).toBe(2);
  expect(JSON.parse(awsIo.out.join('\n'))).toMatchObject({
    decision: 'MIGRATE_NOW',
    shouldMigrate: true,
  });

  const hetznerSimIo = captureIo();
  expect(await runRouterCli(['hetzner:simulate-lifecycle', '--workspace-key', 'ws-hsim'], hetznerSimIo.io)).toBe(0);
  expect(JSON.parse(hetznerSimIo.out.join('\n'))).toMatchObject({
    status: 'SIMULATION_VERIFIED',
    createCount: 1,
    reconcileOutcome: 'ADOPTED_EXISTING_SERVER',
    fenced: true,
    remnants: { servers: 0, volumes: 0, primaryIps: 0 },
  });

  const migSimIo = captureIo();
  expect(await runRouterCli(['migrate:simulate', '--workspace-key', 'ws-msim'], migSimIo.io)).toBe(0);
  expect(JSON.parse(migSimIo.out.join('\n'))).toMatchObject({
    status: 'MIGRATED',
    selectedTarget: 'hetzner-cax11-fallback',
    skippedTargets: [{ name: 'oci-a1-primary', reason: 'OUT_OF_CAPACITY' }],
    sourceTornDown: true,
  });

  // Live hetzner:* commands must reject non-0600 token files before any network call
  const badTokenFile = join(root, 'hcloud.token');
  await writeFile(badTokenFile, 'dummy-token-value\n', { mode: 0o644 });
  await chmod(badTokenFile, 0o644);
  const badHetznerIo = captureIo();
  expect(
    await runRouterCli(
      ['hetzner:fence', '--workspace-key', 'ws-x', '--token-file', badTokenFile],
      badHetznerIo.io,
    ),
  ).toBe(1);
  expect(badHetznerIo.err.join('\n')).toMatch(/owner-only|0600/i);
  expect(badHetznerIo.err.join('\n')).not.toContain('dummy-token-value');
});

test('router CLI supports peers --status-file, polymorphic --agent checkpoints, and live SSH handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-v02-'));
  tempDirs.push(root);

  const statusFile = join(root, 'tailscale-status.json');
  await writeFile(
    statusFile,
    JSON.stringify({
      BackendState: 'Running',
      Peer: {
        'nodekey:abc': {
          HostName: 'worker-arm64',
          DNSName: 'worker-arm64.tail01.ts.net.',
          OS: 'linux',
          TailscaleIPs: ['100.64.1.8'],
          Online: true,
          Relay: 'fra',
        },
      },
    }),
    { mode: 0o600 },
  );
  const peersIo = captureIo();
  expect(await runRouterCli(['peers', '--status-file', statusFile], peersIo.io)).toBe(0);
  expect(JSON.parse(peersIo.out.join('\n'))).toEqual({
    peerCount: 1,
    peers: [
      {
        hostName: 'worker-arm64',
        dnsName: 'worker-arm64.tail01.ts.net',
        tailscaleIps: ['100.64.1.8'],
        os: 'linux',
        online: true,
        relay: 'fra',
        recommendedSshTarget: 'agentrouter@worker-arm64.tail01.ts.net',
      },
    ],
  });

  // Live SSH handoff with Claude Code relocation when sshd is available
  if (isLocalSshdAvailable()) {
    const sshd = await startEphemeralSshd(join(root, 'sshd'));
    try {
      const srcWs = join(root, 'src.claude_ws');
      const dstWs = join(root, 'dst.claude_ws');
      await mkdir(srcWs, { recursive: true, mode: 0o700 });
      await writeFile(join(srcWs, 'app.ts'), 'export const ok = true;\n', { mode: 0o600 });

      const claudeA = join(root, 'claude-a');
      const claudeB = join(root, 'claude-b');
      const slugDirA = join(claudeA, 'projects', encodeClaudeProjectSlug(srcWs));
      await mkdir(slugDirA, { recursive: true, mode: 0o700 });
      const uuid = '44444444-5555-4666-8777-888888888888';
      await writeFile(
        join(slugDirA, `${uuid}.jsonl`),
        `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: uuid, cwd: srcWs, message: { role: 'user', content: 'handoff' } })}\n`,
        { mode: 0o600 },
      );

      const keyFile = join(root, 'handoff.key');
      await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
      await chmod(keyFile, 0o600);

      const handoffIo = captureIo();
      const code = await runRouterCli(
        [
          'handoff',
          '--workspace',
          srcWs,
          '--target-workspace',
          dstWs,
          '--ssh-target',
          `${sshd.username}@127.0.0.1`,
          '--ssh-port',
          String(sshd.port),
          '--identity-file',
          sshd.clientPrivateKeyPath,
          '--known-hosts-file',
          sshd.knownHostsPath,
          '--remote-spool',
          join(root, 'remote-spool'),
          '--key-file',
          keyFile,
          '--agent',
          'claude-code',
          '--claude-config-dir',
          claudeA,
          '--target-claude-config-dir',
          claudeB,
          '--journal-dir',
          join(root, 'journal'),
        ],
        handoffIo.io,
      );
      expect(code).toBe(0);
      expect(await readFile(join(dstWs, 'app.ts'), 'utf8')).toBe('export const ok = true;\n');
      const relocatedJsonl = await readFile(
        join(claudeB, 'projects', encodeClaudeProjectSlug(dstWs), `${uuid}.jsonl`),
        'utf8',
      );
      expect((JSON.parse(relocatedJsonl.trim()) as { cwd: string }).cwd).toBe(dstWs);
    } finally {
      await sshd.close();
    }
  }
}, 20_000);

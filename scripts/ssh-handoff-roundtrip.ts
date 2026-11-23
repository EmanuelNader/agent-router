import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import { OperationJournal } from '../packages/cli/src/journal.js';
import { handoffWorkspace } from '../packages/host-ssh/src/handoff.js';
import { LoopbackHostTransport } from '../packages/host-ssh/src/transport.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/ssh-handoff-'));
const laptopA = join(run, 'laptop-a');
const remoteVps = join(run, 'remote-vps');
const laptopB = join(run, 'laptop-b');

const git = (directory: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: run, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
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

try {
  await cp(resolve('fixtures/workspace'), laptopA, { recursive: true });
  git(laptopA, ['init', '--quiet']);
  git(laptopA, ['add', '.']);
  git(laptopA, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  await writeFile(join(laptopA, 'src/message.txt'), 'unfinished laptop edits\n');
  await writeFile(join(laptopA, '.workspace-note'), 'hidden note\n');
  await rename(join(laptopA, 'README.md'), join(laptopA, 'PROJECT.md'));

  const journal = new OperationJournal(join(run, 'journal'));
  const key = randomBytes(32);

  // 1. Start work on Laptop A.
  const laptopServerA = await spawnTrackedServer(laptopA, join(run, 'state-laptop-a'));
  const sessionId = await laptopServerA.client.createSession(laptopA, 'Laptop to VPS handoff');
  await laptopServerA.client.runShellCommand(sessionId, "printf 'router-laptop-turn-1\\n'");

  // 2. Handoff Laptop A -> Remote VPS.
  let vpsServer: RunningServer | undefined;
  await handoffWorkspace({
    workspaceKey: 'ws_roundtrip',
    journal,
    encryptionKey: key,
    sourceWorkspace: laptopA,
    sourceStagingDir: join(run, 'stage-laptop-a'),
    targetWorkspace: remoteVps,
    transport: new LoopbackHostTransport(join(run, 'spool-to-vps')),
    exportSourceSessions: async () => [await laptopServerA.client.exportSessionForCheckpoint(sessionId)],
    fenceSource: fenceTrackedServer,
    activateTargetAndImportSession: async (transfer, directory) => {
      assert.equal(activeCount, 0, 'Source must be fenced before target starts');
      vpsServer = await spawnTrackedServer(directory, join(run, 'state-vps'));
      return await vpsServer.client.importSession(transfer, directory);
    },
  });

  // 3. Continue work inside the imported session on Remote VPS.
  assert.ok(vpsServer);
  await vpsServer.client.runShellCommand(sessionId, "printf 'router-remote-turn-2\\n'");
  await writeFile(join(remoteVps, 'vps-output.txt'), 'generated on remote host\n');
  const expectedAfterVps = await hashWorkspace(remoteVps);

  // 4. Handoff Remote VPS -> Laptop B.
  let laptopServerB: RunningServer | undefined;
  await handoffWorkspace({
    workspaceKey: 'ws_roundtrip',
    journal,
    encryptionKey: key,
    sourceWorkspace: remoteVps,
    sourceStagingDir: join(run, 'stage-vps'),
    targetWorkspace: laptopB,
    transport: new LoopbackHostTransport(join(run, 'spool-to-laptop')),
    exportSourceSessions: async () => [await vpsServer!.client.exportSessionForCheckpoint(sessionId)],
    fenceSource: fenceTrackedServer,
    activateTargetAndImportSession: async (transfer, directory) => {
      assert.equal(activeCount, 0, 'Remote VPS must be fenced before Laptop B starts');
      laptopServerB = await spawnTrackedServer(directory, join(run, 'state-laptop-b'));
      return await laptopServerB.client.importSession(transfer, directory);
    },
  });

  assert.ok(laptopServerB);
  assert.equal(maxConcurrentServers, 1, 'Never more than one active OpenCode server');
  const finalSession = await laptopServerB.client.exportSession(sessionId);
  assert.equal((finalSession.info.location as { directory?: unknown } | undefined)?.directory, laptopB);
  requireCompletedShellOutput(finalSession.messages, 'router-laptop-turn-1\n');
  requireCompletedShellOutput(finalSession.messages, 'router-remote-turn-2\n');
  assert.deepEqual(await hashWorkspace(laptopB), expectedAfterVps);

  const operations = await journal.list();
  assert.equal(operations.length, 2);
  assert.ok(operations.every(op => op.status === 'COMPLETED'));

  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        hops: 'LAPTOP_TO_VPS_TO_LAPTOP',
        maxConcurrentAgents: maxConcurrentServers,
        journalOperationsCompleted: operations.length,
        multiHopShellHistory: 'PRESERVED',
        workspaceAndGitState: 'PRESERVED',
      },
      null,
      2,
    ),
  );
} finally {
  await fenceTrackedServer();
  await rm(run, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import { captureCheckpoint, restoreCheckpoint } from '../packages/snapshots/src/checkpoint.js';
import { isResticAvailable, ResticRepositoryStore } from '../packages/snapshots/src/restic.js';
import { LocalEncryptedStore, type SnapshotStore } from '../packages/snapshots/src/store.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';

const { values } = parseArgs({ options: { restic: { type: 'boolean', default: false } } });
if (values.restic && !isResticAvailable()) {
  console.error(JSON.stringify({ status: 'FAIL', reason: 'RESTIC_UNAVAILABLE' }));
  process.exit(1);
}

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/checkpoint-'));
const source = join(run, 'source');
const target = join(run, 'target');
const git = (directory: string, args: string[]) =>
  execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: run, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });

let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
try {
  await cp(resolve('fixtures/workspace'), source, { recursive: true });
  git(source, ['init', '--quiet']);
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  await writeFile(join(source, 'src/message.txt'), 'unfinished edits\n');
  await writeFile(join(source, '.workspace-note'), 'hidden and untracked\n');
  await writeFile(join(source, 'notes.txt'), 'untracked work\n');
  await rename(join(source, 'README.md'), join(source, 'PROJECT.md'));

  server = await startIsolatedServer(source, join(run, 'source-agent'));
  const sessionId = await server.client.createSession(source, 'Encrypted checkpoint fixture');
  await server.client.runShellCommand(sessionId, "printf 'router-checkpoint-fixture\\n'");

  const resticStore = values.restic
    ? new ResticRepositoryStore(join(run, 'restic-repo'), randomBytes(32).toString('hex'))
    : undefined;
  const store: SnapshotStore = resticStore ?? new LocalEncryptedStore(join(run, 'store'), randomBytes(32));

  const manifest = await captureCheckpoint({
    workspace: source,
    store,
    exportSessions: async () => [await server!.client.exportSessionForCheckpoint(sessionId)],
    quiesceSource: async () => {
      await server!.stop();
      server = undefined;
    },
  });

  if (resticStore) await resticStore.verifyIntegrity();
  const expectedFiles = await hashWorkspace(source);

  const restoredManifest = await restoreCheckpoint({
    checkpointId: manifest.checkpointId,
    targetWorkspace: target,
    store,
    importSession: async (transfer, directory) => {
      if (!server) server = await startIsolatedServer(directory, join(run, 'target-agent'));
      return await server.client.importSession(transfer, directory);
    },
  });

  assert.equal(restoredManifest.checkpointId, manifest.checkpointId);
  assert.ok(server, 'Target server must start after workspace verification');
  const restored = await server.client.exportSession(sessionId);
  assert.equal((restored.info.location as { directory?: unknown } | undefined)?.directory, target);
  requireCompletedShellOutput(restored.messages, 'router-checkpoint-fixture\n');
  assert.deepEqual(await hashWorkspace(target), expectedFiles);

  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        backend: values.restic ? 'RESTIC' : 'AES_256_GCM',
        encryptedAtRest: true,
        verifiedManifest: 'PASS',
        gitWorkingTree: 'PASS',
        sessionId: 'PRESERVED',
        settledShellHistory: 'PRESERVED',
      },
      null,
      2,
    ),
  );
} finally {
  await server?.stop();
  await rm(run, { recursive: true, force: true });
}

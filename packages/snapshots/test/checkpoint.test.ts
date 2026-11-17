import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { captureCheckpoint, restoreCheckpoint } from '../src/checkpoint.js';
import { LocalEncryptedStore, type SnapshotEntry, type SnapshotStore } from '../src/store.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

test('quiesces source before hashing, then captures and restores dirty Git state, modes, and sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-checkpoint-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'README.md'), 'initial\n');
  await writeFile(join(source, 'scripts/run.sh'), '#!/bin/sh\necho ok\n');
  await chmod(join(source, 'scripts/run.sh'), 0o755);

  git(source, ['init', '-q']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  await rename(join(source, 'README.md'), join(source, 'PROJECT.md'));
  await writeFile(join(source, '.hidden-note'), 'keep hidden\n');
  await writeFile(join(source, 'untracked.txt'), 'before-quiesce\n');

  const store = new LocalEncryptedStore(join(root, 'store'), randomBytes(32));
  const settledSession = {
    info: { id: 'ses_1', title: 'fixture' },
    messages: [{ type: 'shell', status: 'exited', exit: 0, time: { completed: 1 }, output: { output: 'ok\n' } }],
  };

  const manifest = await captureCheckpoint({
    workspace: source,
    store,
    exportSessions: async () => [settledSession],
    quiesceSource: async () => {
      // Simulates final writer flush during graceful shutdown; checkpoint must observe post-quiesce bytes.
      await writeFile(join(source, 'untracked.txt'), 'flushed-on-quiesce\n');
    },
  });

  const imported: { sessionId: string; directory: string }[] = [];
  const restored = await restoreCheckpoint({
    checkpointId: manifest.checkpointId,
    targetWorkspace: target,
    store,
    importSession: async (transfer, directory) => {
      imported.push({ sessionId: transfer.info.id, directory });
      return transfer.info.id;
    },
  });

  expect(restored.checkpointId).toBe(manifest.checkpointId);
  expect(imported).toEqual([{ sessionId: 'ses_1', directory: target }]);
  expect(await hashWorkspace(target)).toEqual(await hashWorkspace(source));
  expect(git(target, ['rev-parse', 'HEAD'])).toBe(git(source, ['rev-parse', 'HEAD']));
  expect(git(target, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(
    git(source, ['status', '--porcelain=v1', '--untracked-files=all']),
  );
  expect(git(target, ['ls-files', '--stage'])).toBe(git(source, ['ls-files', '--stage']));
});

test('rejects capturing a checkpoint while a session has an unfinished shell turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-checkpoint-running-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'file.txt'), 'data');

  let quiesced = false;
  await expect(
    captureCheckpoint({
      workspace: source,
      store: new LocalEncryptedStore(join(root, 'store'), randomBytes(32)),
      exportSessions: async () => [
        { info: { id: 'ses_running' }, messages: [{ type: 'shell', status: 'running' }] },
      ],
      quiesceSource: async () => {
        quiesced = true;
      },
    }),
  ).rejects.toThrow(/unfinished/i);
  expect(quiesced).toBe(false);
});

test('cleans up target and skips session import when restored file bytes violate the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-checkpoint-corrupt-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'file.txt'), 'expected-bytes');

  const memory = new Map<string, SnapshotEntry[]>();
  const corruptingStore: SnapshotStore = {
    async put(id, entries) {
      memory.set(
        id,
        entries.map(entry =>
          entry.path === 'workspace/file.txt' ? { ...entry, data: Buffer.from('corrupted-bytes') } : entry,
        ),
      );
    },
    async get(id) {
      return memory.get(id) ?? [];
    },
  };

  const manifest = await captureCheckpoint({
    workspace: source,
    store: corruptingStore,
    exportSessions: async () => [{ info: { id: 'ses_never' }, messages: [] }],
    quiesceSource: async () => {},
  });

  let importCalled = false;
  await expect(
    restoreCheckpoint({
      checkpointId: manifest.checkpointId,
      targetWorkspace: target,
      store: corruptingStore,
      importSession: async transfer => {
        importCalled = true;
        return transfer.info.id;
      },
    }),
  ).rejects.toThrow(/manifest|hash/i);
  expect(importCalled).toBe(false);
  await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
});

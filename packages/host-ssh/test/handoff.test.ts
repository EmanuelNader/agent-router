import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { handoffWorkspace } from '../src/handoff.js';
import { LoopbackHostTransport, type HostTransport } from '../src/transport.js';

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

test('fences source before target activation and completes laptop -> remote -> laptop round trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-handoff-'));
  tempDirs.push(root);
  const laptopA = join(root, 'laptop-a');
  const remoteVps = join(root, 'remote-vps');
  const laptopB = join(root, 'laptop-b');

  await mkdir(join(laptopA, 'scripts'), { recursive: true });
  await writeFile(join(laptopA, 'README.md'), 'baseline\n');
  await writeFile(join(laptopA, 'scripts/check.sh'), '#!/bin/sh\necho ok\n');
  await chmod(join(laptopA, 'scripts/check.sh'), 0o755);

  git(laptopA, ['init', '-q']);
  git(laptopA, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.']);
  git(laptopA, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  await rename(join(laptopA, 'README.md'), join(laptopA, 'PROJECT.md'));
  await writeFile(join(laptopA, 'notes.txt'), 'uncommitted work\n');

  const journal = new OperationJournal(join(root, 'journal'));
  const key = randomBytes(32);
  const events: string[] = [];
  const session = {
    info: { id: 'ses_handoff_1', title: 'portable task' },
    messages: [{ type: 'shell', status: 'exited', exit: 0, time: { completed: 10 }, output: { output: 'ok\n' } }],
  };

  const toRemote = await handoffWorkspace({
    workspaceKey: 'ws_portable',
    journal,
    encryptionKey: key,
    sourceWorkspace: laptopA,
    sourceStagingDir: join(root, 'stage-a'),
    targetWorkspace: remoteVps,
    transport: new LoopbackHostTransport(join(root, 'spool-1')),
    exportSourceSessions: async () => [session],
    fenceSource: async () => {
      events.push('source-fenced');
    },
    activateTargetAndImportSession: async (transfer, directory) => {
      events.push(`target-activated:${directory}`);
      return transfer.info.id;
    },
  });

  expect(toRemote.operation.status).toBe('COMPLETED');
  expect(events).toEqual(['source-fenced', `target-activated:${remoteVps}`]);

  // Modify a file on the remote VPS and hand back to a fresh laptop directory.
  await writeFile(join(remoteVps, 'remote-progress.txt'), 'done on vps\n');
  const backToLaptop = await handoffWorkspace({
    workspaceKey: 'ws_portable',
    journal,
    encryptionKey: key,
    sourceWorkspace: remoteVps,
    sourceStagingDir: join(root, 'stage-vps'),
    targetWorkspace: laptopB,
    transport: new LoopbackHostTransport(join(root, 'spool-2')),
    exportSourceSessions: async () => [session],
    fenceSource: async () => {
      events.push('vps-fenced');
    },
    activateTargetAndImportSession: async transfer => transfer.info.id,
  });

  expect(backToLaptop.operation.status).toBe('COMPLETED');
  expect(await hashWorkspace(laptopB)).toEqual(await hashWorkspace(remoteVps));
  expect(git(laptopB, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('?? remote-progress.txt');
});

test('keeps source unfenced and clears PENDING lock when pre-fence check fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-handoff-prefence-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.txt'), 'safe');

  const journal = new OperationJournal(join(root, 'journal'));
  let sourceFenced = false;

  await expect(
    handoffWorkspace({
      workspaceKey: 'ws_prefence',
      journal,
      encryptionKey: randomBytes(32),
      sourceWorkspace: source,
      sourceStagingDir: join(root, 'stage'),
      targetWorkspace: join(root, 'target'),
      transport: new LoopbackHostTransport(join(root, 'spool')),
      exportSourceSessions: async () => [{ info: { id: 'ses_1' }, messages: [{ type: 'shell', status: 'running' }] }],
      fenceSource: async () => {
        sourceFenced = true;
      },
      activateTargetAndImportSession: async transfer => transfer.info.id,
    }),
  ).rejects.toThrow(/unfinished/i);

  expect(sourceFenced).toBe(false);
  expect(await journal.list()).toEqual([]);
});

test('marks journal NEEDS_RECONCILE and blocks retries when transfer corrupts after source fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-handoff-postfence-'));
  tempDirs.push(root);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a.txt'), 'important');

  const journal = new OperationJournal(join(root, 'journal'));
  let fenced = false;
  const corruptTransport: HostTransport = {
    async transferEncryptedCheckpoint() {
      throw new Error('SSH connection reset mid-transfer');
    },
    async readTransferredCheckpoint() {
      throw new Error('Unreachable');
    },
  };

  await expect(
    handoffWorkspace({
      workspaceKey: 'ws_postfence',
      journal,
      encryptionKey: randomBytes(32),
      sourceWorkspace: source,
      sourceStagingDir: join(root, 'stage'),
      targetWorkspace: join(root, 'target'),
      transport: corruptTransport,
      exportSourceSessions: async () => [{ info: { id: 'ses_1' }, messages: [] }],
      fenceSource: async () => {
        fenced = true;
      },
      activateTargetAndImportSession: async transfer => transfer.info.id,
    }),
  ).rejects.toThrow(/transfer/i);

  expect(fenced).toBe(true);
  const records = await journal.list();
  expect(records).toHaveLength(1);
  expect(records[0]?.status).toBe('NEEDS_RECONCILE');
});

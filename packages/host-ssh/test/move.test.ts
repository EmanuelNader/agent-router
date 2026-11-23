import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import { restoreAgentCheckpoint } from '../../snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { assertRemoteWords, moveWorkspaceToHost, type MoveTransport } from '../src/move.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(restore: (stdin: Buffer | undefined) => string) {
  const root = await mkdtemp(join(tmpdir(), 'router-move-unit-'));
  tempDirs.push(root);
  const workspace = join(root, 'ws');
  await mkdir(workspace);
  await writeFile(join(workspace, 'a.txt'), 'a\n');
  const calls: string[][] = [];
  const spool = new Set<string>();
  const transport: MoveTransport = {
    async runRemoteCommand(command, input) {
      calls.push(command);
      if (command[1] === '--version') return { stdout: '9.9.9\n' };
      if (command[1] === 'restore') return { stdout: restore(input) };
      return { stdout: '' };
    },
    async transferEncryptedCheckpoint(id) { spool.add(id); },
    async readTransferredCheckpoint() { throw new Error('unused'); },
    async removeTransferredCheckpoint(id) { spool.delete(id); },
  };
  const journal = new OperationJournal(join(root, 'journal'));
  const run = (overrides: Partial<Parameters<typeof moveWorkspaceToHost>[0]> = {}) => moveWorkspaceToHost({
    workspaceKey: 'ws', journal, encryptionKey: randomBytes(32), sourceWorkspace: workspace, agent: { kind: 'none' },
    transport, routerVersion: '9.9.9', remoteRouter: 'agent-router', remoteWorkspace: '/home/u/ws', remoteSpool: '/home/u/.agent-router/spool',
    ...overrides,
  });
  return { workspace, calls, spool, journal, run, transport };
}

test('a remote restore failure after it started is journaled as NEEDS_RECONCILE and keeps the source', async () => {
  const f = await fixture(() => { throw new Error('connection dropped'); });
  await expect(f.run({ removeSource: true })).rejects.toThrow('connection dropped');
  expect((await f.journal.listBlocking()).map(r => r.status)).toEqual(['NEEDS_RECONCILE']);
  await access(join(f.workspace, 'a.txt'));
  expect(f.spool.size).toBe(1);
});

test('a manifest that differs from the captured checkpoint is not accepted as a completed move', async () => {
  const f = await fixture(() => JSON.stringify({ operationId: 'op_x' }));
  await expect(f.run()).rejects.toThrow(/REMOTE_RESTORE_UNVERIFIED/);
  expect((await f.journal.listBlocking()).map(r => r.status)).toEqual(['NEEDS_RECONCILE']);
});

test('a version mismatch refuses before capture and leaves no blocking journal entry', async () => {
  const f = await fixture(() => '');
  await expect(f.run({ routerVersion: '1.0.0' })).rejects.toThrow(/REMOTE_ROUTER_VERSION_MISMATCH/);
  expect(await f.journal.listBlocking()).toEqual([]);
  expect(f.calls.some(c => c[1] === 'restore')).toBe(false);
  expect(f.spool.size).toBe(0);
});

test('a remote build without a required feature refuses before capture and leaves no blocking journal entry', async () => {
  const f = await fixture(() => '{}');
  const transport: MoveTransport = {
    ...f.transport,
    async runRemoteCommand(command, input) {
      if (command[1] === 'supports') throw new Error('exit 1');
      return await f.transport.runRemoteCommand(command, input);
    },
  };
  await expect(f.run({ transport, requiredRemoteFeatures: ['opencode-pending-inbox'] })).rejects.toThrow(/REMOTE_ROUTER_TOO_OLD/);
  expect(f.calls.some(command => command[1] === 'restore')).toBe(false);
  expect(f.spool.size).toBe(0);
  expect(await f.journal.listBlocking()).toEqual([]);
});

test('the key travels on stdin, never in the remote command', async () => {
  let stdin = '';
  const f = await fixture(input => { stdin = input?.toString('utf8') ?? ''; throw new Error('stop'); });
  const key = randomBytes(32);
  await expect(f.run({ encryptionKey: key })).rejects.toThrow('stop');
  expect(stdin.trim()).toBe(key.toString('hex'));
  expect(JSON.stringify(f.calls)).not.toContain(key.toString('hex'));
});

test('remote arguments with shell syntax are refused', async () => {
  for (const word of ['a b', '$(id)', 'a;b', '-oProxyCommand=x', "a'b", '']) {
    expect(() => assertRemoteWords([word])).toThrow(/unsafe/);
  }
  expect(assertRemoteWords(['--codex-home', '/home/u/.codex_1', 'http://127.0.0.1:4096'])).toHaveLength(3);
  const f = await fixture(() => '');
  await expect(f.run({ remoteRouter: 'agent-router;id' })).rejects.toThrow(/unsafe/);
  expect(await f.journal.listBlocking()).toEqual([]);
});

test('--remove-source keeps a source whose Git state changed after the checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-move-git-'));
  tempDirs.push(root);
  const workspace = join(root, 'ws');
  await mkdir(workspace);
  await writeFile(join(workspace, 'a.txt'), 'a\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: workspace, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  const key = randomBytes(32);
  let checkpointId = '';
  const transport: MoveTransport = {
    async runRemoteCommand(command) {
      if (command[1] === '--version') return { stdout: '9.9.9' };
      if (command[1] !== 'restore') return { stdout: '' };
      const manifest = await restoreAgentCheckpoint({
        checkpointId, targetWorkspace: join(root, 'remote-ws'),
        store: new LocalEncryptedStore(join(root, 'spool'), key), agent: { kind: 'none' },
      });
      // Work committed on the source while the remote restore ran: files are unchanged, HEAD is not.
      git('commit', '-q', '--allow-empty', '-m', 'two');
      return { stdout: JSON.stringify({ operationId: 'op_remote', ...manifest }) };
    },
    async transferEncryptedCheckpoint(id, bytes) {
      checkpointId = id;
      await mkdir(join(root, 'spool'), { recursive: true });
      await writeFile(join(root, 'spool', `${id}.enc`), bytes);
    },
    async readTransferredCheckpoint() { throw new Error('unused'); },
    async removeTransferredCheckpoint() {},
  };
  const result = await moveWorkspaceToHost({
    workspaceKey: 'ws', journal: new OperationJournal(join(root, 'journal')), encryptionKey: key, sourceWorkspace: workspace,
    agent: { kind: 'none' }, transport, routerVersion: '9.9.9', remoteRouter: 'agent-router',
    remoteWorkspace: '/home/u/ws', remoteSpool: '/home/u/.agent-router/spool', removeSource: true,
  });
  expect(result.sourceRemoved).toBe(false);
  expect(result.operation.status).toBe('COMPLETED');
  await access(join(workspace, 'a.txt'));
});

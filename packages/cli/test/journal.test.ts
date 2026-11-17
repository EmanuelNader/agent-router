import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationJournal } from '../src/journal.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('persists owner-only PENDING receipt with retryToken and transitions atomically to COMPLETED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-'));
  tempDirs.push(root);
  const journalDir = join(root, 'journal');
  const journal = new OperationJournal(journalDir);

  const started = await journal.begin({
    kind: 'HANDOFF',
    workspaceKey: 'ws_alpha',
    summary: 'Starting SSH handoff',
  });
  expect(started.status).toBe('PENDING');
  expect(started.retryToken).toMatch(/^rt_[a-f0-9]{32}$/);
  expect((await lstat(journalDir)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(journalDir, `${started.operationId}.json`))).mode & 0o777).toBe(0o600);

  const completed = await journal.complete(started.operationId, 'Handoff verified');
  expect(completed.status).toBe('COMPLETED');
  expect(completed.retryToken).toBe(started.retryToken);
  expect(await journal.read(started.operationId)).toEqual(completed);
});

test('blocks concurrent PENDING or NEEDS_RECONCILE operations on the same workspace until reconciled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-lock-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));

  const op = await journal.begin({
    kind: 'PROVISION',
    workspaceKey: 'ws_locked',
    summary: 'Launching host',
  });

  await expect(
    journal.begin({ kind: 'HANDOFF', workspaceKey: 'ws_locked', summary: 'Duplicate attempt' }),
  ).rejects.toThrow(/reconcil|pending/i);

  // Unrelated workspace is not blocked.
  const other = await journal.begin({ kind: 'CHECKPOINT', workspaceKey: 'ws_other', summary: 'Independent' });
  await journal.complete(other.operationId, 'Done');

  await journal.markNeedsReconcile(op.operationId, 'Interrupted after fence');
  await expect(
    journal.begin({ kind: 'HANDOFF', workspaceKey: 'ws_locked', summary: 'Still blocked' }),
  ).rejects.toThrow(/reconcil/i);

  await expect(journal.abortUnfenced(op.operationId)).rejects.toThrow(/reconcil|pending/i);

  await journal.reconcile(op.operationId, 'Verified source stopped and target clean');
  const next = await journal.begin({ kind: 'HANDOFF', workspaceKey: 'ws_locked', summary: 'Resumed cleanly' });
  expect(next.status).toBe('PENDING');
});

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LoopbackHostTransport } from '../../host-ssh/src/transport.js';
import { OperationJournal } from '../src/journal.js';
import { migrateWorkspace } from '../src/migrate.js';
import { runAllowanceWatchLoop } from '../src/watch.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('autonomous watch loop monitors healthy ticks, then evacuates automatically when GitHub 2026 billing hits MIGRATE_NOW', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-watch-loop-'));
  tempDirs.push(root);

  const srcWs = join(root, 'src-ws');
  const dstWs = join(root, 'dst-ws');
  await mkdir(srcWs, { recursive: true, mode: 0o700 });
  await writeFile(join(srcWs, 'state.txt'), 'live-codespace-work\n', { mode: 0o600 });

  const journal = new OperationJournal(join(root, 'journal'));
  const key = randomBytes(32);
  const fixedNow = new Date('2026-11-18T00:00:00.000Z');
  let tornDown = false;

  const res = await runAllowanceWatchLoop({
    workspaceKey: 'ws-codespace-01',
    journal,
    maxTicks: 4,
    pollAllowance: async tick => ({
      kind: 'GITHUB_BILLING_USAGE',
      observedAt: '2026-11-17T23:58:00.000Z',
      activeMachineCores: 4,
      now: fixedNow,
      payload: {
        usageItems: [
          {
            product: 'codespaces',
            sku: 'codespaces_compute_d4',
            unitType: 'hours',
            grossQuantity: tick === 1 ? 10 : 28.5, // tick 1 => 40 core-hrs (HEALTHY); tick 2 => 114 core-hrs (MIGRATE_NOW)
          },
        ],
      },
    }),
    executeMigration: async trigger =>
      await migrateWorkspace({
        workspaceKey: 'ws-codespace-01',
        journal,
        encryptionKey: key,
        trigger,
        source: {
          workspacePath: srcWs,
          stagingDir: join(root, 'stage'),
          exportSessions: async () => [
            {
              info: { id: 'ses_watch_01', title: 'watch-session', directory: srcWs },
              messages: [],
            },
          ],
          fenceAgent: async () => undefined,
          teardownCompute: async () => {
            tornDown = true;
          },
        },
        candidates: [
          {
            name: 'oci-a1-primary',
            targetWorkspace: join(root, 'unused-oci'),
            transport: new LoopbackHostTransport(join(root, 'spool-oci')),
            prepareCompute: async () => ({ status: 'OUT_OF_CAPACITY' }),
            activateAndImportSession: async transfer => transfer.info.id,
          },
          {
            name: 'tailscale-laptop-fallback',
            targetWorkspace: dstWs,
            transport: new LoopbackHostTransport(join(root, 'spool-laptop')),
            prepareCompute: async () => ({ status: 'READY', targetFingerprint: 'fp_laptop_01' }),
            activateAndImportSession: async transfer => transfer.info.id,
          },
        ],
      }),
  });

  expect(res.outcome).toBe('EVACUATED');
  if (res.outcome !== 'EVACUATED') throw new Error('expected EVACUATED');
  expect(res.ticksRun).toBe(2);
  expect(res.triggerReasons).toEqual(['LOW_CODESPACES_CORE_HOURS']);
  expect(res.migration.selectedTarget).toBe('tailscale-laptop-fallback');
  expect(tornDown).toBe(true);
  expect(await readFile(join(dstWs, 'state.txt'), 'utf8')).toBe('live-codespace-work\n');
  expect(await journal.listBlocking('ws-codespace-01')).toHaveLength(0);
});

test('autonomous watch loop fails closed on blocking journal entries or stale allowance evidence without migrating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-watch-fence-'));
  tempDirs.push(root);

  const journal = new OperationJournal(join(root, 'journal'));
  const pending = await journal.begin({
    kind: 'HANDOFF',
    workspaceKey: 'ws-fenced',
    summary: 'Unreconciled prior handoff',
  });
  await journal.markNeedsReconcile(pending.operationId, 'Interrupted');

  let migrateCalled = false;
  const blockedByJournal = await runAllowanceWatchLoop({
    workspaceKey: 'ws-fenced',
    journal,
    maxTicks: 3,
    pollAllowance: async () => {
      throw new Error('should not even poll when journal is blocked');
    },
    executeMigration: async () => {
      migrateCalled = true;
      throw new Error('should not migrate');
    },
  });

  expect(blockedByJournal.outcome).toBe('BLOCKED_BY_JOURNAL');
  expect(migrateCalled).toBe(false);

  await journal.reconcile(pending.operationId, 'Reconciled');

  const blockedByStale = await runAllowanceWatchLoop({
    workspaceKey: 'ws-fenced',
    journal,
    maxTicks: 3,
    pollAllowance: async () => ({
      kind: 'CODESPACES',
      now: new Date('2026-11-18T00:00:00.000Z'),
      snapshot: {
        observedAt: '2026-11-17T22:00:00.000Z',
        usedCoreHours: 118,
        usedStorageGbMonth: 5,
        activeMachineCores: 2,
      },
    }),
    executeMigration: async () => {
      migrateCalled = true;
      throw new Error('should not migrate on stale evidence');
    },
  });

  expect(blockedByStale.outcome).toBe('BLOCKED_BY_EVIDENCE');
  if (blockedByStale.outcome === 'BLOCKED_BY_EVIDENCE') {
    expect(blockedByStale.reasons).toContain('STALE_CODESPACES_EVIDENCE');
  }
  expect(migrateCalled).toBe(false);
});

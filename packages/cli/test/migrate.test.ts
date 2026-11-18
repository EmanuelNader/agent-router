import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LoopbackHostTransport, type HostTransport } from '../../host-ssh/src/transport.js';
import { OperationJournal } from '../src/journal.js';
import { migrateWorkspace } from '../src/migrate.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const fixedNow = new Date('2026-11-18T00:00:00.000Z');

test('skips migration when AWS Free Plan allowance is healthy without touching source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-migrate-healthy-'));
  tempDirs.push(root);
  let fenced = false;
  let tornDown = false;

  const res = await migrateWorkspace({
    workspaceKey: 'ws-healthy',
    journal: new OperationJournal(join(root, 'journal')),
    encryptionKey: randomBytes(32),
    trigger: {
      kind: 'AWS_FREE_PLAN',
      snapshot: {
        observedAt: '2026-11-17T23:59:00.000Z',
        accountPlanType: 'FREE',
        accountPlanStatus: 'ACTIVE',
        remainingCreditAmount: 75,
        creditCurrency: 'USD',
        expiresAt: '2027-03-01T00:00:00.000Z',
      },
      now: fixedNow,
    },
    source: {
      workspacePath: join(root, 'src'),
      stagingDir: join(root, 'stage'),
      exportSessions: async () => [],
      fenceAgent: async () => {
        fenced = true;
      },
      teardownCompute: async () => {
        tornDown = true;
      },
    },
    candidates: [],
  });

  expect(res).toEqual({ status: 'SKIPPED_HEALTHY', reasons: [] });
  expect(fenced).toBe(false);
  expect(tornDown).toBe(false);
});

test('falls back from OCI OUT_OF_CAPACITY to Hetzner CAX11 on AWS credit trigger and tears down source after verify', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-migrate-fallback-'));
  tempDirs.push(root);
  const srcWs = join(root, 'src-ws');
  const dstWs = join(root, 'dst-hetzner-ws');
  await mkdir(srcWs, { recursive: true, mode: 0o700 });
  await writeFile(join(srcWs, 'progress.txt'), 'saved-before-aws-cutoff\n', { mode: 0o600 });

  let sourceFenced = false;
  let sourceFencedBeforeTargetActivate = false;
  let sourceTornDown = false;

  const result = await migrateWorkspace({
    workspaceKey: 'ws-fallback',
    journal: new OperationJournal(join(root, 'journal')),
    encryptionKey: randomBytes(32),
    trigger: {
      kind: 'AWS_FREE_PLAN',
      snapshot: {
        observedAt: '2026-11-17T23:58:00.000Z',
        accountPlanType: 'FREE',
        accountPlanStatus: 'ACTIVE',
        remainingCreditAmount: 3.5,
        creditCurrency: 'USD',
        expiresAt: '2027-02-01T00:00:00.000Z',
      },
      minCreditFloorUsd: 5,
      now: fixedNow,
    },
    source: {
      workspacePath: srcWs,
      stagingDir: join(root, 'stage'),
      exportSessions: async () => [{ info: { id: 'ses_fallback_01' }, messages: [] }],
      fenceAgent: async () => {
        sourceFenced = true;
      },
      teardownCompute: async () => {
        sourceTornDown = true;
      },
    },
    candidates: [
      {
        name: 'oci-a1-ashburn',
        targetWorkspace: join(root, 'dst-oci'),
        transport: new LoopbackHostTransport(join(root, 'spool-oci')),
        prepareCompute: async () => ({ status: 'OUT_OF_CAPACITY' }),
        activateAndImportSession: async transfer => transfer.info.id,
      },
      {
        name: 'hetzner-cax11-nbg1',
        targetWorkspace: dstWs,
        transport: new LoopbackHostTransport(join(root, 'spool-hetzner')),
        prepareCompute: async () => {
          // Source must still be running while destination compute is provisioned!
          expect(sourceFenced).toBe(false);
          return { status: 'READY', targetFingerprint: 'hcloud_0123456789abcdef' };
        },
        activateAndImportSession: async transfer => {
          sourceFencedBeforeTargetActivate = sourceFenced;
          return transfer.info.id;
        },
      },
    ],
  });

  expect(result.status).toBe('MIGRATED');
  if (result.status !== 'MIGRATED') throw new Error('Expected MIGRATED');
  expect(result.selectedTarget).toBe('hetzner-cax11-nbg1');
  expect(result.skippedTargets).toEqual([{ name: 'oci-a1-ashburn', reason: 'OUT_OF_CAPACITY' }]);
  expect(sourceFencedBeforeTargetActivate).toBe(true);
  expect(sourceTornDown).toBe(true);
  expect(await readFile(join(dstWs, 'progress.txt'), 'utf8')).toBe('saved-before-aws-cutoff\n');
});

test('keeps source running when all targets are out of capacity and never tears down source on corrupt transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-migrate-abort-'));
  tempDirs.push(root);
  const srcWs = join(root, 'src-ws');
  await mkdir(srcWs, { recursive: true, mode: 0o700 });
  await writeFile(join(srcWs, 'important.txt'), 'do-not-lose-me\n', { mode: 0o600 });

  let fenced = false;
  let tornDown = false;
  const journal = new OperationJournal(join(root, 'journal'));

  const noCap = await migrateWorkspace({
    workspaceKey: 'ws-nocap',
    journal,
    encryptionKey: randomBytes(32),
    trigger: 'MANUAL',
    source: {
      workspacePath: srcWs,
      stagingDir: join(root, 'stage-1'),
      exportSessions: async () => [],
      fenceAgent: async () => {
        fenced = true;
      },
      teardownCompute: async () => {
        tornDown = true;
      },
    },
    candidates: [
      {
        name: 'oci-a1',
        targetWorkspace: join(root, 'dst-1'),
        transport: new LoopbackHostTransport(join(root, 'spool-1')),
        prepareCompute: async () => ({ status: 'OUT_OF_CAPACITY' }),
        activateAndImportSession: async t => t.info.id,
      },
    ],
  });

  expect(noCap).toEqual({
    status: 'ABORTED_NO_CAPACITY',
    sourceIntact: true,
    skippedTargets: [{ name: 'oci-a1', reason: 'OUT_OF_CAPACITY' }],
  });
  expect(fenced).toBe(false);
  expect(tornDown).toBe(false);

  // Corrupting transport flips a ciphertext byte in transit: source compute MUST NOT be torn down!
  const corruptTransport: HostTransport = {
    saved: Buffer.alloc(0),
    async transferEncryptedCheckpoint(_id: string, bytes: Buffer) {
      const mutated = Buffer.from(bytes);
      mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 0xff;
      (this as { saved: Buffer }).saved = mutated;
    },
    async readTransferredCheckpoint() {
      return (this as { saved: Buffer }).saved;
    },
  } as HostTransport & { saved: Buffer };

  await expect(
    migrateWorkspace({
      workspaceKey: 'ws-corrupt',
      journal,
      encryptionKey: randomBytes(32),
      trigger: 'MANUAL',
      source: {
        workspacePath: srcWs,
        stagingDir: join(root, 'stage-2'),
        exportSessions: async () => [],
        fenceAgent: async () => {
          fenced = true;
        },
        teardownCompute: async () => {
          tornDown = true;
        },
      },
      candidates: [
        {
          name: 'ssh-target',
          targetWorkspace: join(root, 'dst-2'),
          transport: corruptTransport,
          prepareCompute: async () => ({ status: 'READY' }),
          activateAndImportSession: async t => t.info.id,
        },
      ],
    }),
  ).rejects.toThrow(/decrypt/i);

  // Source was fenced during checkpoint capture, so journal MUST be NEEDS_RECONCILE and source VM MUST NOT be deleted!
  expect(tornDown).toBe(false);
  const ops = await journal.list();
  expect(ops.find(o => o.workspaceKey === 'ws-corrupt')?.status).toBe('NEEDS_RECONCILE');
});

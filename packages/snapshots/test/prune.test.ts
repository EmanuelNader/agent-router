import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { pruneLocalCheckpoints } from '../src/prune.js';
import { LocalEncryptedStore } from '../src/store.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('prunes older encrypted checkpoints while keeping newest keepLast and journal-protected IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-prune-'));
  tempDirs.push(root);
  const storeDir = join(root, 'store');
  const store = new LocalEncryptedStore(storeDir, randomBytes(32));

  const ids = [
    'chk_0000000000000001',
    'chk_0000000000000002',
    'chk_0000000000000003',
    'chk_0000000000000004',
  ];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    await store.put(id, [{ path: 'note.txt', executable: false, data: Buffer.from(`v${i}`) }]);
    const ts = new Date(Date.UTC(2026, 10, 17, 20, i, 0));
    await utimes(join(storeDir, `${id}.enc`), ts, ts);
  }

  // Protect the oldest checkpoint (chk_...0001) as if referenced by a blocking journal record
  const result = await pruneLocalCheckpoints({
    storeDirectory: storeDir,
    keepLast: 2,
    protectedCheckpointIds: ['chk_0000000000000001'],
  });

  expect(result.keptIds).toEqual(['chk_0000000000000004', 'chk_0000000000000003']);
  expect(result.skippedProtectedIds).toEqual(['chk_0000000000000001']);
  expect(result.deletedIds).toEqual(['chk_0000000000000002']);
  expect(result.reclaimedBytes).toBeGreaterThan(0);

  // Kept and protected checkpoints remain readable; deleted checkpoint throws ENOENT
  expect((await store.get('chk_0000000000000001'))[0]!.data.toString()).toBe('v0');
  expect((await store.get('chk_0000000000000004'))[0]!.data.toString()).toBe('v3');
  await expect(store.get('chk_0000000000000002')).rejects.toThrow();

  await expect(pruneLocalCheckpoints({ storeDirectory: storeDir, keepLast: 0 })).rejects.toThrow(/keepLast/i);
});

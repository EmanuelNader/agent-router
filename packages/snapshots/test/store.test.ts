import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isResticAvailable, ResticRepositoryStore } from '../src/restic.js';
import { LocalEncryptedStore } from '../src/store.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('encrypts entries at rest with AES-256-GCM, preserves modes, and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-store-'));
  tempDirs.push(root);
  const key = randomBytes(32);
  const store = new LocalEncryptedStore(join(root, 'repo'), key);
  const id = 'chk_0123456789abcdef';

  await store.put(id, [
    { path: 'scripts/check.sh', executable: true, data: Buffer.from('#!/bin/sh\necho ok\n') },
    { path: 'secret-phrase.txt', executable: false, data: Buffer.from('plaintext-marker-9912') },
  ]);

  await expect(store.put(id, [])).rejects.toMatchObject({ code: 'EEXIST' });

  const rawCiphertext = await readFile(join(root, 'repo', `${id}.enc`));
  expect(rawCiphertext.includes(Buffer.from('plaintext-marker-9912'))).toBe(false);

  const restored = await store.get(id);
  expect(restored).toHaveLength(2);
  expect(restored[0]?.executable).toBe(true);
  expect(restored[1]?.data.toString('utf8')).toBe('plaintext-marker-9912');
});

test('rejects tampered ciphertext, wrong keys, and swapped checkpoint IDs (AAD binding)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-store-tamper-'));
  tempDirs.push(root);
  const key = randomBytes(32);
  const store = new LocalEncryptedStore(join(root, 'repo'), key);
  const id = 'chk_0123456789abcdef';
  const otherId = 'chk_fedcba9876543210';

  await store.put(id, [{ path: 'a.txt', executable: false, data: Buffer.from('hello') }]);

  const wrongKeyStore = new LocalEncryptedStore(join(root, 'repo'), randomBytes(32));
  await expect(wrongKeyStore.get(id)).rejects.toThrow(/decrypt/i);

  const originalPath = join(root, 'repo', `${id}.enc`);
  const swappedPath = join(root, 'repo', `${otherId}.enc`);
  await rename(originalPath, swappedPath);
  await expect(store.get(otherId)).rejects.toThrow(/decrypt/i);
  await rename(swappedPath, originalPath);

  const bytes = await readFile(originalPath);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
  await writeFile(originalPath, bytes);
  await expect(store.get(id)).rejects.toThrow(/decrypt/i);
});

describe.runIf(isResticAvailable())('ResticRepositoryStore integration', () => {
  test('initializes an encrypted restic repo, verifies integrity, and restores entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-restic-'));
    tempDirs.push(root);
    const store = new ResticRepositoryStore(join(root, 'restic-repo'), randomBytes(32).toString('hex'));
    const id = 'chk_abcdef0123456789';

    await store.put(id, [
      { path: 'workspace/scripts/check.sh', executable: true, data: Buffer.from('#!/bin/sh\nprintf ok\n') },
      { path: 'workspace/.hidden', executable: false, data: Buffer.from('secret-restic-payload-4421') },
    ]);

    await store.verifyIntegrity();
    const restored = await store.get(id);
    expect(restored).toEqual([
      { path: 'workspace/.hidden', executable: false, data: Buffer.from('secret-restic-payload-4421') },
      { path: 'workspace/scripts/check.sh', executable: true, data: Buffer.from('#!/bin/sh\nprintf ok\n') },
    ]);
  }, 20_000);
});

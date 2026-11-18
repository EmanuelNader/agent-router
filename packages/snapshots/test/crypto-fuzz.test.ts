import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { LocalEncryptedStore } from '../src/store.js';

let root: string;
let bytes: Buffer;
let store: LocalEncryptedStore;
const id = 'chk_0000000000000001';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'router-crypto-fuzz-'));
  store = new LocalEncryptedStore(root, Buffer.alloc(32, 0x42));
  await store.put(id, [{ path: 'fixture.txt', executable: false, data: Buffer.from('fixed adversarial encryption fixture') }]);
  bytes = await readFile(join(root, `${id}.enc`));
  expect(bytes.length).toBeGreaterThan(48);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

// Exhaust every bit in the header, nonce, authentication tag, and first 16
// ciphertext bytes. Mutation positions/values are fixed; encryption IVs remain random.
const bitVectors = Array.from({ length: 48 * 8 }, (_, bit) => ({ byte: Math.floor(bit / 8), mask: 1 << (bit % 8) }));
test.each(bitVectors)('crypto-fuzz rejects AR01 bit mutation byte=$byte mask=$mask', async ({ byte, mask }) => {
  const changed = Buffer.from(bytes);
  changed[byte] = changed[byte]! ^ mask;
  await writeFile(join(root, `${id}.enc`), changed);
  await expect(store.get(id)).rejects.toThrow();
});

test.each(Array.from({ length: 16 }, (_, i) => `chk_${(i + 2).toString(16).padStart(16, '0')}`))('crypto-fuzz rejects AAD swap %s', async otherId => {
  await writeFile(join(root, `${otherId}.enc`), bytes);
  await expect(store.get(otherId)).rejects.toThrow(/authentication/);
});

test('crypto-fuzz control restores the untampered container', async () => {
  await writeFile(join(root, `${id}.enc`), bytes);
  expect((await store.get(id))[0]?.data.toString()).toBe('fixed adversarial encryption fixture');
});

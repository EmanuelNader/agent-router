import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { z } from 'zod';
import { assertSafeRelativePath } from './manifest.js';

export interface SnapshotEntry {
  path: string;
  executable: boolean;
  data: Buffer;
}

export interface SnapshotStore {
  put(checkpointId: string, entries: SnapshotEntry[]): Promise<void>;
  get(checkpointId: string): Promise<SnapshotEntry[]>;
}

export const checkpointIdSchema = z.string().regex(/^chk_[a-f0-9]{16,64}$/);

const wireEntrySchema = z.object({
  path: z.string().transform(value => assertSafeRelativePath(value)),
  executable: z.boolean(),
  base64: z.string(),
});
const wireBundleSchema = z.object({
  version: z.literal(1),
  entries: z.array(wireEntrySchema),
});

export class LocalEncryptedStore implements SnapshotStore {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(directory: string, key: Buffer) {
    if (key.byteLength !== 32) throw new Error('Snapshot encryption requires a 32-byte AES-256 key');
    this.directory = resolve(directory);
    this.key = Buffer.from(key);
  }

  async put(checkpointId: string, entries: SnapshotEntry[]): Promise<void> {
    const id = checkpointIdSchema.parse(checkpointId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      version: 1,
      entries: entries.map(entry => ({
        path: assertSafeRelativePath(entry.path),
        executable: entry.executable,
        base64: entry.data.toString('base64'),
      })),
    });
    const compressed = brotliCompressSync(Buffer.from(payload, 'utf8'));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record = Buffer.concat([Buffer.from('AR01'), iv, tag, encrypted]);
    await writeFile(join(this.directory, `${id}.enc`), record, { mode: 0o600, flag: 'wx' });
  }

  async get(checkpointId: string): Promise<SnapshotEntry[]> {
    const id = checkpointIdSchema.parse(checkpointId);
    const record = await readFile(join(this.directory, `${id}.enc`));
    if (record.byteLength < 32 || !record.subarray(0, 4).equals(Buffer.from('AR01'))) {
      throw new Error('Cannot decrypt invalid checkpoint container');
    }
    const iv = record.subarray(4, 16);
    const tag = record.subarray(16, 32);
    const ciphertext = record.subarray(32);
    let compressed: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Cannot decrypt checkpoint: authentication failed');
    }
    const parsed = wireBundleSchema.parse(JSON.parse(brotliDecompressSync(compressed).toString('utf8')));
    return parsed.entries.map(entry => ({
      path: entry.path,
      executable: entry.executable,
      data: Buffer.from(entry.base64, 'base64'),
    }));
  }
}

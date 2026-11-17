import { expect, test } from 'vitest';
import { assertSafeRelativePath, checkpointManifestSchema } from '../src/manifest.js';

const validManifest = {
  schemaVersion: 1 as const,
  checkpointId: 'chk_0123456789abcdef0123456789abcdef',
  createdAt: '2026-11-17T22:00:00.000Z',
  architecture: 'arm64',
  opencodeVersion: '2.2.7' as const,
  sessionIds: ['ses_fixture1'],
  git: {
    present: true as const,
    head: '0123456789abcdef0123456789abcdef01234567',
    statusPorcelain: ' M src/message.txt\n?? notes.txt\n',
    indexStage: '100644 0123456789abcdef0123456789abcdef01234567 0\tsrc/message.txt\n',
  },
  workspaceFiles: [
    {
      path: 'src/message.txt',
      executable: false,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  ],
};

test('accepts a valid v1 checkpoint manifest', () => {
  expect(checkpointManifestSchema.parse(validManifest)).toEqual(validManifest);
});

test('rejects wrong schemaVersion, wrong opencodeVersion, malformed hashes, or unsafe paths', () => {
  expect(() => checkpointManifestSchema.parse({ ...validManifest, schemaVersion: 2 })).toThrow();
  expect(() => checkpointManifestSchema.parse({ ...validManifest, opencodeVersion: '1.0.0' })).toThrow();
  expect(() =>
    checkpointManifestSchema.parse({
      ...validManifest,
      workspaceFiles: [{ ...validManifest.workspaceFiles[0]!, sha256: 'not-a-sha256' }],
    }),
  ).toThrow();
  expect(() =>
    checkpointManifestSchema.parse({
      ...validManifest,
      workspaceFiles: [{ ...validManifest.workspaceFiles[0]!, path: '../escape.txt' }],
    }),
  ).toThrow();
});

test('assertSafeRelativePath rejects traversal, absolute, backslash, empty, and NUL paths', () => {
  expect(assertSafeRelativePath('.git/HEAD')).toBe('.git/HEAD');
  expect(() => assertSafeRelativePath('')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('/etc/passwd')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('a/../b')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('a\\b')).toThrow(/relative path/i);
  expect(() => assertSafeRelativePath('a\0b')).toThrow(/relative path/i);
});

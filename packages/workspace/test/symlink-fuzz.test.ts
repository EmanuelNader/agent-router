import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { validateWorkspaceLink } from '../src/symlinks.js';

test.each(Array.from({ length: 16 }, (_, depth) => depth))('symlink-fuzz rejects root escape from depth %i', async depth => {
  const root = await mkdtemp(join(tmpdir(), 'router-link-fuzz-'));
  try {
    const parts = Array.from({ length: depth }, (_, i) => `d${i}`);
    await mkdir(join(root, ...parts), { recursive: true });
    const relative = [...parts, 'link'].join('/');
    const target = '../'.repeat(depth + 1) + 'outside';
    await symlink(target, join(root, relative));
    await expect(validateWorkspaceLink(root, relative, target)).rejects.toThrow(/escape/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(Array.from({ length: 8 }, (_, depth) => depth + 1))('symlink-fuzz rejects an indirect absolute escape after %i links', async depth => {
  const root = await mkdtemp(join(tmpdir(), 'router-chain-fuzz-'));
  try {
    for (let i = 0; i < depth; i++) await symlink(i === depth - 1 ? '/etc/passwd' : `link${i + 1}`, join(root, `link${i}`));
    await expect(validateWorkspaceLink(root, 'entry', 'link0')).rejects.toThrow(/relative/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symlink-fuzz control allows a confined parent-relative target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-link-control-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'data'), 'fixture');
    await symlink('../data', join(root, 'nested/link'));
    await expect(validateWorkspaceLink(root, 'nested/link', '../data')).resolves.toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

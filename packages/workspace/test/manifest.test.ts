import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashWorkspace } from '../src/manifest.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'router-manifest-'));
  temporary.push(root);
  return root;
}

test('includes hidden and untracked files with deterministic paths and executable permissions', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'not part of content receipt');
  await writeFile(path.join(root, 'z.txt'), 'abc');
  await writeFile(path.join(root, '.note'), '');
  await chmod(path.join(root, 'z.txt'), 0o755);
  expect(await hashWorkspace(root)).toEqual([
    { path: '.note', executable: false, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    { path: 'z.txt', executable: true, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
  ]);
});

test('detects changed file contents rather than just filenames', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'file'), 'abc');
  const before = await hashWorkspace(root);
  await writeFile(path.join(root, 'file'), 'changed');
  expect(await hashWorkspace(root)).not.toEqual(before);
});

test('rejects symlinks instead of reading outside the selected workspace', async () => {
  const root = await fixture();
  await symlink('/etc/passwd', path.join(root, 'outside'));
  await expect(hashWorkspace(root)).rejects.toThrow(/symlink/i);
});

test('rejects a symlink used as the workspace root', async () => {
  const root = await fixture();
  const alias = path.join(root, 'alias');
  await symlink(root, alias);
  await expect(hashWorkspace(alias)).rejects.toThrow(/directory/i);
});

import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SnapshotPaths } from '../src/paths.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

test('sees a missing nested path as inside its parent and does not create it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'router-paths-'));
  temporary.push(root);
  const workspace = path.join(root, 'workspace');
  const missing = path.join(workspace, 'nested-repo');
  await mkdir(workspace);
  expect(await SnapshotPaths.isInside(workspace, missing)).toBe(true);
  expect(await SnapshotPaths.isInside(missing, workspace)).toBe(false);
  expect(await SnapshotPaths.isInside(workspace, path.join(root, 'elsewhere'))).toBe(false);
  await expect(lstat(missing)).rejects.toThrow();
});

test('follows a symlink when deciding whether a missing repository would land in the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'router-paths-link-'));
  temporary.push(root);
  const realWorkspace = path.join(root, 'real');
  const linked = path.join(root, 'linked');
  await mkdir(realWorkspace);
  await symlink(realWorkspace, linked);
  expect(await SnapshotPaths.isInside(linked, path.join(linked, 'nested-repo'))).toBe(true);
  await expect(lstat(path.join(realWorkspace, 'nested-repo'))).rejects.toThrow();
});

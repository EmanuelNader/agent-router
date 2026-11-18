import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { captureAgentCheckpoint, restoreAgentCheckpoint } from '../src/checkpoint.js';
import { LocalEncryptedStore } from '../src/store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'router-v3-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'lib'), { recursive: true });
  await writeFile(join(source, 'lib/data'), 'portable');
  return { root, source, store: new LocalEncryptedStore(join(root, 'store'), randomBytes(32)) };
}

test('v3 preserves confined file/directory symlinks and excludes disposable caches', async () => {
  const { root, source, store } = await fixture();
  await symlink('lib/data', join(source, 'file-link'));
  await symlink('lib', join(source, 'dir-link'));
  await symlink('dir-link/data', join(source, 'chain'));
  for (const cache of ['node_modules', '.pnpm-store', '.work']) {
    await mkdir(join(source, cache));
    await writeFile(join(source, cache, 'disposable'), 'not portable');
  }
  const manifest = await captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } });
  expect(manifest.schemaVersion).toBe(3);
  const target = join(root, 'target');
  await restoreAgentCheckpoint({ checkpointId: manifest.checkpointId, targetWorkspace: target, store, agent: { kind: 'none' } });
  expect(await readlink(join(target, 'file-link'))).toBe('lib/data');
  expect(await readlink(join(target, 'dir-link'))).toBe('lib');
  expect(await readFile(join(target, 'chain'), 'utf8')).toBe('portable');
  for (const cache of ['node_modules', '.pnpm-store', '.work']) await expect(access(join(target, cache))).rejects.toThrow();
});

test.each(['../outside', '/etc/passwd', 'lib/../../outside'])('rejects escaping symlink %s before storing a checkpoint', async target => {
  const { source, store } = await fixture();
  await symlink(target, join(source, 'escape'));
  await expect(captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } })).rejects.toThrow(/symlink|escape|relative/i);
});

test('supports configured cache exclusions and explicitly retaining default cache names', async () => {
  const { root, source, store } = await fixture();
  for (const name of ['custom-cache', 'node_modules']) {
    await mkdir(join(source, name));
    await writeFile(join(source, name, 'data'), name);
  }
  const manifest = await captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' }, exclusions: ['custom-cache'] });
  const target = join(root, 'target');
  await restoreAgentCheckpoint({ checkpointId: manifest.checkpointId, targetWorkspace: target, store, agent: { kind: 'none' } });
  await expect(access(join(target, 'custom-cache'))).rejects.toThrow();
  expect(await readFile(join(target, 'node_modules/data'), 'utf8')).toBe('node_modules');
});

test.each(['cycle', 'indirect-escape', 'metadata'])('rejects unsafe symlink graph: %s', async kind => {
  const { source, store } = await fixture();
  if (kind === 'cycle') {
    await symlink('b', join(source, 'a'));
    await symlink('a', join(source, 'b'));
  } else if (kind === 'indirect-escape') {
    await symlink('../../outside', join(source, 'lib/escape'));
    await symlink('lib/escape/data', join(source, 'a'));
  } else await symlink('.git/config', join(source, 'a'));
  await expect(captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } })).rejects.toThrow(/symlink/i);
});

test('rejects an archive file below a symlink before creating the target', async () => {
  const { root, source, store } = await fixture();
  await symlink('lib', join(source, 'alias'));
  const manifest = await captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } });
  const entries = await store.get(manifest.checkpointId);
  entries.push({ path: 'workspace/alias/injected', executable: false, data: Buffer.from('unsafe') });
  const target = join(root, 'target');
  await expect(restoreAgentCheckpoint({
    checkpointId: manifest.checkpointId, targetWorkspace: target,
    store: { put: async () => {}, get: async () => entries }, agent: { kind: 'none' },
  })).rejects.toThrow(/overlaps symlink/);
  await expect(access(target)).rejects.toThrow();
});

test.each([1, 2])('still restores a legacy v%s checkpoint', async version => {
  const { root, source, store } = await fixture();
  const manifest = await captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } });
  const entries = await store.get(manifest.checkpointId);
  const legacy: Record<string, unknown> = { ...manifest, schemaVersion: version };
  delete legacy.exclusions;
  delete legacy.symlinks;
  if (version === 1) {
    delete legacy.agentKind;
    legacy.opencodeVersion = '2.2.7';
  }
  const compatible = entries.filter(entry => version !== 1 || entry.path !== 'meta/agent.json').map(entry =>
    entry.path === 'meta/manifest.json' ? { ...entry, data: Buffer.from(JSON.stringify(legacy)) } : entry);
  if (version === 1) compatible.push({ path: 'meta/sessions.json', executable: false, data: Buffer.from('[]') });
  const target = join(root, 'legacy');
  const restored = await restoreAgentCheckpoint({
    checkpointId: manifest.checkpointId, targetWorkspace: target,
    store: { put: async () => {}, get: async () => compatible }, agent: { kind: 'none' },
  });
  expect(restored.schemaVersion).toBe(version);
  expect(await readFile(join(target, 'lib/data'), 'utf8')).toBe('portable');
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, readlink } from 'node:fs/promises';
import { restoreAgentCheckpoint } from '../packages/snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../packages/snapshots/src/store.js';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node.split('.')[0], '24');
assert.match(await readFile('/etc/os-release', 'utf8'), /VERSION_ID="24\.04"/);
const [storeDir, keyFile, checkpointId, target] = process.argv.slice(2);
assert.ok(storeDir && keyFile && checkpointId && target);
const manifest = await restoreAgentCheckpoint({
  checkpointId, targetWorkspace: target, store: new LocalEncryptedStore(storeDir, await readFile(keyFile)), agent: { kind: 'none' },
});
assert.equal(manifest.schemaVersion, 3);
assert.equal(await readFile(`${target}/src/data.txt`, 'utf8'), 'dirty\n');
assert.equal(await readFile(`${target}/untracked.txt`, 'utf8'), 'untracked\n');
assert.equal(await readlink(`${target}/link.txt`), 'src/data.txt');
assert.equal(execFileSync('git', ['show', ':src/data.txt'], { cwd: target, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: target, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }), 'staged\n');
await assert.rejects(access(`${target}/node_modules`));
console.log(JSON.stringify({ status: 'LINUX_V3_RESTORED', architecture: 'linux/aarch64', ubuntu: '24.04', nodeMajor: 24,
  schemaVersion: 3, dirtyLinkedWorktree: true, stagedIndex: true, symlink: true, cachesExcluded: true }));

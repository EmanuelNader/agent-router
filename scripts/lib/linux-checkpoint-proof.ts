import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureAgentCheckpoint, restoreAgentCheckpoint } from '../../packages/snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../../packages/snapshots/src/store.js';
import { verificationDockerEnvironment } from '../../packages/workspace/src/docker.js';

export const CHECKPOINT_LINUX_IMAGE = 'agent-router-verification:ubuntu24-node24';

export async function verifyLinuxCheckpoint() {
  const root = await mkdtemp(join(tmpdir(), 'router-v3-linux-'));
  const name = `router-v3-${randomBytes(6).toString('hex')}`;
  const docker = (args: string[]) => execFileSync('docker', args, {
    env: verificationDockerEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000,
  });
  const git = (cwd: string, args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  let started = false;
  try {
    docker(['image', 'inspect', CHECKPOINT_LINUX_IMAGE]);
    const base = join(root, 'base');
    const source = join(root, 'linked');
    await mkdir(join(base, 'src'), { recursive: true });
    await writeFile(join(base, 'src/data.txt'), 'committed\n');
    await symlink('src/data.txt', join(base, 'link.txt'));
    git(base, ['init', '-q']); git(base, ['add', '.']);
    git(base, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    git(base, ['worktree', 'add', '-q', '--detach', source]);
    await writeFile(join(source, 'src/data.txt'), 'staged\n'); git(source, ['add', 'src/data.txt']);
    await writeFile(join(source, 'src/data.txt'), 'dirty\n');
    await writeFile(join(source, 'untracked.txt'), 'untracked\n');
    await mkdir(join(source, 'node_modules'));
    await writeFile(join(source, 'node_modules/disposable'), 'excluded');
    const key = randomBytes(32);
    const store = new LocalEncryptedStore(join(root, 'store'), key);
    const manifest = await captureAgentCheckpoint({ workspace: source, store, agent: { kind: 'none' } });
    // A copied gitdir pointer cannot pass either restore after this deletion.
    await rm(base, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    await restoreAgentCheckpoint({ checkpointId: manifest.checkpointId, targetWorkspace: join(root, 'native'), store, agent: { kind: 'none' } });

    const runtime = join(root, 'runtime');
    await mkdir(join(runtime, 'node_modules'), { recursive: true });
    // A separate output directory avoids racing the standalone build test's
    // cleanup of dist/ while Vitest runs files concurrently.
    execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', resolve('tsconfig.build.json'), '--outDir', join(runtime, 'dist')], {
      stdio: 'ignore', timeout: 60_000,
    });
    for (const dependency of ['zod', 'smol-toml', 'jsonc-parser']) {
      await cp(await realpath(resolve('node_modules', dependency)), join(runtime, 'node_modules', dependency), { recursive: true });
    }
    await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, 'key'), key, { mode: 0o600 });
    docker(['run', '-d', '--rm', '--platform=linux/arm64', '--network=none', '--name', name, CHECKPOINT_LINUX_IMAGE, 'sleep', '120']);
    started = true;
    docker(['cp', runtime, `${name}:/proof`]);
    docker(['cp', join(root, 'store'), `${name}:/store`]);
    docker(['cp', join(root, 'key'), `${name}:/key`]);
    const result = JSON.parse(docker(['exec', name, 'node', '/proof/dist/scripts/linux-checkpoint-guest.js', '/store', '/key', manifest.checkpointId, '/restored']));
    assert.equal(result.status, 'LINUX_V3_RESTORED');
    assert.equal(result.architecture, 'linux/aarch64');
    assert.equal(result.stagedIndex, true);
    assert.equal(result.symlink, true);
    assert.equal(result.cachesExcluded, true);
    return result as { status: 'LINUX_V3_RESTORED'; architecture: 'linux/aarch64'; schemaVersion: 3 };
  } finally {
    if (started) { try { docker(['rm', '-f', name]); } catch { /* --rm container may already have exited */ } }
    await rm(root, { recursive: true, force: true });
  }
}

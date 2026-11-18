import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('compiles standalone dist/ build and executes bin/agent-router.mjs natively on Node 24 without tsx', () => {
  const repoRoot = resolve('.');
  execFileSync('pnpm', ['build'], { cwd: repoRoot, encoding: 'utf8' });

  const binPath = resolve('bin/agent-router.mjs');
  const versionOut = execFileSync(process.execPath, [binPath, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(versionOut.trim()).toBe('1.0.0');

  const simOut = execFileSync(process.execPath, [binPath, 'migrate:simulate', '--workspace-key', 'ws-bin-check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  expect(JSON.parse(simOut)).toMatchObject({
    status: 'MIGRATED',
    workspaceKey: 'ws-bin-check',
    selectedTarget: 'hetzner-cax11-fallback',
  });
}, 20_000);

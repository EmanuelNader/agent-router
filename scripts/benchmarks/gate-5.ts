import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

await mkdir('.work', { recursive: true, mode: 0o700 });
const root = await mkdtemp(resolve('.work/fuzz-proof-'));
try {
  const files: string[] = [];
  for (const entry of await readdir('packages', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let names: string[];
    try { names = await readdir(join('packages', entry.name, 'test')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const name of names) if (/fuzz.*\.test\.ts$/.test(name)) files.push(join('packages', entry.name, 'test', name));
  }
  assert.ok(files.length >= 7);
  const report = join(root, 'result.json');
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files.sort(), '--reporter=json', `--outputFile=${report}`], { stdio: 'ignore', timeout: 120_000 });
  assert.equal(run.status, 0, 'Adversarial suite must pass');
  const data = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(data.success, true);
  assert.equal(data.numPendingTests, 0);
  assert.equal(data.numTodoTests, 0);
  assert.equal(data.testResults.length, files.length);
  const names: string[] = [];
  for (const suite of data.testResults) {
    assert.equal(suite.status, 'passed');
    for (const test of suite.assertionResults) {
      assert.equal(test.status, 'passed');
      if (!test.fullName.includes('control')) names.push(test.fullName);
    }
  }
  for (const family of ['crypto-fuzz', 'ssh-fuzz', 'path-fuzz', 'journal-fuzz', 'symlink-fuzz', 'guard-fuzz']) {
    assert.ok(names.some(name => name.includes(family)), `Missing adversarial family: ${family}`);
  }
  assert.ok(names.some(name => name.includes('AAD swap')));
  assert.ok(names.some(name => name.includes('ProxyCommand')));
  assert.ok(names.some(name => name.includes('IdentityFile')));
  assert.ok(names.some(name => name.includes('real process')));
  assert.ok(names.length >= 200);
  console.log(JSON.stringify({ status: 'GATE_5_VERIFIED', executedAdversarialVectors: names.length, files: files.length }));
} finally { await rm(root, { recursive: true, force: true }); }

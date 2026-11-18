import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.version, '1.0.0');
assert.equal(pkg.packageManager, 'pnpm@11.25.0');
assert.equal(execFileSync('node', ['bin/agent-router.mjs', '--version'], { encoding: 'utf8' }).trim(), pkg.version);
const help = execFileSync('node', ['bin/agent-router.mjs', '--help'], { encoding: 'utf8' });
for (const command of ['1.0.0', 'mcp:doctor', 'fly:guard', 'fly:simulate-lifecycle', 'checkpoint', 'watch:simulate']) assert.ok(help.includes(command));

const report = JSON.parse(readFileSync('.work/benchmark-tests.json', 'utf8'));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
const attacks = report.testResults.flatMap((suite: { assertionResults: { fullName: string }[] }) => suite.assertionResults).filter((test: { fullName: string }) => test.fullName.includes('fuzz') && !test.fullName.includes('control')).length;
assert.ok(attacks >= 200);
for (const file of ['README.md', 'docs/plans/agent-router-execution-plan.md', 'docs/evidence/08-v1-benchmark.md']) {
  const doc = readFileSync(file, 'utf8');
  for (const fact of ['1.0.0', 'v3', 'ACP', 'MCP', 'Fly', 'ubuntu:24.04']) assert.ok(doc.includes(fact), `${file}: missing release evidence ${fact}`);
  const current = file.endsWith('08-v1-benchmark.md') ? doc.split('## Earlier implementation observations')[0] : file === 'README.md' ? doc.split('## Run the local proof')[0] : doc.split('## v1.0.0 autonomous benchmark work')[1];
  assert.ok(current);
  assert.ok(current.includes(`${report.numPassedTests} tests`), `${file}: stale test count`);
  assert.ok(new RegExp(`\\b${attacks} (?:adversarial|attack)`).test(current), `${file}: stale adversarial count`);
  for (const privatePath of [process.cwd(), homedir()]) assert.ok(!doc.includes(privatePath), `${file}: private path`);
  assert.doesNotMatch(doc, /(?:\/Users\/|\/home\/)[\w.-]+\//);
  assert.doesNotMatch(doc, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bocid1\.[a-z0-9]+\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9]{20,}/i);
}
const evidence = readFileSync('docs/evidence/08-v1-benchmark.md', 'utf8');
for (const boundary of ['CONFIGURATION_LOADING_ONLY', 'IMPORTED_USER_MESSAGE', 'zero skipped', 'zero live cloud', 'define_subagent']) assert.ok(evidence.includes(boundary));
console.log('GATE_8_RELEASE_DOCUMENTATION_VERIFIED');

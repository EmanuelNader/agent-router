import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
const root = resolve(import.meta.dirname, '..');
const gates = [
  'Portable v3 checkpoints: linked worktrees, safe symlinks, Linux restore',
  'Cross-agent MCP translation and fail-closed secret doctor',
  'ACP v1 live OpenCode cold resume',
  'Fly cost guardrails and crash-reconciled simulated lifecycle',
  'At least 200 adversarial vectors across all required boundaries',
  'Real multi-hop v1 E2E with all required tools and zero remnants',
  'Build, check, probe, roundtrip, E2E and test-count bar',
  'v1 release documentation and sanitized observed evidence',
];

function run(args: string[]): boolean {
  // Child diagnostics may contain private paths or upstream responses. Emit only
  // fixed command labels and exit status; never persist raw child output.
  const result = spawnSync('pnpm', args, {
    cwd: root, stdio: 'ignore', timeout: 15 * 60_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return !result.error && result.status === 0;
}

function buildBar(): boolean {
  const checks = ['build', 'check', 'agent:probe', 'agent:roundtrip', 'e2e'];
  let passed = true;
  for (const check of checks) {
    const ok = run([check]);
    console.log(`  ${check}: ${ok ? 'PASS' : 'FAIL'}`);
    passed = ok && passed;
  }
  const report = resolve(root, '.work/benchmark-tests.json');
  mkdirSync(resolve(root, '.work'), { recursive: true, mode: 0o700 });
  // Remove stale-report ambiguity: a report is trusted only after this test run
  // itself succeeds, never when a command fails or times out.
  const tested = run(['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`]);
  if (!tested) return false;
  try {
    const data = JSON.parse(readFileSync(report, 'utf8'));
    return passed && data.success === true && data.numPassedTests >= 140
      && data.numFailedTests === 0 && data.numPendingTests === 0
      && data.numTodoTests === 0 && data.numPendingTestSuites === 0
      && Array.isArray(data.testResults) && data.testResults.length > 0
      && data.testResults.every((suite: { status: string }) => suite.status === 'passed');
  } catch { return false; }
}

let passed = 0;
for (const [index, name] of gates.entries()) {
  const number = index + 1;
  // Dedicated gate proofs must assert every subrequirement, including real tool
  // compatibility. Missing proofs fail closed; source-file presence earns no credit.
  const proof = `scripts/benchmarks/gate-${number}.ts`;
  const ok = number === 7 ? buildBar()
    : existsSync(resolve(root, proof)) && run(['exec', 'tsx', proof]);
  if (ok) passed++;
  console.log(`Gate ${number}: ${ok ? 'PASS' : 'FAIL'} — ${name}`);
}
console.log(`${passed}/8 gates; ${passed * 12.5}/100`);
process.exitCode = passed === 8 ? 0 : 1;

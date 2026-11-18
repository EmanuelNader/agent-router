import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Contract/fault tests use injected transports and one local Unix socket.
// This gate never instantiates a credentialed cloud connection.
execFileSync('pnpm', ['exec', 'vitest', 'run', 'packages/cloud-fly/test'], { stdio: 'ignore', timeout: 120_000 });
function cli(command: string, args: string[] = []) {
  return JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/router.ts', command, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
  }));
}
const guard = cli('fly:guard', ['--demo']);
assert.equal(guard.status, 'GUARDED_PAID_TARGET');
assert.equal(guard.source, 'DEMO');
assert.equal(guard.liveProvisioningAllowed, false);
assert.ok(guard.maximumAdditionalUsd > 0);
const lifecycle = cli('fly:simulate-lifecycle');
assert.equal(lifecycle.crashReconciled, true);
assert.equal(lifecycle.remnants, 0);
assert.equal(lifecycle.blockingJournalEntries, 0);
assert.equal(lifecycle.liveCloudCalls, 0);
console.log('GATE_4_FLY_CONTRACT_AND_MIGRATION_VERIFIED');

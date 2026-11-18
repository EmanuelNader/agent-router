import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const receipt = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e.ts'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180_000,
}));
assert.equal(receipt.status, 'E2E_VERIFIED');
assert.equal(receipt.version, '1.0.0');
assert.equal(receipt.acp.protocolVersion, 1);
assert.equal(receipt.acp.agentVersion, '2.2.7');
assert.equal(receipt.acp.coldResume, true);
assert.equal(receipt.mcpLoaders.status, 'MCP_LOADERS_VERIFIED');
assert.equal(receipt.mcpDoctor, 'MCP_PORTABLE');
assert.equal(receipt.linkedWorktreeSource, true);
assert.equal(receipt.linuxGuestVerified, 'Linux/aarch64');
assert.equal(receipt.linuxCheckpoint.status, 'LINUX_V3_RESTORED');
assert.equal(receipt.linuxCheckpoint.stagedIndex, true);
assert.equal(receipt.linuxCheckpoint.symlink, true);
assert.equal(receipt.returnTransport, 'RESTIC_OVER_LIVE_SFTP');
assert.equal(receipt.watchOutcome, 'EVACUATED');
assert.equal(receipt.watchTicksRun, 2);
assert.equal(receipt.maxConcurrentAgents, 1);
assert.equal(receipt.blockingJournalEntries, 0);
for (const count of Object.values(receipt.finalCloudRemnants)) assert.equal(count, 0);
for (const agent of ['opencode@2.2.7', 'codex-cli', 'claude-code']) assert.ok(receipt.verifiedAgentAdapters.includes(agent));
for (const daemon of ['openssh-sshd', 'ssh', 'scp', 'restic-sftp']) assert.ok(receipt.daemonsExercised.includes(daemon));
console.log('GATE_6_MASTER_E2E_VERIFIED');

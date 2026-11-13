import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpenCodeAdapter } from '../packages/agent-opencode/src/adapter.js';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';
import { OPENCODE_VERSION, startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import { SnapshotIdentity, WORKSPACE_EXCLUSIONS } from '../packages/domain/src/snapshot.js';
import { WorkspaceCapture } from '../packages/snapshots/src/capture.js';
import { SnapshotPrivacy } from '../packages/snapshots/src/privacy.js';
import { ResticRepository } from '../packages/snapshots/src/restic.js';
import { WorkspaceRestore } from '../packages/snapshots/src/restore.js';
import { MigrationFixture } from '../packages/workspace/src/fixture.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/restore-'));
const keyDirectory = await mkdtemp(join(tmpdir(), 'router-snapshot-key-'));
let sourceAgent: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
let targetAgent: Awaited<ReturnType<typeof OpenCodeAdapter.resume>> | undefined;
const elapsed = (start: number) => Math.round(performance.now() - start);
try {
  const source = join(run, 'source');
  await MigrationFixture.prepare(resolve('fixtures/workspace'), source);
  sourceAgent = await startIsolatedServer(source, join(run, 'source-agent'));
  const created = await sourceAgent.client.createSession(source, 'Router restore fixture');
  await sourceAgent.client.runShellCommand(created, "printf 'router-history-fixture\\n'");
  const transfer = await OpenCodeAdapter.quiesce(sourceAgent, created);
  sourceAgent = undefined;
  requireCompletedShellOutput(transfer.messages, 'router-history-fixture\n');
  const before = await hashWorkspace(source, WORKSPACE_EXCLUSIONS);
  const beforeGit = MigrationFixture.git(source, ['status', '--porcelain=v1', '--untracked-files=all']);
  const beforeHead = MigrationFixture.git(source, ['rev-parse', 'HEAD']);
  const beforeIndex = MigrationFixture.git(source, ['ls-files', '--stage']);
  const host = SnapshotIdentity.current(OPENCODE_VERSION, randomUUID());
  const passwordFile = await WorkspaceCapture.writeKey(keyDirectory);
  const repository = new ResticRepository({ repository: join(run, 'repository'), passwordFile });
  const captureStart = performance.now();
  const manifest = await WorkspaceCapture.checkpoint({ workspaceDirectory: source, session: transfer, host, repository });
  const captureMs = elapsed(captureStart);
  for (const phrase of ['router-history-fixture', 'keep this hidden note', 'unfinished work survives migration', 'dependency cache stays behind']) {
    if (await SnapshotPrivacy.contains(repository.directory(), phrase)) throw new Error('Checkpoint repository contains plaintext');
  }
  const restoreStart = performance.now();
  const restored = await WorkspaceRestore.restore({ manifest, repository, targetDirectory: join(run, 'restored'), host });
  const restoreMs = elapsed(restoreStart);
  assert.deepEqual(await hashWorkspace(restored.workspaceDirectory, WORKSPACE_EXCLUSIONS), before);
  assert.equal(await readFile(join(restored.workspaceDirectory, '.workspace-note'), 'utf8'), 'keep this hidden note\n');
  assert.equal(await readFile(join(restored.workspaceDirectory, 'notes.txt'), 'utf8'), 'keep this untracked note\n');
  assert.equal(await readFile(join(restored.workspaceDirectory, 'PROJECT.md'), 'utf8'), 'router migration fixture\n');
  await assert.rejects(access(join(restored.workspaceDirectory, 'README.md')));
  await assert.rejects(lstat(join(restored.workspaceDirectory, 'node_modules')));
  await assert.rejects(lstat(join(restored.workspaceDirectory, '.cache')));
  assert.equal(execFileSync(join(restored.workspaceDirectory, 'scripts/check.sh'), { encoding: 'utf8' }), 'fixture-ok\n');
  assert.equal(MigrationFixture.git(restored.workspaceDirectory, ['status', '--porcelain=v1', '--untracked-files=all']), beforeGit);
  assert.equal(MigrationFixture.git(restored.workspaceDirectory, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(MigrationFixture.git(restored.workspaceDirectory, ['ls-files', '--stage']), beforeIndex);
  const resumeStart = performance.now();
  targetAgent = await OpenCodeAdapter.resume(restored.workspaceDirectory, join(run, 'target-agent'), restored.session);
  const resumeMs = elapsed(resumeStart);
  const exported = await targetAgent.client.exportSession(targetAgent.sessionId);
  assert.equal(exported.info.id, created);
  assert.equal((exported.info.location as { directory?: unknown } | undefined)?.directory, restored.workspaceDirectory);
  assert.deepEqual(exported.messages, transfer.messages);
  requireCompletedShellOutput(exported.messages, 'router-history-fixture\n');
  await targetAgent.client.runShellCommand(targetAgent.sessionId, "printf 'router-history-continued\\n'");
  const continued = await targetAgent.client.exportSession(targetAgent.sessionId);
  assert.equal(continued.info.id, created);
  requireCompletedShellOutput(continued.messages, 'router-history-fixture\n');
  requireCompletedShellOutput(continued.messages, 'router-history-continued\n');
  console.log(JSON.stringify({
    status: 'PASS', consistency: manifest.consistency, formatVersion: manifest.formatVersion,
    resticVersion: manifest.resticVersion, snapshotId: manifest.snapshotId, encryption: 'restic-repository',
    plaintextInRepository: 'ABSENT', fileHashes: 'PASS', gitWorkingTree: 'PASS', executable: 'PASS',
    hiddenUntrackedRename: 'PASS', cacheExcluded: 'PASS', sessionId: 'PRESERVED',
    settledShellHistory: 'PRESERVED', continuedShell: 'PASS', freshAgentState: true,
    files: before, captureMs, restoreMs, resumeMs,
    modelInference: 'UNTESTED', pendingInput: 'NOT_TRANSFERRED', cloudMigration: 'UNTESTED',
  }, null, 2));
} finally {
  await sourceAgent?.stop();
  await targetAgent?.stop();
  await rm(run, { recursive: true, force: true });
  await rm(keyDirectory, { recursive: true, force: true });
}

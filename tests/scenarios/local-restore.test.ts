import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeAdapter } from '../../packages/agent-opencode/src/adapter.js';
import { requireCompletedShellOutput } from '../../packages/agent-opencode/src/history.js';
import type { SessionTransfer } from '../../packages/agent-opencode/src/client.js';
import { OPENCODE_VERSION, startIsolatedServer } from '../../packages/agent-opencode/src/server.js';
import { SnapshotError, SnapshotIdentity, WORKSPACE_EXCLUSIONS, type SnapshotHost } from '../../packages/domain/src/snapshot.js';
import { WorkspaceCapture } from '../../packages/snapshots/src/capture.js';
import { SnapshotPrivacy } from '../../packages/snapshots/src/privacy.js';
import { ResticRepository } from '../../packages/snapshots/src/restic.js';
import { WorkspaceRestore } from '../../packages/snapshots/src/restore.js';
import { MigrationFixture } from '../../packages/workspace/src/fixture.js';
import { hashWorkspace } from '../../packages/workspace/src/manifest.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const savedSession: SessionTransfer = {
  info: { id: 'ses_local_restore', title: 'fixture' },
  messages: [{
    type: 'shell', status: 'exited', exit: 0, time: { completed: 1_700_000_000_000 },
    command: "printf 'router-history-fixture\\n'",
    output: { output: 'router-history-fixture\n' },
  }],
};

class CheckpointHarness {
  private constructor(
    readonly root: string,
    readonly workspace: string,
    readonly repository: ResticRepository,
    readonly host: SnapshotHost,
  ) {}

  static async open(): Promise<CheckpointHarness> {
    const root = await mkdtemp(path.join(tmpdir(), 'router-restore-'));
    const keyDirectory = await mkdtemp(path.join(tmpdir(), 'router-key-'));
    temporary.push(root, keyDirectory);
    const workspace = path.join(root, 'source');
    await MigrationFixture.prepare(path.resolve('fixtures/workspace'), workspace);
    const repository = new ResticRepository({
      repository: path.join(root, 'repository'),
      passwordFile: await WorkspaceCapture.writeKey(keyDirectory),
    });
    return new CheckpointHarness(root, workspace, repository, SnapshotIdentity.current(OPENCODE_VERSION, randomUUID()));
  }

  capture(session: SessionTransfer = savedSession) {
    return WorkspaceCapture.checkpoint({ workspaceDirectory: this.workspace, session, host: this.host, repository: this.repository });
  }

  restore(manifest: unknown, name: string) {
    return WorkspaceRestore.restore({
      manifest, repository: this.repository, host: this.host, targetDirectory: path.join(this.root, name),
    });
  }
}

class RepositoryBytes {
  static async flipPack(repository: string): Promise<void> {
    const pack = await RepositoryBytes.firstPack(path.join(repository, 'data'));
    if (!pack) throw new Error('No restic pack to corrupt');
    await chmod(pack, 0o600);
    const data = await readFile(pack);
    const index = Math.min(32, data.length - 1);
    data[index] = (data[index] ?? 0) ^ 0xff;
    await writeFile(pack, data);
  }

  private static async firstPack(directory: string): Promise<string | undefined> {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    for (const name of names) {
      const absolute = path.join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        const nested = await RepositoryBytes.firstPack(absolute);
        if (nested) return nested;
      } else if (stat.isFile()) return absolute;
    }
    return undefined;
  }
}

test('restores the quiesced workspace and session from an encrypted repository', async () => {
  const harness = await CheckpointHarness.open();
  const before = await hashWorkspace(harness.workspace, WORKSPACE_EXCLUSIONS);
  const beforeGit = MigrationFixture.git(harness.workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
  expect(before.map(file => file.path)).toEqual(expect.arrayContaining(['.workspace-note', 'PROJECT.md', 'notes.txt', 'scripts/check.sh', 'src/message.txt']));
  expect(before.map(file => file.path)).not.toContain('README.md');
  expect(before.find(file => file.path === 'scripts/check.sh')?.executable).toBe(true);
  expect(beforeGit).toContain('notes.txt');
  expect(beforeGit).toContain('.workspace-note');
  expect(beforeGit).toContain('PROJECT.md');
  expect(beforeGit).not.toContain('node_modules');
  const manifest = await harness.capture();
  await writeFile(path.join(harness.workspace, 'notes.txt'), 'changed after checkpoint\n');
  for (const phrase of [
    'router-history-fixture', 'keep this hidden note', 'unfinished work survives migration',
    'dependency cache stays behind', 'nested dependency cache stays behind', 'nested tool cache stays behind', 'symlink cache stays behind',
  ]) {
    expect(await SnapshotPrivacy.contains(harness.repository.directory(), phrase)).toBe(false);
  }
  const restored = await harness.restore(manifest, 'restored');
  expect(await hashWorkspace(restored.workspaceDirectory, WORKSPACE_EXCLUSIONS)).toEqual(before);
  expect(await readFile(path.join(restored.workspaceDirectory, 'notes.txt'), 'utf8')).toBe('keep this untracked note\n');
  expect(await readFile(path.join(restored.workspaceDirectory, '.workspace-note'), 'utf8')).toBe('keep this hidden note\n');
  expect(await readFile(path.join(restored.workspaceDirectory, 'PROJECT.md'), 'utf8')).toBe('router migration fixture\n');
  expect(await readFile(path.join(restored.workspaceDirectory, 'packages/foo/keep.txt'), 'utf8')).toBe('nested source file survives\n');
  expect(execFileSync(path.join(restored.workspaceDirectory, 'scripts/check.sh'), { encoding: 'utf8' })).toBe('fixture-ok\n');
  for (const relative of ['node_modules', '.cache', 'packages/foo/node_modules', 'packages/foo/.cache', 'packages/bar/node_modules']) {
    await expect(lstat(path.join(restored.workspaceDirectory, relative))).rejects.toThrow();
  }
  expect(MigrationFixture.git(restored.workspaceDirectory, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(beforeGit);
  expect(MigrationFixture.git(restored.workspaceDirectory, ['rev-parse', 'HEAD'])).toBe(MigrationFixture.git(harness.workspace, ['rev-parse', 'HEAD']));
  expect(MigrationFixture.git(restored.workspaceDirectory, ['ls-files', '--stage'])).toBe(MigrationFixture.git(harness.workspace, ['ls-files', '--stage']));
  expect(restored.session).toEqual(savedSession);
  requireCompletedShellOutput(restored.session.messages, 'router-history-fixture\n');
  expect((await lstat(path.join(harness.root, 'restored', 'session.json'))).mode & 0o077).toBe(0);
  expect(manifest.snapshotId).toMatch(/^[a-f0-9]{64}$/);
  expect(path.resolve(harness.repository.directory()).startsWith(path.resolve(harness.workspace))).toBe(false);
}, 60_000);

test('refuses a tampered manifest and removes the partial restore', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  const tamperedFiles = {
    ...manifest,
    files: manifest.files.map(file => file.path === 'notes.txt' ? { ...file, sha256: '0'.repeat(64) } : file),
  };
  await expect(harness.restore(tamperedFiles, 'files')).rejects.toMatchObject({
    code: 'TAMPERED', message: 'Snapshot was tampered: restored file hashes do not match the manifest',
  });
  await expect(lstat(path.join(harness.root, 'files'))).rejects.toThrow();
  const tamperedSession = { ...manifest, session: { ...manifest.session, sha256: 'c'.repeat(64) } };
  await expect(harness.restore(tamperedSession, 'session')).rejects.toMatchObject({
    code: 'TAMPERED', message: 'Snapshot was tampered: session export does not match the manifest',
  });
  await expect(lstat(path.join(harness.root, 'session'))).rejects.toThrow();
}, 60_000);

test('refuses a corrupted repository pack', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  await RepositoryBytes.flipPack(harness.repository.directory());
  await expect(harness.restore(manifest, 'corrupt')).rejects.toBeInstanceOf(SnapshotError);
  try { await harness.restore(manifest, 'corrupt'); }
  catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).code).toBe('CORRUPTED');
    expect((error as SnapshotError).message).toBe('Snapshot is corrupted: restic integrity check failed');
  }
  await expect(lstat(path.join(harness.root, 'corrupt'))).rejects.toThrow();
}, 60_000);

test('refuses wrong-version snapshots without leaving a workspace', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  const cases: [unknown, string][] = [
    [{ ...manifest, formatVersion: 2 }, 'Snapshot format version 2 is not supported (expected 1)'],
    [{ ...manifest, agentVersion: '9.9.9' }, 'Snapshot agent version 9.9.9 does not match pinned OpenCode 2.2.7'],
    [{ ...manifest, architecture: 'sparc' }, `Snapshot architecture sparc does not match host architecture ${harness.host.architecture}`],
    [{ ...manifest, runtimeDigest: 'd'.repeat(64) }, 'Snapshot runtime digest does not match this host'],
    [{ ...manifest, resticVersion: '0.0.0' }, 'Snapshot restic version 0.0.0 does not match pinned restic 0.19.1'],
  ];
  for (const [index, [body, message]] of cases.entries()) {
    const name = `version-${index}`;
    await expect(harness.restore(body, name)).rejects.toMatchObject({ code: 'WRONG_VERSION', message });
    await expect(lstat(path.join(harness.root, name))).rejects.toThrow();
  }
}, 60_000);

test('refuses an incomplete snapshot that has no session export', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  const bare = path.join(harness.root, 'bare');
  await mkdir(bare);
  await cp(harness.workspace, path.join(bare, 'workspace'), { recursive: true });
  const stored = await harness.repository.backup(bare);
  const incomplete = { ...manifest, snapshotId: stored.snapshotId, archivePath: stored.archivePath };
  await expect(harness.restore(incomplete, 'incomplete')).rejects.toMatchObject({
    code: 'INCOMPLETE', message: 'Snapshot is incomplete: missing session export',
  });
  await expect(lstat(path.join(harness.root, 'incomplete'))).rejects.toThrow();
  await expect(harness.restore({ ...manifest, snapshotId: 'e'.repeat(64) }, 'missing')).rejects.toMatchObject({
    code: 'INCOMPLETE', message: 'Snapshot is incomplete: requested snapshot is missing',
  });
}, 60_000);

test('does not checkpoint a symlink or a repository nested in the workspace', async () => {
  const harness = await CheckpointHarness.open();
  await symlink('/etc/hostname', path.join(harness.workspace, 'outside'));
  await expect(harness.capture()).rejects.toThrow(/symlink/i);
  await expect(lstat(harness.repository.directory())).rejects.toThrow();
  const other = await CheckpointHarness.open();
  const nested = new ResticRepository({
    repository: path.join(other.workspace, 'nested-repo'),
    passwordFile: path.join(other.root, 'missing-key'),
  });
  await writeFile(path.join(other.root, 'missing-key'), 'nested-key\n', { mode: 0o600 });
  await expect(WorkspaceCapture.checkpoint({
    workspaceDirectory: other.workspace, session: savedSession, host: other.host, repository: nested,
  })).rejects.toThrow(/independent/);
  await expect(lstat(path.join(other.workspace, 'nested-repo'))).rejects.toThrow();
}, 60_000);

test('refuses an existing empty restore directory and leaves it in place', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  const target = path.join(harness.root, 'empty-target');
  await mkdir(target);
  await expect(WorkspaceRestore.restore({
    manifest, repository: harness.repository, host: harness.host, targetDirectory: target,
  })).rejects.toThrow('Restore target must not already exist');
  expect(await readdir(target)).toEqual([]);
  const missingParent = path.join(harness.root, 'nonexistent-parent', 'target');
  await expect(WorkspaceRestore.restore({
    manifest, repository: harness.repository, host: harness.host, targetDirectory: missingParent,
  })).rejects.toThrow('Restore target parent must exist');
}, 60_000);

test('fails the checkpoint when the workspace changes before it is copied', async () => {
  const harness = await CheckpointHarness.open();
  await expect(WorkspaceCapture.checkpoint({
    workspaceDirectory: harness.workspace,
    session: savedSession,
    host: harness.host,
    repository: harness.repository,
    beforeCopy: async () => { await writeFile(path.join(harness.workspace, 'notes.txt'), 'changed during capture\n'); },
  })).rejects.toThrow('Workspace changed while it was being checkpointed');
  await expect(lstat(harness.repository.directory())).rejects.toThrow();
  expect(await readFile(path.join(harness.workspace, 'notes.txt'), 'utf8')).toBe('changed during capture\n');
});

test('refuses a manifest whose workspace id was relabeled', async () => {
  const harness = await CheckpointHarness.open();
  const manifest = await harness.capture();
  const workspaceId = randomUUID();
  const target = path.join(harness.root, 'relabeled');
  await expect(WorkspaceRestore.restore({
    manifest: { ...manifest, workspaceId },
    repository: harness.repository,
    host: { ...harness.host, workspaceId },
    targetDirectory: target,
  })).rejects.toMatchObject({
    code: 'TAMPERED',
    message: 'Snapshot was tampered: manifest metadata does not match the checkpoint',
  });
  await expect(lstat(target)).rejects.toThrow();
}, 60_000);

test('fresh OpenCode process keeps the checkpointed history and accepts another command', async () => {
  const harness = await CheckpointHarness.open();
  let source: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
  let target: Awaited<ReturnType<typeof OpenCodeAdapter.resume>> | undefined;
  try {
    source = await startIsolatedServer(harness.workspace, path.join(harness.root, 'source-agent'));
    const created = await source.client.createSession(harness.workspace, 'Router restore fixture');
    await source.client.runShellCommand(created, "printf 'router-history-fixture\\n'");
    const transfer = await OpenCodeAdapter.quiesce(source, created);
    source = undefined;
    requireCompletedShellOutput(transfer.messages, 'router-history-fixture\n');
    const manifest = await harness.capture(transfer);
    const restored = await harness.restore(manifest, 'agent');
    expect(restored.session).toEqual(transfer);
    target = await OpenCodeAdapter.resume(restored.workspaceDirectory, path.join(harness.root, 'target-agent'), restored.session);
    const exported = await target.client.exportSession(target.sessionId);
    expect(exported.info.id).toBe(created);
    expect((exported.info.location as { directory?: unknown } | undefined)?.directory).toBe(restored.workspaceDirectory);
    expect(exported.messages).toEqual(transfer.messages);
    requireCompletedShellOutput(exported.messages, 'router-history-fixture\n');
    await target.client.runShellCommand(target.sessionId, "printf 'router-history-continued\\n'");
    const continued = await target.client.exportSession(target.sessionId);
    expect(continued.info.id).toBe(created);
    requireCompletedShellOutput(continued.messages, 'router-history-fixture\n');
    requireCompletedShellOutput(continued.messages, 'router-history-continued\n');
  } finally {
    await source?.stop();
    await target?.stop();
  }
}, 180_000);

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';
import { hashWorkspace } from '../packages/workspace/src/manifest.js';
import { requireCompletedShellOutput } from '../packages/agent-opencode/src/history.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/roundtrip-'));
const source = join(run, 'source'); const target = join(run, 'target');
const git = (directory: string, args: string[]) => execFileSync('git', args, {
  cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: run, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
});
let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
try {
  await cp(resolve('fixtures/workspace'), source, { recursive: true });
  git(source, ['init', '--quiet']);
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  await writeFile(join(source, 'src/message.txt'), 'unfinished edits\n');
  await writeFile(join(source, '.workspace-note'), 'hidden and untracked\n');
  await writeFile(join(source, 'notes.txt'), 'untracked work\n');
  await rename(join(source, 'README.md'), join(source, 'PROJECT.md'));
  server = await startIsolatedServer(source, join(run, 'source-agent'));
  const id = await server.client.createSession(source, 'Router portability fixture');
  // A completed shell turn is exportable history; a queued prompt is not.
  // This fixed fixture command needs no API key and performs no model inference.
  await server.client.runShellCommand(id, "printf 'router-history-fixture\\n'");
  const transfer = await server.client.exportSession(id);
  requireCompletedShellOutput(transfer.messages, 'router-history-fixture\n');
  await server.stop(); server = undefined;
  const before = await hashWorkspace(source);
  const beforeGit = git(source, ['status', '--porcelain=v1', '--untracked-files=all']);
  const beforeHead = git(source, ['rev-parse', 'HEAD']);
  const beforeIndex = git(source, ['ls-files', '--stage']);
  assert.ok(before.some(file => file.path === 'scripts/check.sh' && file.executable), 'Executable fixture must be present');
  await cp(source, target, { recursive: true });
  server = await startIsolatedServer(target, join(run, 'target-agent'));
  const imported = await server.client.importSession(transfer, target);
  assert.equal(imported, id);
  const restored = await server.client.exportSession(imported);
  assert.equal((restored.info.location as { directory?: unknown } | undefined)?.directory, target, 'Imported session must use the target workspace');
  requireCompletedShellOutput(restored.messages, 'router-history-fixture\n');
  assert.deepEqual(restored.messages, transfer.messages);
  assert.deepEqual(await hashWorkspace(target), before);
  assert.equal(git(target, ['status', '--porcelain=v1', '--untracked-files=all']), beforeGit);
  assert.equal(git(target, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(git(target, ['ls-files', '--stage']), beforeIndex);
  console.log(JSON.stringify({
    status: 'PASS', freshAgentState: true, fileHashes: 'PASS', gitWorkingTree: 'PASS',
    sessionId: 'PRESERVED', settledShellHistory: 'PRESERVED',
    modelInference: 'UNTESTED', liveProcessMigration: 'UNSUPPORTED', cloudMigration: 'UNTESTED',
  }, null, 2));
} finally { await server?.stop(); await rm(run, { recursive: true, force: true }); }

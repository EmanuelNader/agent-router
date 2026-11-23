import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runRouterCli } from '../src/cli.js';
import { OperationJournal } from '../src/journal.js';
import { encodeClaudeProjectSlug } from '../../agent-claude-code/src/adapter.js';
import { isCodexCliAvailable, startIsolatedCodexAppServer } from '../../agent-codex/src/adapter.js';
import { startIsolatedServer } from '../../agent-opencode/src/server.js';
import { isLocalSshdAvailable, startEphemeralSshd, type EphemeralSshd } from '../../host-ssh/src/ephemeral-sshd.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'router-move-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sshd: EphemeralSshd = await startEphemeralSshd(join(root, 'sshd'));
  cleanup.push(() => sshd.close());
  const workspace = join(root, 'laptop', 'project');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'app.ts'), 'export const moved = true;\n');
  await writeFile(join(workspace, '.note'), 'hidden\n');
  const keyHex = randomBytes(32).toString('hex');
  const keyFile = join(root, 'laptop', 'move.key');
  await writeFile(keyFile, keyHex, { mode: 0o600 });
  // Stands in for an Agent Router install on the remote host: the same CLI, run from source.
  const entry = join(root, 'remote', 'entry.mts');
  await mkdir(join(root, 'remote'), { recursive: true });
  await writeFile(entry, `import { runRouterCli } from ${JSON.stringify(resolve('packages/cli/src/cli.ts'))};\nprocess.exitCode = await runRouterCli(process.argv.slice(2));\n`);
  const router = join(root, 'remote', 'agent-router');
  await writeFile(router, `#!/bin/sh\nexec ${process.execPath} ${resolve('node_modules/tsx/dist/cli.mjs')} ${entry} "$@"\n`);
  await chmod(router, 0o755);
  const journalDir = join(root, 'laptop', 'journal');
  const out: string[] = []; const err: string[] = [];
  const move = (extra: string[] = []) => runRouterCli([
    'move', workspace, `${sshd.username}@127.0.0.1`,
    '--key-file', keyFile, '--journal-dir', journalDir,
    '--remote-workspace', join(root, 'remote', 'project'), '--remote-spool', join(root, 'remote', 'spool'),
    '--remote-router', router,
    '--ssh-port', String(sshd.port), '--identity-file', sshd.clientPrivateKeyPath, '--known-hosts-file', sshd.knownHostsPath,
    ...extra,
  ], { stdout: line => out.push(line), stderr: line => err.push(line) });
  return { root, workspace, keyHex, keyFile, journal: new OperationJournal(journalDir), move, out, err };
}

async function filesContaining(directory: string, needle: string, skip: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || file === skip) continue;
    if ((await readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}

test.skipIf(!isLocalSshdAvailable())('move restores the workspace on the remote host over SSH without leaving the key there', async () => {
  const f = await setup();
  expect(await f.move(), f.err.join('\n')).toBe(0);
  const result = JSON.parse(f.out.join(''));
  expect(result.operation.status).toBe('COMPLETED');
  expect(result.sourceRemoved).toBe(false);
  expect(await readFile(join(f.root, 'remote', 'project', 'src', 'app.ts'), 'utf8')).toBe('export const moved = true;\n');
  expect(await readFile(join(f.root, 'remote', 'project', '.note'), 'utf8')).toBe('hidden\n');
  await access(join(f.workspace, 'src', 'app.ts'));
  expect(await readdir(join(f.root, 'remote', 'spool'))).toEqual([]);
  expect(await filesContaining(f.root, f.keyHex, f.keyFile)).toEqual([]);
  expect(await f.journal.listBlocking()).toEqual([]);

  // A second move to the same remote path refuses before touching anything.
  f.out.length = 0;
  expect(await f.move()).toBe(1);
  expect(f.err.join('')).toContain('REMOTE_WORKSPACE_EXISTS_OR_UNREADABLE');
  expect(await f.journal.listBlocking()).toEqual([]);
}, 120_000);

test.skipIf(!isLocalSshdAvailable())('move --remove-source deletes the source only after the remote restore is verified', async () => {
  const f = await setup();
  expect(await f.move(['--remove-source']), f.err.join('\n')).toBe(0);
  expect(JSON.parse(f.out.join('')).sourceRemoved).toBe(true);
  await expect(access(f.workspace)).rejects.toThrow();
  await access(join(f.root, 'remote', 'project', 'src', 'app.ts'));
}, 120_000);

test.skipIf(!isLocalSshdAvailable())('move refuses when the remote host has no Agent Router and leaves the source alone', async () => {
  const f = await setup();
  expect(await f.move(['--remote-router', '/nonexistent/agent-router', '--remove-source'])).toBe(1);
  expect(f.err.join('')).toContain('REMOTE_ROUTER_UNAVAILABLE');
  await access(join(f.workspace, 'src', 'app.ts'));
  await expect(access(join(f.root, 'remote', 'project'))).rejects.toThrow();
  expect(await f.journal.listBlocking()).toEqual([]);

  f.err.length = 0;
  expect(await f.move(['--remove-source', '--journal-dir', join(f.workspace, '.work', 'router-journal')])).toBe(1);
  expect(f.err.join('')).toContain('--journal-dir outside the workspace');
  await access(join(f.workspace, 'src', 'app.ts'));
  await expect(access(join(f.root, 'remote', 'project'))).rejects.toThrow();
}, 120_000);

test.skipIf(!isLocalSshdAvailable())('move carries Claude Code history and rewrites it for the remote path', async () => {
  const f = await setup();
  const claudeLocal = join(f.root, 'laptop', 'claude');
  const claudeRemote = join(f.root, 'remote', 'claude');
  const uuid = '44444444-5555-4666-8777-888888888888';
  const slugDir = join(claudeLocal, 'projects', encodeClaudeProjectSlug(f.workspace));
  await mkdir(slugDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(slugDir, `${uuid}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: uuid, cwd: f.workspace, message: { role: 'user', content: 'move' } })}\n`,
    { mode: 0o600 },
  );
  expect(
    await f.move(['--agent', 'claude-code', '--claude-config-dir', claudeLocal, '--target-claude-config-dir', claudeRemote]),
    f.err.join('\n'),
  ).toBe(0);
  const remoteWorkspace = join(f.root, 'remote', 'project');
  const moved = await readFile(join(claudeRemote, 'projects', encodeClaudeProjectSlug(remoteWorkspace), `${uuid}.jsonl`), 'utf8');
  expect((JSON.parse(moved.trim()) as { cwd: string }).cwd).toBe(remoteWorkspace);
}, 120_000);

test.skipIf(!isLocalSshdAvailable() || !isCodexCliAvailable())('move carries Codex CLI history that the installed Codex resumes at the remote path', async () => {
  const f = await setup();
  const codexLocal = join(f.root, 'laptop', 'codex');
  const codexRemote = join(f.root, 'remote', 'codex');
  const source = await startIsolatedCodexAppServer({ isolatedHome: join(f.root, 'laptop', 'home'), codexHome: codexLocal });
  let threadId: string;
  try {
    threadId = await source.startThread(f.workspace);
    await source.runShellCommand(threadId, "printf 'codex-move-turn\\n'");
  } finally { await source.stop(); }
  expect(
    await f.move(['--agent', 'codex-cli', '--codex-home', codexLocal, '--target-codex-home', codexRemote]),
    f.err.join('\n'),
  ).toBe(0);
  const remoteWorkspace = join(f.root, 'remote', 'project');
  const target = await startIsolatedCodexAppServer({ isolatedHome: join(f.root, 'remote', 'home'), codexHome: codexRemote });
  try {
    expect((await target.resumeThread(threadId, remoteWorkspace)).cwd).toBe(remoteWorkspace);
    const thread = await target.readThread(threadId);
    expect(thread.cwd).toBe(remoteWorkspace);
    expect(JSON.stringify(thread.turns)).toContain('codex-move-turn');
  } finally { await target.stop(); }
}, 180_000);

test.skipIf(!isLocalSshdAvailable())('move carries settled OpenCode history into the OpenCode server on the remote host', async () => {
  const f = await setup();
  const source = await startIsolatedServer(f.workspace, join(f.root, 'laptop', 'opencode'));
  cleanup.push(() => source.stop());
  // The remote server runs before the workspace exists there; the import binds the session to it.
  const target = await startIsolatedServer(join(f.root, 'remote'), join(f.root, 'remote', 'opencode'));
  cleanup.push(() => target.stop());
  const sourcePassword = join(f.root, 'laptop', 'opencode.password');
  const targetPassword = join(f.root, 'remote', 'opencode.password');
  await writeFile(sourcePassword, source.password, { mode: 0o600 });
  await writeFile(targetPassword, target.password, { mode: 0o600 });
  const sessionId = await source.client.createSession(f.workspace, 'Move fixture');
  await source.client.runShellCommand(sessionId, "printf 'opencode-move-turn\\n'");
  const exported = await source.client.exportSession(sessionId);
  expect(
    await f.move([
      '--agent', 'opencode', '--opencode-url', source.baseUrl, '--opencode-password-file', sourcePassword, '--session-id', sessionId,
      '--target-opencode-url', target.baseUrl, '--target-opencode-password-file', targetPassword,
    ]),
    f.err.join('\n'),
  ).toBe(0);
  const restored = await target.client.exportSession(sessionId);
  expect((restored.info.location as { directory?: unknown }).directory).toBe(join(f.root, 'remote', 'project'));
  expect(JSON.stringify(restored.messages)).toContain('opencode-move-turn');
  expect(restored.messages).toEqual(exported.messages);
}, 180_000);

test.skipIf(!isLocalSshdAvailable())('move --stop-source-pid stops the source OpenCode server after exporting its history', async () => {
  const f = await setup();
  const source = await startIsolatedServer(f.workspace, join(f.root, 'laptop', 'opencode'));
  cleanup.push(() => source.stop());
  const target = await startIsolatedServer(join(f.root, 'remote'), join(f.root, 'remote', 'opencode'));
  cleanup.push(() => target.stop());
  const sourcePassword = join(f.root, 'laptop', 'opencode.password');
  const targetPassword = join(f.root, 'remote', 'opencode.password');
  await writeFile(sourcePassword, source.password, { mode: 0o600 });
  await writeFile(targetPassword, target.password, { mode: 0o600 });
  const sessionId = await source.client.createSession(f.workspace, 'Move fixture');
  await source.client.runShellCommand(sessionId, "printf 'opencode-stop-turn\\n'");
  expect(
    await f.move([
      '--agent', 'opencode', '--opencode-url', source.baseUrl, '--opencode-password-file', sourcePassword, '--session-id', sessionId,
      '--target-opencode-url', target.baseUrl, '--target-opencode-password-file', targetPassword,
      '--stop-source-pid', String(source.pid),
    ]),
    f.err.join('\n'),
  ).toBe(0);
  expect(JSON.parse(f.out.join('\n')).sourceAgentStopped).toBe(true);
  expect(() => process.kill(source.pid!, 0)).toThrow(/ESRCH/);
  await expect(source.client.listSessions()).rejects.toThrow();
  expect(JSON.stringify((await target.client.exportSession(sessionId)).messages)).toContain('opencode-stop-turn');
}, 180_000);

test.skipIf(!isLocalSshdAvailable())('move --stop-source-pid leaves the source agent running when the remote pre-flight check fails', async () => {
  const f = await setup();
  const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanup.push(async () => { if (agent.exitCode === null && agent.signalCode === null) { agent.kill('SIGKILL'); await once(agent, 'exit'); } });
  expect(await f.move(['--remote-router', join(f.root, 'remote', 'missing-router'), '--stop-source-pid', String(agent.pid)])).toBe(1);
  expect(f.err.join('\n')).toContain('REMOTE_ROUTER_UNAVAILABLE');
  expect(() => process.kill(agent.pid!, 0)).not.toThrow();
  expect(await f.move(['--stop-source-pid', '999999999'])).toBe(1);
  expect(f.err.join('\n')).toContain('SOURCE_AGENT_NOT_RUNNING');
  await expect(access(join(f.root, 'remote', 'project'))).rejects.toThrow();
}, 60_000);

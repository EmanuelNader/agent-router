import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SessionTransfer } from '../../agent-opencode/src/client.js';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';
import {
  claudeProjectBundleSchema,
  exportClaudeProjectBundle,
  importClaudeProjectBundle,
} from '../../agent-claude-code/src/adapter.js';
import {
  codexRolloutBundleSchema,
  exportCodexRolloutBundle,
  importCodexRolloutBundle,
} from '../../agent-codex/src/adapter.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { inspectWorkspaceMcp } from '../../workspace/src/mcp-portability.js';
import { assertRelativeLink, validateWorkspaceLink } from '../../workspace/src/symlinks.js';
import {
  anyCheckpointManifestSchema,
  assertSafeRelativePath,
  checkpointManifestSchema,
  checkpointManifestV2Schema,
  checkpointManifestV3Schema,
  type CheckpointManifest,
  type CheckpointManifestV2,
  type CheckpointManifestV3,
} from './manifest.js';
import type { SnapshotEntry, SnapshotStore } from './store.js';

function runGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function inspectGit(workspace: string, exclusions: string[] = []): Promise<CheckpointManifest['git']> {
  try {
    const stat = await lstat(path.join(workspace, '.git'));
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Unsupported Git metadata entry');
    if (stat.isFile() && !(await readFile(path.join(workspace, '.git'), 'utf8')).startsWith('gitdir: ')) {
      throw new Error('Invalid Git worktree pointer');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    throw error;
  }
  const tracked = runGit(workspace, ['ls-files', '-z']).split('\0').filter(Boolean);
  if (tracked.some(file => file.split('/').some(part => exclusions.includes(part)))) {
    throw new Error('Cache exclusions overlap tracked Git files');
  }
  return {
    present: true,
    head: runGit(workspace, ['rev-parse', 'HEAD']).trim(),
    statusPorcelain: runGit(workspace, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...exclusions.flatMap(name => [
      `:(exclude)${name}/**`, `:(exclude)${name}`, `:(exclude)**/${name}/**`, `:(exclude)**/${name}`,
    ])]),
    indexStage: runGit(workspace, ['ls-files', '--stage']),
  };
}

function assertSettledSessions(sessions: SessionTransfer[]): void {
  for (const session of sessions) {
    for (const message of session.messages) {
      if (typeof message !== 'object' || message === null) continue;
      const record = message as { type?: unknown; status?: unknown; time?: { completed?: unknown } };
      if (record.type === 'shell') {
        const completed = record.time?.completed;
        if (record.status !== 'exited' || typeof completed !== 'number' || completed <= 0) {
          throw new Error('Cannot capture checkpoint with an unfinished shell turn');
        }
      }
    }
  }
}

async function collectAllFiles(root: string, options: { symlinks?: boolean; exclusions?: string[] } = {}): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (!relative && name === '.git') continue;
      if (name === '.git') throw new Error('Nested Git repositories require separate checkpoints');
      if (options.exclusions?.includes(name)) continue;
      const rel = relative ? `${relative}/${name}` : name;
      const abs = path.join(root, rel);
      const stat = await lstat(abs);
      if (stat.isSymbolicLink()) {
        if (!options.symlinks) throw new Error(`Symlink unsupported in checkpoint: ${rel}`);
        continue;
      }
      if (stat.isDirectory()) await visit(rel);
      else if (stat.isFile()) {
        entries.push({
          path: `workspace/${assertSafeRelativePath(rel)}`,
          executable: (stat.mode & 0o111) !== 0,
          data: await readFile(abs),
        });
      } else throw new Error(`Unsupported special file in checkpoint: ${rel}`);
    }
  }
  await visit('');
  const git = await inspectGit(root);
  if (git.present) {
    // Bundle only portable objects/refs, never repository config, hooks, remotes,
    // alternates, or a linked worktree's machine-specific gitdir pointer.
    const scratch = await mkdtemp(path.join(tmpdir(), 'router-portable-git-'));
    try {
      const bundle = path.join(scratch, 'repository.bundle');
      runGit(root, ['bundle', 'create', bundle, '--all', 'HEAD']);
      const portable = path.join(scratch, 'portable');
      runGit(scratch, ['init', '--template=', portable]);
      const refs = runGit(portable, ['bundle', 'unbundle', bundle]);
      for (const row of refs.trim().split('\n')) {
        const [oid, ref] = row.split(' ');
        if (oid && ref?.startsWith('refs/')) runGit(portable, ['update-ref', ref, oid]);
      }
      await writeFile(path.join(portable, '.git/config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n');
      const head = runGit(root, ['rev-parse', 'HEAD']).trim();
      await writeFile(path.join(portable, '.git/HEAD'), `${head}\n`);
      const index = runGit(root, ['ls-files', '--stage', '-z']);
      // Staged blobs can be unreachable from every commit in the bundle.
      const blobs = new Set(index.split('\0').filter(Boolean).map(row => row.split(' ')[1]!));
      for (const oid of blobs) {
        const bytes = execFileSync('git', ['cat-file', 'blob', oid], {
          cwd: root, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const actual = execFileSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: portable, input: bytes, encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: portable, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (actual !== oid) throw new Error('Staged Git blob hash mismatch');
      }
      runGit(portable, ['read-tree', '--empty']);
      runGit(portable, ['update-index', '-z', '--index-info'], index);
      async function collectGit(relative: string): Promise<void> {
        for (const name of (await readdir(path.join(portable, relative))).sort()) {
          const rel = `${relative}/${name}`;
          const stat = await lstat(path.join(portable, rel));
          if (stat.isDirectory()) await collectGit(rel);
          else if (stat.isFile()) entries.push({ path: `workspace/${rel}`, executable: false, data: await readFile(path.join(portable, rel)) });
          else throw new Error('Unexpected portable Git metadata');
        }
      }
      await collectGit('.git');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return entries;
}

export async function captureCheckpoint(options: {
  workspace: string;
  store: SnapshotStore;
  exportSessions: () => Promise<SessionTransfer[]>;
  quiesceSource: () => Promise<void>;
  exclusions?: string[];
}): Promise<CheckpointManifestV3> {
  return captureAgentCheckpoint({
    workspace: options.workspace, store: options.store,
    agent: { kind: 'opencode', exportSessions: options.exportSessions },
    quiesceSource: options.quiesceSource,
    ...(options.exclusions !== undefined ? { exclusions: options.exclusions } : {}),
  });
}

const sessionsArraySchema = z.array(
  z.object({ info: z.object({ id: z.string().min(1) }).passthrough(), messages: z.array(z.unknown()) }).passthrough(),
);

export async function restoreCheckpoint(options: {
  checkpointId: string;
  targetWorkspace: string;
  store: SnapshotStore;
  importSession: (transfer: SessionTransfer, directory: string) => Promise<string>;
}): Promise<CheckpointManifest | CheckpointManifestV2 | CheckpointManifestV3> {
  const target = path.resolve(options.targetWorkspace);
  try {
    await access(target);
    throw new Error(`Target workspace already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const entries = await options.store.get(options.checkpointId);
  const manifestEntry = entries.find(entry => entry.path === 'meta/manifest.json');
  const sessionsEntry = entries.find(entry => entry.path === 'meta/sessions.json');
  if (!manifestEntry) throw new Error('Checkpoint bundle is missing metadata');
  const versioned = anyCheckpointManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')));
  if (versioned.schemaVersion !== 1) {
    return restoreAgentCheckpoint({
      checkpointId: options.checkpointId, targetWorkspace: target, store: options.store,
      agent: { kind: 'opencode', importSession: options.importSession },
    });
  }
  if (!sessionsEntry) throw new Error('Checkpoint bundle is missing sessions');

  const manifest = checkpointManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')));
  if (manifest.checkpointId !== options.checkpointId) throw new Error('Checkpoint ID mismatch');
  const sessions = sessionsArraySchema.parse(JSON.parse(sessionsEntry.data.toString('utf8')));
  assertSettledSessions(sessions);

  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) {
      if (entry.path === 'meta/manifest.json' || entry.path === 'meta/sessions.json') continue;
      if (!entry.path.startsWith('workspace/')) throw new Error(`Unexpected entry in checkpoint: ${entry.path}`);
      const rel = assertSafeRelativePath(entry.path.slice('workspace/'.length));
      const destination = path.join(target, rel);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.data, { mode: entry.executable ? 0o755 : 0o600, flag: 'wx' });
      if (entry.executable) await chmod(destination, 0o755);
    }

    const actualHashes = await hashWorkspace(target);
    if (JSON.stringify(actualHashes) !== JSON.stringify(manifest.workspaceFiles)) {
      throw new Error('Restored workspace file hashes do not match checkpoint manifest');
    }
    const actualGit = await inspectGit(target);
    if (JSON.stringify(actualGit) !== JSON.stringify(manifest.git)) {
      throw new Error('Restored Git working tree does not match checkpoint manifest');
    }

    for (const session of sessions) {
      const importedId = await options.importSession(session, target);
      if (importedId !== session.info.id) throw new Error('Imported session ID did not match checkpoint');
    }
    return manifest;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export type CaptureAgentSpec =
  | { kind: 'none' }
  | { kind: 'opencode'; exportSessions: () => Promise<SessionTransfer[]> }
  | { kind: 'codex-cli'; codexHome: string }
  | { kind: 'claude-code'; claudeConfigDir: string };

export type RestoreAgentSpec =
  | { kind: 'none' }
  | { kind: 'opencode'; importSession: (transfer: SessionTransfer, directory: string) => Promise<string> }
  | { kind: 'codex-cli'; targetCodexHome: string }
  | { kind: 'claude-code'; targetClaudeConfigDir: string };

const agentBundleEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('opencode'), sessions: sessionsArraySchema }),
  z.object({ kind: z.literal('codex-cli'), bundle: codexRolloutBundleSchema }),
  z.object({ kind: z.literal('claude-code'), bundle: claudeProjectBundleSchema }),
]);

export async function captureAgentCheckpoint(options: {
  workspace: string;
  store: SnapshotStore;
  agent: CaptureAgentSpec;
  quiesceSource?: () => Promise<void>;
  exclusions?: string[];
}): Promise<CheckpointManifestV3> {
  const root = path.resolve(options.workspace);
  const exclusions = options.exclusions ?? ['node_modules', '.pnpm-store', '.work', '.cache'];
  checkpointManifestV3Schema.shape.exclusions.parse(exclusions);
  await inspectWorkspaceMcp(root, exclusions);
  let sessionIds: string[] = [];
  let agentEnvelope: z.infer<typeof agentBundleEnvelopeSchema>;

  if (options.agent.kind === 'opencode') {
    // OpenCode exports over HTTP before its server is stopped by quiesceSource.
    const sessions = await options.agent.exportSessions();
    assertSettledSessions(sessions);
    sessionIds = sessions.map(s => s.info.id);
    agentEnvelope = { kind: 'opencode', sessions };
    if (options.quiesceSource) {
      await options.quiesceSource();
    }
  } else {
    // File-backed agents (codex-cli, claude-code) and workspace-only checkpoints
    // quiesce/stop the source process FIRST so final JSONL buffers flush to disk before export.
    if (options.quiesceSource) {
      await options.quiesceSource();
    }
    if (options.agent.kind === 'none') {
      agentEnvelope = { kind: 'none' };
    } else if (options.agent.kind === 'codex-cli') {
      const bundle = await exportCodexRolloutBundle(options.agent.codexHome, root);
      sessionIds = bundle.rollouts.map(r => r.threadId);
      agentEnvelope = { kind: 'codex-cli', bundle };
    } else {
      const bundle = await exportClaudeProjectBundle(options.agent.claudeConfigDir, root);
      sessionIds = bundle.sessions.map(s => s.sessionId);
      agentEnvelope = { kind: 'claude-code', bundle };
    }
  }

  // Re-scan after the final writer flush; preflight alone cannot attest to bytes
  // changed by quiescing the agent.
  await inspectWorkspaceMcp(root, exclusions);
  checkpointManifestV3Schema.shape.exclusions.parse(exclusions);
  const workspaceFiles = await hashWorkspace(root, { symlinks: true, exclusions });
  const git = await inspectGit(root, exclusions);
  const symlinks: { path: string; target: string }[] = [];
  for (const file of workspaceFiles) {
    if ((await lstat(path.join(root, file.path))).isSymbolicLink()) symlinks.push({ path: file.path, target: await readlink(path.join(root, file.path)) });
  }
  const checkpointId = `chk_${randomBytes(16).toString('hex')}`;
  const manifest: CheckpointManifestV3 = checkpointManifestV3Schema.parse({
    schemaVersion: 3,
    exclusions,
    symlinks,
    checkpointId,
    createdAt: new Date().toISOString(),
    architecture: process.arch,
    agentKind: options.agent.kind,
    sessionIds,
    git,
    workspaceFiles,
  });

  const files = await collectAllFiles(root, { symlinks: true, exclusions });
  files.push(
    { path: 'meta/manifest.json', executable: false, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'meta/agent.json', executable: false, data: Buffer.from(JSON.stringify(agentEnvelope), 'utf8') },
  );
  await options.store.put(checkpointId, files);
  return manifest;
}

export async function restoreAgentCheckpoint(options: {
  checkpointId: string;
  targetWorkspace: string;
  store: SnapshotStore;
  agent: RestoreAgentSpec;
}): Promise<CheckpointManifest | CheckpointManifestV2 | CheckpointManifestV3> {
  const target = path.resolve(options.targetWorkspace);
  try {
    await access(target);
    throw new Error(`Target workspace already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const entries = await options.store.get(options.checkpointId);
  const manifestEntry = entries.find(entry => entry.path === 'meta/manifest.json');
  if (!manifestEntry) throw new Error('Checkpoint bundle is missing manifest');

  const manifest = anyCheckpointManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')));
  if (manifest.checkpointId !== options.checkpointId) throw new Error('Checkpoint ID mismatch');

  if (manifest.schemaVersion === 1) {
    if (options.agent.kind === 'opencode') {
      return await restoreCheckpoint({
        checkpointId: options.checkpointId,
        targetWorkspace: target,
        store: options.store,
        importSession: options.agent.importSession,
      });
    }
    if (options.agent.kind === 'none' && manifest.sessionIds.length === 0) {
      return await restoreCheckpoint({
        checkpointId: options.checkpointId,
        targetWorkspace: target,
        store: options.store,
        importSession: async transfer => transfer.info.id,
      });
    }
    throw new Error('v1 checkpoint with OpenCode sessions requires agent kind "opencode"');
  }

  if (options.agent.kind !== manifest.agentKind) {
    throw new Error(`Checkpoint agent mismatch: archive holds "${manifest.agentKind}", restore requested "${options.agent.kind}"`);
  }

  const agentEntry = entries.find(entry => entry.path === 'meta/agent.json');
  if (!agentEntry) throw new Error('v2 checkpoint bundle is missing meta/agent.json');
  const envelope = agentBundleEnvelopeSchema.parse(JSON.parse(agentEntry.data.toString('utf8')));
  if (envelope.kind !== manifest.agentKind) {
    throw new Error('Checkpoint meta/agent.json kind mismatch');
  }
  if (envelope.kind === 'opencode') {
    assertSettledSessions(envelope.sessions);
  }

  const links = manifest.schemaVersion === 3 ? manifest.symlinks : [];
  const linkPaths = new Set(links.map(link => link.path));
  if (linkPaths.size !== links.length) throw new Error('Duplicate symlink paths');
  for (const link of links) {
    assertRelativeLink(link.target);
    if (link.path.split('/').includes('.git')) throw new Error('Symlink in Git metadata');
    if (manifest.schemaVersion === 3 && link.path.split('/').some(part => manifest.exclusions.includes(part))) throw new Error('Symlink path is excluded');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    assertSafeRelativePath(entry.path);
    if (seen.has(entry.path)) throw new Error('Duplicate checkpoint entry');
    seen.add(entry.path);
    if (entry.path.startsWith('workspace/')) {
      const rel = entry.path.slice('workspace/'.length);
      if (manifest.schemaVersion === 3 && rel.split('/').some(part => manifest.exclusions.includes(part))) throw new Error('Archive entry is excluded');
      if (links.some(link => rel === link.path || rel.startsWith(`${link.path}/`))) throw new Error('Archive entry overlaps symlink');
    }
  }
  if (links.some(link => links.some(other => link !== other && link.path.startsWith(`${other.path}/`)))) throw new Error('Nested symlink archive paths');

  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) {
      if (entry.path === 'meta/manifest.json' || entry.path === 'meta/agent.json') continue;
      if (!entry.path.startsWith('workspace/')) throw new Error(`Unexpected entry in checkpoint: ${entry.path}`);
      const rel = assertSafeRelativePath(entry.path.slice('workspace/'.length));
      const destination = path.join(target, rel);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, entry.data, { mode: entry.executable ? 0o755 : 0o600, flag: 'wx' });
      if (entry.executable) await chmod(destination, 0o755);
    }

    // Create links only after regular files, so no archive write traverses a link.
    for (const link of links) {
      await mkdir(path.dirname(path.join(target, link.path)), { recursive: true, mode: 0o700 });
      await symlink(link.target, path.join(target, link.path));
    }
    for (const link of links) await validateWorkspaceLink(target, link.path, link.target);
    const actualHashes = await hashWorkspace(target, manifest.schemaVersion === 3 ? { symlinks: true, exclusions: manifest.exclusions } : {});
    if (JSON.stringify(actualHashes) !== JSON.stringify(manifest.workspaceFiles)) {
      throw new Error('Restored workspace file hashes do not match checkpoint manifest');
    }
    const actualGit = await inspectGit(target, manifest.schemaVersion === 3 ? manifest.exclusions : []);
    if (JSON.stringify(actualGit) !== JSON.stringify(manifest.git)) {
      throw new Error('Restored Git working tree does not match checkpoint manifest');
    }

    if (envelope.kind === 'opencode' && options.agent.kind === 'opencode') {
      for (const session of envelope.sessions) {
        const importedId = await options.agent.importSession(session, target);
        if (importedId !== session.info.id) throw new Error('Imported OpenCode session ID mismatch');
      }
    } else if (envelope.kind === 'codex-cli' && options.agent.kind === 'codex-cli') {
      await importCodexRolloutBundle(envelope.bundle, options.agent.targetCodexHome, target);
    } else if (envelope.kind === 'claude-code' && options.agent.kind === 'claude-code') {
      await importClaudeProjectBundle(envelope.bundle, options.agent.targetClaudeConfigDir, target);
    }

    return manifest;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

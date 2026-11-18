import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  anyCheckpointManifestSchema,
  assertSafeRelativePath,
  checkpointManifestSchema,
  checkpointManifestV2Schema,
  type CheckpointManifest,
  type CheckpointManifestV2,
} from './manifest.js';
import type { SnapshotEntry, SnapshotStore } from './store.js';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

async function inspectGit(workspace: string): Promise<CheckpointManifest['git']> {
  try {
    const stat = await lstat(path.join(workspace, '.git'));
    if (!stat.isDirectory()) throw new Error('Linked Git worktrees or .git files are unsupported in v1 checkpoints');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false };
    throw error;
  }
  return {
    present: true,
    head: runGit(workspace, ['rev-parse', 'HEAD']).trim(),
    statusPorcelain: runGit(workspace, ['status', '--porcelain=v1', '--untracked-files=all']),
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

async function collectAllFiles(root: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const abs = path.join(root, rel);
      const stat = await lstat(abs);
      if (stat.isSymbolicLink()) throw new Error(`Symlink unsupported in checkpoint: ${rel}`);
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
  return entries;
}

export async function captureCheckpoint(options: {
  workspace: string;
  store: SnapshotStore;
  exportSessions: () => Promise<SessionTransfer[]>;
  quiesceSource: () => Promise<void>;
}): Promise<CheckpointManifest> {
  const root = path.resolve(options.workspace);
  const sessions = await options.exportSessions();
  assertSettledSessions(sessions);

  // Stop/fence source before reading workspace bytes so no active turn mutates files mid-capture.
  await options.quiesceSource();

  const workspaceFiles = await hashWorkspace(root);
  const git = await inspectGit(root);
  const checkpointId = `chk_${randomBytes(16).toString('hex')}`;
  const manifest: CheckpointManifest = checkpointManifestSchema.parse({
    schemaVersion: 1,
    checkpointId,
    createdAt: new Date().toISOString(),
    architecture: process.arch,
    opencodeVersion: OPENCODE_VERSION,
    sessionIds: sessions.map(session => session.info.id),
    git,
    workspaceFiles,
  });

  const files = await collectAllFiles(root);
  files.push(
    { path: 'meta/manifest.json', executable: false, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { path: 'meta/sessions.json', executable: false, data: Buffer.from(JSON.stringify(sessions), 'utf8') },
  );
  await options.store.put(checkpointId, files);
  return manifest;
}

const sessionsArraySchema = z.array(
  z.object({ info: z.object({ id: z.string().min(1) }).passthrough(), messages: z.array(z.unknown()) }).passthrough(),
);

export async function restoreCheckpoint(options: {
  checkpointId: string;
  targetWorkspace: string;
  store: SnapshotStore;
  importSession: (transfer: SessionTransfer, directory: string) => Promise<string>;
}): Promise<CheckpointManifest> {
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
  if (!manifestEntry || !sessionsEntry) throw new Error('Checkpoint bundle is missing metadata');

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
}): Promise<CheckpointManifestV2> {
  const root = path.resolve(options.workspace);
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

  const workspaceFiles = await hashWorkspace(root);
  const git = await inspectGit(root);
  const checkpointId = `chk_${randomBytes(16).toString('hex')}`;
  const manifest: CheckpointManifestV2 = checkpointManifestV2Schema.parse({
    schemaVersion: 2,
    checkpointId,
    createdAt: new Date().toISOString(),
    architecture: process.arch,
    agentKind: options.agent.kind,
    sessionIds,
    git,
    workspaceFiles,
  });

  const files = await collectAllFiles(root);
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
}): Promise<CheckpointManifest | CheckpointManifestV2> {
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
    if (options.agent.kind !== 'opencode') {
      throw new Error('v1 checkpoint requires agent kind "opencode"');
    }
    return await restoreCheckpoint({
      checkpointId: options.checkpointId,
      targetWorkspace: target,
      store: options.store,
      importSession: options.agent.importSession,
    });
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

    const actualHashes = await hashWorkspace(target);
    if (JSON.stringify(actualHashes) !== JSON.stringify(manifest.workspaceFiles)) {
      throw new Error('Restored workspace file hashes do not match checkpoint manifest');
    }
    const actualGit = await inspectGit(target);
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

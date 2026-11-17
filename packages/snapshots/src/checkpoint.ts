import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionTransfer } from '../../agent-opencode/src/client.js';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { assertSafeRelativePath, checkpointManifestSchema, type CheckpointManifest } from './manifest.js';
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

import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionTransferSchema, type SessionTransfer } from '../../agent-opencode/src/client.js';
import { SnapshotManifest, WORKSPACE_EXCLUSIONS, type SnapshotHost, type SnapshotManifestData } from '../../domain/src/snapshot.js';
import { hashWorkspace, type FileReceipt } from '../../workspace/src/manifest.js';
import { SnapshotPaths } from './paths.js';
import type { CheckpointRepository } from './restic.js';

export interface CaptureRequest {
  workspaceDirectory: string;
  session: SessionTransfer;
  host: SnapshotHost;
  repository: CheckpointRepository;
  /** Test hook. Runs after the pre-copy receipt and before the staged copy. */
  beforeCopy?: () => Promise<void> | void;
}

/** Quiesced workspace plus exported session, stored only in the encrypted repository. */
export class WorkspaceCapture {
  static async checkpoint(request: CaptureRequest): Promise<SnapshotManifestData> {
    const workspace = path.resolve(request.workspaceDirectory);
    const parsed = sessionTransferSchema.safeParse(request.session);
    if (!parsed.success) throw new Error('OpenCode session export is invalid');
    const session = parsed.data;
    const observed = await hashWorkspace(workspace, WORKSPACE_EXCLUSIONS);
    if (request.beforeCopy) await request.beforeCopy();
    const sessionBytes = Buffer.from(JSON.stringify(session));
    const stage = await mkdtemp(path.join(tmpdir(), 'router-checkpoint-'));
    try {
      await SnapshotPaths.assertDisjoint(workspace, stage, 'Checkpoint staging must stay outside the workspace');
      await SnapshotPaths.assertDisjoint(workspace, request.repository.directory(), 'Snapshot repository must be independent of the workspace');
      const stagedWorkspace = path.join(stage, 'workspace');
      await cp(workspace, stagedWorkspace, {
        recursive: true,
        filter: (source) => WorkspaceCapture.include(workspace, source),
      });
      const files = await hashWorkspace(stagedWorkspace, WORKSPACE_EXCLUSIONS);
      if (!WorkspaceCapture.sameReceipt(observed, files)) throw new Error('Workspace changed while it was being checkpointed');
      await mkdir(request.repository.directory(), { recursive: true, mode: 0o700 });
      const sessionRecord = { id: session.info.id, sha256: createHash('sha256').update(sessionBytes).digest('hex') };
      const sealed = SnapshotManifest.seal({
        workspaceId: request.host.workspaceId,
        architecture: request.host.architecture,
        platform: request.host.platform,
        agentVersion: request.host.agentVersion,
        runtimeDigest: request.host.runtimeDigest,
        files,
        session: sessionRecord,
      });
      await writeFile(path.join(stage, 'session.json'), sessionBytes, { mode: 0o600 });
      await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(sealed), { mode: 0o600 });
      const stored = await request.repository.backup(stage);
      return SnapshotManifest.create({
        workspaceId: request.host.workspaceId,
        architecture: request.host.architecture,
        platform: request.host.platform,
        agentVersion: request.host.agentVersion,
        runtimeDigest: request.host.runtimeDigest,
        snapshotId: stored.snapshotId,
        archivePath: stored.archivePath,
        files,
        session: sessionRecord,
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private static sameReceipt(actual: FileReceipt[], expected: FileReceipt[]): boolean {
    return actual.length === expected.length && actual.every((file, index) => {
      const other = expected[index];
      return !!other && file.path === other.path && file.executable === other.executable && file.sha256 === other.sha256;
    });
  }

  /** Keep the workspace root, and drop excluded directory names at every depth before copy. */
  private static include(workspace: string, source: string): boolean {
    if (path.resolve(source) === workspace) return true;
    return !(WORKSPACE_EXCLUSIONS as readonly string[]).includes(path.basename(source));
  }

  /** Key material for a test or local repository. Never written inside the Git checkout. */
  static async writeKey(directory: string): Promise<string> {
    const file = path.join(directory, 'snapshot.key');
    await writeFile(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  }
}

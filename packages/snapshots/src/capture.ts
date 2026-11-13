import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionTransferSchema, type SessionTransfer } from '../../agent-opencode/src/client.js';
import { SnapshotManifest, WORKSPACE_EXCLUSIONS, type SnapshotHost, type SnapshotManifestData } from '../../domain/src/snapshot.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { SnapshotPaths } from './paths.js';
import type { CheckpointRepository } from './restic.js';

export interface CaptureRequest {
  workspaceDirectory: string;
  session: SessionTransfer;
  host: SnapshotHost;
  repository: CheckpointRepository;
}

/** Quiesced workspace plus exported session, stored only in the encrypted repository. */
export class WorkspaceCapture {
  static async checkpoint(request: CaptureRequest): Promise<SnapshotManifestData> {
    const workspace = path.resolve(request.workspaceDirectory);
    const parsed = sessionTransferSchema.safeParse(request.session);
    if (!parsed.success) throw new Error('OpenCode session export is invalid');
    const session = parsed.data;
    const files = await hashWorkspace(workspace, WORKSPACE_EXCLUSIONS);
    const sessionBytes = Buffer.from(JSON.stringify(session));
    const stage = await mkdtemp(path.join(tmpdir(), 'router-checkpoint-'));
    try {
      await mkdir(request.repository.directory(), { recursive: true, mode: 0o700 });
      await SnapshotPaths.assertDisjoint(workspace, stage, 'Checkpoint staging must stay outside the workspace');
      await SnapshotPaths.assertDisjoint(workspace, request.repository.directory(), 'Snapshot repository must be independent of the workspace');
      await cp(workspace, path.join(stage, 'workspace'), { recursive: true });
      for (const name of WORKSPACE_EXCLUSIONS) await rm(path.join(stage, 'workspace', name), { recursive: true, force: true });
      await writeFile(path.join(stage, 'session.json'), sessionBytes, { mode: 0o600 });
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
        session: { id: session.info.id, sha256: createHash('sha256').update(sessionBytes).digest('hex') },
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /** Key material for a test or local repository. Never written inside the Git checkout. */
  static async writeKey(directory: string): Promise<string> {
    const file = path.join(directory, 'snapshot.key');
    await writeFile(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return file;
  }
}

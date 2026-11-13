import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sessionTransferSchema, type SessionTransfer } from '../../agent-opencode/src/client.js';
import { SnapshotError, SnapshotManifest, WORKSPACE_EXCLUSIONS, type SnapshotHost, type SnapshotManifestData } from '../../domain/src/snapshot.js';
import { hashWorkspace, type FileReceipt } from '../../workspace/src/manifest.js';
import type { CheckpointRepository } from './restic.js';

export interface RestoredWorkspace {
  workspaceDirectory: string;
  session: SessionTransfer;
}

/** Restore one exact snapshot into a fresh directory and refuse anything that does not match the manifest. */
export class WorkspaceRestore {
  static async restore(input: {
    manifest: unknown;
    repository: CheckpointRepository;
    targetDirectory: string;
    host: SnapshotHost;
  }): Promise<RestoredWorkspace> {
    const manifest = SnapshotManifest.parse(input.manifest);
    SnapshotManifest.assertCompatible(manifest, input.host);
    const target = path.resolve(input.targetDirectory);
    await WorkspaceRestore.assertFresh(target);
    await mkdir(target, { mode: 0o700 });
    try {
      await input.repository.verify(manifest.snapshotId);
      await input.repository.restore(manifest.snapshotId, manifest.archivePath, target);
      return await WorkspaceRestore.verifyTree(target, manifest);
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  private static async assertFresh(target: string): Promise<void> {
    try {
      const stat = await lstat(target);
      if (!stat.isDirectory() || (await readdir(target)).length > 0) throw new Error('Restore target must be a fresh directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private static async verifyTree(target: string, manifest: SnapshotManifestData): Promise<RestoredWorkspace> {
    const workspaceDirectory = path.join(target, 'workspace');
    const sessionPath = path.join(target, 'session.json');
    const workspaceStat = await WorkspaceRestore.optionalStat(workspaceDirectory);
    const sessionStat = await WorkspaceRestore.optionalStat(sessionPath);
    if (!workspaceStat?.isDirectory()) throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: missing workspace files');
    if (!sessionStat?.isFile()) throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: missing session export');
    const sessionBytes = await readFile(sessionPath);
    if (createHash('sha256').update(sessionBytes).digest('hex') !== manifest.session.sha256) {
      throw new SnapshotError('TAMPERED', 'Snapshot was tampered: session export does not match the manifest');
    }
    let session: SessionTransfer;
    try { session = sessionTransferSchema.parse(JSON.parse(sessionBytes.toString('utf8'))); }
    catch { throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: session export is unreadable'); }
    if (session.info.id !== manifest.session.id) throw new SnapshotError('TAMPERED', 'Snapshot was tampered: session id does not match the manifest');
    await chmod(sessionPath, 0o600);
    const files = await hashWorkspace(workspaceDirectory, WORKSPACE_EXCLUSIONS);
    if (!WorkspaceRestore.sameFiles(files, manifest.files)) {
      throw new SnapshotError('TAMPERED', 'Snapshot was tampered: restored file hashes do not match the manifest');
    }
    return { workspaceDirectory, session };
  }

  private static sameFiles(actual: FileReceipt[], expected: FileReceipt[]): boolean {
    return actual.length === expected.length && actual.every((file, index) => {
      const other = expected[index];
      return !!other && file.path === other.path && file.executable === other.executable && file.sha256 === other.sha256;
    });
  }

  private static async optionalStat(file: string) {
    try { return await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
}

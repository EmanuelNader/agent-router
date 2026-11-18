import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionTransfer } from '../../agent-opencode/src/client.js';
import type { OperationJournal, OperationRecord } from '../../cli/src/journal.js';
import { captureCheckpoint, restoreCheckpoint } from '../../snapshots/src/checkpoint.js';
import type { CheckpointManifestV3 } from '../../snapshots/src/manifest.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import type { HostTransport } from './transport.js';

export async function handoffWorkspace(options: {
  workspaceKey: string;
  journal: OperationJournal;
  encryptionKey: Buffer;
  sourceWorkspace: string;
  sourceStagingDir: string;
  targetWorkspace: string;
  transport: HostTransport;
  exportSourceSessions: () => Promise<SessionTransfer[]>;
  fenceSource: () => Promise<void>;
  assertTargetIdle?: () => Promise<void>;
  activateTargetAndImportSession: (transfer: SessionTransfer, directory: string) => Promise<string>;
}): Promise<{ operation: OperationRecord; manifest: CheckpointManifestV3 }> {
  const target = path.resolve(options.targetWorkspace);
  const sourceStage = path.resolve(options.sourceStagingDir);
  const op = await options.journal.begin({
    kind: 'HANDOFF',
    workspaceKey: options.workspaceKey,
    summary: 'Initiating fenced cross-host workspace handoff',
  });

  let sourceFenced = false;
  const receiveScratch = await mkdtemp(path.join(tmpdir(), 'router-handoff-recv-'));
  try {
    // Pre-flight check target availability BEFORE fencing the source workspace.
    try {
      await access(target);
      throw new Error(`Target workspace already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (options.assertTargetIdle) await options.assertTargetIdle();

    await mkdir(sourceStage, { recursive: true, mode: 0o700 });
    const sourceStore = new LocalEncryptedStore(sourceStage, options.encryptionKey);

    const manifest = await captureCheckpoint({
      workspace: options.sourceWorkspace,
      store: sourceStore,
      exportSessions: options.exportSourceSessions,
      quiesceSource: async () => {
        await options.fenceSource();
        sourceFenced = true;
      },
    });

    const encryptedArchive = await readFile(path.join(sourceStage, `${manifest.checkpointId}.enc`));
    await options.transport.transferEncryptedCheckpoint(manifest.checkpointId, encryptedArchive);

    const transferredArchive = await options.transport.readTransferredCheckpoint(manifest.checkpointId);
    const receiveStoreDir = path.join(receiveScratch, 'store');
    await mkdir(receiveStoreDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(receiveStoreDir, `${manifest.checkpointId}.enc`), transferredArchive, {
      mode: 0o600,
      flag: 'wx',
    });

    const targetStore = new LocalEncryptedStore(receiveStoreDir, options.encryptionKey);
    await restoreCheckpoint({
      checkpointId: manifest.checkpointId,
      targetWorkspace: target,
      store: targetStore,
      importSession: options.activateTargetAndImportSession,
    });

    const completed = await options.journal.complete(
      op.operationId,
      `Completed handoff ${manifest.checkpointId}`,
    );
    return { operation: completed, manifest };
  } catch (error) {
    if (sourceFenced) {
      await options.journal.markNeedsReconcile(
        op.operationId,
        'Handoff interrupted after source fence; verify source/target state before retry',
      );
    } else {
      await options.journal.abortUnfenced(op.operationId);
    }
    throw error;
  } finally {
    await rm(receiveScratch, { recursive: true, force: true });
  }
}

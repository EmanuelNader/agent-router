import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OperationJournal, OperationRecord } from '../../cli/src/journal.js';
import { captureAgentCheckpoint, inspectGit, type CaptureAgentSpec } from '../../snapshots/src/checkpoint.js';
import { checkpointManifestV3Schema, type CheckpointManifestV3 } from '../../snapshots/src/manifest.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { hashWorkspace } from '../../workspace/src/manifest.js';
import { validateRemotePosixDirectory, type HostTransport } from './transport.js';

export interface MoveTransport extends HostTransport {
  runRemoteCommand(remoteCommand: string[], input?: Buffer): Promise<{ stdout: string }>;
  removeTransferredCheckpoint(checkpointId: string): Promise<void>;
}

/** SSH joins the command vector into one remote shell line, so every word must be free of shell syntax. */
const remoteWordPattern = /^[A-Za-z0-9_./:=@+,-]+$/;

export function assertRemoteWords(words: string[]): string[] {
  for (const word of words) {
    if (!remoteWordPattern.test(word) || (word.startsWith('-') && !/^--[a-z][a-z-]*$/.test(word))) {
      throw new Error('Remote command contains an unsafe argument');
    }
  }
  return words;
}

/**
 * Moves a quiesced workspace and its saved agent history to another host that already has Agent Router.
 *
 * The encrypted checkpoint is uploaded, then restored by the remote Agent Router, which reads the key from
 * stdin so it is never written to the remote disk. A failure before the remote restore starts leaves the
 * source untouched and clears the journal entry. Once the remote restore has been started its outcome can be
 * unknown (for example a dropped connection), so any failure from there is recorded as NEEDS_RECONCILE.
 * The source agent is stopped only after the remote pre-flight checks pass and is never restarted here.
 * The source is removed only on request, only after the remote reports the same manifest, and only if the
 * source still matches the checkpoint.
 */
export async function moveWorkspaceToHost(options: {
  workspaceKey: string;
  journal: OperationJournal;
  encryptionKey: Buffer;
  sourceWorkspace: string;
  agent: CaptureAgentSpec;
  transport: MoveTransport;
  routerVersion: string;
  remoteRouter: string;
  remoteWorkspace: string;
  remoteSpool: string;
  remoteAgentArgs?: string[];
  /** Features the remote build must report through `supports`, checked before capture. */
  requiredRemoteFeatures?: string[];
  /** Stops the source agent. Runs after the remote pre-flight checks, at the point capture needs the agent quiet. */
  quiesceSource?: () => Promise<void>;
  removeSource?: boolean;
}): Promise<{ operation: OperationRecord; manifest: CheckpointManifestV3; remoteWorkspace: string; sourceRemoved: boolean; sourceAgentStopped: boolean }> {
  const source = path.resolve(options.sourceWorkspace);
  const remoteWorkspace = validateRemotePosixDirectory(options.remoteWorkspace);
  const remoteSpool = validateRemotePosixDirectory(options.remoteSpool);
  const remoteJournal = path.posix.join(path.posix.dirname(remoteSpool), 'journal');
  const router = assertRemoteWords([options.remoteRouter])[0]!;
  const agentArgs = assertRemoteWords(options.remoteAgentArgs ?? []);
  assertRemoteWords([options.workspaceKey]);
  const { transport } = options;

  const op = await options.journal.begin({
    kind: 'HANDOFF',
    workspaceKey: options.workspaceKey,
    summary: `Moving ${options.workspaceKey} (${options.agent.kind}) to a remote host`,
  });
  const scratch = await mkdtemp(path.join(tmpdir(), 'router-move-'));
  let uploadedId: string | undefined;
  let remoteRestoreStarted = false;
  let sourceAgentStopped = false;
  try {
    let remoteVersion: string;
    try {
      remoteVersion = (await transport.runRemoteCommand([router, '--version'])).stdout.trim();
    } catch {
      throw new Error('REMOTE_ROUTER_UNAVAILABLE: could not run Agent Router on the remote host');
    }
    if (remoteVersion !== options.routerVersion) {
      throw new Error(`REMOTE_ROUTER_VERSION_MISMATCH: local ${options.routerVersion}, remote differs`);
    }
    for (const feature of assertRemoteWords(options.requiredRemoteFeatures ?? [])) {
      try {
        await transport.runRemoteCommand([router, 'supports', feature]);
      } catch {
        throw new Error(`REMOTE_ROUTER_TOO_OLD: the remote Agent Router does not support ${feature}; update it`);
      }
    }
    try {
      await transport.runRemoteCommand(['test', '!', '-e', remoteWorkspace]);
    } catch {
      throw new Error('REMOTE_WORKSPACE_EXISTS_OR_UNREADABLE: remote target workspace must not exist');
    }

    const store = new LocalEncryptedStore(path.join(scratch, 'store'), options.encryptionKey);
    const manifest = await captureAgentCheckpoint({
      workspace: source,
      store,
      agent: options.agent,
      ...(options.quiesceSource
        ? {
            quiesceSource: async () => {
              await options.quiesceSource!();
              sourceAgentStopped = true;
            },
          }
        : {}),
    });
    const ciphertext = await readFile(path.join(scratch, 'store', `${manifest.checkpointId}.enc`));
    await transport.transferEncryptedCheckpoint(manifest.checkpointId, ciphertext);
    uploadedId = manifest.checkpointId;

    remoteRestoreStarted = true;
    const { stdout } = await transport.runRemoteCommand(
      [
        router, 'restore',
        '--checkpoint', manifest.checkpointId,
        '--target', remoteWorkspace,
        '--store', remoteSpool,
        '--key-stdin',
        '--journal-dir', remoteJournal,
        '--workspace-key', options.workspaceKey,
        '--agent', options.agent.kind,
        ...agentArgs,
      ],
      Buffer.from(`${options.encryptionKey.toString('hex')}\n`, 'utf8'),
    );
    let remoteManifest: unknown;
    try {
      const { operationId: _remoteOperation, ...rest } = JSON.parse(stdout) as Record<string, unknown>;
      remoteManifest = checkpointManifestV3Schema.parse(rest);
    } catch {
      throw new Error('REMOTE_RESTORE_UNVERIFIED: remote restore did not return a checkpoint manifest');
    }
    if (!isDeepStrictEqual(remoteManifest, manifest)) {
      throw new Error('REMOTE_RESTORE_UNVERIFIED: remote manifest differs from the captured checkpoint');
    }

    let sourceRemoved = false;
    let note = 'source kept';
    if (options.removeSource) {
      const current = await hashWorkspace(source, { symlinks: true, exclusions: manifest.exclusions });
      // hashWorkspace skips .git, so commits and staging made after capture need their own check.
      const currentGit = await inspectGit(source, manifest.exclusions);
      if (isDeepStrictEqual(current, manifest.workspaceFiles) && isDeepStrictEqual(currentGit, manifest.git)) {
        await rm(source, { recursive: true, force: true });
        sourceRemoved = true;
        note = 'source removed';
      } else {
        note = 'source kept because it changed after the checkpoint';
      }
    }
    await transport.removeTransferredCheckpoint(manifest.checkpointId).catch(() => undefined);
    const operation = await options.journal.complete(op.operationId, `Moved ${manifest.checkpointId}; ${note}`);
    return { operation, manifest, remoteWorkspace, sourceRemoved, sourceAgentStopped };
  } catch (error) {
    if (remoteRestoreStarted) {
      await options.journal
        .markNeedsReconcile(
          op.operationId,
          `Move failed after remote restore started${uploadedId ? ` (${uploadedId})` : ''}; check the remote workspace before retry`,
        )
        .catch(() => undefined);
    } else {
      if (uploadedId) await transport.removeTransferredCheckpoint(uploadedId).catch(() => undefined);
      await options.journal.abortUnfenced(op.operationId).catch(() => undefined);
    }
    if (sourceAgentStopped && error instanceof Error) {
      error.message += '; the source agent was stopped and has not been restarted';
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

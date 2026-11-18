import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkpointIdSchema } from '../../snapshots/src/store.js';

const sshBaseOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15'] as const;

export function validateSshTarget(target: string): string {
  if (
    !target ||
    target.startsWith('-') ||
    /[\s\r\n\0:\\/]/.test(target) ||
    !/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(target)
  ) {
    throw new Error('Invalid SSH target: expected safe host or user@host without option flags or delimiters');
  }
  return target;
}

function validatePort(port?: number): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('Invalid SSH port: expected integer between 1 and 65535');
  }
}

export function buildSshArgs(target: string, remoteCommand: string[], port?: number): string[] {
  const checkedTarget = validateSshTarget(target);
  validatePort(port);
  if (remoteCommand.length === 0 || remoteCommand.some(arg => !arg || arg.includes('\0'))) {
    throw new Error('Invalid remote SSH command vector');
  }
  return [
    ...sshBaseOptions,
    ...(port !== undefined ? ['-p', String(port)] : []),
    '--',
    checkedTarget,
    ...remoteCommand,
  ];
}

export function buildScpUploadArgs(
  localArchivePath: string,
  target: string,
  remoteArchivePath: string,
  port?: number,
): string[] {
  const checkedTarget = validateSshTarget(target);
  validatePort(port);
  if (!path.isAbsolute(localArchivePath) || /[\r\n\0]/.test(localArchivePath)) {
    throw new Error('Local archive path must be an absolute path');
  }
  if (!path.posix.isAbsolute(remoteArchivePath) || /[\s\r\n\0:]/.test(remoteArchivePath)) {
    throw new Error('Remote archive path must be a safe POSIX absolute path without colons or whitespace');
  }
  return [
    ...sshBaseOptions,
    ...(port !== undefined ? ['-P', String(port)] : []),
    '--',
    localArchivePath,
    `${checkedTarget}:${remoteArchivePath}`,
  ];
}

export interface HostTransport {
  transferEncryptedCheckpoint(checkpointId: string, encryptedBytes: Buffer): Promise<void>;
  readTransferredCheckpoint(checkpointId: string): Promise<Buffer>;
}

export class LoopbackHostTransport implements HostTransport {
  private readonly spoolDirectory: string;

  constructor(spoolDirectory: string) {
    this.spoolDirectory = path.resolve(spoolDirectory);
  }

  async transferEncryptedCheckpoint(checkpointId: string, encryptedBytes: Buffer): Promise<void> {
    const id = checkpointIdSchema.parse(checkpointId);
    await mkdir(this.spoolDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.spoolDirectory, `${id}.enc`), encryptedBytes, { mode: 0o600, flag: 'wx' });
  }

  async readTransferredCheckpoint(checkpointId: string): Promise<Buffer> {
    const id = checkpointIdSchema.parse(checkpointId);
    return await readFile(path.join(this.spoolDirectory, `${id}.enc`));
  }
}

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkpointIdSchema } from '../../snapshots/src/store.js';

const execFileAsync = promisify(execFile);

export interface SshConnectionOptions {
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  configFile?: string;
  strictHostKeyChecking?: 'yes' | 'accept-new';
}

function buildSshBaseOptions(opts: SshConnectionOptions): string[] {
  const hostKeyMode = opts.strictHostKeyChecking ?? 'yes';
  return ['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${hostKeyMode}`, '-o', 'ConnectTimeout=15'];
}

function validateSafeLocalAuthFile(filePath: string, label: string): string {
  if (
    !path.isAbsolute(filePath) ||
    /[\s\r\n\0"'%]/.test(filePath) ||
    /^\/dev(\/|$)/.test(path.posix.normalize(filePath))
  ) {
    throw new Error(`Invalid SSH ${label}: expected regular absolute file path without whitespace, quotes, %, or /dev`);
  }
  return filePath;
}

function normalizeConnectionOptions(portOrOptions?: number | SshConnectionOptions): SshConnectionOptions {
  if (typeof portOrOptions === 'number') {
    validatePort(portOrOptions);
    return { port: portOrOptions };
  }
  const opts = portOrOptions ?? {};
  validatePort(opts.port);
  if (opts.strictHostKeyChecking === 'accept-new' && opts.knownHostsFile === undefined) {
    throw new Error('StrictHostKeyChecking=accept-new requires an explicit isolated knownHostsFile');
  }
  if (
    opts.strictHostKeyChecking !== undefined &&
    opts.strictHostKeyChecking !== 'yes' &&
    opts.strictHostKeyChecking !== 'accept-new'
  ) {
    throw new Error('Invalid StrictHostKeyChecking mode');
  }
  return {
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.identityFile !== undefined
      ? { identityFile: validateSafeLocalAuthFile(opts.identityFile, 'identityFile') }
      : {}),
    ...(opts.knownHostsFile !== undefined
      ? { knownHostsFile: validateSafeLocalAuthFile(opts.knownHostsFile, 'knownHostsFile') }
      : {}),
    ...(opts.configFile !== undefined
      ? { configFile: validateSafeLocalAuthFile(opts.configFile, 'configFile') }
      : {}),
    ...(opts.strictHostKeyChecking !== undefined ? { strictHostKeyChecking: opts.strictHostKeyChecking } : {}),
  };
}

function buildAuthOptionFlags(opts: SshConnectionOptions): string[] {
  const flags: string[] = [];
  if (opts.configFile !== undefined) {
    flags.push('-F', opts.configFile);
  }
  if (opts.identityFile !== undefined) {
    flags.push('-o', 'IdentitiesOnly=yes', '-i', opts.identityFile);
  }
  if (opts.knownHostsFile !== undefined) {
    flags.push('-o', `UserKnownHostsFile=${opts.knownHostsFile}`);
  }
  return flags;
}

export function validateSshTarget(target: string): string {
  if (
    !target ||
    target.startsWith('-') ||
    /[\s\r\n\0\\/]/.test(target) ||
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

export function validateRemotePosixDirectory(remoteDirectory: string): string {
  if (
    !path.posix.isAbsolute(remoteDirectory) ||
    !/^\/[A-Za-z0-9._/-]+$/.test(remoteDirectory) ||
    remoteDirectory.split('/').includes('..')
  ) {
    throw new Error('Remote directory must be a safe POSIX absolute path without traversal, colons, or metacharacters');
  }
  const normalized = path.posix.normalize(remoteDirectory).replace(/\/+$/, '');
  if (!normalized || normalized === '/') {
    throw new Error('Remote directory must not be filesystem root');
  }
  return normalized;
}

export function buildSshArgs(
  target: string,
  remoteCommand: string[],
  portOrOptions?: number | SshConnectionOptions,
): string[] {
  const checkedTarget = validateSshTarget(target);
  const sshDestination = checkedTarget.replace(/\[([0-9a-fA-F:]+)\]$/, '$1');
  const conn = normalizeConnectionOptions(portOrOptions);
  if (remoteCommand.length === 0 || remoteCommand.some(arg => !arg || arg.includes('\0'))) {
    throw new Error('Invalid remote SSH command vector');
  }
  return [
    ...buildSshBaseOptions(conn),
    ...buildAuthOptionFlags(conn),
    ...(conn.port !== undefined ? ['-p', String(conn.port)] : []),
    '--',
    sshDestination,
    ...remoteCommand,
  ];
}

export function buildScpUploadArgs(
  localArchivePath: string,
  target: string,
  remoteArchivePath: string,
  portOrOptions?: number | SshConnectionOptions,
): string[] {
  const checkedTarget = validateSshTarget(target);
  const conn = normalizeConnectionOptions(portOrOptions);
  if (!path.isAbsolute(localArchivePath) || /[\r\n\0]/.test(localArchivePath)) {
    throw new Error('Local archive path must be an absolute path');
  }
  if (!path.posix.isAbsolute(remoteArchivePath) || /[\s\r\n\0:]/.test(remoteArchivePath)) {
    throw new Error('Remote archive path must be a safe POSIX absolute path without colons or whitespace');
  }
  return [
    ...buildSshBaseOptions(conn),
    ...buildAuthOptionFlags(conn),
    ...(conn.port !== undefined ? ['-P', String(conn.port)] : []),
    '--',
    localArchivePath,
    `${checkedTarget}:${remoteArchivePath}`,
  ];
}

export function buildScpDownloadArgs(
  target: string,
  remoteArchivePath: string,
  localArchivePath: string,
  portOrOptions?: number | SshConnectionOptions,
): string[] {
  const checkedTarget = validateSshTarget(target);
  const conn = normalizeConnectionOptions(portOrOptions);
  if (!path.posix.isAbsolute(remoteArchivePath) || /[\s\r\n\0:]/.test(remoteArchivePath)) {
    throw new Error('Remote archive path must be a safe POSIX absolute path without colons or whitespace');
  }
  if (!path.isAbsolute(localArchivePath) || /[\r\n\0]/.test(localArchivePath)) {
    throw new Error('Local archive path must be an absolute path');
  }
  return [
    ...buildSshBaseOptions(conn),
    ...buildAuthOptionFlags(conn),
    ...(conn.port !== undefined ? ['-P', String(conn.port)] : []),
    '--',
    `${checkedTarget}:${remoteArchivePath}`,
    localArchivePath,
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

export interface SshCliTransportOptions {
  target: string;
  remoteSpoolDirectory: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
  configFile?: string;
  strictHostKeyChecking?: 'yes' | 'accept-new';
  sshBinary?: string;
  scpBinary?: string;
  timeoutMs?: number;
}

export class SshCliTransport implements HostTransport {
  private readonly target: string;
  private readonly remoteSpoolDirectory: string;
  private readonly connOptions: SshConnectionOptions;
  private readonly sshBinary: string;
  private readonly scpBinary: string;
  private readonly timeoutMs: number;

  constructor(options: SshCliTransportOptions) {
    this.target = validateSshTarget(options.target);
    this.remoteSpoolDirectory = validateRemotePosixDirectory(options.remoteSpoolDirectory);
    this.connOptions = normalizeConnectionOptions({
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.identityFile !== undefined ? { identityFile: options.identityFile } : {}),
      ...(options.knownHostsFile !== undefined ? { knownHostsFile: options.knownHostsFile } : {}),
      ...(options.configFile !== undefined ? { configFile: options.configFile } : {}),
      ...(options.strictHostKeyChecking !== undefined
        ? { strictHostKeyChecking: options.strictHostKeyChecking }
        : {}),
    });
    this.sshBinary = options.sshBinary ?? 'ssh';
    this.scpBinary = options.scpBinary ?? 'scp';
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private subprocessEnv(): NodeJS.ProcessEnv {
    if (this.connOptions.identityFile !== undefined) {
      return { ...process.env, SSH_AUTH_SOCK: '' };
    }
    return process.env;
  }

  async runRemoteCommand(remoteCommand: string[]): Promise<{ stdout: string }> {
    const args = buildSshArgs(this.target, remoteCommand, this.connOptions);
    try {
      const { stdout } = await execFileAsync(this.sshBinary, args, {
        env: this.subprocessEnv(),
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout };
    } catch (err) {
      const code = typeof (err as { code?: unknown })?.code === 'number' ? (err as { code: number }).code : undefined;
      const sanitized = new Error(`SSH remote command "${remoteCommand[0] ?? 'unknown'}" failed`) as NodeJS.ErrnoException & {
        exitCode?: number;
      };
      if (code !== undefined) sanitized.exitCode = code;
      throw sanitized;
    }
  }

  async transferEncryptedCheckpoint(checkpointId: string, encryptedBytes: Buffer): Promise<void> {
    const id = checkpointIdSchema.parse(checkpointId);
    const remoteFinalPath = path.posix.join(this.remoteSpoolDirectory, `${id}.enc`);
    const remoteTempPath = path.posix.join(this.remoteSpoolDirectory, `.${id}.${randomBytes(8).toString('hex')}.tmp`);

    await this.runRemoteCommand(['mkdir', '-m', '0700', '-p', this.remoteSpoolDirectory]);
    try {
      await this.runRemoteCommand(['test', '!', '-e', remoteFinalPath]);
    } catch (err) {
      if ((err as { exitCode?: number }).exitCode === 1) {
        const exists = new Error(`Checkpoint already exists on remote host: ${id}`) as NodeJS.ErrnoException;
        exists.code = 'EEXIST';
        throw exists;
      }
      throw err;
    }

    const scratch = await mkdtemp(path.join(tmpdir(), 'router-scp-up-'));
    let uploadedTemp = false;
    try {
      await chmod(scratch, 0o700);
      const localStagingPath = path.join(scratch, `${id}.enc`);
      await writeFile(localStagingPath, encryptedBytes, { mode: 0o600, flag: 'wx' });

      const scpArgs = buildScpUploadArgs(localStagingPath, this.target, remoteTempPath, this.connOptions);
      try {
        await execFileAsync(this.scpBinary, scpArgs, {
          env: this.subprocessEnv(),
          timeout: this.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
        uploadedTemp = true;
      } catch {
        throw new Error('SCP checkpoint upload failed');
      }

      await this.runRemoteCommand(['chmod', '0600', remoteTempPath]);
      try {
        await this.runRemoteCommand(['ln', remoteTempPath, remoteFinalPath]);
      } catch (err) {
        if ((err as { exitCode?: number }).exitCode === 1) {
          const exists = new Error(`Checkpoint already exists on remote host: ${id}`) as NodeJS.ErrnoException;
          exists.code = 'EEXIST';
          throw exists;
        }
        throw err;
      }
    } finally {
      if (uploadedTemp) {
        await this.runRemoteCommand(['rm', '-f', remoteTempPath]).catch(() => undefined);
      }
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async readTransferredCheckpoint(checkpointId: string): Promise<Buffer> {
    const id = checkpointIdSchema.parse(checkpointId);
    const remoteFinalPath = path.posix.join(this.remoteSpoolDirectory, `${id}.enc`);
    const scratch = await mkdtemp(path.join(tmpdir(), 'router-scp-down-'));
    try {
      await chmod(scratch, 0o700);
      const localPath = path.join(scratch, `${id}.enc`);
      const scpArgs = buildScpDownloadArgs(this.target, remoteFinalPath, localPath, this.connOptions);
      try {
        await execFileAsync(this.scpBinary, scpArgs, {
          env: this.subprocessEnv(),
          timeout: this.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch {
        throw new Error('SCP checkpoint download failed');
      }
      await chmod(localPath, 0o600);
      return await readFile(localPath);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

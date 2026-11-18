import { execFile, execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assertSafeRelativePath } from './manifest.js';
import { checkpointIdSchema, type SnapshotEntry, type SnapshotStore } from './store.js';

const execFileAsync = promisify(execFile);

const sftpDefaultOption = 'sftp.args=-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15';

export type ResticRemoteInput =
  | {
      kind: 'sftp';
      target: string;
      path: string;
      port?: number;
      identityFile?: string;
      knownHostsFile?: string;
    }
  | {
      kind: 'oci-s3';
      namespace: string;
      region: string;
      bucket: string;
      prefix?: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | {
      kind: 'r2';
      accountId: string;
      bucket: string;
      prefix?: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | {
      kind: 'aws-s3';
      region: string;
      bucket: string;
      prefix?: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export interface ResticAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ResticRemoteConfig {
  repository: string;
  options: string[];
  awsCredentials?: ResticAwsCredentials;
}

export interface ResticStoreConfig {
  options?: string[];
  awsCredentials?: ResticAwsCredentials;
  extraEnv?: Record<string, string>;
  resticBinary?: string;
}

function validateSftpTarget(target: string): string {
  if (
    !target ||
    target.startsWith('-') ||
    /[\s\r\n\0:\\/]/.test(target) ||
    !/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(target)
  ) {
    throw new Error('Invalid SFTP target: expected safe host or user@host');
  }
  return target;
}

function validateSftpPath(remotePath: string): { isAbsolute: boolean; normalized: string } {
  if (!remotePath || remotePath.includes('~') || remotePath.startsWith('-') || /[\s\r\n\0:\\]/.test(remotePath)) {
    throw new Error('Invalid SFTP path: tilde expansion, flags, colons, and whitespace are forbidden');
  }
  if (remotePath.startsWith('/')) {
    const normalized = path.posix.normalize(remotePath).replace(/\/+$/, '');
    if (!normalized.startsWith('/') || normalized === '/' || remotePath.split('/').includes('..')) {
      throw new Error('Invalid SFTP absolute path');
    }
    return { isAbsolute: true, normalized };
  }
  return { isAbsolute: false, normalized: assertSafeRelativePath(remotePath) };
}

function validateBucket(bucket: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new Error('Invalid S3 bucket name');
  }
  return bucket;
}

function validateAwsCredentials(accessKeyId: string, secretAccessKey: string): ResticAwsCredentials {
  if (
    !accessKeyId.trim() ||
    !secretAccessKey.trim() ||
    /[\r\n\0]/.test(accessKeyId) ||
    /[\r\n\0]/.test(secretAccessKey)
  ) {
    throw new Error('Invalid S3 credentials');
  }
  return { accessKeyId, secretAccessKey };
}

function validateResticOption(option: string): string {
  if (!/^[a-z0-9._-]+=[A-Za-z0-9._=:/ -]+$/.test(option) || /[\r\n\0]/.test(option)) {
    throw new Error('Invalid restic -o option');
  }
  return option;
}

function validateSftpLocalAuthFile(filePath: string, label: string): string {
  if (!path.isAbsolute(filePath) || !/^[A-Za-z0-9._/-]+$/.test(filePath)) {
    throw new Error(`Invalid SFTP ${label}: expected safe absolute path without spaces or quotes`);
  }
  return filePath;
}

export function buildResticRemoteConfig(input: ResticRemoteInput): ResticRemoteConfig {
  if (input.kind === 'sftp') {
    const target = validateSftpTarget(input.target);
    const checkedPath = validateSftpPath(input.path);
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)) {
      throw new Error('Invalid SFTP port');
    }
    const repository =
      input.port !== undefined
        ? checkedPath.isAbsolute
          ? `sftp://${target}:${input.port}//${checkedPath.normalized.slice(1)}`
          : `sftp://${target}:${input.port}/${checkedPath.normalized}`
        : `sftp:${target}:${checkedPath.normalized}`;

    const extraArgs: string[] = [];
    if (input.identityFile !== undefined) {
      extraArgs.push('-o', 'IdentitiesOnly=yes', '-i', validateSftpLocalAuthFile(input.identityFile, 'identityFile'));
    }
    if (input.knownHostsFile !== undefined) {
      extraArgs.push('-o', `UserKnownHostsFile=${validateSftpLocalAuthFile(input.knownHostsFile, 'knownHostsFile')}`);
    }
    const sftpOption = extraArgs.length > 0 ? `${sftpDefaultOption} ${extraArgs.join(' ')}` : sftpDefaultOption;

    return {
      repository,
      options: [sftpOption],
    };
  }

  const bucket = validateBucket(input.bucket);
  const suffix = input.prefix ? `/${assertSafeRelativePath(input.prefix)}` : '';
  const awsCredentials = validateAwsCredentials(input.accessKeyId, input.secretAccessKey);

  if (input.kind === 'oci-s3') {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.namespace)) {
      throw new Error('Invalid OCI Object Storage namespace');
    }
    if (!/^[a-z]{2,3}-[a-z0-9-]+-\d+$/.test(input.region)) {
      throw new Error('Invalid OCI region');
    }
    return {
      repository: `s3:https://${input.namespace}.compat.objectstorage.${input.region}.oraclecloud.com/${bucket}${suffix}`,
      options: ['s3.bucket-lookup=path', `s3.region=${input.region}`],
      awsCredentials,
    };
  }

  if (input.kind === 'r2') {
    if (!/^[a-f0-9]{32}$/.test(input.accountId)) {
      throw new Error('Invalid Cloudflare R2 account ID');
    }
    return {
      repository: `s3:https://${input.accountId}.r2.cloudflarestorage.com/${bucket}${suffix}`,
      options: ['s3.region=auto'],
      awsCredentials,
    };
  }

  if (!/^[a-z]{2,3}-[a-z0-9-]+-\d+$/.test(input.region)) {
    throw new Error('Invalid AWS S3 region');
  }
  return {
    repository: `s3:s3.${input.region}.amazonaws.com/${bucket}${suffix}`,
    options: [`s3.region=${input.region}`],
    awsCredentials,
  };
}

export function isResticAvailable(): boolean {
  try {
    return execFileSync('restic', ['version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).startsWith('restic ');
  } catch {
    return false;
  }
}

const resticSnapshotsSchema = z.array(z.object({ id: z.string().min(1) }));

export class ResticRepositoryStore implements SnapshotStore {
  private readonly repository: string;
  private readonly password: string;
  private readonly options: string[];
  private readonly awsCredentials: ResticAwsCredentials | undefined;
  private readonly extraEnv: Record<string, string>;
  private readonly resticBinary: string;
  private initialized = false;

  constructor(repository: string, password: string, extraEnvOrConfig: Record<string, string> | ResticStoreConfig = {}) {
    if (!repository.trim() || /[\r\n\0]/.test(repository) || !password || password.length < 16) {
      throw new Error('Restic repository and a strong password (>= 16 chars) are required');
    }
    this.repository = repository;
    this.password = password;

    if (
      'options' in extraEnvOrConfig ||
      'awsCredentials' in extraEnvOrConfig ||
      'extraEnv' in extraEnvOrConfig ||
      'resticBinary' in extraEnvOrConfig
    ) {
      const cfg = extraEnvOrConfig as ResticStoreConfig;
      this.options = (cfg.options ?? []).map(validateResticOption);
      this.awsCredentials = cfg.awsCredentials
        ? validateAwsCredentials(cfg.awsCredentials.accessKeyId, cfg.awsCredentials.secretAccessKey)
        : undefined;
      this.extraEnv = { ...(cfg.extraEnv ?? {}) };
      this.resticBinary = cfg.resticBinary ?? 'restic';
    } else {
      this.options = [];
      this.awsCredentials = undefined;
      this.extraEnv = { ...(extraEnvOrConfig as Record<string, string>) };
      this.resticBinary = 'restic';
    }
  }

  static fromRemoteConfig(
    remote: ResticRemoteConfig,
    password: string,
    overrides: Omit<ResticStoreConfig, 'options' | 'awsCredentials'> = {},
  ): ResticRepositoryStore {
    return new ResticRepositoryStore(remote.repository, password, {
      options: remote.options,
      ...(remote.awsCredentials ? { awsCredentials: remote.awsCredentials } : {}),
      ...overrides,
    });
  }

  private async withRestic<T>(fn: (run: (args: string[], cwd?: string) => Promise<string>, scratch: string) => Promise<T>): Promise<T> {
    const scratch = await mkdtemp(path.join(tmpdir(), 'router-restic-run-'));
    try {
      await chmod(scratch, 0o700);
      const passwordFile = path.join(scratch, 'password');
      const cacheDir = path.join(scratch, 'cache');
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(passwordFile, this.password, { mode: 0o600, flag: 'wx' });

      let credentialsEnv: Record<string, string> = {};
      if (this.awsCredentials) {
        const credentialsFile = path.join(scratch, 'aws-credentials');
        const body = `[default]\naws_access_key_id = ${this.awsCredentials.accessKeyId}\naws_secret_access_key = ${this.awsCredentials.secretAccessKey}\n`;
        await writeFile(credentialsFile, body, { mode: 0o600, flag: 'wx' });
        await chmod(credentialsFile, 0o600);
        credentialsEnv = {
          AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
          AWS_PROFILE: 'default',
        };
      }

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: scratch,
        XDG_CACHE_HOME: cacheDir,
        TMPDIR: scratch,
        RESTIC_REPOSITORY: this.repository,
        RESTIC_PASSWORD_FILE: passwordFile,
        ...credentialsEnv,
        ...this.extraEnv,
      };

      const optionPrefix = this.options.flatMap(opt => ['-o', opt]);

      const run = async (args: string[], cwd = scratch): Promise<string> => {
        const subcommand = args[0] ?? 'command';
        try {
          const { stdout } = await execFileAsync(this.resticBinary, [...optionPrefix, ...args], {
            cwd,
            env,
            timeout: 60_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return stdout;
        } catch {
          // Never expose repository credentials, paths, or raw stderr details.
          throw new Error(`restic ${subcommand} failed`);
        }
      };

      return await fn(run, scratch);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async ensureInitialized(run: (args: string[]) => Promise<string>): Promise<void> {
    if (this.initialized) return;
    try {
      await run(['cat', 'config']);
    } catch {
      await run(['init']);
    }
    this.initialized = true;
  }

  async put(checkpointId: string, entries: SnapshotEntry[]): Promise<void> {
    const id = checkpointIdSchema.parse(checkpointId);
    await this.withRestic(async (run, scratch) => {
      await this.ensureInitialized(run);
      const existing = resticSnapshotsSchema.parse(JSON.parse(await run(['snapshots', '--json', '--tag', id])));
      if (existing.length > 0) {
        const error = new Error(`Checkpoint already exists: ${id}`) as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }

      const stage = path.join(scratch, 'stage');
      await mkdir(stage, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        const rel = assertSafeRelativePath(entry.path);
        const dest = path.join(stage, rel);
        await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await writeFile(dest, entry.data, { mode: entry.executable ? 0o755 : 0o600, flag: 'wx' });
        if (entry.executable) await chmod(dest, 0o755);
      }
      await run(['backup', '.', '--tag', id, '--quiet'], stage);
    });
  }

  async verifyIntegrity(): Promise<void> {
    await this.withRestic(async run => {
      await run(['check', '--read-data']);
    });
  }

  async get(checkpointId: string): Promise<SnapshotEntry[]> {
    const id = checkpointIdSchema.parse(checkpointId);
    return await this.withRestic(async (run, scratch) => {
      const matches = resticSnapshotsSchema.parse(JSON.parse(await run(['snapshots', '--json', '--tag', id])));
      if (matches.length !== 1) throw new Error('Expected exactly one restic snapshot for checkpoint');

      const restoredRoot = path.join(scratch, 'restored');
      await mkdir(restoredRoot, { recursive: true, mode: 0o700 });
      await run(['restore', matches[0]!.id, '--target', restoredRoot]);

      const entries: SnapshotEntry[] = [];
      async function visit(relative: string): Promise<void> {
        for (const name of (await readdir(path.join(restoredRoot, relative))).sort()) {
          const rel = relative ? `${relative}/${name}` : name;
          const abs = path.join(restoredRoot, rel);
          const stat = await lstat(abs);
          if (stat.isSymbolicLink()) throw new Error(`Symlink unsupported in restored snapshot: ${rel}`);
          if (stat.isDirectory()) await visit(rel);
          else if (stat.isFile()) {
            entries.push({
              path: assertSafeRelativePath(rel),
              executable: (stat.mode & 0o111) !== 0,
              data: await readFile(abs),
            });
          } else throw new Error(`Unsupported special file in restored snapshot: ${rel}`);
        }
      }
      await visit('');
      return entries;
    });
  }
}

import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RESTIC_VERSION, SnapshotError } from '../../domain/src/snapshot.js';
import { SnapshotPaths } from './paths.js';

export interface CheckpointSnapshot {
  snapshotId: string;
  archivePath: string;
}

/** Encrypted checkpoint store. Restic is the only implementation in this milestone. */
export interface CheckpointRepository {
  directory(): string;
  backup(directory: string): Promise<CheckpointSnapshot>;
  restore(snapshotId: string, archivePath: string, targetDirectory: string): Promise<void>;
  verify(snapshotId: string): Promise<void>;
}

interface ToolResult { code: number; stdout: string; stderr: string }

export class ResticRepository implements CheckpointRepository {
  private readonly binary: string;
  private readonly repository: string;
  private readonly passwordFile: string;
  private versionChecked = false;

  constructor(options: { repository: string; passwordFile: string; binary?: string }) {
    this.binary = options.binary ?? process.env.ROUTER_RESTIC_BIN ?? 'restic';
    this.repository = path.resolve(options.repository);
    this.passwordFile = path.resolve(options.passwordFile);
  }

  directory(): string { return this.repository; }

  async backup(directory: string): Promise<CheckpointSnapshot> {
    const source = await ResticRepository.realDirectory(directory);
    await mkdir(this.repository, { recursive: true, mode: 0o700 });
    await this.assertPasswordFile();
    await SnapshotPaths.assertDisjoint(this.repository, source, 'Snapshot repository must be independent of the backed-up directory');
    await this.assertBinary();
    await this.ensureRepository();
    const result = await this.execute(['--no-cache', 'backup', '--json', '--one-file-system', source]);
    if (result.code !== 0) throw new Error(ResticRepository.failure('Snapshot backup failed', result.stderr));
    const snapshotId = ResticRepository.snapshotId(result.stdout);
    if (!snapshotId) throw new Error('Snapshot backup did not return a snapshot id');
    return { snapshotId, archivePath: source };
  }

  async verify(snapshotId: string): Promise<void> {
    await this.assertPasswordFile();
    await this.assertBinary();
    const check = await this.execute(['--no-cache', 'check', '--read-data']);
    if (check.code !== 0) throw ResticRepository.integrity(check.stderr);
    const listed = await this.execute(['--no-cache', 'snapshots', '--json']);
    if (listed.code !== 0) throw ResticRepository.integrity(listed.stderr);
    const ids = ResticRepository.snapshotIds(listed.stdout);
    if (!ids) throw new SnapshotError('CORRUPTED', 'Snapshot is corrupted: repository metadata is unreadable');
    if (!ids.includes(snapshotId)) throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: requested snapshot is missing');
  }

  async restore(snapshotId: string, archivePath: string, targetDirectory: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(snapshotId) || !archivePath.startsWith('/') || archivePath.includes(':') || archivePath.includes('\n')) {
      throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: requested snapshot data is missing');
    }
    await this.assertPasswordFile();
    await this.assertBinary();
    const result = await this.execute(['--no-cache', 'restore', `${snapshotId}:${archivePath}`, '--target', targetDirectory]);
    if (result.code !== 0) {
      if (/ciphertext verification failed|repository contains errors|damaged pack/i.test(result.stderr)) throw ResticRepository.integrity(result.stderr);
      throw new SnapshotError('INCOMPLETE', 'Snapshot is incomplete: requested snapshot data is missing');
    }
  }

  private async assertBinary(): Promise<void> {
    if (this.versionChecked) return;
    const result = await this.execute(['version']);
    if (result.code !== 0 || !result.stdout.startsWith(`restic ${RESTIC_VERSION} `)) {
      throw new Error(`Pinned restic ${RESTIC_VERSION} is not available`);
    }
    this.versionChecked = true;
  }

  private async ensureRepository(): Promise<void> {
    await mkdir(this.repository, { recursive: true, mode: 0o700 });
    try {
      if ((await lstat(path.join(this.repository, 'config'))).isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await this.execute(['--no-cache', 'init']);
    if (result.code !== 0) throw new Error(ResticRepository.failure('Snapshot repository could not be created', result.stderr));
  }

  private async assertPasswordFile(): Promise<void> {
    const stat = await this.passwordStat();
    if (!stat.isFile()) throw new Error('Snapshot key file must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('Snapshot key file must not be group or world readable');
    try {
      if (await SnapshotPaths.isInside(this.repository, this.passwordFile)) throw new Error('Snapshot key file must stay outside the repository');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async passwordStat() {
    try { return await lstat(this.passwordFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Snapshot key file is missing');
      throw error;
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
      RESTIC_REPOSITORY: this.repository,
      RESTIC_PASSWORD_FILE: this.passwordFile,
    };
    return env;
  }

  private execute(args: string[]): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const child = spawn(this.binary, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const push = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) { child.kill('SIGKILL'); fail(new Error('Snapshot tool output exceeded the limit')); return; }
        chunks.push(chunk);
      };
      child.stdout?.on('data', (chunk: Buffer) => push(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => push(stderr, chunk));
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Snapshot tool timed out')); }, 60_000);
      child.once('error', error => {
        clearTimeout(timer);
        fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Pinned restic ${RESTIC_VERSION} is not available`) : new Error('Snapshot tool could not start'));
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  }

  private static async realDirectory(directory: string): Promise<string> {
    const resolved = path.resolve(directory);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('Snapshot source must be a real directory');
    return resolved;
  }

  private static snapshotId(stdout: string): string | undefined {
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as { message_type?: string; snapshot_id?: string };
        if (parsed.message_type === 'summary' && parsed.snapshot_id && /^[a-f0-9]{64}$/.test(parsed.snapshot_id)) return parsed.snapshot_id;
      } catch { /* keep scanning summary lines */ }
    }
    return undefined;
  }

  private static snapshotIds(stdout: string): string[] | undefined {
    try {
      const parsed = JSON.parse(stdout) as { id?: string }[];
      if (!Array.isArray(parsed)) return undefined;
      return parsed.flatMap(item => item.id && /^[a-f0-9]{64}$/.test(item.id) ? [item.id] : []);
    } catch { return undefined; }
  }

  private static integrity(stderr: string): SnapshotError {
    if (/wrong password|no key found/i.test(stderr)) return new SnapshotError('CORRUPTED', 'Snapshot is corrupted: repository key was rejected');
    return new SnapshotError('CORRUPTED', 'Snapshot is corrupted: restic integrity check failed');
  }

  private static failure(prefix: string, stderr: string): string {
    const fatal = stderr.split('\n').map(line => line.trim()).find(line => line.startsWith('Fatal:'));
    return fatal ? `${prefix}: ${fatal.slice(0, 180)}` : prefix;
  }
}

import { execFile, execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { assertSafeRelativePath } from './manifest.js';
import { checkpointIdSchema, type SnapshotEntry, type SnapshotStore } from './store.js';

const execFileAsync = promisify(execFile);

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
  private readonly extraEnv: Record<string, string>;
  private initialized = false;

  constructor(repository: string, password: string, extraEnv: Record<string, string> = {}) {
    if (!repository.trim() || !password || password.length < 16) {
      throw new Error('Restic repository and a strong password (>= 16 chars) are required');
    }
    this.repository = repository;
    this.password = password;
    this.extraEnv = { ...extraEnv };
  }

  private async withRestic<T>(fn: (run: (args: string[], cwd?: string) => Promise<string>, scratch: string) => Promise<T>): Promise<T> {
    const scratch = await mkdtemp(path.join(tmpdir(), 'router-restic-run-'));
    try {
      await chmod(scratch, 0o700);
      const passwordFile = path.join(scratch, 'password');
      const cacheDir = path.join(scratch, 'cache');
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(passwordFile, this.password, { mode: 0o600, flag: 'wx' });

      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: scratch,
        XDG_CACHE_HOME: cacheDir,
        TMPDIR: scratch,
        RESTIC_REPOSITORY: this.repository,
        RESTIC_PASSWORD_FILE: passwordFile,
        ...this.extraEnv,
      };

      const run = async (args: string[], cwd = scratch): Promise<string> => {
        try {
          const { stdout } = await execFileAsync('restic', args, { cwd, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
          return stdout;
        } catch {
          // Never expose repository credentials, paths, or raw stderr details.
          throw new Error(`restic ${args[0] ?? 'command'} failed`);
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

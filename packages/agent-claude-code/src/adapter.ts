import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const SUPPORTED_CLAUDE_CODE_MAJOR_MINOR = '2.1.';

export function findClaudeBinary(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map(dir => path.join(dir, 'claude')),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function isClaudeCodeAvailable(): boolean {
  const bin = findClaudeBinary();
  if (!bin) return false;
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return out.includes('Claude Code');
  } catch {
    return false;
  }
}

/**
 * Encodes an absolute workspace path into Claude Code's `projects/<slug>` directory name:
 * every non-alphanumeric character (`/`, `.`, `_`, `:`, `\`) is replaced with `-`.
 */
export function encodeClaudeProjectSlug(workspacePath: string): string {
  if (!path.isAbsolute(workspacePath) && !path.posix.isAbsolute(workspacePath)) {
    throw new Error('Claude Code workspace path must be absolute');
  }
  const trimmed = workspacePath.replace(/\/+$/, '');
  return trimmed.replace(/[^A-Za-z0-9]/g, '-');
}

function remapPathPrefix(value: string, sourceRoot: string, targetRoot: string): string {
  const srcNorm = sourceRoot.replace(/\/+$/, '');
  const dstNorm = targetRoot.replace(/\/+$/, '');
  if (value === srcNorm) return dstNorm;
  if (value.startsWith(`${srcNorm}/`)) {
    return `${dstNorm}${value.slice(srcNorm.length)}`;
  }
  return value;
}

export function rebindClaudeTranscriptLine(
  line: string,
  sourceWorkspace: string,
  targetWorkspace: string,
): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const updated: Record<string, unknown> = { ...parsed };
  if (typeof updated.cwd === 'string') {
    updated.cwd = remapPathPrefix(updated.cwd, sourceWorkspace, targetWorkspace);
  }
  return JSON.stringify(updated);
}

const uuidFilenamePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export const claudeProjectBundleSchema = z.object({
  schemaVersion: z.literal(1),
  agent: z.literal('claude-code'),
  sourceWorkspace: z.string().min(1),
  sessions: z.array(
    z.object({
      sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      rawJsonl: z.string().min(1),
    }),
  ),
});
export type ClaudeProjectBundle = z.infer<typeof claudeProjectBundleSchema>;

export async function exportClaudeProjectBundle(
  claudeConfigDirInput: string,
  sourceWorkspaceInput: string,
): Promise<ClaudeProjectBundle> {
  const claudeConfigDir = path.resolve(claudeConfigDirInput);
  const sourceWorkspace = path.resolve(sourceWorkspaceInput);
  const slugDir = path.join(claudeConfigDir, 'projects', encodeClaudeProjectSlug(sourceWorkspace));

  const sessions: ClaudeProjectBundle['sessions'] = [];
  if (existsSync(slugDir)) {
    const entries = (await readdir(slugDir)).sort();
    for (const name of entries) {
      if (!uuidFilenamePattern.test(name)) continue;
      const abs = path.join(slugDir, name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink unsupported in Claude Code project directory: ${name}`);
      }
      if (!st.isFile()) continue;
      const rawJsonl = await readFile(abs, 'utf8');
      const lines = rawJsonl.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        JSON.parse(line);
      }
      sessions.push({
        sessionId: name.slice(0, -'.jsonl'.length),
        rawJsonl,
      });
    }
  }

  return claudeProjectBundleSchema.parse({
    schemaVersion: 1,
    agent: 'claude-code',
    sourceWorkspace,
    sessions,
  });
}

export async function importClaudeProjectBundle(
  bundleInput: ClaudeProjectBundle,
  targetClaudeConfigDirInput: string,
  targetWorkspaceInput: string,
): Promise<string[]> {
  const bundle = claudeProjectBundleSchema.parse(bundleInput);
  const targetClaudeConfigDir = path.resolve(targetClaudeConfigDirInput);
  const targetWorkspace = path.resolve(targetWorkspaceInput);
  const targetSlugDir = path.join(
    targetClaudeConfigDir,
    'projects',
    encodeClaudeProjectSlug(targetWorkspace),
  );

  try {
    await access(targetSlugDir);
    const existsErr = new Error(`Target Claude Code project store already exists: ${targetSlugDir}`) as NodeJS.ErrnoException;
    existsErr.code = 'EEXIST';
    throw existsErr;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await mkdir(targetSlugDir, { recursive: true, mode: 0o700 });
  await chmod(targetClaudeConfigDir, 0o700);
  await chmod(targetSlugDir, 0o700);

  const importedIds: string[] = [];
  for (const session of bundle.sessions) {
    const reboundLines = session.rawJsonl
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => rebindClaudeTranscriptLine(line, bundle.sourceWorkspace, targetWorkspace));
    const dest = path.join(targetSlugDir, `${session.sessionId}.jsonl`);
    await writeFile(dest, `${reboundLines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    importedIds.push(session.sessionId);
  }
  return importedIds;
}

/**
 * Invokes `claude purge --dry-run <workspace>` inside an isolated `CLAUDE_CONFIG_DIR`
 * (performing zero mutations and zero network calls) to prove the installed Claude Code CLI
 * resolves `<workspace>` to our relocated `projects/<slug>` transcript directory.
 */
export async function verifyClaudeProjectRecognition(options: {
  isolatedHome: string;
  claudeConfigDir: string;
  workspace: string;
  claudeBinary?: string;
}): Promise<{ recognized: boolean; expectedSlugDirectory: string }> {
  const bin = options.claudeBinary ?? findClaudeBinary();
  if (!bin) throw new Error('Claude Code binary not found');

  const isolatedHome = path.resolve(options.isolatedHome);
  const claudeConfigDir = path.resolve(options.claudeConfigDir);
  const workspace = path.resolve(options.workspace);
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });

  const expectedSlugDirectory = path.join(
    claudeConfigDir,
    'projects',
    encodeClaudeProjectSlug(workspace),
  );

  const { stdout } = await execFileAsync(bin, ['purge', '--dry-run', workspace], {
    env: {
      PATH: `${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}:${path.dirname(bin)}`,
      HOME: isolatedHome,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    timeout: 15_000,
  });

  const recognized =
    stdout.includes(expectedSlugDirectory) &&
    stdout.includes('project transcripts (.jsonl)') &&
    /Dry run:\s+[1-9]\d*\s+item\(s\)/i.test(stdout);

  return {
    recognized,
    expectedSlugDirectory,
  };
}

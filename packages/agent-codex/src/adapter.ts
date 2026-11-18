import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { assertSafeRelativePath } from '../../snapshots/src/manifest.js';

export const SUPPORTED_CODEX_MAJOR_MINOR = '0.169.';

export function findCodexBinary(): string | null {
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map(dir => path.join(dir, 'codex')),
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function isCodexCliAvailable(): boolean {
  const bin = findCodexBinary();
  if (!bin) return false;
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return out.startsWith('codex-cli ');
  } catch {
    return false;
  }
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

function remapCodexObject(node: unknown, sourceRoot: string, targetRoot: string): unknown {
  if (Array.isArray(node)) {
    return node.map(item => remapCodexObject(item, sourceRoot, targetRoot));
  }
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      if (key === 'cwd' && typeof val === 'string') {
        out[key] = remapPathPrefix(val, sourceRoot, targetRoot);
      } else if (key === 'runtime_workspace_roots' && Array.isArray(val)) {
        out[key] = val.map(entry =>
          typeof entry === 'string' ? remapPathPrefix(entry, sourceRoot, targetRoot) : entry,
        );
      } else {
        out[key] = remapCodexObject(val, sourceRoot, targetRoot);
      }
    }
    return out;
  }
  return node;
}

export function rebindCodexRolloutLine(line: string, sourceWorkspace: string, targetWorkspace: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const parsed: unknown = JSON.parse(trimmed);
  return JSON.stringify(remapCodexObject(parsed, sourceWorkspace, targetWorkspace));
}

export const codexRolloutBundleSchema = z.object({
  schemaVersion: z.literal(1),
  agent: z.literal('codex-cli'),
  sourceWorkspace: z.string().min(1),
  rollouts: z.array(
    z.object({
      relativePath: z.string().regex(/^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9T._-]+\.jsonl$/),
      threadId: z.string().min(1),
      rawJsonl: z.string().min(1),
    }),
  ),
});
export type CodexRolloutBundle = z.infer<typeof codexRolloutBundleSchema>;

export async function exportCodexRolloutBundle(
  codexHomeInput: string,
  sourceWorkspaceInput: string,
): Promise<CodexRolloutBundle> {
  const codexHome = path.resolve(codexHomeInput);
  const sourceWorkspace = path.resolve(sourceWorkspaceInput);
  const sessionsRoot = path.join(codexHome, 'sessions');

  const rollouts: CodexRolloutBundle['rollouts'] = [];

  async function walk(relDir: string): Promise<void> {
    const absDir = path.join(codexHome, relDir);
    if (!existsSync(absDir)) return;
    const entries = (await readdir(absDir)).sort();
    for (const name of entries) {
      const rel = `${relDir}/${name}`;
      const abs = path.join(codexHome, rel);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink unsupported in Codex sessions directory: ${rel}`);
      }
      if (st.isDirectory()) {
        await walk(rel);
      } else if (st.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        const rawJsonl = await readFile(abs, 'utf8');
        const lines = rawJsonl.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        const first = JSON.parse(lines[0]!) as {
          type?: unknown;
          payload?: { id?: unknown; session_id?: unknown; cwd?: unknown };
        };
        if (first.type !== 'session_meta') continue;
        const threadId = String(first.payload?.id ?? first.payload?.session_id ?? '');
        const cwd = String(first.payload?.cwd ?? '');
        if (!threadId || cwd !== sourceWorkspace) continue;

        rollouts.push({
          relativePath: assertSafeRelativePath(rel),
          threadId,
          rawJsonl,
        });
      }
    }
  }

  if (existsSync(sessionsRoot)) {
    await walk('sessions');
  }

  return codexRolloutBundleSchema.parse({
    schemaVersion: 1,
    agent: 'codex-cli',
    sourceWorkspace,
    rollouts,
  });
}

export async function importCodexRolloutBundle(
  bundleInput: CodexRolloutBundle,
  targetCodexHomeInput: string,
  targetWorkspaceInput: string,
): Promise<string[]> {
  const bundle = codexRolloutBundleSchema.parse(bundleInput);
  const targetCodexHome = path.resolve(targetCodexHomeInput);
  const targetWorkspace = path.resolve(targetWorkspaceInput);

  await mkdir(targetCodexHome, { recursive: true, mode: 0o700 });
  await chmod(targetCodexHome, 0o700);

  const importedThreadIds: string[] = [];
  for (const rollout of bundle.rollouts) {
    const safeRel = assertSafeRelativePath(rollout.relativePath);
    const dest = path.join(targetCodexHome, safeRel);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const reboundLines = rollout.rawJsonl
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => rebindCodexRolloutLine(line, bundle.sourceWorkspace, targetWorkspace));
    await writeFile(dest, `${reboundLines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    importedThreadIds.push(rollout.threadId);
  }
  return importedThreadIds;
}

export interface CodexTurn {
  id: string;
  status: string;
  items: unknown[];
}

export interface IsolatedCodexServer {
  startThread(cwd: string): Promise<string>;
  runShellCommand(threadId: string, command: string): Promise<void>;
  resumeThread(threadId: string, cwd: string): Promise<{ cwd: string }>;
  readThread(threadId: string): Promise<{ id: string; cwd: string; turns: CodexTurn[] }>;
  stop(): Promise<void>;
}

/**
 * Starts an isolated `codex app-server --stdio` process with a private `CODEX_HOME`,
 * disabled analytics, and a loopback-only model provider (zero personal credentials or network calls).
 */
export async function startIsolatedCodexAppServer(options: {
  isolatedHome: string;
  codexHome: string;
  codexBinary?: string;
}): Promise<IsolatedCodexServer> {
  const bin = options.codexBinary ?? findCodexBinary();
  if (!bin) throw new Error('Codex CLI binary not found');

  const isolatedHome = path.resolve(options.isolatedHome);
  const codexHome = path.resolve(options.codexHome);
  await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);

  const configPath = path.join(codexHome, 'config.toml');
  if (!existsSync(configPath)) {
    await writeFile(
      configPath,
      [
        'model = "gpt-5-codex"',
        'model_provider = "loopback"',
        '[analytics]',
        'enabled = false',
        '[model_providers.loopback]',
        'name = "Loopback"',
        'base_url = "http://127.0.0.1:9/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
  }

  const proc = spawn(bin, ['app-server', '--stdio'], {
    env: {
      PATH: `${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}:${path.dirname(bin)}`,
      HOME: isolatedHome,
      CODEX_HOME: codexHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messages: { id?: number; result?: unknown; error?: unknown }[] = [];
  let stdoutBuffer = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx = stdoutBuffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (line) {
        try {
          messages.push(JSON.parse(line) as { id?: number; result?: unknown; error?: unknown });
        } catch {
          // Ignore non-JSON lines if any
        }
      }
      newlineIdx = stdoutBuffer.indexOf('\n');
    }
  });

  let nextId = 1;
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const hitIndex = messages.findIndex(msg => msg.id === id);
      if (hitIndex !== -1) {
        const [hit] = messages.splice(hitIndex, 1);
        if (hit?.error) {
          throw new Error(`Codex RPC ${method} failed`);
        }
        return hit?.result as T;
      }
      if (proc.exitCode !== null) {
        throw new Error(`Codex app-server exited unexpectedly before ${method} completed`);
      }
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`Timed out waiting for Codex RPC ${method}`);
  }

  await rpc('initialize', {
    clientInfo: { name: 'agent-router', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

  return {
    async startThread(cwd: string): Promise<string> {
      const res = await rpc<{ thread: { id: string } }>('thread/start', {
        cwd: path.resolve(cwd),
        ephemeral: false,
      });
      return res.thread.id;
    },

    async runShellCommand(threadId: string, command: string): Promise<void> {
      await rpc('thread/shellCommand', { threadId, command });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const read = await rpc<{ thread: { turns: CodexTurn[] } }>('thread/read', {
          threadId,
          includeTurns: true,
        });
        if (read.thread.turns.length > 0 && read.thread.turns.every(t => t.status === 'completed')) {
          return;
        }
        await new Promise(r => setTimeout(r, 60));
      }
      throw new Error('Timed out waiting for Codex shell command turn to settle');
    },

    async resumeThread(threadId: string, cwd: string): Promise<{ cwd: string }> {
      const res = await rpc<{ thread: { cwd: string } }>('thread/resume', {
        threadId,
        cwd: path.resolve(cwd),
      });
      return { cwd: res.thread.cwd };
    },

    async readThread(threadId: string): Promise<{ id: string; cwd: string; turns: CodexTurn[] }> {
      const res = await rpc<{ thread: { id: string; cwd: string; turns: CodexTurn[] } }>('thread/read', {
        threadId,
        includeTurns: true,
      });
      return res.thread;
    },

    async stop(): Promise<void> {
      if (proc.exitCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
        }, 2_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    },
  };
}

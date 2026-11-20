import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';

const initializeSchema = z.object({
  protocolVersion: z.literal(1),
  agentCapabilities: z.object({
    loadSession: z.boolean().optional(),
    sessionCapabilities: z.object({ resume: z.object({}).passthrough().optional() }).passthrough().optional(),
  }).passthrough(),
  agentInfo: z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
}).passthrough();
type Initialization = z.infer<typeof initializeSchema>;

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Explicit isolated environment; never implicitly inherit process.env. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxFrameBytes?: number;
  onSessionUpdate?: (params: unknown) => void;
}

/** ACP v1 lifecycle client. It never grants filesystem, terminal, or permission requests. */
export class AcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private failure: Error | undefined;
  private initialization: Initialization | undefined;
  private initializing = false;
  private exited = false;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly timeoutMs: number;
  private readonly maxFrameBytes: number;

  constructor(private readonly options: AcpClientOptions) {
    if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)) throw new Error('ACP_ISOLATED_ENV_REQUIRED');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000
      || !Number.isInteger(this.maxFrameBytes) || this.maxFrameBytes < 128 || this.maxFrameBytes > 16 * 1024 * 1024) throw new Error('ACP_INVALID_LIMITS');
    if (!path.isAbsolute(options.cwd)) throw new Error('ACP_ABSOLUTE_CWD_REQUIRED');
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.closed = new Promise(resolve => this.child.once('close', () => {
      this.exited = true;
      this.fail('ACP_CONNECTION_CLOSED');
      if (this.killTimer) clearTimeout(this.killTimer);
      resolve();
    }));
    this.child.once('error', () => this.fail('ACP_SPAWN_FAILED'));
    this.child.stdin.on('error', () => this.fail('ACP_WRITE_FAILED'));
    this.child.stdout.on('error', () => this.fail('ACP_READ_FAILED'));
    this.child.stderr.resume(); // Upstream diagnostics may contain secrets; never retain them.
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  private terminate(signal: NodeJS.Signals): void {
    if (this.exited || !this.child.pid) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }

  private fail(code: string): void {
    if (this.failure) return;
    this.failure = new Error(code);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.terminate('SIGTERM');
    if (!this.exited) {
      this.killTimer = setTimeout(() => this.terminate('SIGKILL'), 2_000);
      this.killTimer.unref();
    }
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) {
        if (this.buffer.length > this.maxFrameBytes) this.fail('ACP_FRAME_TOO_LARGE');
        return;
      }
      if (newline > this.maxFrameBytes) { this.fail('ACP_FRAME_TOO_LARGE'); return; }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const message: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
        const m = message as Record<string, unknown>;
        if (m.jsonrpc !== '2.0') throw new Error();
        if (typeof m.method === 'string') {
          if (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error')) throw new Error();
          if (Object.hasOwn(m, 'id')) {
            if (typeof m.id !== 'string' && typeof m.id !== 'number') throw new Error();
            // No advertised client capabilities: explicitly deny execution requests.
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported client method' } }) + '\n');
          } else if (m.method === 'session/update') this.options.onSessionUpdate?.(m.params);
        } else {
          if (typeof m.id !== 'number' || Object.hasOwn(m, 'result') === Object.hasOwn(m, 'error')) throw new Error();
          const request = this.pending.get(m.id);
          if (!request) throw new Error();
          clearTimeout(request.timer);
          this.pending.delete(m.id);
          if (Object.hasOwn(m, 'error')) request.reject(new Error('ACP_REMOTE_ERROR'));
          else request.resolve(m.result);
        }
      } catch { this.fail('ACP_INVALID_FRAME'); return; }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 64) return Promise.reject(new Error('ACP_TOO_MANY_REQUESTS'));
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(frame) > this.maxFrameBytes) return Promise.reject(new Error('ACP_FRAME_TOO_LARGE'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('ACP_REQUEST_TIMEOUT'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame);
    });
  }

  async initialize(): Promise<Initialization> {
    if (this.initialization || this.initializing) throw new Error('ACP_ALREADY_INITIALIZED');
    this.initializing = true;
    try {
      const result = await this.request('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent-router', version: '1.0.0' },
      });
      const checked = initializeSchema.safeParse(result);
      if (!checked.success) { this.fail('ACP_INCOMPATIBLE_INITIALIZATION'); throw this.failure; }
      this.initialization = checked.data;
      return checked.data;
    } finally { this.initializing = false; }
  }

  private assertSession(cwd: string): void {
    if (!this.initialization) throw new Error('ACP_NOT_INITIALIZED');
    if (!path.isAbsolute(cwd)) throw new Error('ACP_ABSOLUTE_CWD_REQUIRED');
  }

  async newSession(cwd: string): Promise<string> {
    this.assertSession(cwd);
    const result = await this.request('session/new', { cwd, mcpServers: [] });
    const checked = z.object({ sessionId: z.string().min(1) }).safeParse(result);
    if (!checked.success) { this.fail('ACP_INVALID_SESSION'); throw this.failure; }
    return checked.data.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.assertSession(cwd);
    if (this.initialization?.agentCapabilities.loadSession !== true) throw new Error('ACP_LOAD_UNSUPPORTED');
    if (!sessionId || sessionId.length > 4096) throw new Error('ACP_INVALID_SESSION');
    const result = await this.request('session/load', { sessionId, cwd, mcpServers: [] });
    if (!result || typeof result !== 'object' || Array.isArray(result)) { this.fail('ACP_INVALID_SESSION'); throw this.failure; }
  }

  /** Reattaches without history replay; the agent sends no session/update before responding. */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    this.assertSession(cwd);
    if (!this.initialization?.agentCapabilities.sessionCapabilities?.resume) throw new Error('ACP_RESUME_UNSUPPORTED');
    if (!sessionId || sessionId.length > 4096) throw new Error('ACP_INVALID_SESSION');
    const result = await this.request('session/resume', { sessionId, cwd, mcpServers: [] });
    if (!result || typeof result !== 'object' || Array.isArray(result)) { this.fail('ACP_INVALID_SESSION'); throw this.failure; }
  }

  /** Prefers session/resume and falls back to session/load, which replays history through onSessionUpdate. */
  async reconnectSession(sessionId: string, cwd: string): Promise<'resume' | 'load'> {
    this.assertSession(cwd);
    if (this.initialization?.agentCapabilities.sessionCapabilities?.resume) {
      await this.resumeSession(sessionId, cwd);
      return 'resume';
    }
    await this.loadSession(sessionId, cwd);
    return 'load';
  }

  async close(): Promise<void> {
    this.fail('ACP_CLIENT_CLOSED');
    this.child.stdin.end();
    const killer = setTimeout(() => this.terminate('SIGKILL'), 2_000);
    try { await this.closed; } finally { clearTimeout(killer); }
  }
}

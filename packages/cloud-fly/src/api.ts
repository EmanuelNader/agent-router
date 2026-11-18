import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';

export interface FlyApiRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: string;
}
export type FlyApiTransport = (request: FlyApiRequest) => Promise<{ status: number; body: Buffer }>;
type Connection = { kind: 'https'; token: string } | { kind: 'self'; socketPath?: string };
const machineSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8,32}$/), instance_id: z.string().min(1).max(128),
  state: z.enum(['started', 'stopped', 'suspended', 'destroyed', 'starting', 'stopping', 'suspending', 'created', 'destroying', 'replacing', 'launch_failed']),
  config: z.object({
    metadata: z.record(z.string(), z.string()),
    guest: z.object({ memory_mb: z.number().int().positive() }).optional(),
    init: z.object({ swap_size_mb: z.number().int().min(0).optional() }).nullable().optional(),
    schedule: z.string().nullable().optional(),
  }),
});
const leaseSchema = z.object({ data: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), expires_at: z.number().finite().positive() }) });

/** Fixed-origin Machines API transport. No credentials or upstream bodies are logged. */
export class FlyMachinesApi {
  private readonly basePath: string;
  private readonly send: FlyApiTransport;
  get appName(): string { return this.options.appName; }
  get machineId(): string { return this.options.machineId; }
  constructor(private readonly options: {
    appName: string;
    machineId: string;
    connection: Connection;
    /** Explicit transport injection for local contract tests; never an alternate cloud origin. */
    transport?: FlyApiTransport;
  }) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.appName) || !/^[a-f0-9]{8,32}$/.test(options.machineId)) throw new Error('FLY_INVALID_SCOPE');
    if (options.connection.kind === 'https' && (!options.connection.token || /[\r\n\0]/.test(options.connection.token))) throw new Error('FLY_INVALID_CREDENTIAL');
    this.basePath = `/v1/apps/${options.appName}/machines/${options.machineId}`;
    this.send = options.transport ?? (input => new Promise((resolve, reject) => {
      const self = options.connection.kind === 'self';
      const request = (self ? httpRequest : httpsRequest)({
        hostname: self ? 'flaps' : 'api.machines.dev',
        ...(self ? { socketPath: (options.connection as Extract<Connection, { kind: 'self' }>).socketPath ?? '/.fly/api' } : { port: 443 }),
        method: input.method, path: input.path, headers: input.headers,
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_048_576) { response.destroy(); request.destroy(); reject(new Error('FLY_RESPONSE_TOO_LARGE')); }
          else chunks.push(chunk);
        });
        response.once('error', () => reject(new Error('FLY_API_TRANSPORT_FAILED')));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      });
      const deadline = setTimeout(() => request.destroy(new Error('FLY_API_TIMEOUT')), 25_000);
      request.once('close', () => clearTimeout(deadline));
      request.once('error', () => reject(new Error('FLY_API_TRANSPORT_FAILED')));
      request.end(input.body);
    }));
  }

  private async call(method: FlyApiRequest['method'], suffix: string, body?: unknown, nonce?: string): Promise<unknown> {
    if (this.options.connection.kind === 'self' && !(method === 'POST' && suffix === '/suspend')) throw new Error('FLY_SELF_SOCKET_SCOPE');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.connection.kind === 'https') headers.Authorization = `Bearer ${this.options.connection.token}`;
    if (nonce !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(nonce)) throw new Error('FLY_INVALID_LEASE');
      headers['fly-machine-lease-nonce'] = nonce;
    }
    let response: Awaited<ReturnType<FlyApiTransport>>;
    try { response = await this.send({ method, path: this.basePath + suffix, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new Error('FLY_API_TRANSPORT_FAILED'); }
    if (response.body.length > 1_048_576) throw new Error('FLY_RESPONSE_TOO_LARGE');
    if (response.status === 404) throw new Error('FLY_MACHINE_NOT_FOUND');
    if (response.status < 200 || response.status >= 300) throw new Error('FLY_API_REQUEST_FAILED');
    try { return response.body.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) : {}; }
    catch { throw new Error('FLY_INVALID_RESPONSE'); }
  }

  async inspect() {
    const result = machineSchema.safeParse(await this.call('GET', ''));
    if (!result.success || result.data.id !== this.options.machineId) throw new Error('FLY_INVALID_RESPONSE');
    return result.data;
  }
  async createLease(retryToken: string): Promise<{ nonce: string; expiresAt: number }> {
    if (!/^rt_[a-f0-9]{24,64}$/.test(retryToken)) throw new Error('FLY_INVALID_RETRY_TOKEN');
    const result = leaseSchema.safeParse(await this.call('POST', '/lease', { ttl: 60, description: retryToken }));
    if (!result.success || result.data.data.expires_at * 1000 <= Date.now()) throw new Error('FLY_INVALID_LEASE');
    return { nonce: result.data.data.nonce, expiresAt: result.data.data.expires_at * 1000 };
  }
  async releaseLease(nonce: string): Promise<void> { await this.call('DELETE', '/lease', undefined, nonce); }
  async suspend(nonce?: string): Promise<void> {
    if (this.options.connection.kind === 'https' && !nonce) throw new Error('FLY_LEASE_REQUIRED');
    await this.call('POST', '/suspend', undefined, nonce);
  }
  async start(nonce?: string): Promise<void> {
    if (this.options.connection.kind === 'self') throw new Error('FLY_SELF_SOCKET_SCOPE');
    if (!nonce) throw new Error('FLY_LEASE_REQUIRED');
    await this.call('POST', '/start', undefined, nonce);
  }
  async destroy(nonce?: string): Promise<void> {
    if (this.options.connection.kind === 'self') throw new Error('FLY_SELF_SOCKET_SCOPE');
    if (!nonce) throw new Error('FLY_LEASE_REQUIRED');
    await this.call('DELETE', '?force=true', undefined, nonce);
  }
  async wait(state: 'started' | 'stopped' | 'suspended' | 'destroyed', instanceId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(instanceId)) throw new Error('FLY_INVALID_INSTANCE');
    if (!['started', 'stopped', 'suspended', 'destroyed'].includes(state)) throw new Error('FLY_INVALID_STATE');
    await this.call('GET', `/wait?state=${state}&instance_id=${encodeURIComponent(instanceId)}&timeout=20`);
  }
}

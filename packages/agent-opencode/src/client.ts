import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const transferSchema = z.object({
  info: z.object({ id: z.string().min(1) }).passthrough(),
  messages: z.array(z.unknown()),
}).passthrough();
export type SessionTransfer = z.infer<typeof transferSchema>;

const inboxItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  delivery: z.enum(['steer', 'queue']),
  // Only user and synthetic items carry text; compaction and move payloads have other shapes.
  payload: z.unknown(),
}).passthrough();
const textPayloadSchema = z.object({ text: z.string() }).passthrough();
export type InboxItem = z.infer<typeof inboxItemSchema>;

const pendingInboxItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['user', 'synthetic']),
  delivery: z.enum(['steer', 'queue']),
  payload: z.object({ text: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }).strict(),
}).strict();
/** A pending inbox item a checkpoint can carry: text only, with an admission endpoint in OpenCode 2.3.2. */
export type PendingInboxItem = z.infer<typeof pendingInboxItemSchema>;

function toPendingInboxItem(item: InboxItem): PendingInboxItem {
  const carried = pendingInboxItemSchema.safeParse({ id: item.id, type: item.type, delivery: item.delivery, payload: item.payload });
  // Only a user prompt's text is carried; anything else in its payload (files, agents, skills) is untested.
  if (!carried.success || (carried.data.type === 'user' && carried.data.payload.metadata !== undefined)) {
    throw new Error(
      `OPENCODE_PENDING_INBOX: inbox item ${item.type} ${item.id} is not a text-only prompt and cannot be carried in a checkpoint; ` +
        'let the agent consume it or delete it first',
    );
  }
  return carried.data;
}

/** Pinned to OpenCode 2.3.2. Transfer data can contain private conversation text. */
export class OpenCodeClient {
  private readonly url: URL;
  private readonly authorization: string;

  constructor(baseUrl: string, password: string) {
    this.url = new URL(baseUrl);
    const local = ['127.0.0.1', '[::1]'].includes(this.url.hostname);
    if (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && local)) {
      throw new Error('OpenCode requires HTTPS outside loopback');
    }
    if (this.url.username || this.url.password || !password) throw new Error('Invalid OpenCode credentials');
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: this.authorization, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch { throw new Error('OpenCode request could not complete'); }
    // Never include URLs, response bodies, or authentication values in errors.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenCode request failed (${response.status})`); }
    if (response.status === 204) return undefined;
    try { return await response.json(); }
    catch { throw new Error('OpenCode returned invalid JSON'); }
  }

  health() { return this.request('/api/info'); }
  listSessions() { return this.request('/api/session?limit=1'); }
  configuration(directory: string) {
    const query = new URLSearchParams({ 'location[directory]': directory });
    return this.request(`/api/config?${query}`);
  }

  async createSession(directory: string, title: string): Promise<string> {
    const result = z.object({ data: z.object({ id: z.string().min(1) }) }).safeParse(
      await this.request('/api/session', { title, location: { directory } }),
    );
    if (!result.success) throw new Error('Invalid OpenCode session response');
    return result.data.data.id;
  }

  runShellCommand(sessionId: string, command: string) {
    return this.request(`/api/session/${encodeURIComponent(sessionId)}/shell`, { command });
  }

  async exportSession(sessionId: string): Promise<SessionTransfer> {
    const result = z.object({ data: transferSchema }).safeParse(
      await this.request(`/api/experimental/session/${encodeURIComponent(sessionId)}/export`),
    );
    if (!result.success) throw new Error('Invalid OpenCode transfer response');
    return result.data.data;
  }

  /**
   * Exports a session for a checkpoint together with its pending text-only inbox items, which the export omits.
   * Refuses when the inbox holds an item that cannot be re-admitted, or when it changes during the export.
   */
  async exportSessionForCheckpoint(sessionId: string): Promise<SessionTransfer> {
    const before = (await this.listInbox(sessionId)).map(toPendingInboxItem);
    const transfer = await this.exportSession(sessionId);
    const after = (await this.listInbox(sessionId)).map(toPendingInboxItem);
    if (!isDeepStrictEqual(before, after)) {
      throw new Error('OPENCODE_PENDING_INBOX: the session inbox changed during the export; stop sending prompts and retry');
    }
    return after.length > 0 ? { ...transfer, pendingInbox: after } : transfer;
  }

  /** Imports a session, then re-admits any pending inbox items the checkpoint carried, without waking the agent loop. */
  async importSession(transfer: SessionTransfer, directory: string): Promise<string> {
    const { pendingInbox, ...session } = transferSchema.parse(transfer);
    const pending = z.array(pendingInboxItemSchema).safeParse(pendingInbox ?? []);
    if (!pending.success) throw new Error('Invalid pending inbox in OpenCode transfer');
    const result = z.object({ data: z.object({ id: z.string().min(1) }) }).safeParse(
      await this.request('/api/experimental/session/import', { ...session, location: { directory } }),
    );
    if (!result.success) throw new Error('Invalid OpenCode import response');
    const sessionId = result.data.data.id;
    if (pending.data.length > 0) {
      for (const item of pending.data) await this.admitInboxItem(sessionId, item);
      const admitted = (await this.listInbox(sessionId)).map(toPendingInboxItem);
      if (!isDeepStrictEqual(admitted, pending.data)) {
        throw new Error('OPENCODE_PENDING_INBOX: the destination inbox does not match the checkpoint after re-admission');
      }
    }
    return sessionId;
  }

  /** Admitted work not yet delivered to the agent loop. It is absent from exportSession. */
  async listInbox(sessionId: string): Promise<InboxItem[]> {
    const result = z.object({ data: z.array(inboxItemSchema) }).safeParse(
      await this.request(`/api/session/${encodeURIComponent(sessionId)}/inbox`),
    );
    if (!result.success) throw new Error('Invalid OpenCode inbox response');
    return result.data.data;
  }

  /**
   * Admits an inbox item without waking the agent loop. Passing the original ID makes the call idempotent;
   * without one OpenCode mints a new ID.
   * Only user and synthetic items have an admission endpoint in OpenCode 2.3.2.
   */
  async admitInboxItem(
    sessionId: string, item: Pick<InboxItem, 'type' | 'delivery' | 'payload'> & { id?: string },
  ): Promise<InboxItem> {
    const payload = textPayloadSchema.safeParse(item.payload);
    if ((item.type !== 'user' && item.type !== 'synthetic') || !payload.success) {
      throw new Error(`OpenCode inbox item type "${item.type}" cannot be admitted`);
    }
    const result = z.object({ data: inboxItemSchema }).safeParse(
      await this.request(
        `/api/session/${encodeURIComponent(sessionId)}/${item.type === 'user' ? 'prompt' : 'synthetic'}`,
        { ...payload.data, ...(item.id ? { id: item.id } : {}), delivery: item.delivery, resume: false },
      ),
    );
    if (!result.success) throw new Error('Invalid OpenCode admission response');
    return result.data.data;
  }
}

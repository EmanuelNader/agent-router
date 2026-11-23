import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { PendingInboxItem } from '../src/client.js';
import { startIsolatedServer } from '../src/server.js';

/** OpenAI-compatible chat endpoint on loopback that records each request and streams a fixed reply. */
async function startStubModel() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(404).end('{}'); return; }
      requests.push(body);
      const event = (choices: object[], usage?: object) =>
        response.write(`data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 1, model: 'echo', choices, ...(usage ? { usage } : {}) })}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      event([{ index: 0, delta: { role: 'assistant', content: 'stub reply' }, finish_reason: null }]);
      event([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      event([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    stop: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

async function startServerWithStubModel(workspace: string, state: string, modelUrl: string) {
  await mkdir(join(state, 'config'), { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'config', 'opencode.json'), JSON.stringify({
    model: 'stub/echo',
    providers: { stub: {
      name: 'Stub', package: '@opencode/ai/providers/openai-compatible',
      settings: { apiKey: 'none', baseURL: modelUrl }, models: { echo: { name: 'Echo' } },
    } },
  }));
  return startIsolatedServer(workspace, state);
}

test('OpenCode 2.3.2 delivers re-admitted inbox prompts to the model once the destination session resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-router-inbox-delivery-'));
  const model = await startStubModel();
  const servers: { stop(): Promise<void> }[] = [];
  try {
    const sourceWorkspace = join(root, 'source');
    const targetWorkspace = join(root, 'target');
    await cp(resolve('fixtures/workspace'), sourceWorkspace, { recursive: true });
    await cp(sourceWorkspace, targetWorkspace, { recursive: true });

    const source = await startServerWithStubModel(sourceWorkspace, join(root, 'source-agent'), model.baseUrl);
    servers.push(source);
    const sessionId = await source.client.createSession(sourceWorkspace, 'Inbox delivery fixture');
    await source.client.runShellCommand(sessionId, "printf 'shell fixture\\n'");
    await source.client.admitInboxItem(sessionId, { type: 'user', delivery: 'queue', payload: { text: 'queued fixture prompt' } });
    await source.client.admitInboxItem(sessionId, { type: 'user', delivery: 'steer', payload: { text: 'steered fixture prompt' } });
    const transfer = await source.client.exportSessionForCheckpoint(sessionId);
    const carried = transfer.pendingInbox as PendingInboxItem[];
    expect(carried.map(item => item.type)).toEqual(['synthetic', 'user', 'user']);
    await source.stop();

    const target = await startServerWithStubModel(targetWorkspace, join(root, 'target-agent'), model.baseUrl);
    servers.push(target);
    expect(await target.client.importSession(transfer, targetWorkspace)).toBe(sessionId);
    expect((await target.client.listInbox(sessionId)).map(item => item.id)).toEqual(carried.map(item => item.id));
    expect(model.requests).toEqual([]);

    const call = async (path: string, body?: unknown) => {
      const response = await fetch(`${target.baseUrl}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, `${path}: ${response.status}`).toBe(true);
      return response.status === 204 ? undefined : await response.json() as { data: { type: string; text?: string }[] };
    };
    // Agent Router never wakes the agent loop. Here it is woken the way a client would: by admitting a prompt
    // with resume:true. Reusing the first carried user prompt's ID adds no new inbox item.
    const queued = carried.find(item => item.type === 'user')!;
    await call(`session/${sessionId}/prompt`, { id: queued.id, text: queued.payload.text, delivery: queued.delivery, resume: true });
    await call(`experimental/session/${sessionId}/wait`, {});

    expect(await target.client.listInbox(sessionId)).toEqual([]);
    const sent = model.requests.join('\n');
    for (const text of ['queued fixture prompt', 'steered fixture prompt', 'shell fixture']) expect(sent).toContain(text);
    const messages = (await call(`session/${sessionId}/message`))!.data;
    expect(messages.filter(message => message.type === 'user').map(message => message.text).sort())
      .toEqual(['queued fixture prompt', 'steered fixture prompt']);
    expect(messages.filter(message => message.type === 'assistant').length).toBeGreaterThan(0);
  } finally {
    for (const server of servers) await server.stop().catch(() => {});
    await model.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

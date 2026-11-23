import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeClient } from '../src/client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

test('authenticates to the pinned v2 API and returns the session transfer payload', async () => {
  const transcript = { info: { id: 'ses_fixture', title: 'unfinished task' }, messages: [{ type: 'user', text: 'remember fixture' }] };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('opencode:temporary-test-password').toString('base64')}`) { res.writeHead(401).end(); return; }
    if (req.url !== '/api/experimental/session/ses_fixture/export') { res.writeHead(404).end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: transcript }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  expect(await client.exportSession('ses_fixture')).toEqual(transcript);
});

test('does not include upstream response bodies or credentials in an authentication error', async () => {
  const server = createServer((_req, res) => { res.writeHead(401).end('sensitive upstream detail'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  await expect(client.health()).rejects.toThrow('OpenCode request failed (401)');
});

test('rejects sending credentials to an unencrypted remote host', () => {
  expect(() => new OpenCodeClient('http://example.com', 'temporary-test-password')).toThrow(/HTTPS/);
});

test('lists the inbox and re-admits an item under its original ID without waking the agent loop', async () => {
  const item = { id: 'msg_fixture', type: 'user', delivery: 'queue', payload: { text: 'pending fixture' } };
  const move = { id: 'msg_move', type: 'move', delivery: 'queue', payload: { projectID: 'prj_fixture', location: {} } };
  const requests: { url: string | undefined; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: req.method === 'GET' ? [item, move] : item }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  expect(await client.listInbox('ses_fixture')).toEqual([item, move]);
  await client.admitInboxItem('ses_fixture', { ...item, delivery: 'queue' });
  expect(requests).toEqual([
    { url: '/api/session/ses_fixture/inbox', body: undefined },
    { url: '/api/session/ses_fixture/prompt', body: { text: 'pending fixture', id: 'msg_fixture', delivery: 'queue', resume: false } },
  ]);
  await expect(client.admitInboxItem('ses_fixture', { ...move, delivery: 'queue' })).rejects.toThrow(/cannot be admitted/);
});

test('a checkpoint export refuses pending inbox work but allows the record of a finished shell turn', async () => {
  const transcript = { info: { id: 'ses_fixture' }, messages: [] };
  const shell = { id: 'msg_shell', type: 'synthetic', delivery: 'queue', payload: { text: 'ran', metadata: { source: 'shell' } } };
  let inbox: unknown[] = [shell];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: req.url?.endsWith('/inbox') ? inbox : transcript }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  expect(await client.exportSessionForCheckpoint('ses_fixture')).toEqual(transcript);
  for (const pending of [
    { id: 'msg_user', type: 'user', delivery: 'queue', payload: { text: 'do this next' } },
    { id: 'msg_other', type: 'synthetic', delivery: 'steer', payload: { text: 'not from a shell turn' } },
    { id: 'msg_compact', type: 'compaction', delivery: 'queue', payload: {} },
  ]) {
    inbox = [shell, pending];
    await expect(client.exportSessionForCheckpoint('ses_fixture')).rejects.toThrow(`OPENCODE_PENDING_INBOX: session has 1 pending inbox item(s) (${pending.type} ${pending.id})`);
  }
});

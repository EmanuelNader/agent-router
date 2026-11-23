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

test('a checkpoint export carries text-only pending inbox items and refuses the rest', async () => {
  const transcript = { info: { id: 'ses_fixture' }, messages: [] };
  const shell = { id: 'msg_shell', type: 'synthetic', delivery: 'steer', payload: { text: 'ran', metadata: { source: 'shell' } }, sessionID: 'ses_fixture', time: { created: 1 } };
  const user = { id: 'msg_user', type: 'user', delivery: 'queue', payload: { text: 'do this next' }, sessionID: 'ses_fixture', time: { created: 2 } };
  let inbox: unknown[] = [];
  let inboxReads = 0;
  let afterFirstRead: unknown[] | undefined;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!req.url?.endsWith('/inbox')) { res.end(JSON.stringify({ data: transcript })); return; }
    res.end(JSON.stringify({ data: inboxReads++ > 0 && afterFirstRead ? afterFirstRead : inbox }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  expect(await client.exportSessionForCheckpoint('ses_fixture')).toEqual(transcript);
  inbox = [shell, user];
  expect(await client.exportSessionForCheckpoint('ses_fixture')).toEqual({
    ...transcript,
    pendingInbox: [
      { id: 'msg_shell', type: 'synthetic', delivery: 'steer', payload: shell.payload },
      { id: 'msg_user', type: 'user', delivery: 'queue', payload: user.payload },
    ],
  });
  for (const blocked of [
    { id: 'msg_files', type: 'user', delivery: 'queue', payload: { text: 'see file', files: [{ uri: 'file:///x' }] } },
    { id: 'msg_compact', type: 'compaction', delivery: 'queue', payload: {} },
    { id: 'msg_move', type: 'move', delivery: 'queue', payload: { projectID: 'prj_fixture' } },
  ]) {
    inbox = [user, blocked];
    await expect(client.exportSessionForCheckpoint('ses_fixture')).rejects.toThrow(`OPENCODE_PENDING_INBOX: inbox item ${blocked.type} ${blocked.id}`);
  }
  inbox = [user]; inboxReads = 0; afterFirstRead = [user, { ...user, id: 'msg_late' }];
  await expect(client.exportSessionForCheckpoint('ses_fixture')).rejects.toThrow(/inbox changed during the export/);
});

test('an import re-admits carried inbox items under their original IDs and refuses a destination inbox that differs', async () => {
  const item = { id: 'msg_user', type: 'user', delivery: 'queue', payload: { text: 'do this next' } };
  const requests: { url: string | undefined; body: unknown }[] = [];
  let listed: unknown[] = [item];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: req.url?.endsWith('/import') ? { id: 'ses_fixture' } : req.method === 'GET' ? listed : item }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const client = new OpenCodeClient(`http://127.0.0.1:${address.port}`, 'temporary-test-password');
  const transfer = { info: { id: 'ses_fixture' }, messages: [], pendingInbox: [item] };
  expect(await client.importSession(transfer, '/work/project')).toBe('ses_fixture');
  expect(requests).toEqual([
    { url: '/api/experimental/session/import', body: { info: { id: 'ses_fixture' }, messages: [], location: { directory: '/work/project' } } },
    { url: '/api/session/ses_fixture/prompt', body: { text: 'do this next', id: 'msg_user', delivery: 'queue', resume: false } },
    { url: '/api/session/ses_fixture/inbox', body: undefined },
  ]);
  listed = [];
  await expect(client.importSession(transfer, '/work/project')).rejects.toThrow(/does not match the checkpoint/);
  await expect(client.importSession({ ...transfer, pendingInbox: [{ ...item, type: 'move' }] }, '/work/project')).rejects.toThrow('Invalid pending inbox');
});

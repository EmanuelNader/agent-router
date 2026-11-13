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

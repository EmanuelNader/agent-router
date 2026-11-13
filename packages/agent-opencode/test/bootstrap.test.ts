import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { OPENCODE_VERSION } from '../src/server.js';
import { OpenCodeBootstrap } from '../src/bootstrap.js';
import { SshLoopbackTunnel } from '../src/tunnel.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const password = 'ab'.repeat(32);

test('cloud-init installs the pinned release once and binds it to loopback', () => {
  const script = OpenCodeBootstrap.cloudInit(password);
  expect(script).toContain(`@opencode/cli@${OPENCODE_VERSION}`);
  expect(script).toContain('opencode serve --hostname 127.0.0.1 --port 4096');
  expect(script).toContain('systemctl is-active --quiet agent-router-opencode');
  expect(script).toContain('6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c');
  expect(script).toContain('OPENCODE_DISABLE_PROJECT_CONFIG=1');
  expect(script).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  expect(script).not.toContain('oci_api_key');
  expect(Buffer.byteLength(script)).toBeLessThan(16_000);
  expect(() => OpenCodeBootstrap.cloudInit('short')).toThrow(/password/);
});

test('health uses the existing client and an injected loopback tunnel', async () => {
  const server = createServer((request, response) => {
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    if (request.headers.authorization !== expected || !request.url?.startsWith('/api/session')) { response.writeHead(401).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end('[]');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  let opened = '';
  await OpenCodeBootstrap.verifyThroughTunnel('203.0.113.20', password, async host => {
    opened = host;
    return { baseUrl: `http://127.0.0.1:${address.port}`, close: async () => {} };
  });
  expect(opened).toBe('203.0.113.20');
  await expect(OpenCodeBootstrap.verify(`http://127.0.0.1:${address.port}`, 'cd'.repeat(32))).rejects.toThrow('AGENT_UNAUTHORIZED');
});

test('the ssh forward targets loopback and refuses a shell metacharacter host', () => {
  const args = SshLoopbackTunnel.commandArgs({
    host: '203.0.113.20', privateKeyPath: '/tmp/id_ed25519', knownHostsPath: '/tmp/known_hosts', localPort: 4409,
  });
  expect(args).toContain('StrictHostKeyChecking=accept-new');
  expect(args).toContain('127.0.0.1:4409:127.0.0.1:4096');
  expect(args).toContain('ubuntu@203.0.113.20');
  expect(args.join(' ')).not.toContain(password);
  expect(() => SshLoopbackTunnel.commandArgs({
    host: '203.0.113.20;rm', privateKeyPath: '/tmp/id_ed25519', knownHostsPath: '/tmp/known_hosts', localPort: 1,
  })).toThrow('SSH_TUNNEL_FAILED');
});

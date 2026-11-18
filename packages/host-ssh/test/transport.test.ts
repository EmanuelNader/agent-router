import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildScpUploadArgs, buildSshArgs, LoopbackHostTransport, validateSshTarget } from '../src/transport.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('builds hardened OpenSSH and SCP argument vectors with option termination', () => {
  expect(buildSshArgs('agent@vps.tailnet.ts.net', ['opencode', '--version'], 2222)).toEqual([
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15',
    '-p', '2222',
    '--',
    'agent@vps.tailnet.ts.net',
    'opencode',
    '--version',
  ]);

  expect(buildScpUploadArgs('/tmp/chk_0123456789abcdef.enc', 'agent@100.64.0.9', '/var/lib/router/chk.enc', 2200)).toEqual([
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15',
    '-P', '2200',
    '--',
    '/tmp/chk_0123456789abcdef.enc',
    'agent@100.64.0.9:/var/lib/router/chk.enc',
  ]);
});

test('rejects SSH option injection, whitespace, colons, and invalid ports', () => {
  expect(() => validateSshTarget('-oProxyCommand=evil')).toThrow(/target/i);
  expect(() => validateSshTarget('user@host name')).toThrow(/target/i);
  expect(() => validateSshTarget('user@host:path')).toThrow(/target/i);
  expect(() => buildSshArgs('agent@host', [], 22)).toThrow(/command/i);
  expect(() => buildSshArgs('agent@host', ['true'], 70000)).toThrow(/port/i);
  expect(() => buildScpUploadArgs('relative.enc', 'agent@host', '/remote/chk.enc')).toThrow(/absolute/i);
  expect(() => buildScpUploadArgs('/local/chk.enc', 'agent@host', 'relative/chk.enc')).toThrow(/absolute/i);
});

test('LoopbackHostTransport transfers encrypted containers into owner-only remote storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-transport-'));
  tempDirs.push(root);
  const transport = new LoopbackHostTransport(join(root, 'remote-spool'));
  const payload = Buffer.from('AR01-encrypted-bytes');

  await transport.transferEncryptedCheckpoint('chk_0123456789abcdef', payload);
  expect(await transport.readTransferredCheckpoint('chk_0123456789abcdef')).toEqual(payload);
  await expect(transport.transferEncryptedCheckpoint('chk_0123456789abcdef', payload)).rejects.toMatchObject({
    code: 'EEXIST',
  });
});

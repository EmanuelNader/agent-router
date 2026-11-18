import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  buildScpDownloadArgs,
  buildScpUploadArgs,
  buildSshArgs,
  LoopbackHostTransport,
  SshCliTransport,
  validateSshTarget,
} from '../src/transport.js';

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

  expect(buildScpDownloadArgs('agent@100.64.0.9', '/var/lib/router/chk.enc', '/tmp/local.enc', 2200)).toEqual([
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15',
    '-P', '2200',
    '--',
    'agent@100.64.0.9:/var/lib/router/chk.enc',
    '/tmp/local.enc',
  ]);
});

test('rejects SSH option injection, whitespace, colons, and invalid ports, while supporting bracketed IPv6', () => {
  expect(() => validateSshTarget('-oProxyCommand=evil')).toThrow(/target/i);
  expect(() => validateSshTarget('user@host name')).toThrow(/target/i);
  expect(() => validateSshTarget('user@host:path')).toThrow(/target/i);
  expect(validateSshTarget('agent@[fd7a:115c:a1e0::99]')).toBe('agent@[fd7a:115c:a1e0::99]');
  expect(buildSshArgs('agent@[fd7a:115c:a1e0::99]', ['true'])).toContain('agent@fd7a:115c:a1e0::99');
  expect(buildScpUploadArgs('/tmp/chk.enc', 'agent@[fd7a:115c:a1e0::99]', '/var/lib/chk.enc')).toContain(
    'agent@[fd7a:115c:a1e0::99]:/var/lib/chk.enc',
  );
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

test('SshCliTransport executes hardened ssh/scp binaries, prevents overwrite, and scrubs remote stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-ssh-cli-'));
  tempDirs.push(root);
  const remoteSpoolDir = join(root, 'remote-fs', 'spool');
  const invocationLog = join(root, 'ssh-scp.log');
  const fakeSsh = join(root, 'exec-ssh.sh');
  const fakeScp = join(root, 'exec-scp.sh');

  await writeFile(
    fakeSsh,
    `#!/bin/sh
set -eu
printf 'ssh:%s\\n' "$*" >> "${invocationLog}"
while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  if [ "$arg" = "--" ]; then
    break
  fi
done
target="$1"
shift
if [ "$target" = "fail@100.64.0.99" ]; then
  echo "Permission denied (publickey) for secret-host-fingerprint-8821" >&2
  exit 255
fi
exec "$@"
`,
    { mode: 0o700 },
  );
  await chmod(fakeSsh, 0o700);

  await writeFile(
    fakeScp,
    `#!/bin/sh
set -eu
printf 'scp:%s\\n' "$*" >> "${invocationLog}"
while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  if [ "$arg" = "--" ]; then
    break
  fi
done
src="$1"
dst="$2"
case "$dst" in
  *:*)
    remote_path="\${dst#*:}"
    cp "$src" "$remote_path"
    ;;
  *)
    remote_path="\${src#*:}"
    cp "$remote_path" "$dst"
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(fakeScp, 0o700);

  const transport = new SshCliTransport({
    target: 'agent@100.64.0.9',
    remoteSpoolDirectory: remoteSpoolDir,
    port: 2222,
    sshBinary: fakeSsh,
    scpBinary: fakeScp,
  });

  const payload = Buffer.from('AR01-live-ssh-transport-bytes');
  await transport.transferEncryptedCheckpoint('chk_0123456789abcdef', payload);

  const remoteStat = await stat(join(remoteSpoolDir, 'chk_0123456789abcdef.enc'));
  expect(remoteStat.mode & 0o777).toBe(0o600);

  const roundtripped = await transport.readTransferredCheckpoint('chk_0123456789abcdef');
  expect(roundtripped).toEqual(payload);

  await expect(transport.transferEncryptedCheckpoint('chk_0123456789abcdef', payload)).rejects.toMatchObject({
    code: 'EEXIST',
  });

  const logText = await readFile(invocationLog, 'utf8');
  expect(logText).toContain('ssh:-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -p 2222 -- agent@100.64.0.9');
  expect(logText).toContain('scp:-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -P 2222 --');

  const failingTransport = new SshCliTransport({
    target: 'fail@100.64.0.99',
    remoteSpoolDirectory: remoteSpoolDir,
    sshBinary: fakeSsh,
    scpBinary: fakeScp,
  });
  await expect(failingTransport.transferEncryptedCheckpoint('chk_fedcba9876543210', payload)).rejects.not.toThrow(
    /secret-host-fingerprint-8821/,
  );
});

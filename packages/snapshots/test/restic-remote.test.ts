import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { buildResticRemoteConfig, ResticRepositoryStore } from '../src/restic.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('builds hardened SFTP restic configs and rejects tilde, traversal, and option injection', () => {
  const rel = buildResticRemoteConfig({
    kind: 'sftp',
    target: 'agent@vps.tailnet.ts.net',
    path: 'agent-router/repo',
  });
  expect(rel).toEqual({
    repository: 'sftp:agent@vps.tailnet.ts.net:agent-router/repo',
    options: ['sftp.args=-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15'],
  });

  const absWithPort = buildResticRemoteConfig({
    kind: 'sftp',
    target: 'agent@100.64.0.12',
    port: 2222,
    path: '/var/lib/agent-router/restic',
  });
  expect(absWithPort).toEqual({
    repository: 'sftp://agent@100.64.0.12:2222//var/lib/agent-router/restic',
    options: ['sftp.args=-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15'],
  });

  expect(() =>
    buildResticRemoteConfig({ kind: 'sftp', target: 'agent@host', path: '~/backups' }),
  ).toThrow(/tilde|path/i);
  expect(() =>
    buildResticRemoteConfig({ kind: 'sftp', target: '-oProxyCommand=evil', path: '/srv/repo' }),
  ).toThrow(/target/i);
  expect(() =>
    buildResticRemoteConfig({ kind: 'sftp', target: 'agent@host', path: '../escape' }),
  ).toThrow(/path/i);
});

test('builds OCI Object Storage, Cloudflare R2, and AWS S3 restic configs without embedding credentials in URLs', () => {
  const oci = buildResticRemoteConfig({
    kind: 'oci-s3',
    namespace: 'ax99example',
    region: 'us-ashburn-1',
    bucket: 'agent-router-snapshots',
    prefix: 'workspaces/alpha',
    accessKeyId: 'oci-ak-test-1234',
    secretAccessKey: 'oci-sk-super-secret-value',
  });
  expect(oci.repository).toBe(
    's3:https://ax99example.compat.objectstorage.us-ashburn-1.oraclecloud.com/agent-router-snapshots/workspaces/alpha',
  );
  expect(oci.options).toEqual(['s3.bucket-lookup=path', 's3.region=us-ashburn-1']);
  expect(JSON.stringify({ repository: oci.repository, options: oci.options })).not.toContain('oci-sk-super-secret-value');

  const r2 = buildResticRemoteConfig({
    kind: 'r2',
    accountId: '0123456789abcdef0123456789abcdef',
    bucket: 'router-r2-free',
    accessKeyId: 'r2-ak',
    secretAccessKey: 'r2-sk-secret',
  });
  expect(r2.repository).toBe(
    's3:https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/router-r2-free',
  );
  expect(r2.options).toEqual(['s3.region=auto']);

  const aws = buildResticRemoteConfig({
    kind: 'aws-s3',
    region: 'us-east-2',
    bucket: 'router-aws-bucket',
    accessKeyId: 'aws-ak',
    secretAccessKey: 'aws-sk-secret',
  });
  expect(aws.repository).toBe('s3:s3.us-east-2.amazonaws.com/router-aws-bucket');
  expect(aws.options).toEqual(['s3.region=us-east-2']);
});

test('passes -o backend options and owner-only 0600 AWS_SHARED_CREDENTIALS_FILE while scrubbing errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-restic-remote-'));
  tempDirs.push(root);
  const logPath = join(root, 'invocations.log');
  const fakeRestic = join(root, 'fake-restic.sh');

  await writeFile(
    fakeRestic,
    `#!/bin/sh
set -eu
cred_mode=""
if [ -n "\${AWS_SHARED_CREDENTIALS_FILE:-}" ] && [ -f "\${AWS_SHARED_CREDENTIALS_FILE}" ]; then
  cred_mode="$(stat -f '%Lp' "\${AWS_SHARED_CREDENTIALS_FILE}" 2>/dev/null || stat -c '%a' "\${AWS_SHARED_CREDENTIALS_FILE}")"
  grep -q "aws_secret_access_key = ultra-secret-oci-key-991" "\${AWS_SHARED_CREDENTIALS_FILE}"
fi
printf '%s|mode=%s\\n' "$*" "$cred_mode" >> "${logPath}"
for arg in "$@"; do
  if [ "$arg" = "snapshots" ]; then
    printf '[]\\n'
    exit 0
  fi
  if [ "$arg" = "check" ]; then
    echo "simulated remote backend error for ultra-secret-oci-key-991" >&2
    exit 1
  fi
done
exit 0
`,
    { mode: 0o700 },
  );
  await chmod(fakeRestic, 0o700);

  const remote = buildResticRemoteConfig({
    kind: 'oci-s3',
    namespace: 'tenancyns',
    region: 'us-phoenix-1',
    bucket: 'router-free-bucket',
    accessKeyId: 'ak-oci-001',
    secretAccessKey: 'ultra-secret-oci-key-991',
  });

  const store = ResticRepositoryStore.fromRemoteConfig(remote, 'strong-restic-passphrase-1234', {
    resticBinary: fakeRestic,
  });

  await store.put('chk_0123456789abcdef', [
    { path: 'note.txt', executable: false, data: Buffer.from('remote-hello') },
  ]);

  const log = await readFile(logPath, 'utf8');
  expect(log).toContain('-o s3.bucket-lookup=path -o s3.region=us-phoenix-1 cat config|mode=600');
  expect(log).toContain('-o s3.bucket-lookup=path -o s3.region=us-phoenix-1 backup . --tag chk_0123456789abcdef --quiet|mode=600');
  expect(log).not.toContain('ultra-secret-oci-key-991');

  await expect(store.verifyIntegrity()).rejects.toThrow('restic check failed');
  await expect(store.verifyIntegrity()).rejects.not.toThrow(/ultra-secret-oci-key-991/);
});

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { common } from 'oci-sdk';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { OciConnection, prepareOciKey, writeOciConfig } from '../src/oci-connection.js';

let root: string;
let directory: string;
const account = {
  user: 'ocid1.user.oc1..exampleuser', tenancy: 'ocid1.tenancy.oc1..exampletenancy', region: 'us-sanjose-1',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'router-oci-connection-'));
  directory = join(root, 'credentials');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('generated RSA credentials are owner-only and load through the pinned OCI SDK', async () => {
  const prepared = await prepareOciKey(directory);
  const keyPath = join(directory, 'oci_api_key.pem');
  const privateKey = createPrivateKey(await readFile(keyPath));
  expect(privateKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })).toBe(await readFile(prepared.publicKeyPath, 'utf8'));
  expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(keyPath)).mode & 0o777).toBe(0o600);

  const configured = await writeOciConfig(directory, account);
  expect((await lstat(configured.configPath)).mode & 0o777).toBe(0o600);
  const auth = new common.ConfigFileAuthenticationDetailsProvider(configured.configPath, 'DEFAULT');
  expect(auth.getUser()).toBe(account.user);
  expect(auth.getTenantId()).toBe(account.tenancy);
  expect(auth.getRegion().regionId).toBe(account.region);
  expect(auth.getFingerprint()).toBe(prepared.fingerprint);
  expect(prepared).not.toHaveProperty('privateKey');

  // Verify OciConnection static methods produce equivalent behavior
  const classDirectory = join(root, 'class-credentials');
  const classPrepared = await OciConnection.prepareKey(classDirectory);
  expect(classPrepared.fingerprint).toMatch(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
  const classConfigured = await OciConnection.writeConfig(classDirectory, account);
  expect((await lstat(classConfigured.configPath)).mode & 0o777).toBe(0o600);
});

test('prepare and configure preserve existing files and reject config injection', async () => {
  const prepared = await prepareOciKey(directory);
  const originalPublicKey = await readFile(prepared.publicKeyPath, 'utf8');
  await expect(prepareOciKey(directory)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(prepared.publicKeyPath, 'utf8')).toBe(originalPublicKey);
  await expect(writeOciConfig(directory, { ...account, user: `${account.user}\nregion=another` })).rejects.toThrow(/OCID/);
  const result = await writeOciConfig(directory, account);
  const originalConfig = await readFile(result.configPath, 'utf8');
  await expect(writeOciConfig(directory, { ...account, region: 'us-phoenix-1' })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(result.configPath, 'utf8')).toBe(originalConfig);
});

test('credentials cannot be created in a checkout or configured through symlinks or broad key permissions', async () => {
  const repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, '.git'), 'gitdir: elsewhere\n');
  await expect(prepareOciKey(join(repo, 'credentials'))).rejects.toThrow(/outside Git/);

  await prepareOciKey(directory);
  const checkoutMarker = join(directory, '.git');
  await writeFile(checkoutMarker, 'gitdir: elsewhere\n');
  await expect(writeOciConfig(directory, account)).rejects.toThrow(/outside Git/);
  await rm(checkoutMarker);
  const link = join(root, 'alias');
  await symlink(directory, link);
  await expect(writeOciConfig(link, account)).rejects.toThrow(/owner-only credential directory/);
  const keyPath = join(directory, 'oci_api_key.pem');
  await chmod(keyPath, 0o644);
  await expect(writeOciConfig(directory, account)).rejects.toThrow(/owner-only OCI key file/);
  await rm(keyPath);
  await symlink(join(directory, 'oci_api_key_public.pem'), keyPath);
  await expect(writeOciConfig(directory, account)).rejects.toMatchObject({ code: 'ELOOP' });
});

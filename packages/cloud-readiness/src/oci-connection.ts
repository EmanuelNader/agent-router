import { createHash, createPrivateKey, createPublicKey, generateKeyPair } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { regionSchema } from './oci-report.js';

const privateName = 'oci_api_key.pem';
const publicName = 'oci_api_key_public.pem';
const generate = promisify(generateKeyPair);

function fingerprint(key: ReturnType<typeof createPublicKey>) {
  // OCI identifies RSA keys by the MD5 fingerprint of the public DER bytes.
  return createHash('md5').update(key.export({ type: 'spki', format: 'der' })).digest('hex').match(/../g)!.join(':');
}

async function checkedDirectory(path: string) {
  if (!isAbsolute(path) || /[\r\n\0=]/.test(path) || path !== path.trim()) {
    throw new Error('Use an absolute credential directory with no config delimiters');
  }
  const parent = await realpath(dirname(path));
  const name = basename(path);
  if (!name || name === '.' || name === '..') throw new Error('Specify a dedicated credential directory');
  const directory = join(parent, name);
  if (/[\r\n\0=]/.test(directory) || directory !== directory.trim()) throw new Error('Invalid resolved credential path');
  for (let ancestor = directory;; ancestor = dirname(ancestor)) {
    try {
      await lstat(join(ancestor, '.git'));
      throw new Error('Keep OCI credentials outside Git checkouts');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  return directory;
}

export class OciConnection {
  static async prepareKey(path: string) {
    const directory = await checkedDirectory(path);
    const { privateKey, publicKey } = await generate('rsa', { modulusLength: 2048 });
    const publicKeyPath = join(directory, publicName);
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(join(directory, privateName), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { publicKeyPath, fingerprint: fingerprint(publicKey) };
  }

  static async writeConfig(path: string, input: { user: string; tenancy: string; region: string }) {
    const { user, tenancy, region } = input;
    if (!/^ocid1\.user\.[a-z0-9]+\.\.[a-z0-9]+$/.test(user)
      || !/^ocid1\.tenancy\.[a-z0-9]+\.\.[a-z0-9]+$/.test(tenancy)
      || !regionSchema.safeParse(region).success) {
      throw new Error('Supply the inspector user OCID, tenancy OCID, and home region');
    }
    const directory = await checkedDirectory(path);
    const directoryInfo = await lstat(directory);
    const uid = process.getuid?.();
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== uid || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error('Use an owner-only credential directory');
    }
    const keyPath = join(directory, privateName);
    const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let keyFingerprint: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 16_384) {
        throw new Error('Use an owner-only OCI key file');
      }
      const key = createPrivateKey(await handle.readFile());
      if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
        throw new Error('OCI requires an RSA signing key of at least 2048 bits');
      }
      keyFingerprint = fingerprint(createPublicKey(key));
    } finally { await handle.close(); }

    const configPath = join(directory, 'config');
    const config = ['[DEFAULT]', `user=${user}`, `fingerprint=${keyFingerprint}`, `key_file=${keyPath}`, `tenancy=${tenancy}`, `region=${region}`, ''].join('\n');
    const staging = await mkdtemp(join(directory, '.config-'));
    try {
      const stagedConfig = join(staging, 'config');
      await writeFile(stagedConfig, config, { mode: 0o600, flag: 'wx' });
      // Publish the complete file without replacing a config created by another run.
      await link(stagedConfig, configPath);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return { configPath, fingerprint: keyFingerprint };
  }

  static readonly prepareOciKey = OciConnection.prepareKey;
  static readonly writeOciConfig = OciConnection.writeConfig;
}

export const prepareOciKey = OciConnection.prepareKey;
export const writeOciConfig = OciConnection.writeConfig;

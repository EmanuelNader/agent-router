import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DeployError } from './errors.js';

const token = z.string().regex(/^ar[a-f0-9]{32}$/);
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  password: z.string().regex(/^[a-f0-9]{64}$/),
  tokens: z.object({
    vcn: token, internetGateway: token, securityList: token, subnet: token, instance: token,
  }),
  instanceId: z.string().min(1).optional(),
  bootVolumeId: z.string().min(1).optional(),
});
export type DeployRecord = z.infer<typeof stateSchema>;

/** Local retry tokens and the agent password. The file is owner-only and is not a receipt. */
export class OciDeployState {
  static newToken(): string {
    return `ar${randomBytes(16).toString('hex')}`;
  }

  static create(): DeployRecord {
    return {
      schemaVersion: 1,
      password: randomBytes(32).toString('hex'),
      tokens: {
        vcn: this.newToken(), internetGateway: this.newToken(), securityList: this.newToken(),
        subnet: this.newToken(), instance: this.newToken(),
      },
    };
  }

  /** Drop the recorded instance so the next launch does not replay a terminated create. */
  static withoutInstance(record: DeployRecord): DeployRecord {
    return {
      schemaVersion: 1,
      password: record.password,
      tokens: { ...record.tokens, instance: this.newToken() },
    };
  }

  static passwordFromUserData(userData: string | undefined): string | null {
    if (!userData) return null;
    let script: string;
    try { script = Buffer.from(userData, 'base64').toString('utf8'); }
    catch { return null; }
    return script.match(/^OPENCODE_PASSWORD=([a-f0-9]{64})$/m)?.[1] ?? null;
  }

  static async load(path: string): Promise<DeployRecord | null> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new DeployError('STATE_INVALID');
    }
    if (!info.isFile()) throw new DeployError('STATE_INVALID');
    const uid = process.getuid?.();
    if (info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 65_536) throw new DeployError('STATE_PERMISSIONS');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const parsed = stateSchema.safeParse(JSON.parse(await handle.readFile({ encoding: 'utf8' })));
      if (!parsed.success) throw new DeployError('STATE_INVALID');
      return parsed.data;
    } catch (error) {
      if (error instanceof DeployError) throw error;
      throw new DeployError('STATE_INVALID');
    } finally { await handle.close(); }
  }

  static async save(path: string, record: DeployRecord): Promise<void> {
    const body = JSON.stringify(stateSchema.parse(record));
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.state-${randomBytes(6).toString('hex')}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(body); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

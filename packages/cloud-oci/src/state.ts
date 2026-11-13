import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DeployError } from './errors.js';

const token = z.string().regex(/^ar[a-f0-9]{32}$/);
const resourceId = z.string().min(1);
const resourcesSchema = z.object({
  vcnId: resourceId.optional(),
  internetGatewayId: resourceId.optional(),
  securityListId: resourceId.optional(),
  subnetId: resourceId.optional(),
  routeTableId: resourceId.optional(),
  instanceId: resourceId.optional(),
  bootVolumeId: resourceId.optional(),
});
const stateSchema = z.object({
  schemaVersion: z.literal(2),
  deploymentId: z.string().regex(/^dep[a-f0-9]{16}$/),
  password: z.string().regex(/^[a-f0-9]{64}$/),
  region: z.string().regex(/^[a-z]{2,3}-[a-z0-9-]+-\d+$/).optional(),
  compartmentId: z.string().regex(/^ocid1\.compartment\.oc1\.\.[a-z0-9]+$/).optional(),
  tokens: z.object({
    vcn: token, internetGateway: token, securityList: token, subnet: token, instance: token,
  }),
  resources: resourcesSchema,
});
export type DeployRecord = z.infer<typeof stateSchema>;
export type ResourceIds = z.infer<typeof resourcesSchema>;

/** Local retry tokens, deployment id, and the saved resource IDs. The file is owner-only. */
export class OciDeployState {
  static newToken(): string {
    return `ar${randomBytes(16).toString('hex')}`;
  }

  static create(): DeployRecord {
    return {
      schemaVersion: 2,
      deploymentId: `dep${randomBytes(8).toString('hex')}`,
      password: randomBytes(32).toString('hex'),
      tokens: {
        vcn: this.newToken(), internetGateway: this.newToken(), securityList: this.newToken(),
        subnet: this.newToken(), instance: this.newToken(),
      },
      resources: {},
    };
  }

  static locate(record: DeployRecord, region: string, compartmentId: string): DeployRecord {
    return { ...record, region, compartmentId };
  }

  static remember(record: DeployRecord, patch: ResourceIds): DeployRecord {
    return { ...record, resources: { ...record.resources, ...patch } };
  }

  /** New ids and tokens so a later launch does not replay creates OCI still remembers as deleted. */
  static afterDestroy(record: DeployRecord): DeployRecord {
    const fresh = this.create();
    return {
      ...fresh,
      ...(record.region ? { region: record.region } : {}),
      ...(record.compartmentId ? { compartmentId: record.compartmentId } : {}),
    };
  }

  /** Drop the recorded instance so the next launch does not replay a terminated create. */
  static withoutInstance(record: DeployRecord): DeployRecord {
    const resources = { ...record.resources };
    delete resources.instanceId;
    delete resources.bootVolumeId;
    return {
      schemaVersion: 2,
      deploymentId: record.deploymentId,
      password: record.password,
      ...(record.region ? { region: record.region } : {}),
      ...(record.compartmentId ? { compartmentId: record.compartmentId } : {}),
      tokens: { ...record.tokens, instance: this.newToken() },
      resources,
    };
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

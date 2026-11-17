import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const safeSummarySchema = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !/[\r\n\0]/.test(value), 'Operation summary must be single-line without control characters');

export const operationKindSchema = z.enum(['CHECKPOINT', 'RESTORE', 'HANDOFF', 'PROVISION']);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const operationStatusSchema = z.enum(['PENDING', 'COMPLETED', 'NEEDS_RECONCILE']);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const operationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^op_[a-f0-9]{16,64}$/),
  kind: operationKindSchema,
  status: operationStatusSchema,
  workspaceKey: z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value)),
  retryToken: z.string().regex(/^rt_[a-f0-9]{24,64}$/),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  summary: safeSummarySchema,
});
export type OperationRecord = z.infer<typeof operationRecordSchema>;

export class OperationJournal {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('Operation journal must be an owner-only real directory');
    }
  }

  private async writeAtomic(record: OperationRecord): Promise<OperationRecord> {
    const validated = operationRecordSchema.parse(record);
    await this.ensureDirectory();
    const tempPath = join(this.directory, `.${validated.operationId}.${randomBytes(8).toString('hex')}.tmp`);
    const finalPath = join(this.directory, `${validated.operationId}.json`);
    try {
      await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(tempPath, finalPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return validated;
  }

  async read(operationId: string): Promise<OperationRecord> {
    if (!/^op_[a-f0-9]{16,64}$/.test(operationId)) throw new Error('Invalid operation ID');
    const raw = await readFile(join(this.directory, `${operationId}.json`), 'utf8');
    return operationRecordSchema.parse(JSON.parse(raw));
  }

  async list(): Promise<OperationRecord[]> {
    try {
      await this.ensureDirectory();
    } catch {
      return [];
    }
    const entries = (await readdir(this.directory)).filter(name => /^op_[a-f0-9]{16,64}\.json$/.test(name)).sort();
    const records: OperationRecord[] = [];
    for (const entry of entries) {
      const raw = await readFile(join(this.directory, entry), 'utf8');
      records.push(operationRecordSchema.parse(JSON.parse(raw)));
    }
    return records;
  }

  async begin(input: { kind: OperationKind; workspaceKey: string; summary: string }): Promise<OperationRecord> {
    await this.ensureDirectory();
    const existing = await this.list();
    const blocking = existing.find(
      record =>
        record.workspaceKey === input.workspaceKey &&
        (record.status === 'PENDING' || record.status === 'NEEDS_RECONCILE'),
    );
    if (blocking) {
      throw new Error(
        `Workspace "${input.workspaceKey}" is blocked by ${blocking.status} operation ${blocking.operationId}; reconcile first`,
      );
    }
    const now = new Date().toISOString();
    return await this.writeAtomic({
      schemaVersion: 1,
      operationId: `op_${randomBytes(16).toString('hex')}`,
      kind: input.kind,
      status: 'PENDING',
      workspaceKey: input.workspaceKey,
      retryToken: `rt_${randomBytes(16).toString('hex')}`,
      startedAt: now,
      updatedAt: now,
      summary: input.summary,
    });
  }

  async complete(operationId: string, summary: string): Promise<OperationRecord> {
    const current = await this.read(operationId);
    if (current.status !== 'PENDING') {
      throw new Error(`Cannot complete operation ${operationId} from status ${current.status}`);
    }
    return await this.writeAtomic({
      ...current,
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
      summary,
    });
  }

  async markNeedsReconcile(operationId: string, summary: string): Promise<OperationRecord> {
    const current = await this.read(operationId);
    if (current.status !== 'PENDING') {
      throw new Error(`Cannot mark operation ${operationId} for reconciliation from status ${current.status}`);
    }
    return await this.writeAtomic({
      ...current,
      status: 'NEEDS_RECONCILE',
      updatedAt: new Date().toISOString(),
      summary,
    });
  }

  async reconcile(operationId: string, summary: string): Promise<OperationRecord> {
    const current = await this.read(operationId);
    if (current.status !== 'NEEDS_RECONCILE' && current.status !== 'PENDING') {
      throw new Error(`Operation ${operationId} does not require reconciliation`);
    }
    return await this.writeAtomic({
      ...current,
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
      summary,
    });
  }

  async abortUnfenced(operationId: string): Promise<void> {
    const current = await this.read(operationId);
    if (current.status !== 'PENDING') {
      throw new Error(`Cannot abort operation ${operationId} in status ${current.status}; reconcile instead`);
    }
    await rm(join(this.directory, `${operationId}.json`));
  }
}

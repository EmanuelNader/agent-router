import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
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
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Operation journal must be an owner-only real directory');
    }
    await chmod(this.directory, 0o700);
  }

  private async writeAtomic(record: OperationRecord): Promise<OperationRecord> {
    const validated = operationRecordSchema.parse(record);
    await this.ensureDirectory();
    const tempPath = join(this.directory, `.${validated.operationId}.${randomBytes(8).toString('hex')}.tmp`);
    const finalPath = join(this.directory, `${validated.operationId}.json`);
    try {
      const file = await open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(tempPath, finalPath);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return validated;
  }

  async read(operationId: string): Promise<OperationRecord> {
    if (!/^op_[a-f0-9]{16,64}$/.test(operationId)) throw new Error('Invalid operation ID');
    await this.ensureDirectory();
    const file = join(this.directory, `${operationId}.json`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('JOURNAL_UNSAFE_RECORD');
    const raw = await readFile(file, 'utf8');
    const record = operationRecordSchema.parse(JSON.parse(raw));
    if (record.operationId !== operationId) throw new Error('JOURNAL_RECORD_ID_MISMATCH');
    return record;
  }

  async list(): Promise<OperationRecord[]> {
    await this.ensureDirectory();
    const names = await readdir(this.directory);
    for (const name of names) {
      const temp = /^\.(op_[a-f0-9]{16,64})\.[a-f0-9]{16}\.tmp$/.exec(name);
      if (temp && !names.includes(`${temp[1]}.json`)) throw new Error('JOURNAL_INCOMPLETE_WRITE');
    }
    const entries = names.filter(name => /^op_[a-f0-9]{16,64}\.json$/.test(name)).sort();
    const records: OperationRecord[] = [];
    for (const entry of entries) {
      records.push(await this.read(entry.slice(0, -5)));
    }
    return records;
  }

  async listBlocking(workspaceKey?: string): Promise<OperationRecord[]> {
    const all = await this.list();
    return all.filter(
      record =>
        (workspaceKey === undefined || record.workspaceKey === workspaceKey) &&
        (record.status === 'PENDING' || record.status === 'NEEDS_RECONCILE'),
    );
  }

  async collectProtectedCheckpointIds(): Promise<string[]> {
    const blocking = await this.listBlocking();
    const ids = new Set<string>();
    const pattern = /chk_[a-f0-9]{16,64}/g;
    for (const record of blocking) {
      for (const match of record.summary.matchAll(pattern)) {
        ids.add(match[0]);
      }
    }
    return [...ids];
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

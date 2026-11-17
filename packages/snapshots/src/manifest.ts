import path from 'node:path';
import { z } from 'zod';
import { OPENCODE_VERSION } from '../../agent-opencode/src/server.js';

export function assertSafeRelativePath(entryPath: string): string {
  if (
    !entryPath ||
    entryPath.includes('\0') ||
    entryPath.includes('\\') ||
    entryPath.startsWith('/') ||
    path.posix.isAbsolute(entryPath)
  ) {
    throw new Error(`Unsafe relative path in checkpoint: ${entryPath}`);
  }
  const segments = entryPath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe relative path in checkpoint: ${entryPath}`);
  }
  return entryPath;
}

const safePathSchema = z.string().transform(value => assertSafeRelativePath(value));
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const fileReceiptSchema = z.object({
  path: safePathSchema,
  executable: z.boolean(),
  sha256: sha256Schema,
});

export const gitStateSchema = z.discriminatedUnion('present', [
  z.object({
    present: z.literal(true),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    statusPorcelain: z.string(),
    indexStage: z.string(),
  }),
  z.object({ present: z.literal(false) }),
]);

export const checkpointManifestSchema = z.object({
  schemaVersion: z.literal(1),
  checkpointId: z.string().regex(/^chk_[a-f0-9]{16,64}$/),
  createdAt: z.iso.datetime(),
  architecture: z.string().min(1),
  opencodeVersion: z.literal(OPENCODE_VERSION),
  sessionIds: z.array(z.string().min(1)),
  git: gitStateSchema,
  workspaceFiles: z.array(fileReceiptSchema),
});

export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

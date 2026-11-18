import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkpointIdSchema } from './store.js';

export interface PruneLocalCheckpointsOptions {
  storeDirectory: string;
  keepLast: number;
  protectedCheckpointIds?: Iterable<string>;
}

export interface PruneLocalCheckpointsResult {
  keptIds: string[];
  deletedIds: string[];
  skippedProtectedIds: string[];
  reclaimedBytes: number;
}

/**
 * Prunes older encrypted `chk_*.enc` containers from a `LocalEncryptedStore` directory while:
 * 1. Keeping at least the newest `keepLast` (>= 1) checkpoints by file modification time
 * 2. Refusing to delete any checkpoint ID listed in `protectedCheckpointIds` (e.g. referenced by
 *    an `IN_PROGRESS` or `NEEDS_RECONCILE` journal entry).
 */
export async function pruneLocalCheckpoints(
  options: PruneLocalCheckpointsOptions,
): Promise<PruneLocalCheckpointsResult> {
  if (!Number.isInteger(options.keepLast) || options.keepLast < 1) {
    throw new Error('Invalid keepLast: must be an integer >= 1');
  }

  const resolvedDir = path.resolve(options.storeDirectory);
  const protectedSet = new Set<string>();
  for (const rawId of options.protectedCheckpointIds ?? []) {
    protectedSet.add(checkpointIdSchema.parse(rawId));
  }

  let fileNames: string[];
  try {
    fileNames = await readdir(resolvedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { keptIds: [], deletedIds: [], skippedProtectedIds: [], reclaimedBytes: 0 };
    }
    throw err;
  }

  const entries: Array<{ id: string; filePath: string; mtimeMs: number; size: number }> = [];
  for (const name of fileNames) {
    if (!name.endsWith('.enc')) continue;
    const candidateId = name.slice(0, -4);
    const parsed = checkpointIdSchema.safeParse(candidateId);
    if (!parsed.success) continue;

    const filePath = path.join(resolvedDir, name);
    const st = await stat(filePath);
    if (!st.isFile()) continue;
    entries.push({
      id: parsed.data,
      filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
  }

  // Sort newest-first; tie-break descending by ID for deterministic ordering
  entries.sort((a, b) => (b.mtimeMs !== a.mtimeMs ? b.mtimeMs - a.mtimeMs : b.id.localeCompare(a.id)));

  const keptIds: string[] = [];
  const deletedIds: string[] = [];
  const skippedProtectedIds: string[] = [];
  let reclaimedBytes = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (i < options.keepLast) {
      keptIds.push(entry.id);
      continue;
    }
    if (protectedSet.has(entry.id)) {
      skippedProtectedIds.push(entry.id);
      continue;
    }
    await unlink(entry.filePath);
    deletedIds.push(entry.id);
    reclaimedBytes += entry.size;
  }

  return {
    keptIds,
    deletedIds,
    skippedProtectedIds,
    reclaimedBytes,
  };
}

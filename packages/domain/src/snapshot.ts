import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SNAPSHOT_FORMAT_VERSION = 1;
export const RESTIC_VERSION = '0.19.1';
export const CONSISTENCY_METHOD = 'agent-stopped-session-exported';
/** Named directory entries omitted from both the content receipt and the checkpoint. */
export const WORKSPACE_EXCLUSIONS = ['node_modules', '.cache'] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fileReceiptSchema = z.strictObject({
  path: z.string().min(1),
  executable: z.boolean(),
  sha256,
});

export const snapshotManifestSchema = z.strictObject({
  formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  workspaceId: z.uuid(),
  architecture: z.string().min(1),
  platform: z.string().min(1),
  agentVersion: z.string().min(1),
  runtimeDigest: sha256,
  snapshotId: sha256,
  consistency: z.string().min(1),
  resticVersion: z.string().min(1),
  files: z.array(fileReceiptSchema),
  session: z.strictObject({ id: z.string().min(1), sha256 }),
  archivePath: z.string().min(1),
  exclusions: z.array(z.string()),
});

export type SnapshotManifestData = z.infer<typeof snapshotManifestSchema>;
export type SnapshotFailure = 'CORRUPTED' | 'TAMPERED' | 'WRONG_VERSION' | 'INCOMPLETE';

export interface SnapshotHost {
  architecture: string;
  platform: string;
  agentVersion: string;
  runtimeDigest: string;
  workspaceId: string;
}

export class SnapshotError extends Error {
  readonly code: SnapshotFailure;
  constructor(code: SnapshotFailure, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

/** Versioned checkpoint contract. The session text stays in the encrypted snapshot, not here. */
export class SnapshotManifest {
  static parse(value: unknown): SnapshotManifestData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SnapshotError('INCOMPLETE', 'Snapshot manifest is incomplete');
    }
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, 'formatVersion')) throw new SnapshotError('INCOMPLETE', 'Snapshot manifest is incomplete');
    if (record.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot format version ${String(record.formatVersion)} is not supported (expected ${SNAPSHOT_FORMAT_VERSION})`);
    }
    const parsed = snapshotManifestSchema.safeParse(value);
    if (!parsed.success) throw new SnapshotError('INCOMPLETE', 'Snapshot manifest is incomplete');
    return parsed.data;
  }

  static create(input: Omit<SnapshotManifestData, 'formatVersion' | 'consistency' | 'resticVersion' | 'exclusions'>): SnapshotManifestData {
    if (!input.archivePath.startsWith('/') || input.archivePath.includes(':') || input.archivePath.includes('\n')) {
      throw new Error('Snapshot archive path is invalid');
    }
    return snapshotManifestSchema.parse({
      ...input,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      consistency: CONSISTENCY_METHOD,
      resticVersion: RESTIC_VERSION,
      exclusions: [...WORKSPACE_EXCLUSIONS],
    });
  }

  static assertCompatible(manifest: SnapshotManifestData, host: SnapshotHost): void {
    if (manifest.agentVersion !== host.agentVersion) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot agent version ${manifest.agentVersion} does not match pinned OpenCode ${host.agentVersion}`);
    }
    if (manifest.resticVersion !== RESTIC_VERSION) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot restic version ${manifest.resticVersion} does not match pinned restic ${RESTIC_VERSION}`);
    }
    if (manifest.consistency !== CONSISTENCY_METHOD) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot consistency method ${manifest.consistency} is not supported`);
    }
    if (manifest.runtimeDigest !== host.runtimeDigest) {
      throw new SnapshotError('WRONG_VERSION', 'Snapshot runtime digest does not match this host');
    }
    if (manifest.architecture !== host.architecture) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot architecture ${manifest.architecture} does not match host architecture ${host.architecture}`);
    }
    if (manifest.platform !== host.platform) {
      throw new SnapshotError('WRONG_VERSION', `Snapshot platform ${manifest.platform} does not match host platform ${host.platform}`);
    }
    if (manifest.workspaceId !== host.workspaceId) {
      throw new SnapshotError('WRONG_VERSION', 'Snapshot workspace id does not match the requested workspace');
    }
    if (manifest.exclusions.length !== WORKSPACE_EXCLUSIONS.length || manifest.exclusions.some((name, index) => name !== WORKSPACE_EXCLUSIONS[index])) {
      throw new SnapshotError('WRONG_VERSION', 'Snapshot exclusions do not match the supported checkpoint');
    }
  }
}

/** Local runtime fingerprint. This milestone does not build a container image. */
export class SnapshotIdentity {
  static runtimeDigest(nodeVersion: string, agentVersion: string, resticVersion: string = RESTIC_VERSION): string {
    return createHash('sha256').update(`node=${nodeVersion}\nagent=${agentVersion}\nrestic=${resticVersion}\n`).digest('hex');
  }

  static current(agentVersion: string, workspaceId: string): SnapshotHost {
    return {
      architecture: process.arch,
      platform: process.platform,
      agentVersion,
      runtimeDigest: SnapshotIdentity.runtimeDigest(process.version, agentVersion),
      workspaceId,
    };
  }
}

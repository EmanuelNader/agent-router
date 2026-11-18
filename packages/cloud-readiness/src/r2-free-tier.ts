import { z } from 'zod';

export const r2FreeTierSnapshotSchema = z.object({
  observedAt: z.iso.datetime(),
  storageClass: z.enum(['STANDARD', 'INFREQUENT_ACCESS']),
  storedGbMonth: z.number().nonnegative(),
  monthlyClassAOps: z.number().int().nonnegative(),
  monthlyClassBOps: z.number().int().nonnegative(),
  publicDevelopmentUrlEnabled: z.boolean().default(false),
});
export type R2FreeTierSnapshot = z.input<typeof r2FreeTierSnapshotSchema>;

export interface EvaluateR2FreeTierOptions {
  maxStoredGbMonth?: number;
  maxClassAOps?: number;
  maxClassBOps?: number;
  now?: Date;
}

export interface R2FreeTierEvaluation {
  status: 'GUARDED_FREE_ELIGIBLE' | 'BLOCKED';
  blockers: string[];
  remainingStorageBufferGb: number;
  remainingClassABuffer: number;
  remainingClassBBuffer: number;
}

/**
 * Guardrails for Cloudflare R2 2026 Free Tier encrypted snapshot storage:
 * - Standard storage free tier: 10 GB-month, 1,000,000 Class A ops/mo, 10,000,000 Class B ops/mo, $0 egress
 * - Infrequent Access (IA) has ZERO free tier ($9/M Class A, $0.90/M Class B) and must be blocked
 * - Public r2.dev URLs expose buckets to unauthenticated Class B request spikes and must be disabled
 * - Enforces 85% safety buffers (8.5 GB, 850k Class A, 8.5M Class B) since R2 has no hard spend cap.
 */
export function evaluateR2FreeTierGuardrails(
  snapshotInput: R2FreeTierSnapshot,
  options: EvaluateR2FreeTierOptions = {},
): R2FreeTierEvaluation {
  const snapshot = r2FreeTierSnapshotSchema.parse(snapshotInput);
  const now = options.now ?? new Date();
  const maxStoredGbMonth = options.maxStoredGbMonth ?? 8.5;
  const maxClassAOps = options.maxClassAOps ?? 850_000;
  const maxClassBOps = options.maxClassBOps ?? 8_500_000;

  const blockers: string[] = [];
  const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
  if (ageMs > 15 * 60_000) blockers.push('STALE_R2_EVIDENCE');
  if (ageMs < 0) blockers.push('FUTURE_R2_EVIDENCE');

  if (snapshot.storageClass !== 'STANDARD') {
    blockers.push('NON_FREE_R2_STORAGE_CLASS');
  }
  if (snapshot.storedGbMonth > maxStoredGbMonth) {
    blockers.push('NEAR_OR_OVER_10GB_R2_CAP');
  }
  if (snapshot.monthlyClassAOps > maxClassAOps) {
    blockers.push('NEAR_OR_OVER_1M_CLASS_A_CAP');
  }
  if (snapshot.monthlyClassBOps > maxClassBOps) {
    blockers.push('NEAR_OR_OVER_10M_CLASS_B_CAP');
  }
  if (snapshot.publicDevelopmentUrlEnabled) {
    blockers.push('PUBLIC_R2_BUCKET_EXPOSED');
  }

  return {
    status: blockers.length === 0 ? 'GUARDED_FREE_ELIGIBLE' : 'BLOCKED',
    blockers,
    remainingStorageBufferGb: Number(Math.max(0, maxStoredGbMonth - snapshot.storedGbMonth).toFixed(3)),
    remainingClassABuffer: Math.max(0, maxClassAOps - snapshot.monthlyClassAOps),
    remainingClassBBuffer: Math.max(0, maxClassBOps - snapshot.monthlyClassBOps),
  };
}

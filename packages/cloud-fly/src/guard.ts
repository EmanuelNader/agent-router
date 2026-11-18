import { z } from 'zod';

const nonnegative = z.number().finite().min(0);
export const flyEvidenceSchema = z.object({
  source: z.enum(['DEMO', 'READ_ONLY_INSPECTION']),
  observedAt: z.iso.datetime(),
  pricingObservedAt: z.iso.datetime(),
  billingEnabled: z.literal(true),
  capacityVerified: z.literal(true),
  imageVerified: z.literal(true),
  rootfsGb: nonnegative,
  maxRootfsGb: z.number().finite().positive().max(64),
  runningUsdPerSecond: z.number().finite().positive(),
  stoppedRootfsUsdPerGbMonth: z.number().finite().min(0.15),
  maxRunningSeconds: z.number().finite().int().positive(),
  horizonSeconds: z.number().finite().int().positive().max(2_592_000),
  ancillaryCostUpperBoundUsd: nonnegative,
  monthlyBudgetUsd: z.number().finite().positive(),
  alreadySpentUsd: nonnegative,
  memoryMb: z.number().int().min(256).max(2048),
  swapMb: z.literal(0),
  scheduleConfigured: z.literal(false),
  target: z.object({ appName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), machineId: z.string().regex(/^[a-f0-9]{8,32}$/), instanceId: z.string().min(1).max(128) }).optional(),
}).strict();

export interface FlyGuardResult {
  status: 'GUARDED_PAID_TARGET' | 'BLOCKED';
  reasons: string[];
  maximumAdditionalUsd?: number;
  liveProvisioningAllowed: false;
}

/** Synthetic local example, never evidence from a connected account. */
export function flyDemoEvidence(now = new Date()) {
  return {
    source: 'DEMO' as const, observedAt: now.toISOString(), pricingObservedAt: now.toISOString(),
    billingEnabled: true, capacityVerified: true, imageVerified: true,
    rootfsGb: 2, maxRootfsGb: 3, runningUsdPerSecond: 0.000002,
    stoppedRootfsUsdPerGbMonth: 0.15, maxRunningSeconds: 3600, horizonSeconds: 2_592_000,
    ancillaryCostUpperBoundUsd: 0.25, monthlyBudgetUsd: 10, alreadySpentUsd: 0.5,
    memoryMb: 512, swapMb: 0, scheduleConfigured: false,
  };
}

export function evaluateFlyGuardrails(input: unknown, now = new Date()): FlyGuardResult {
  const blocked = (reason: string): FlyGuardResult => ({ status: 'BLOCKED', reasons: [reason], liveProvisioningAllowed: false });
  const parsed = flyEvidenceSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(now.getTime())) return blocked('INVALID_OR_MISSING_EVIDENCE');
  const data = parsed.data;
  for (const timestamp of [data.observedAt, data.pricingObservedAt]) {
    const age = now.getTime() - Date.parse(timestamp);
    if (age < 0 || age > 900_000) return blocked('STALE_OR_FUTURE_EVIDENCE');
  }
  if (data.rootfsGb > data.maxRootfsGb) return blocked('ROOTFS_LIMIT_EXCEEDED');
  if (data.maxRunningSeconds > data.horizonSeconds) return blocked('INVALID_RUNNING_BOUND');
  // No crash-proof stop deadline is enforced by the provider. Reserve compute
  // for the entire horizon, regardless of a caller's shorter runtime estimate.
  // Reserve maximum rootfs separately for the whole horizon as well.
  const maximumAdditionalUsd = data.maxRootfsGb * data.stoppedRootfsUsdPerGbMonth * data.horizonSeconds / 2_592_000
    + data.horizonSeconds * data.runningUsdPerSecond + data.ancillaryCostUpperBoundUsd;
  if (!Number.isFinite(maximumAdditionalUsd) || !Number.isFinite(maximumAdditionalUsd + data.alreadySpentUsd)) return blocked('COST_OVERFLOW');
  if (maximumAdditionalUsd + data.alreadySpentUsd > data.monthlyBudgetUsd) return blocked('BUDGET_EXCEEDED');
  return { status: 'GUARDED_PAID_TARGET', maximumAdditionalUsd, reasons: ['PAID_ROOTFS_RESERVED', 'FULL_HORIZON_COMPUTE_AND_ANCILLARY_RESERVED'], liveProvisioningAllowed: false };
}

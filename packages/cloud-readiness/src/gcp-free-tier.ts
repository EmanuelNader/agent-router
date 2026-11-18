import { z } from 'zod';

const eligibleGcpRegions = new Set(['us-west1', 'us-central1', 'us-east1']);

export const gcpFreeTierSnapshotSchema = z.object({
  observedAt: z.iso.datetime(),
  region: z.string().min(1),
  machineType: z.string().min(1),
  provisioningModel: z.enum(['STANDARD', 'SPOT', 'PREEMPTIBLE']),
  bootDiskType: z.string().min(1),
  totalStandardDiskGb: z.number().nonnegative(),
  gpuCount: z.number().int().nonnegative(),
  monthlyNorthAmericaEgressGb: z.number().nonnegative(),
  allowPremiumOrChinaAustraliaEgress: z.boolean(),
  hasBudgetAlertUpTo5Usd: z.boolean(),
});
export type GcpFreeTierSnapshot = z.infer<typeof gcpFreeTierSnapshotSchema>;

export interface EvaluateGcpFreeTierOptions {
  maxMonthlyEgressGb?: number;
  now?: Date;
}

export interface GcpFreeTierEvaluation {
  status: 'GUARDED_FREE_ELIGIBLE' | 'BLOCKED';
  blockers: string[];
  remainingEgressBufferGb: number;
}

/**
 * Guardrails for Google Cloud Compute Engine Always Free `e2-micro` instances:
 * - Only non-preemptible (`STANDARD`) `e2-micro` in `us-west1`, `us-central1`, or `us-east1`
 * - Only `pd-standard` boot disk (`<= 30 GB` combined); blocks paid `pd-balanced` / `pd-ssd`
 * - Zero GPUs/accelerators
 * - Enforces a safety buffer (`0.85 GB` default) below GCP's `1 GB/mo` North America egress cap
 *   and blocks China/Australia/Premium-tier egress or missing <= $5 billing alerts.
 */
export function evaluateGcpAlwaysFreeGuardrails(
  snapshotInput: GcpFreeTierSnapshot,
  options: EvaluateGcpFreeTierOptions = {},
): GcpFreeTierEvaluation {
  const snapshot = gcpFreeTierSnapshotSchema.parse(snapshotInput);
  const now = options.now ?? new Date();
  const maxMonthlyEgressGb = options.maxMonthlyEgressGb ?? 0.85;

  const blockers: string[] = [];
  const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
  if (ageMs > 15 * 60_000) blockers.push('STALE_GCP_EVIDENCE');
  if (ageMs < 0) blockers.push('FUTURE_GCP_EVIDENCE');

  if (!eligibleGcpRegions.has(snapshot.region)) {
    blockers.push('INELIGIBLE_GCP_FREE_REGION');
  }
  if (snapshot.machineType !== 'e2-micro') {
    blockers.push('PAID_GCP_MACHINE_TYPE');
  }
  if (snapshot.provisioningModel !== 'STANDARD') {
    blockers.push('INELIGIBLE_PROVISIONING_MODEL');
  }
  if (snapshot.bootDiskType !== 'pd-standard') {
    blockers.push('PAID_GCP_DISK_TYPE');
  }
  if (snapshot.totalStandardDiskGb > 30) {
    blockers.push('EXCEEDS_30GB_STANDARD_DISK_CAP');
  }
  if (snapshot.gpuCount > 0) {
    blockers.push('PAID_ACCELERATOR_ATTACHED');
  }
  if (snapshot.monthlyNorthAmericaEgressGb > maxMonthlyEgressGb) {
    blockers.push('NEAR_OR_OVER_1GB_EGRESS_CAP');
  }
  if (snapshot.allowPremiumOrChinaAustraliaEgress) {
    blockers.push('PAID_EGRESS_DESTINATION_OR_TIER');
  }
  if (!snapshot.hasBudgetAlertUpTo5Usd) {
    blockers.push('MISSING_GCP_BUDGET_ALERT');
  }

  const remainingEgressBufferGb = Number(
    Math.max(0, maxMonthlyEgressGb - snapshot.monthlyNorthAmericaEgressGb).toFixed(3),
  );

  return {
    status: blockers.length === 0 ? 'GUARDED_FREE_ELIGIBLE' : 'BLOCKED',
    blockers,
    remainingEgressBufferGb,
  };
}

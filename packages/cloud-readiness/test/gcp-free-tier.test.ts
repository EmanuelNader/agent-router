import { expect, test } from 'vitest';
import { evaluateGcpAlwaysFreeGuardrails } from '../src/gcp-free-tier.js';

const fixedNow = new Date('2026-11-18T00:00:00.000Z');

test('approves compliant GCP e2-micro in us-west1 with pd-standard <= 30 GB and < 0.85 GB egress', () => {
  const res = evaluateGcpAlwaysFreeGuardrails(
    {
      observedAt: '2026-11-17T23:55:00.000Z',
      region: 'us-west1',
      machineType: 'e2-micro',
      provisioningModel: 'STANDARD',
      bootDiskType: 'pd-standard',
      totalStandardDiskGb: 30,
      gpuCount: 0,
      monthlyNorthAmericaEgressGb: 0.35,
      allowPremiumOrChinaAustraliaEgress: false,
      hasBudgetAlertUpTo5Usd: true,
    },
    { now: fixedNow },
  );

  expect(res).toEqual({
    status: 'GUARDED_FREE_ELIGIBLE',
    blockers: [],
    remainingEgressBufferGb: 0.5,
  });
});

test('blocks GCP bill traps: pd-balanced disk, non-eligible region, >0.85 GB egress, and stale evidence', () => {
  const traps = evaluateGcpAlwaysFreeGuardrails(
    {
      observedAt: '2026-11-17T23:55:00.000Z',
      region: 'us-east4',
      machineType: 'e2-micro',
      provisioningModel: 'STANDARD',
      bootDiskType: 'pd-balanced',
      totalStandardDiskGb: 40,
      gpuCount: 0,
      monthlyNorthAmericaEgressGb: 0.92,
      allowPremiumOrChinaAustraliaEgress: true,
      hasBudgetAlertUpTo5Usd: false,
    },
    { now: fixedNow },
  );

  expect(traps.status).toBe('BLOCKED');
  expect(traps.blockers).toEqual([
    'INELIGIBLE_GCP_FREE_REGION',
    'PAID_GCP_DISK_TYPE',
    'EXCEEDS_30GB_STANDARD_DISK_CAP',
    'NEAR_OR_OVER_1GB_EGRESS_CAP',
    'PAID_EGRESS_DESTINATION_OR_TIER',
    'MISSING_GCP_BUDGET_ALERT',
  ]);
});

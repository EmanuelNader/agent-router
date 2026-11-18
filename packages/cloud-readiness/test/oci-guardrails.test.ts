import { expect, test } from 'vitest';
import {
  evaluateBudgetAlerts,
  evaluateOciPaygGuardrails,
  evaluateQuotaStatements,
  inspectOciGuardrails,
  type OciGuardrailReader,
} from '../src/oci-guardrails.js';
import type { OciInspection } from '../src/oci-report.js';

const now = new Date('2026-11-17T22:00:00.000Z');
const known = (limit: number, used: number, available: number) => ({
  status: 'KNOWN' as const,
  limit,
  used,
  available,
});

function baseInspection(): OciInspection {
  return {
    schemaVersion: 1,
    source: 'DEMO',
    observedAt: now.toISOString(),
    homeRegion: 'us-example-1',
    region: 'us-example-1',
    availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: known(4, 0, 4),
      a1RegionalMemoryGb: known(24, 0, 24),
      a1AdOcpus: known(4, 0, 4),
      a1AdMemoryGb: known(24, 0, 24),
      microInstances: known(2, 0, 2),
      freeStorageGb: known(200, 50, 150),
    },
    issues: [],
  };
}

const safeStatements = [
  'Zero compute-core quotas in compartment agent-router-workers',
  'Set compute-core quota standard-a1-core-count to 2 in compartment agent-router-workers',
  'Set compute-core quota standard-a1-memory-count to 12 in compartment agent-router-workers',
  'Set block-storage quota total-storage-gb to 200 in compartment agent-router-workers',
];

test('accepts ordered Always-Free compartment quota caps and rejects missing or over-permissive rules', () => {
  expect(evaluateQuotaStatements(safeStatements, 'agent-router-workers')).toEqual({
    status: 'VERIFIED',
    zeroedOtherComputeShapes: true,
    maxA1Ocpus: 2,
    maxA1MemoryGb: 12,
    maxStorageGb: 200,
  });

  // Missing initial "zero compute-core quotas" leaves paid shapes uncapped.
  expect(evaluateQuotaStatements(safeStatements.slice(1), 'agent-router-workers')).toEqual({
    status: 'BLOCKED',
    reason: 'MISSING_COMPARTMENT_QUOTA',
  });

  // Exceeding 4 OCPUs or 200 GB free ceiling is unsafe for $0 PAYG operation.
  expect(
    evaluateQuotaStatements(
      [
        ...safeStatements.slice(0, 1),
        'Set compute-core quota standard-a1-core-count to 8 in compartment agent-router-workers',
        ...safeStatements.slice(2),
      ],
      'agent-router-workers',
    ),
  ).toEqual({
    status: 'BLOCKED',
    reason: 'UNSAFE_COMPARTMENT_QUOTA',
  });

  // Zeroing after setting A1 wipes out A1 or ordering is broken.
  expect(
    evaluateQuotaStatements([...safeStatements.slice(1), safeStatements[0]!], 'agent-router-workers'),
  ).toEqual({
    status: 'BLOCKED',
    reason: 'MISSING_COMPARTMENT_QUOTA',
  });
});

test('verifies active monthly budget tripwires (<= $5) without exposing email recipients', () => {
  expect(
    evaluateBudgetAlerts([
      {
        lifecycleState: 'ACTIVE',
        resetPeriod: 'MONTHLY',
        amount: 10,
        coversTarget: true,
        alerts: [
          {
            lifecycleState: 'ACTIVE',
            type: 'ACTUAL',
            thresholdType: 'PERCENTAGE',
            threshold: 10, // 10% of $10 = $1.00 tripwire
            hasRecipients: true,
          },
        ],
      },
    ]),
  ).toEqual({ status: 'VERIFIED', lowestTripwireAmount: 1 });

  // $50 tripwire is too high to protect a $0 free-only user.
  expect(
    evaluateBudgetAlerts([
      {
        lifecycleState: 'ACTIVE',
        resetPeriod: 'MONTHLY',
        amount: 100,
        coversTarget: true,
        alerts: [
          {
            lifecycleState: 'ACTIVE',
            type: 'ACTUAL',
            thresholdType: 'ABSOLUTE',
            threshold: 50,
            hasRecipients: true,
          },
        ],
      },
    ]),
  ).toEqual({ status: 'BLOCKED', reason: 'MISSING_BUDGET_ALERT' });
});

test('inspectOciGuardrails scrubs upstream errors/identities and evaluateOciPaygGuardrails enforces caps', async () => {
  const reader: OciGuardrailReader = {
    quotaStatements: async () => safeStatements,
    budgets: async () => [
      {
        lifecycleState: 'ACTIVE',
        resetPeriod: 'MONTHLY',
        amount: 5,
        coversTarget: true,
        alerts: [
          {
            lifecycleState: 'ACTIVE',
            type: 'FORECAST',
            thresholdType: 'ABSOLUTE',
            threshold: 1,
            hasRecipients: true,
          },
        ],
      },
    ],
  };

  const guardrails = await inspectOciGuardrails(reader, 'agent-router-workers', now);
  const fitting = evaluateOciPaygGuardrails(
    baseInspection(),
    guardrails,
    { ocpus: 2, memoryGb: 12, bootGb: 50, additionalInstances: 1 },
    now,
  );
  expect(fitting.status).toBe('GUARDED_QUOTA_FITS');
  expect(fitting.provisioningAllowed).toBe(false);

  // Requesting 2 instances of 2 OCPUs = 4 OCPUs fits tenancy limit (4), MUST be blocked by compartment cap (2)!
  const exceedsCompartmentCap = evaluateOciPaygGuardrails(
    baseInspection(),
    guardrails,
    { ocpus: 2, memoryGb: 6, bootGb: 50, additionalInstances: 2 },
    now,
  );
  expect(exceedsCompartmentCap.status).toBe('BLOCKED');
  expect(exceedsCompartmentCap.blockers).toContain('EXCEEDS_COMPARTMENT_A1_OCPU_CAP');

  // Reader failure omits sensitive upstream error text and fails closed.
  const failingGuardrails = await inspectOciGuardrails(
    {
      quotaStatements: async () => {
        throw new Error('ocid1.tenancy.oc1..secret-leak');
      },
      budgets: reader.budgets,
    },
    'agent-router-workers',
    now,
  );
  expect(JSON.stringify(failingGuardrails)).not.toContain('secret-leak');
  const blocked = evaluateOciPaygGuardrails(
    baseInspection(),
    failingGuardrails,
    { ocpus: 1, memoryGb: 4, bootGb: 50, additionalInstances: 1 },
    now,
  );
  expect(blocked.status).toBe('BLOCKED');
  expect(blocked.blockers).toContain('QUOTA_INSPECTION_FAILED');
});

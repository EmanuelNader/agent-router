import { expect, test } from 'vitest';
import { evaluateCodespacesAllowance } from '../src/codespaces-allowance.js';
import { parseGitHubCodespacesBillingUsage } from '../src/github-billing-api.js';

const fixedNow = new Date('2026-11-18T00:00:00.000Z');

test('parses GitHub 2026 Billing Usage Summary SKUs into Codespaces core-hours and storage without leaking repo names', () => {
  const rawPayload = {
    usageItems: [
      {
        product: 'codespaces',
        sku: 'codespaces_compute_d4',
        unitType: 'hours',
        grossQuantity: 25,
        repositoryName: 'private-org/secret-repo-alpha',
      },
      {
        product: 'codespaces',
        sku: 'codespaces_compute_d2',
        unitType: 'minutes',
        grossQuantity: 360,
        repositoryName: 'private-org/secret-repo-beta',
      },
      {
        product: 'codespaces',
        sku: 'codespaces_storage',
        unitType: 'gigabyte-hours',
        grossQuantity: 7200,
      },
      {
        product: 'codespaces',
        sku: 'codespaces_prebuild_storage',
        unitType: 'gb-month',
        quantity: 4.1,
      },
      {
        product: 'copilot',
        sku: 'coding_agent_ai_credit',
        unitType: 'credits',
        grossQuantity: 500,
      },
    ],
  };

  const snapshot = parseGitHubCodespacesBillingUsage(rawPayload, {
    observedAt: '2026-11-17T23:58:00.000Z',
    activeMachineCores: 4,
  });

  // 25h * 4 cores = 100 core-hrs; 360m (6h) * 2 cores = 12 core-hrs => 112 core-hrs
  // 7200 GB-hours / 720 = 10 GB-month + 4.1 GB-month = 14.1 GB-month
  expect(snapshot).toEqual({
    observedAt: '2026-11-17T23:58:00.000Z',
    usedCoreHours: 112,
    usedStorageGbMonth: 14.1,
    activeMachineCores: 4,
    includedCoreHours: 120,
    includedStorageGbMonth: 15,
  });
  expect(JSON.stringify(snapshot)).not.toContain('secret-repo');

  const evaluation = evaluateCodespacesAllowance(snapshot, { now: fixedNow });
  expect(evaluation.decision).toBe('MIGRATE_NOW');
  expect(evaluation.reasons).toEqual(['LOW_CODESPACES_CORE_HOURS', 'HIGH_CODESPACES_STORAGE_USAGE']);

  // Also verify d8, d16, d32 SKUs, PascalCase GigabyteHours, and Math.max(grossQuantity, quantity)
  const highCoreSnapshot = parseGitHubCodespacesBillingUsage(
    {
      usageItems: [
        { product: 'codespaces', sku: 'codespaces_compute_d8', unitType: 'hours', grossQuantity: 1 },
        { product: 'codespaces', sku: 'codespaces_compute_d16', unitType: 'hours', grossQuantity: 0, quantity: 0.5 },
        { product: 'codespaces', sku: 'codespaces_compute_d32', unitType: 'minutes', grossQuantity: 30 },
        { product: 'codespaces', sku: 'codespaces_storage', unitType: 'GigabyteHours', grossQuantity: 720 },
      ],
    },
    { observedAt: '2026-11-17T23:58:00.000Z', activeMachineCores: 8 },
  );
  // 1*8 + 0.5*16 + 0.5*32 = 8 + 8 + 16 = 32 core-hours; 720 / 720 = 1 GB-month
  expect(highCoreSnapshot.usedCoreHours).toBe(32);
  expect(highCoreSnapshot.usedStorageGbMonth).toBe(1);
});

test('fails closed on unrecognized Codespaces SKU or unknown unitType so billable usage is never under-counted', () => {
  expect(() =>
    parseGitHubCodespacesBillingUsage(
      {
        usageItems: [
          {
            product: 'codespaces',
            sku: 'codespaces_gpu_h100',
            unitType: 'hours',
            grossQuantity: 2,
          },
        ],
      },
      { observedAt: '2026-11-17T23:58:00.000Z', activeMachineCores: 2 },
    ),
  ).toThrow(/Unrecognized Codespaces billing SKU/i);

  expect(() =>
    parseGitHubCodespacesBillingUsage(
      {
        usageItems: [
          {
            product: 'codespaces',
            sku: 'codespaces_compute_d2',
            unitType: 'credits',
            grossQuantity: 10,
          },
        ],
      },
      { observedAt: '2026-11-17T23:58:00.000Z', activeMachineCores: 2 },
    ),
  ).toThrow(/Unsupported unitType/i);

  expect(() =>
    parseGitHubCodespacesBillingUsage(
      {
        usageItems: [
          {
            product: 'codespaces',
            sku: 'codespaces_storage',
            unitType: 'hours',
            grossQuantity: 10,
          },
        ],
      },
      { observedAt: '2026-11-17T23:58:00.000Z', activeMachineCores: 2 },
    ),
  ).toThrow(/Unsupported unitType/i);
});

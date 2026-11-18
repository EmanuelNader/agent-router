import { expect, test } from 'vitest';
import { evaluateCodespacesAllowance } from '../src/codespaces-allowance.js';

const fixedNow = new Date('2026-11-18T00:00:00.000Z');

test('tracks GitHub Codespaces 120 core-hours / 15 GB-month quota and triggers MIGRATE_NOW before exhaustion', () => {
  const healthy = evaluateCodespacesAllowance(
    {
      observedAt: '2026-11-17T23:58:00.000Z',
      usedCoreHours: 40,
      usedStorageGbMonth: 6.5,
      activeMachineCores: 2,
    },
    { now: fixedNow },
  );
  expect(healthy).toEqual({
    decision: 'HEALTHY',
    shouldMigrate: false,
    remainingCoreHours: 80,
    estimatedHoursLeftOnActiveMachine: 40,
    remainingStorageGbMonth: 8.5,
    reasons: [],
  });

  const lowHours = evaluateCodespacesAllowance(
    {
      observedAt: '2026-11-17T23:58:00.000Z',
      usedCoreHours: 112,
      usedStorageGbMonth: 14.0,
      activeMachineCores: 4,
    },
    { now: fixedNow },
  );
  expect(lowHours.decision).toBe('MIGRATE_NOW');
  expect(lowHours.shouldMigrate).toBe(true);
  expect(lowHours.estimatedHoursLeftOnActiveMachine).toBe(2);
  expect(lowHours.reasons).toEqual(['LOW_CODESPACES_CORE_HOURS', 'HIGH_CODESPACES_STORAGE_USAGE']);

  const stale = evaluateCodespacesAllowance(
    {
      observedAt: '2026-11-17T23:30:00.000Z',
      usedCoreHours: 10,
      usedStorageGbMonth: 2.0,
      activeMachineCores: 2,
    },
    { now: fixedNow },
  );
  expect(stale.decision).toBe('BLOCKED');
  expect(stale.shouldMigrate).toBe(false);
  expect(stale.reasons).toContain('STALE_CODESPACES_EVIDENCE');
});

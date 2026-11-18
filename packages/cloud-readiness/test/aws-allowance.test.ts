import { expect, test } from 'vitest';
import { evaluateAwsFreePlanAllowance } from '../src/aws-allowance.js';

const now = new Date('2026-11-18T00:00:00.000Z');

test('marks healthy AWS Free Plan when credits and expiration window exceed safety thresholds', () => {
  const result = evaluateAwsFreePlanAllowance(
    {
      observedAt: '2026-11-17T23:55:00.000Z',
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      remainingCreditAmount: 84.5,
      creditCurrency: 'USD',
      expiresAt: '2027-03-01T00:00:00.000Z',
    },
    { minCreditFloorUsd: 5, minDaysRemaining: 7, now },
  );

  expect(result).toEqual({
    decision: 'HEALTHY',
    shouldMigrate: false,
    remainingCreditUsd: 84.5,
    daysRemaining: 103,
    reasons: [],
  });
});

test('triggers proactive MIGRATE_NOW before AWS suspends a low-credit or expiring Free Plan', () => {
  const lowCredit = evaluateAwsFreePlanAllowance(
    {
      observedAt: '2026-11-17T23:58:00.000Z',
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      remainingCreditAmount: 4.25,
      creditCurrency: 'USD',
      expiresAt: '2027-02-01T00:00:00.000Z',
    },
    { minCreditFloorUsd: 5, minDaysRemaining: 7, now },
  );
  expect(lowCredit.decision).toBe('MIGRATE_NOW');
  expect(lowCredit.shouldMigrate).toBe(true);
  expect(lowCredit.reasons).toContain('LOW_REMAINING_CREDITS');

  const expiringSoon = evaluateAwsFreePlanAllowance(
    {
      observedAt: '2026-11-17T23:58:00.000Z',
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      remainingCreditAmount: 60,
      creditCurrency: 'USD',
      expiresAt: '2026-11-22T00:00:00.000Z',
    },
    { minCreditFloorUsd: 5, minDaysRemaining: 7, now },
  );
  expect(expiringSoon.decision).toBe('MIGRATE_NOW');
  expect(expiringSoon.reasons).toContain('EXPIRING_SOON');
});

test('fails closed on stale or incomplete AWS Free Plan telemetry', () => {
  const stale = evaluateAwsFreePlanAllowance(
    {
      observedAt: '2026-11-17T23:30:00.000Z',
      accountPlanType: 'FREE',
      accountPlanStatus: 'ACTIVE',
      remainingCreditAmount: 90,
      creditCurrency: 'USD',
      expiresAt: '2027-03-01T00:00:00.000Z',
    },
    { now },
  );
  expect(stale.decision).toBe('BLOCKED');
  expect(stale.reasons).toContain('STALE_AWS_EVIDENCE');
});

import { expect, test } from 'vitest';
import { evaluateAwsFreePlanAllowance } from '../src/aws-allowance.js';

const now = new Date('2026-11-18T10:00:00Z');
const snapshot = { observedAt: now.toISOString(), accountPlanType: 'FREE' as const, accountPlanStatus: 'ACTIVE' as const,
  remainingCreditAmount: 100, creditCurrency: 'USD', expiresAt: '2027-01-01T00:00:00Z' };
test.each(['minCreditFloorUsd', 'minDaysRemaining'].flatMap(field => [NaN, Infinity, -Infinity, -1].map((value, variant) => ({ field, value, variant }))))('guard-fuzz blocks AWS option $field variant $variant', ({ field, value }) => {
  expect(evaluateAwsFreePlanAllowance(snapshot, { now, [field]: value }).decision).toBe('BLOCKED');
});
test('guard-fuzz blocks an invalid AWS evaluation clock', () => {
  expect(evaluateAwsFreePlanAllowance(snapshot, { now: new Date(NaN) }).decision).toBe('BLOCKED');
});

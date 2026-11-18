import { expect, test } from 'vitest';
import { evaluateFlyGuardrails, flyDemoEvidence } from '../src/guard.js';

const now = new Date('2026-11-18T10:00:00Z');
const numericFields = ['rootfsGb', 'maxRootfsGb', 'runningUsdPerSecond', 'stoppedRootfsUsdPerGbMonth', 'maxRunningSeconds', 'horizonSeconds', 'ancillaryCostUpperBoundUsd', 'monthlyBudgetUsd', 'alreadySpentUsd', 'memoryMb', 'swapMb'];
const values = [NaN, Infinity, -Infinity, undefined];
test.each(numericFields.flatMap(field => values.map((value, i) => ({ field, value, variant: i }))))('guard-fuzz blocks $field nonfinite/missing variant $variant', ({ field, value }) => {
  expect(evaluateFlyGuardrails({ ...flyDemoEvidence(now), [field]: value }, now).status).toBe('BLOCKED');
});
const dates = ['', 'invalid', '2026-11-18T10:00:00.001Z', '2026-11-18T09:44:59.999Z', '9999-01-01T00:00:00Z', undefined];
test.each(['observedAt', 'pricingObservedAt'].flatMap(field => dates.map((value, i) => ({ field, value, variant: i }))))('guard-fuzz blocks $field clock/missing variant $variant', ({ field, value }) => {
  expect(evaluateFlyGuardrails({ ...flyDemoEvidence(now), [field]: value }, now).status).toBe('BLOCKED');
});

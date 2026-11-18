import { expect, test } from 'vitest';
import { evaluateFlyGuardrails, flyDemoEvidence } from '../src/guard.js';

const now = new Date('2026-11-18T10:00:00Z');
const valid = {
  source: 'DEMO',
  observedAt: now.toISOString(), pricingObservedAt: now.toISOString(), billingEnabled: true,
  capacityVerified: true, imageVerified: true, rootfsGb: 2, maxRootfsGb: 3,
  runningUsdPerSecond: 0.000002, stoppedRootfsUsdPerGbMonth: 0.15,
  maxRunningSeconds: 3600, horizonSeconds: 2_592_000, ancillaryCostUpperBoundUsd: 0.25,
  monthlyBudgetUsd: 10, alreadySpentUsd: 0.5, memoryMb: 512, swapMb: 0, scheduleConfigured: false,
};

test('counts paid stopped rootfs and running compute inside an explicit budget', () => {
  const result = evaluateFlyGuardrails(valid, now);
  expect(result.status).toBe('GUARDED_PAID_TARGET');
  expect(result.maximumAdditionalUsd).toBeCloseTo(5.884);
  expect(result.liveProvisioningAllowed).toBe(false);
});

test.each([
  { rootfsGb: NaN }, { rootfsGb: Infinity }, { runningUsdPerSecond: NaN },
  { ancillaryCostUpperBoundUsd: undefined }, { billingEnabled: false },
  { capacityVerified: false }, { imageVerified: false }, { rootfsGb: 4 },
  { stoppedRootfsUsdPerGbMonth: 0 }, { monthlyBudgetUsd: 0.1 }, { maxRunningSeconds: Infinity },
  { observedAt: '2026-11-18T10:00:01Z' }, { observedAt: '2026-11-17T10:00:00Z' },
  { pricingObservedAt: '2026-11-17T10:00:00Z' }, { memoryMb: 4096 }, { swapMb: 512 },
  { scheduleConfigured: true }, { maxRunningSeconds: 2_592_001 },
])('blocks unknown, stale, or unsafe evidence: %j', patch => {
  expect(evaluateFlyGuardrails({ ...valid, ...patch }, now).status).toBe('BLOCKED');
});

test('blocks an invalid clock', () => {
  expect(evaluateFlyGuardrails(valid, new Date(NaN)).status).toBe('BLOCKED');
});

test('does not trust a declared runtime limit without external enforcement', () => {
  const now = new Date();
  const evidence = flyDemoEvidence(now);
  evidence.maxRunningSeconds = 1;
  evidence.monthlyBudgetUsd = 2;
  expect(evaluateFlyGuardrails(evidence, now).status).toBe('BLOCKED');
  evidence.maxRunningSeconds = 0;
  evidence.monthlyBudgetUsd = 10;
  expect(evaluateFlyGuardrails(evidence, now).status).toBe('BLOCKED');
});

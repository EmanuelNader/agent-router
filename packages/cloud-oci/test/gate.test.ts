import { expect, test } from 'vitest';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { OciFreeTierGate } from '../src/gate.js';

const now = new Date('2026-11-13T12:00:00Z');
const known = (limit: number, used: number, available: number) => ({ status: 'KNOWN' as const, limit, used, available });
function report(source: OciInspection['source'] = 'OCI_API'): OciInspection {
  return {
    schemaVersion: 1, source, observedAt: now.toISOString(),
    homeRegion: 'us-example-1', region: 'us-example-1', availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: known(2, 0, 2), a1RegionalMemoryGb: known(12, 0, 12),
      a1AdOcpus: known(2, 0, 2), a1AdMemoryGb: known(12, 0, 12),
      microInstances: known(2, 1, 1), freeStorageGb: known(200, 100, 100),
    }, issues: [],
  };
}
const free = {
  schemaVersion: 1 as const, evidence: 'RECORDED' as const, accountClass: 'ALWAYS_FREE' as const,
  monthlyUsage: 'WITHIN_ALLOTMENT' as const, imageCharge: 'NONE' as const, networkCharge: 'NONE' as const,
  storageCharge: 'NONE' as const, capacity: 'AVAILABLE' as const, compartmentQuota: 'FITS' as const,
};

test('a fresh Always Free report can authorize one A1 host', () => {
  const result = OciFreeTierGate.evaluate({ report: report(), eligibility: free, mode: 'LIVE', now });
  expect(result.provisioningAllowed).toBe(true);
  expect(result.profile).toMatchObject({ shape: 'VM.Standard.A1.Flex', ocpus: 1, memoryGb: 4, bootGb: 50 });
});

test('Pay As You Go is allowed only when monthly usage is inside the allotment', () => {
  expect(OciFreeTierGate.evaluate({
    report: report(), eligibility: { ...free, accountClass: 'PAYG' }, mode: 'LIVE', now,
  }).provisioningAllowed).toBe(true);
  expect(OciFreeTierGate.evaluate({
    report: report(), eligibility: { ...free, accountClass: 'PAYG', monthlyUsage: 'UNKNOWN' }, mode: 'LIVE', now,
  }).blockers).toContain('UNCERTAIN_USAGE');
});

test('trial accounts, known charges, and unknown eligibility are refused', () => {
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, accountClass: 'TRIAL' }, mode: 'LIVE', now }).blockers).toContain('TRIAL_NOT_FREE_ONLY');
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, imageCharge: 'KNOWN_CHARGE' }, mode: 'LIVE', now }).blockers).toContain('KNOWN_IMAGE_CHARGE');
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, networkCharge: 'UNKNOWN' }, mode: 'LIVE', now }).blockers).toContain('UNCERTAIN_NETWORK_CHARGE');
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, storageCharge: 'KNOWN_CHARGE' }, mode: 'LIVE', now }).blockers).toContain('KNOWN_STORAGE_CHARGE');
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, capacity: 'UNKNOWN' }, mode: 'LIVE', now }).blockers).toContain('UNCERTAIN_CAPACITY');
  expect(OciFreeTierGate.evaluate({ report: report(), eligibility: { ...free, compartmentQuota: 'UNKNOWN' }, mode: 'DRY_RUN', now }).provisioningAllowed).toBe(false);
});

test('demo reports and fixture evidence cannot launch', () => {
  expect(OciFreeTierGate.evaluate({ report: report('DEMO'), eligibility: free, mode: 'LIVE', now }).blockers).toContain('DEMO_CANNOT_AUTHORIZE');
  expect(OciFreeTierGate.evaluate({
    report: report(), eligibility: { ...free, evidence: 'FIXTURE' }, mode: 'DRY_RUN', now,
  }).blockers).toContain('FIXTURE_CANNOT_AUTHORIZE');
  expect(OciFreeTierGate.evaluate({
    report: report('DEMO'), eligibility: { ...free, evidence: 'FIXTURE' }, mode: 'DRY_RUN', now,
  }).provisioningAllowed).toBe(true);
});

test('stale or insufficient quota still blocks a free attestation', () => {
  const stale = report(); stale.observedAt = '2026-11-13T11:00:00Z';
  expect(OciFreeTierGate.evaluate({ report: stale, eligibility: free, mode: 'LIVE', now }).blockers).toContain('STALE_EVIDENCE');
  const tight = report(); tight.metrics.freeStorageGb = known(200, 180, 20);
  expect(OciFreeTierGate.evaluate({ report: tight, eligibility: free, mode: 'LIVE', now }).blockers).toContain('INSUFFICIENT_freeStorageGb');
});

import { expect, test } from 'vitest';
import { previewOciDeployment } from '../src/oci-plan.js';
import type { OciInspection } from '../src/oci-report.js';

const now = new Date('2026-11-12T20:00:00Z');
const request = { ocpus: 1, memoryGb: 4, bootGb: 50, additionalInstances: 1 };
const known = (limit: number, used: number, available: number) => ({ status: 'KNOWN' as const, limit, used, available });
function report(): OciInspection {
  return {
    schemaVersion: 1, source: 'DEMO', observedAt: now.toISOString(),
    homeRegion: 'us-example-1', region: 'us-example-1', availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: known(2, 0, 2), a1RegionalMemoryGb: known(12, 0, 12),
      a1AdOcpus: known(2, 0, 2), a1AdMemoryGb: known(12, 0, 12),
      microInstances: known(2, 1, 1), freeStorageGb: known(200, 141, 59),
    }, issues: [],
  };
}

test('a fitting preview retains demo provenance and cannot authorize provisioning', () => {
  const result = previewOciDeployment(report(), request, now);
  expect(result.status).toBe('QUOTA_FITS');
  expect(result.source).toBe('DEMO');
  expect(result.provisioningAllowed).toBe(false);
  expect(result.candidate).toMatchObject({ shape: 'VM.Standard.A1.Flex', architecture: 'arm64', ocpus: 1 });
  expect(result.unverified).toContain('PHYSICAL_CAPACITY');
});

test('retained storage usage blocks another disk even when a micro slot is free', () => {
  const value = report(); value.metrics.freeStorageGb = known(200, 160, 40);
  expect(previewOciDeployment(value, request, now).blockers).toContain('INSUFFICIENT_freeStorageGb');
});

test('additional instances require simultaneous compute and disk headroom', () => {
  const result = previewOciDeployment(report(), { ...request, additionalInstances: 2 }, now);
  expect(result.status).toBe('BLOCKED');
  expect(result.checks.find(check => check.resource === 'freeStorageGb')?.required).toBe(100);
});

test('regional and AD limits are both enforced', () => {
  for (const key of ['a1RegionalOcpus', 'a1AdOcpus'] as const) {
    const value = report(); value.metrics[key] = known(2, 2, 0);
    expect(previewOciDeployment(value, request, now).blockers).toContain(`INSUFFICIENT_${key}`);
  }
});

test('unknown, stale, future, or non-home evidence cannot fit', () => {
  const unknown = report(); unknown.metrics.a1AdOcpus = { status: 'UNKNOWN', reason: 'REQUEST_FAILED' };
  expect(previewOciDeployment(unknown, request, now).status).toBe('BLOCKED');
  const stale = report(); stale.observedAt = '2026-11-12T19:44:59Z';
  expect(previewOciDeployment(stale, request, now).blockers).toContain('STALE_EVIDENCE');
  const future = report(); future.observedAt = '2026-11-12T20:01:00Z';
  expect(previewOciDeployment(future, request, now).blockers).toContain('FUTURE_EVIDENCE');
  const other = report(); other.region = 'us-other-1';
  expect(previewOciDeployment(other, request, now).blockers).toContain('REGION_NOT_HOME');
});

test('invalid report values and impossible or unsafe requests are rejected', () => {
  expect(() => previewOciDeployment(report(), { ...request, ocpus: 0 }, now)).toThrow();
  expect(() => previewOciDeployment(report(), { ...request, bootGb: 1 }, now)).toThrow();
  expect(() => previewOciDeployment(report(), { ...request, memoryGb: 65 }, now)).toThrow();
  const value = report(); value.metrics.freeStorageGb = known(200, 1, Number.NaN);
  expect(() => previewOciDeployment(value, request, now)).toThrow();
});

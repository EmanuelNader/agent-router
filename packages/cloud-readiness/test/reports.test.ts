import { expect, test } from 'vitest';
import { ociReadiness, awsReadiness } from '../src/reports.js';

test('OCI region access cannot authorize free provisioning or expose raw identity', () => {
  const raw = { regionName: 'us-phoenix-1', isHomeRegion: true, status: 'READY', accountId: 'private-account' };
  const report = ociReadiness([raw]);
  expect(report.homeRegion).toBe('us-phoenix-1');
  expect(report.provisioningAllowed).toBe(false);
  expect(report.freeComputeEligibility).toBe('UNKNOWN');
  expect(JSON.stringify(report)).not.toContain('private-account');
});

test('missing, unready, or ambiguous home regions stay unknown', () => {
  expect(ociReadiness([]).homeRegion).toBe('UNKNOWN');
  expect(ociReadiness([{ regionName: 'x', isHomeRegion: true, status: 'IN_PROGRESS' }]).homeRegion).toBe('UNKNOWN');
  expect(ociReadiness([
    { regionName: 'x', isHomeRegion: true, status: 'READY' },
    { regionName: 'y', isHomeRegion: true, status: 'READY' },
  ]).homeRegion).toBe('UNKNOWN');
});

test('AWS plan discovery alone cannot authorize provisioning', () => {
  const raw = { accountId: 'private-account', accountPlanType: 'FREE' as const, accountPlanStatus: 'ACTIVE' as const };
  const report = awsReadiness(raw);
  expect(report.accountPlanType).toBe('FREE');
  expect(report.provisioningAllowed).toBe(false);
  expect(report.freeComputeEligibility).toBe('UNKNOWN');
  expect(JSON.stringify(report)).not.toContain('private-account');
});

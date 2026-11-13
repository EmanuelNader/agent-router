import { expect, test } from 'vitest';
import { AwsReports, awsReadiness } from '../src/reports.js';

test('AWS plan discovery alone cannot authorize provisioning', () => {
  const raw = { accountId: 'private-account', accountPlanType: 'FREE' as const, accountPlanStatus: 'ACTIVE' as const };
  const report = awsReadiness(raw);
  expect(report.accountPlanType).toBe('FREE');
  expect(report.provisioningAllowed).toBe(false);
  expect(report.freeComputeEligibility).toBe('UNKNOWN');
  expect(JSON.stringify(report)).not.toContain('private-account');

  // Verify class with static function produces identical results
  const classReport = AwsReports.readiness(raw);
  expect(classReport).toEqual(report);
});

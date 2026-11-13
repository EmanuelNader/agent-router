import type { GetAccountPlanStateCommandOutput } from '@aws-sdk/client-freetier';

type RegionAccess = { regionName: string; isHomeRegion: boolean; status: string };

/** Connection discovery is deliberately insufficient to authorize provisioning. */
export function ociReadiness(regions: RegionAccess[]) {
  const home = regions.filter(region => region.isHomeRegion && region.status === 'READY');
  return {
    provider: 'oci', authentication: 'VERIFIED',
    homeRegion: home.length === 1 ? home[0]!.regionName : 'UNKNOWN',
    freeComputeEligibility: 'UNKNOWN', provisioningAllowed: false,
    missingEvidence: ['tenancy-wide usage', 'account benefits', 'shape availability', 'storage and network costs'],
  } as const;
}

type AwsPlan = Pick<GetAccountPlanStateCommandOutput,
  'accountPlanType' | 'accountPlanStatus' | 'accountPlanRemainingCredits' | 'accountPlanExpirationDate'>;
export function awsReadiness(plan: AwsPlan) {
  return {
    provider: 'aws', authentication: 'VERIFIED',
    accountPlanType: plan.accountPlanType ?? 'UNKNOWN',
    accountPlanStatus: plan.accountPlanStatus ?? 'UNKNOWN',
    remainingCreditAmount: plan.accountPlanRemainingCredits?.amount ?? null,
    creditCurrency: plan.accountPlanRemainingCredits?.unit ?? null,
    expiresAt: plan.accountPlanExpirationDate?.toISOString() ?? null,
    freeComputeEligibility: 'UNKNOWN', provisioningAllowed: false,
    missingEvidence: ['offer-specific eligibility', 'current usage', 'region and instance limits', 'storage and network costs'],
  } as const;
}

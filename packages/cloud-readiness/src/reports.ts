import type { GetAccountPlanStateCommandOutput } from '@aws-sdk/client-freetier';

type AwsPlan = Pick<GetAccountPlanStateCommandOutput,
  'accountPlanType' | 'accountPlanStatus' | 'accountPlanRemainingCredits' |   'accountPlanExpirationDate'>;

/** Caller has already authenticated. The plan alone cannot authorize provisioning. */
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

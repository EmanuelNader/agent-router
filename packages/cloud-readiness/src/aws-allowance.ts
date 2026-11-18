import { z } from 'zod';

export const awsAllowanceSnapshotSchema = z.object({
  observedAt: z.iso.datetime(),
  accountPlanType: z.enum(['FREE', 'PAID', 'UNKNOWN']),
  accountPlanStatus: z.enum(['NOT_STARTED', 'ACTIVE', 'EXPIRED', 'UNKNOWN']),
  remainingCreditAmount: z.number().nonnegative().nullable(),
  creditCurrency: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type AwsAllowanceSnapshot = z.infer<typeof awsAllowanceSnapshotSchema>;

export interface EvaluateAwsAllowanceOptions {
  minCreditFloorUsd?: number;
  minDaysRemaining?: number;
  now?: Date;
}

export interface AwsAllowanceEvaluation {
  decision: 'HEALTHY' | 'MIGRATE_NOW' | 'BLOCKED';
  shouldMigrate: boolean;
  remainingCreditUsd: number | null;
  daysRemaining: number | null;
  reasons: string[];
}

/**
 * Evaluates AWS Free Tier Plan (`GetAccountPlanState`) remaining credit and 6-month cutoff
 * so Agent Router can migrate an active workspace BEFORE AWS suspends an exhausted Free Plan account.
 */
export function evaluateAwsFreePlanAllowance(
  snapshotInput: AwsAllowanceSnapshot,
  options: EvaluateAwsAllowanceOptions = {},
): AwsAllowanceEvaluation {
  const snapshot = awsAllowanceSnapshotSchema.parse(snapshotInput);
  const now = options.now ?? new Date();
  const minCreditFloorUsd = options.minCreditFloorUsd ?? 5;
  const minDaysRemaining = options.minDaysRemaining ?? 7;

  const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
  if (ageMs > 15 * 60_000) {
    return {
      decision: 'BLOCKED',
      shouldMigrate: false,
      remainingCreditUsd: null,
      daysRemaining: null,
      reasons: ['STALE_AWS_EVIDENCE'],
    };
  }
  if (ageMs < 0) {
    return {
      decision: 'BLOCKED',
      shouldMigrate: false,
      remainingCreditUsd: null,
      daysRemaining: null,
      reasons: ['FUTURE_AWS_EVIDENCE'],
    };
  }

  if (snapshot.accountPlanStatus === 'EXPIRED') {
    return {
      decision: 'MIGRATE_NOW',
      shouldMigrate: true,
      remainingCreditUsd: snapshot.remainingCreditAmount,
      daysRemaining: 0,
      reasons: ['AWS_FREE_PLAN_EXPIRED'],
    };
  }

  if (
    snapshot.accountPlanType !== 'FREE' ||
    snapshot.accountPlanStatus !== 'ACTIVE' ||
    snapshot.remainingCreditAmount === null ||
    snapshot.creditCurrency !== 'USD' ||
    snapshot.expiresAt === null
  ) {
    return {
      decision: 'BLOCKED',
      shouldMigrate: false,
      remainingCreditUsd: null,
      daysRemaining: null,
      reasons: ['INCOMPLETE_OR_NON_FREE_AWS_PLAN_STATE'],
    };
  }

  const daysRemaining = Math.floor((Date.parse(snapshot.expiresAt) - now.getTime()) / 86_400_000);
  const reasons: string[] = [];

  if (snapshot.remainingCreditAmount <= minCreditFloorUsd) {
    reasons.push('LOW_REMAINING_CREDITS');
  }
  if (daysRemaining <= minDaysRemaining) {
    reasons.push('EXPIRING_SOON');
  }

  if (reasons.length > 0) {
    return {
      decision: 'MIGRATE_NOW',
      shouldMigrate: true,
      remainingCreditUsd: snapshot.remainingCreditAmount,
      daysRemaining,
      reasons,
    };
  }

  return {
    decision: 'HEALTHY',
    shouldMigrate: false,
    remainingCreditUsd: snapshot.remainingCreditAmount,
    daysRemaining,
    reasons: [],
  };
}

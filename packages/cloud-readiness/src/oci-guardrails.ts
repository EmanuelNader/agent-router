import { z } from 'zod';
import { previewOciDeployment } from './oci-plan.js';
import { deploymentRequestSchema, type DeploymentRequest, type OciInspection } from './oci-report.js';

export const compartmentNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

export const quotaEvaluationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('VERIFIED'),
    zeroedOtherComputeShapes: z.literal(true),
    maxA1Ocpus: z.number().int().min(1).max(4),
    maxA1MemoryGb: z.number().int().min(1).max(24),
    maxStorageGb: z.number().int().min(50).max(200),
  }),
  z.object({
    status: z.literal('BLOCKED'),
    reason: z.enum(['QUOTA_INSPECTION_FAILED', 'MISSING_COMPARTMENT_QUOTA', 'UNSAFE_COMPARTMENT_QUOTA']),
  }),
]);
export type QuotaEvaluation = z.infer<typeof quotaEvaluationSchema>;

export const budgetEvaluationSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('VERIFIED'),
    lowestTripwireAmount: z.number().positive().max(5),
  }),
  z.object({
    status: z.literal('BLOCKED'),
    reason: z.enum(['BUDGET_INSPECTION_FAILED', 'MISSING_BUDGET_ALERT']),
  }),
]);
export type BudgetEvaluation = z.infer<typeof budgetEvaluationSchema>;

export const guardrailReportSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['OCI_API', 'DEMO']),
  observedAt: z.iso.datetime(),
  compartmentName: compartmentNameSchema,
  compartmentQuota: quotaEvaluationSchema,
  budgetAlert: budgetEvaluationSchema,
});
export type OciGuardrailReport = z.infer<typeof guardrailReportSchema>;

export interface SanitizedBudgetAlertInput {
  lifecycleState: string;
  type: string;
  thresholdType: string;
  threshold: number;
  hasRecipients: boolean;
}

export interface SanitizedBudgetInput {
  lifecycleState: string;
  resetPeriod: string;
  amount: number;
  coversTarget: boolean;
  alerts: SanitizedBudgetAlertInput[];
}

export interface OciGuardrailReader {
  quotaStatements(): Promise<string[]>;
  budgets(): Promise<SanitizedBudgetInput[]>;
}

/**
 * Evaluates OCI declarative quota statements in order for `compartmentName`.
 * Safe PAYG operation requires zeroing compute-core shapes first, then explicitly setting
 * Always-Free-bounded A1 core/memory and total block-storage caps without later overrides.
 */
export function evaluateQuotaStatements(statements: string[], compartmentName: string): QuotaEvaluation {
  const target = compartmentNameSchema.parse(compartmentName).toLowerCase();
  let zeroedCompute = false;
  let maxA1Ocpus: number | undefined;
  let maxA1MemoryGb: number | undefined;
  let maxStorageGb: number | undefined;

  for (const raw of statements) {
    const normalized = raw.trim().replace(/\s+/g, ' ');
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (!lower.endsWith(` in compartment ${target}`)) continue;

    if (lower === `zero compute-core quotas in compartment ${target}`) {
      zeroedCompute = true;
      maxA1Ocpus = undefined;
      maxA1MemoryGb = undefined;
      continue;
    }

    if (lower.startsWith('unset ')) {
      return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
    }

    const setMatch = lower.match(/^set ([a-z0-9-]+) quota ([a-z0-9/*_-]+) to (\d+) in compartment ([a-z0-9._-]+)$/);
    if (!setMatch) {
      if (lower.includes('compute') || lower.includes('block-storage')) {
        return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
      }
      continue;
    }

    const [, family, quotaName, rawValue] = setMatch;
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value)) return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };

    if (family === 'compute-core') {
      if (!zeroedCompute) return { status: 'BLOCKED', reason: 'MISSING_COMPARTMENT_QUOTA' };
      if (quotaName === 'standard-a1-core-count') {
        if (value < 1 || value > 4) return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
        maxA1Ocpus = value;
      } else if (quotaName === 'standard-a1-memory-count') {
        if (value < 1 || value > 24) return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
        maxA1MemoryGb = value;
      } else if (value > 0) {
        return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
      }
    } else if (family === 'block-storage' && quotaName === 'total-storage-gb') {
      if (value < 50 || value > 200) return { status: 'BLOCKED', reason: 'UNSAFE_COMPARTMENT_QUOTA' };
      maxStorageGb = value;
    }
  }

  if (!zeroedCompute || maxA1Ocpus === undefined || maxA1MemoryGb === undefined || maxStorageGb === undefined) {
    return { status: 'BLOCKED', reason: 'MISSING_COMPARTMENT_QUOTA' };
  }

  return {
    status: 'VERIFIED',
    zeroedOtherComputeShapes: true,
    maxA1Ocpus,
    maxA1MemoryGb,
    maxStorageGb,
  };
}

export function evaluateBudgetAlerts(budgets: SanitizedBudgetInput[], maxTripwireAmount = 5): BudgetEvaluation {
  let lowest: number | undefined;
  for (const item of budgets) {
    if (
      item.lifecycleState !== 'ACTIVE' ||
      item.resetPeriod !== 'MONTHLY' ||
      !item.coversTarget ||
      !Number.isFinite(item.amount) ||
      item.amount <= 0
    ) {
      continue;
    }
    for (const alert of item.alerts) {
      if (
        alert.lifecycleState !== 'ACTIVE' ||
        (alert.type !== 'ACTUAL' && alert.type !== 'FORECAST') ||
        !alert.hasRecipients ||
        !Number.isFinite(alert.threshold) ||
        alert.threshold <= 0
      ) {
        continue;
      }
      const effectiveAmount =
        alert.thresholdType === 'ABSOLUTE'
          ? alert.threshold
          : alert.thresholdType === 'PERCENTAGE'
            ? (item.amount * alert.threshold) / 100
            : Number.POSITIVE_INFINITY;

      if (effectiveAmount > 0 && effectiveAmount <= maxTripwireAmount) {
        lowest = lowest === undefined ? effectiveAmount : Math.min(lowest, effectiveAmount);
      }
    }
  }

  if (lowest === undefined) return { status: 'BLOCKED', reason: 'MISSING_BUDGET_ALERT' };
  return { status: 'VERIFIED', lowestTripwireAmount: Number(lowest.toFixed(2)) };
}

export async function inspectOciGuardrails(
  reader: OciGuardrailReader,
  compartmentName: string,
  now = new Date(),
): Promise<OciGuardrailReport> {
  const checkedName = compartmentNameSchema.parse(compartmentName);
  const observedAt = now.toISOString();

  const [quotaResult, budgetResult] = await Promise.allSettled([reader.quotaStatements(), reader.budgets()]);
  const compartmentQuota: QuotaEvaluation =
    quotaResult.status === 'fulfilled'
      ? evaluateQuotaStatements(quotaResult.value, checkedName)
      : { status: 'BLOCKED', reason: 'QUOTA_INSPECTION_FAILED' };

  const budgetAlert: BudgetEvaluation =
    budgetResult.status === 'fulfilled'
      ? evaluateBudgetAlerts(budgetResult.value)
      : { status: 'BLOCKED', reason: 'BUDGET_INSPECTION_FAILED' };

  return guardrailReportSchema.parse({
    schemaVersion: 1,
    source: 'OCI_API',
    observedAt,
    compartmentName: checkedName,
    compartmentQuota,
    budgetAlert,
  });
}

export function evaluateOciPaygGuardrails(
  inspection: OciInspection,
  guardrailsInput: OciGuardrailReport,
  requested: DeploymentRequest,
  now = new Date(),
) {
  const guardrails = guardrailReportSchema.parse(guardrailsInput);
  const request = deploymentRequestSchema.parse(requested);
  const basePlan = previewOciDeployment(inspection, request, now);
  const blockers: string[] = [...basePlan.blockers];

  const age = now.getTime() - Date.parse(guardrails.observedAt);
  if (age > 15 * 60_000) blockers.push('STALE_GUARDRAIL_EVIDENCE');
  if (age < 0) blockers.push('FUTURE_GUARDRAIL_EVIDENCE');

  if (guardrails.compartmentQuota.status === 'BLOCKED') {
    blockers.push(guardrails.compartmentQuota.reason);
  } else {
    if (request.ocpus * request.additionalInstances > guardrails.compartmentQuota.maxA1Ocpus) {
      blockers.push('EXCEEDS_COMPARTMENT_A1_OCPU_CAP');
    }
    if (request.memoryGb * request.additionalInstances > guardrails.compartmentQuota.maxA1MemoryGb) {
      blockers.push('EXCEEDS_COMPARTMENT_A1_MEMORY_CAP');
    }
    if (request.bootGb * request.additionalInstances > guardrails.compartmentQuota.maxStorageGb) {
      blockers.push('EXCEEDS_COMPARTMENT_STORAGE_CAP');
    }
  }

  if (guardrails.budgetAlert.status === 'BLOCKED') {
    blockers.push(guardrails.budgetAlert.reason);
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    status: uniqueBlockers.length === 0 ? ('GUARDED_QUOTA_FITS' as const) : ('BLOCKED' as const),
    source: basePlan.source === 'DEMO' || guardrails.source === 'DEMO' ? ('DEMO' as const) : ('OCI_API' as const),
    observedAt: guardrails.observedAt,
    provisioningAllowed: false as const,
    compartmentName: guardrails.compartmentName,
    candidate: basePlan.candidate,
    checks: basePlan.checks,
    guardrails: {
      compartmentQuota: guardrails.compartmentQuota,
      budgetAlert: guardrails.budgetAlert,
    },
    blockers: uniqueBlockers,
    unverified: [
      'ACCOUNT_BENEFITS_AND_MONTHLY_USAGE',
      'PHYSICAL_CAPACITY',
      'IMAGE_COMPATIBILITY_AND_SIZE',
      'NETWORK_AND_STORAGE_COSTS',
      'PROVISIONER_NOT_IMPLEMENTED',
    ],
  };
}

import { z } from 'zod';

export const codespacesAllowanceSnapshotSchema = z.object({
  observedAt: z.iso.datetime(),
  usedCoreHours: z.number().nonnegative(),
  usedStorageGbMonth: z.number().nonnegative(),
  activeMachineCores: z.union([
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
  includedCoreHours: z.number().positive().default(120),
  includedStorageGbMonth: z.number().positive().default(15),
});
export type CodespacesAllowanceSnapshot = z.input<typeof codespacesAllowanceSnapshotSchema>;

export interface EvaluateCodespacesAllowanceOptions {
  minCoreHoursBuffer?: number;
  maxStorageGbMonthBuffer?: number;
  now?: Date;
}

export interface CodespacesAllowanceEvaluation {
  decision: 'HEALTHY' | 'MIGRATE_NOW' | 'BLOCKED';
  shouldMigrate: boolean;
  remainingCoreHours: number | null;
  estimatedHoursLeftOnActiveMachine: number | null;
  remainingStorageGbMonth: number | null;
  reasons: string[];
}

/**
 * Evaluates GitHub Codespaces personal monthly free quota (120 core-hours + 15 GB-month storage)
 * and signals `MIGRATE_NOW` before GitHub freezes or bills an active Codespace.
 */
export function evaluateCodespacesAllowance(
  snapshotInput: CodespacesAllowanceSnapshot,
  options: EvaluateCodespacesAllowanceOptions = {},
): CodespacesAllowanceEvaluation {
  const snapshot = codespacesAllowanceSnapshotSchema.parse(snapshotInput);
  const now = options.now ?? new Date();
  const minCoreHoursBuffer = options.minCoreHoursBuffer ?? 10;
  const maxStorageGbMonthBuffer = options.maxStorageGbMonthBuffer ?? 13.5;

  const ageMs = now.getTime() - Date.parse(snapshot.observedAt);
  if (ageMs > 15 * 60_000) {
    return {
      decision: 'BLOCKED',
      shouldMigrate: false,
      remainingCoreHours: null,
      estimatedHoursLeftOnActiveMachine: null,
      remainingStorageGbMonth: null,
      reasons: ['STALE_CODESPACES_EVIDENCE'],
    };
  }
  if (ageMs < 0) {
    return {
      decision: 'BLOCKED',
      shouldMigrate: false,
      remainingCoreHours: null,
      estimatedHoursLeftOnActiveMachine: null,
      remainingStorageGbMonth: null,
      reasons: ['FUTURE_CODESPACES_EVIDENCE'],
    };
  }

  const remainingCoreHours = Number(Math.max(0, snapshot.includedCoreHours - snapshot.usedCoreHours).toFixed(2));
  const estimatedHoursLeftOnActiveMachine = Number(
    (remainingCoreHours / snapshot.activeMachineCores).toFixed(2),
  );
  const remainingStorageGbMonth = Number(
    Math.max(0, snapshot.includedStorageGbMonth - snapshot.usedStorageGbMonth).toFixed(2),
  );

  const reasons: string[] = [];
  if (remainingCoreHours <= minCoreHoursBuffer) {
    reasons.push('LOW_CODESPACES_CORE_HOURS');
  }
  if (snapshot.usedStorageGbMonth >= maxStorageGbMonthBuffer) {
    reasons.push('HIGH_CODESPACES_STORAGE_USAGE');
  }

  if (reasons.length > 0) {
    return {
      decision: 'MIGRATE_NOW',
      shouldMigrate: true,
      remainingCoreHours,
      estimatedHoursLeftOnActiveMachine,
      remainingStorageGbMonth,
      reasons,
    };
  }

  return {
    decision: 'HEALTHY',
    shouldMigrate: false,
    remainingCoreHours,
    estimatedHoursLeftOnActiveMachine,
    remainingStorageGbMonth,
    reasons: [],
  };
}

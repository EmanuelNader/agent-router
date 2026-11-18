import {
  evaluateAwsFreePlanAllowance,
  type AwsAllowanceSnapshot,
} from '../../cloud-readiness/src/aws-allowance.js';
import {
  evaluateCodespacesAllowance,
  type CodespacesAllowanceSnapshot,
} from '../../cloud-readiness/src/codespaces-allowance.js';
import { parseGitHubCodespacesBillingUsage } from '../../cloud-readiness/src/github-billing-api.js';
import type { OperationJournal } from './journal.js';
import type { MigrateWorkspaceResult, MigrationTrigger } from './migrate.js';

export type AllowancePollSample =
  | {
      kind: 'AWS_FREE_PLAN';
      snapshot: AwsAllowanceSnapshot;
      minCreditFloorUsd?: number;
      minDaysRemaining?: number;
      now?: Date;
    }
  | {
      kind: 'CODESPACES';
      snapshot: CodespacesAllowanceSnapshot;
      minCoreHoursBuffer?: number;
      maxStorageGbMonthBuffer?: number;
      now?: Date;
    }
  | {
      kind: 'GITHUB_BILLING_USAGE';
      payload: unknown;
      observedAt: string;
      activeMachineCores: 2 | 4 | 8 | 16 | 32;
      minCoreHoursBuffer?: number;
      maxStorageGbMonthBuffer?: number;
      now?: Date;
    };

export interface WatchTickRecord {
  tick: number;
  decision: 'HEALTHY' | 'MIGRATE_NOW' | 'BLOCKED';
  reasons: string[];
}

export type WatchLoopResult =
  | {
      outcome: 'EVACUATED';
      ticksRun: number;
      triggerReasons: string[];
      migration: Extract<MigrateWorkspaceResult, { status: 'MIGRATED' }>;
      history: WatchTickRecord[];
    }
  | {
      outcome: 'NO_FALLBACK_CAPACITY';
      ticksRun: number;
      triggerReasons: string[];
      migration: Extract<MigrateWorkspaceResult, { status: 'ABORTED_NO_CAPACITY' }>;
      history: WatchTickRecord[];
    }
  | {
      outcome: 'BLOCKED_BY_JOURNAL';
      ticksRun: number;
      blockingOperationIds: string[];
      history: WatchTickRecord[];
    }
  | {
      outcome: 'BLOCKED_BY_EVIDENCE';
      ticksRun: number;
      reasons: string[];
      history: WatchTickRecord[];
    }
  | {
      outcome: 'HEALTHY_MAX_TICKS_REACHED';
      ticksRun: number;
      history: WatchTickRecord[];
    }
  | {
      outcome: 'STOPPED';
      ticksRun: number;
      history: WatchTickRecord[];
    };

export interface RunAllowanceWatchLoopOptions {
  workspaceKey: string;
  journal: OperationJournal;
  maxTicks: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  pollAllowance: (tick: number) => Promise<AllowancePollSample>;
  executeMigration: (trigger: MigrationTrigger, reasons: string[]) => Promise<MigrateWorkspaceResult>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

function evaluateSample(sample: AllowancePollSample): {
  decision: 'HEALTHY' | 'MIGRATE_NOW' | 'BLOCKED';
  reasons: string[];
  trigger: MigrationTrigger;
} {
  if (sample.kind === 'AWS_FREE_PLAN') {
    const res = evaluateAwsFreePlanAllowance(sample.snapshot, {
      ...(sample.minCreditFloorUsd !== undefined ? { minCreditFloorUsd: sample.minCreditFloorUsd } : {}),
      ...(sample.minDaysRemaining !== undefined ? { minDaysRemaining: sample.minDaysRemaining } : {}),
      ...(sample.now !== undefined ? { now: sample.now } : {}),
    });
    return {
      decision: res.decision,
      reasons: res.reasons,
      trigger: {
        kind: 'AWS_FREE_PLAN',
        snapshot: sample.snapshot,
        ...(sample.minCreditFloorUsd !== undefined ? { minCreditFloorUsd: sample.minCreditFloorUsd } : {}),
        ...(sample.minDaysRemaining !== undefined ? { minDaysRemaining: sample.minDaysRemaining } : {}),
        ...(sample.now !== undefined ? { now: sample.now } : {}),
      },
    };
  }

  const csSnapshot =
    sample.kind === 'GITHUB_BILLING_USAGE'
      ? parseGitHubCodespacesBillingUsage(sample.payload, {
          observedAt: sample.observedAt,
          activeMachineCores: sample.activeMachineCores,
        })
      : sample.snapshot;

  const res = evaluateCodespacesAllowance(csSnapshot, {
    ...(sample.minCoreHoursBuffer !== undefined ? { minCoreHoursBuffer: sample.minCoreHoursBuffer } : {}),
    ...(sample.maxStorageGbMonthBuffer !== undefined
      ? { maxStorageGbMonthBuffer: sample.maxStorageGbMonthBuffer }
      : {}),
    ...(sample.now !== undefined ? { now: sample.now } : {}),
  });

  return {
    decision: res.decision,
    reasons: res.reasons,
    trigger: {
      kind: 'CODESPACES',
      snapshot: csSnapshot,
      ...(sample.minCoreHoursBuffer !== undefined ? { minCoreHoursBuffer: sample.minCoreHoursBuffer } : {}),
      ...(sample.maxStorageGbMonthBuffer !== undefined
        ? { maxStorageGbMonthBuffer: sample.maxStorageGbMonthBuffer }
        : {}),
      ...(sample.now !== undefined ? { now: sample.now } : {}),
    },
  };
}

/**
 * Autonomous, fail-closed allowance monitor loop:
 * 1. Verifies zero `PENDING` or `NEEDS_RECONCILE` journal records before every tick.
 * 2. Fails closed (`BLOCKED_BY_EVIDENCE`) on missing, malformed, or stale (> 15m) quota telemetry.
 * 3. Automatically runs `executeMigration` when `MIGRATE_NOW` fires and halts once evacuated.
 */
export async function runAllowanceWatchLoop(
  options: RunAllowanceWatchLoopOptions,
): Promise<WatchLoopResult> {
  if (!Number.isInteger(options.maxTicks) || options.maxTicks < 1) {
    throw new Error('Invalid maxTicks: must be an integer >= 1');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 0;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('Invalid pollIntervalMs: must be >= 0');
  }

  const history: WatchTickRecord[] = [];
  const sleepFn = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));

  for (let tick = 1; tick <= options.maxTicks; tick++) {
    if (options.signal?.aborted) {
      return { outcome: 'STOPPED', ticksRun: tick - 1, history };
    }

    const blocking = await options.journal.listBlocking(options.workspaceKey);
    if (blocking.length > 0) {
      return {
        outcome: 'BLOCKED_BY_JOURNAL',
        ticksRun: tick - 1,
        blockingOperationIds: blocking.map(record => record.operationId),
        history,
      };
    }

    let evaluated: ReturnType<typeof evaluateSample>;
    try {
      const sample = await options.pollAllowance(tick);
      evaluated = evaluateSample(sample);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'MALFORMED_ALLOWANCE_EVIDENCE';
      history.push({ tick, decision: 'BLOCKED', reasons: [reason] });
      return {
        outcome: 'BLOCKED_BY_EVIDENCE',
        ticksRun: tick,
        reasons: [reason],
        history,
      };
    }

    history.push({
      tick,
      decision: evaluated.decision,
      reasons: evaluated.reasons,
    });

    if (evaluated.decision === 'BLOCKED') {
      return {
        outcome: 'BLOCKED_BY_EVIDENCE',
        ticksRun: tick,
        reasons: evaluated.reasons,
        history,
      };
    }

    if (evaluated.decision === 'MIGRATE_NOW') {
      const migration = await options.executeMigration(evaluated.trigger, evaluated.reasons);
      if (migration.status === 'MIGRATED') {
        return {
          outcome: 'EVACUATED',
          ticksRun: tick,
          triggerReasons: evaluated.reasons,
          migration,
          history,
        };
      }
      if (migration.status === 'ABORTED_NO_CAPACITY') {
        return {
          outcome: 'NO_FALLBACK_CAPACITY',
          ticksRun: tick,
          triggerReasons: evaluated.reasons,
          migration,
          history,
        };
      }
    }

    if (tick < options.maxTicks && pollIntervalMs > 0) {
      await sleepFn(pollIntervalMs);
    }
  }

  return {
    outcome: 'HEALTHY_MAX_TICKS_REACHED',
    ticksRun: options.maxTicks,
    history,
  };
}

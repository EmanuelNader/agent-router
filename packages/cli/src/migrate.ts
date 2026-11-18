import type { SessionTransfer } from '../../agent-opencode/src/client.js';
import {
  evaluateAwsFreePlanAllowance,
  type AwsAllowanceSnapshot,
} from '../../cloud-readiness/src/aws-allowance.js';
import { handoffWorkspace } from '../../host-ssh/src/handoff.js';
import type { HostTransport } from '../../host-ssh/src/transport.js';
import type { CheckpointManifest } from '../../snapshots/src/manifest.js';
import type { OperationJournal } from './journal.js';

export type MigrationTrigger =
  | 'MANUAL'
  | {
      kind: 'AWS_FREE_PLAN';
      snapshot: AwsAllowanceSnapshot;
      minCreditFloorUsd?: number;
      minDaysRemaining?: number;
      now?: Date;
    };

export interface MigrationSource {
  workspacePath: string;
  stagingDir: string;
  exportSessions: () => Promise<SessionTransfer[]>;
  fenceAgent: () => Promise<void>;
  teardownCompute?: () => Promise<void>;
}

export interface MigrationCandidate {
  name: string;
  targetWorkspace: string;
  transport: HostTransport;
  prepareCompute: () => Promise<
    | { status: 'READY'; targetFingerprint?: string }
    | { status: 'OUT_OF_CAPACITY' }
  >;
  activateAndImportSession: (transfer: SessionTransfer, directory: string) => Promise<string>;
}

export type MigrateWorkspaceResult =
  | {
      status: 'SKIPPED_HEALTHY';
      reasons: string[];
    }
  | {
      status: 'ABORTED_NO_CAPACITY';
      sourceIntact: true;
      skippedTargets: { name: string; reason: 'OUT_OF_CAPACITY' }[];
    }
  | {
      status: 'MIGRATED';
      operationId: string;
      checkpointId: string;
      selectedTarget: string;
      targetFingerprint: string | null;
      triggerReasons: string[];
      skippedTargets: { name: string; reason: 'OUT_OF_CAPACITY' }[];
      sourceTornDown: boolean;
      manifest: CheckpointManifest;
    };

/**
 * Allowance-aware and capacity-resilient cross-host workspace migration (Milestone 4).
 * Safety invariants:
 * 1. Stale/incomplete allowance telemetry fails closed BEFORE touching the running source.
 * 2. Destination compute capacity is verified BEFORE fencing the source agent.
 * 3. Source compute teardown runs ONLY AFTER destination hash verification and session import succeed.
 */
export async function migrateWorkspace(options: {
  workspaceKey: string;
  journal: OperationJournal;
  encryptionKey: Buffer;
  trigger: MigrationTrigger;
  source: MigrationSource;
  candidates: MigrationCandidate[];
}): Promise<MigrateWorkspaceResult> {
  let triggerReasons: string[] = ['MANUAL_REQUEST'];

  if (options.trigger !== 'MANUAL') {
    const evalResult = evaluateAwsFreePlanAllowance(options.trigger.snapshot, {
      ...(options.trigger.minCreditFloorUsd !== undefined
        ? { minCreditFloorUsd: options.trigger.minCreditFloorUsd }
        : {}),
      ...(options.trigger.minDaysRemaining !== undefined
        ? { minDaysRemaining: options.trigger.minDaysRemaining }
        : {}),
      ...(options.trigger.now !== undefined ? { now: options.trigger.now } : {}),
    });

    if (evalResult.decision === 'BLOCKED') {
      throw new Error(`ALLOWANCE_CHECK_BLOCKED: ${evalResult.reasons.join(', ')}`);
    }
    if (!evalResult.shouldMigrate) {
      return { status: 'SKIPPED_HEALTHY', reasons: [] };
    }
    triggerReasons = evalResult.reasons;
  }

  const skippedTargets: { name: string; reason: 'OUT_OF_CAPACITY' }[] = [];
  let chosen: { candidate: MigrationCandidate; targetFingerprint: string | null } | null = null;

  for (const candidate of options.candidates) {
    const prep = await candidate.prepareCompute();
    if (prep.status === 'OUT_OF_CAPACITY') {
      skippedTargets.push({ name: candidate.name, reason: 'OUT_OF_CAPACITY' });
      continue;
    }
    chosen = {
      candidate,
      targetFingerprint: prep.targetFingerprint ?? null,
    };
    break;
  }

  if (!chosen) {
    return {
      status: 'ABORTED_NO_CAPACITY',
      sourceIntact: true,
      skippedTargets,
    };
  }

  const { operation, manifest } = await handoffWorkspace({
    workspaceKey: options.workspaceKey,
    journal: options.journal,
    encryptionKey: options.encryptionKey,
    sourceWorkspace: options.source.workspacePath,
    sourceStagingDir: options.source.stagingDir,
    targetWorkspace: chosen.candidate.targetWorkspace,
    transport: chosen.candidate.transport,
    exportSourceSessions: options.source.exportSessions,
    fenceSource: options.source.fenceAgent,
    activateTargetAndImportSession: chosen.candidate.activateAndImportSession,
  });

  let sourceTornDown = false;
  if (options.source.teardownCompute) {
    await options.source.teardownCompute();
    sourceTornDown = true;
  }

  return {
    status: 'MIGRATED',
    operationId: operation.operationId,
    checkpointId: manifest.checkpointId,
    selectedTarget: chosen.candidate.name,
    targetFingerprint: chosen.targetFingerprint,
    triggerReasons,
    skippedTargets,
    sourceTornDown,
    manifest,
  };
}

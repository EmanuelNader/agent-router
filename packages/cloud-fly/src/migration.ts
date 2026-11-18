import { createHash } from 'node:crypto';
import type { MigrationCandidate } from '../../cli/src/migrate.js';
import { evaluateFlyGuardrails } from './guard.js';
import type { FlyGateway, FlyMachineLifecycle } from './provider.js';

/** Resume an existing dedicated, scale-to-zero Machine before workspace cutover. */
export function createFlyMigrationCandidate(options: {
  workspaceKey: string;
  machineId: string;
  targetWorkspace: string;
  lifecycle: FlyMachineLifecycle;
  gateway: FlyGateway;
  evidence: () => unknown | Promise<unknown>;
  transport: MigrationCandidate['transport'];
  activateAndImportSession: MigrationCandidate['activateAndImportSession'];
}): MigrationCandidate {
  return {
    name: 'fly-machine', targetWorkspace: options.targetWorkspace,
    transport: options.transport, activateAndImportSession: options.activateAndImportSession,
    prepareCompute: async () => {
      const evidence = await options.evidence();
      if (evaluateFlyGuardrails(evidence).status !== 'GUARDED_PAID_TARGET') throw new Error('FLY_MIGRATION_BLOCKED_BY_EVIDENCE');
      await options.lifecycle.transition(options.workspaceKey, options.machineId, 'start', evidence);
      const observed = await options.gateway.inspect(options.machineId);
      if (observed.state !== 'started' || observed.workspaceKey !== options.workspaceKey || observed.id !== options.machineId) throw new Error('FLY_MIGRATION_TARGET_UNVERIFIED');
      return { status: 'READY', targetFingerprint: `fly_${createHash('sha256').update(options.machineId).digest('hex').slice(0, 16)}` };
    },
  };
}

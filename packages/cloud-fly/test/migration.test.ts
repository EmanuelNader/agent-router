import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import { migrateWorkspace } from '../../cli/src/migrate.js';
import { LoopbackHostTransport } from '../../host-ssh/src/transport.js';
import { createFlyMigrationCandidate } from '../src/migration.js';
import { flyDemoEvidence } from '../src/guard.js';
import { FlyMachineLifecycle, InMemoryFlyGateway } from '../src/provider.js';

test('migrates to a guarded suspended Fly candidate after fencing the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-fly-migrate-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(source);
    await writeFile(join(source, 'progress.txt'), 'saved-work');
    const journal = new OperationJournal(join(root, 'journal'));
    const gateway = new InMemoryFlyGateway('ws-fly', 'suspended');
    const lifecycle = new FlyMachineLifecycle({ journal, gateway });
    let active = 1;
    let maxActive = 1;
    let tornDown = false;
    const candidate = createFlyMigrationCandidate({
      workspaceKey: 'ws-fly', machineId: 'abcd1234', targetWorkspace: target,
      lifecycle, gateway, evidence: () => flyDemoEvidence(),
      transport: new LoopbackHostTransport(join(root, 'spool')),
      activateAndImportSession: async transfer => {
        expect(active).toBe(0);
        active++;
        maxActive = Math.max(maxActive, active);
        return transfer.info.id;
      },
    });
    const result = await migrateWorkspace({
      workspaceKey: 'ws-fly', journal, encryptionKey: randomBytes(32), trigger: 'MANUAL',
      source: { workspacePath: source, stagingDir: join(root, 'staging'),
        exportSessions: async () => [{ info: { id: 'ses_fly_fixture' }, messages: [] }],
        fenceAgent: async () => { active--; }, teardownCompute: async () => { tornDown = true; },
      }, candidates: [candidate],
    });
    expect(result.status).toBe('MIGRATED');
    if (result.status === 'MIGRATED') expect(result.selectedTarget).toBe('fly-machine');
    expect(await readFile(join(target, 'progress.txt'), 'utf8')).toBe('saved-work');
    expect(maxActive).toBe(1);
    expect(tornDown).toBe(true);
    expect(await journal.listBlocking()).toEqual([]);
    await lifecycle.transition('ws-fly', 'abcd1234', 'delete');
    expect(gateway.remnants()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

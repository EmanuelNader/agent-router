import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import { FlyMachineLifecycle, InMemoryFlyGateway } from '../src/provider.js';
import { flyDemoEvidence } from '../src/guard.js';

test('suspends, resumes, and deletes a simulated Machine without remnants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-fly-'));
  try {
    const journal = new OperationJournal(root);
    const gateway = new InMemoryFlyGateway('ws-fly');
    const lifecycle = new FlyMachineLifecycle({ journal, gateway });
    await lifecycle.transition('ws-fly', 'abcd1234', 'suspend');
    expect((await gateway.inspect('abcd1234')).state).toBe('suspended');
    await lifecycle.transition('ws-fly', 'abcd1234', 'start', flyDemoEvidence());
    await lifecycle.transition('ws-fly', 'abcd1234', 'delete');
    expect(gateway.remnants()).toBe(0);
    expect(await journal.listBlocking()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(['suspend', 'start', 'delete'] as const)('reconciles a lost %s response without repeating the mutation', async action => {
  const root = await mkdtemp(join(tmpdir(), 'router-fly-fault-'));
  try {
    const journal = new OperationJournal(root);
    const gateway = new InMemoryFlyGateway('ws-fly', action === 'start' ? 'suspended' : 'started');
    gateway.failAfterMutation = true;
    const lifecycle = new FlyMachineLifecycle({ journal, gateway });
    await expect(lifecycle.transition('ws-fly', 'abcd1234', action, flyDemoEvidence())).rejects.toThrow('FLY_ACTION_UNCERTAIN');
    const [blocked] = await journal.listBlocking();
    expect(blocked?.status).toBe('NEEDS_RECONCILE');
    const restarted = new FlyMachineLifecycle({ journal: new OperationJournal(root), gateway });
    expect(await restarted.reconcile(blocked!.operationId)).toBe('RECONCILED');
    expect(gateway.mutations).toBe(1);
    expect(await journal.listBlocking()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

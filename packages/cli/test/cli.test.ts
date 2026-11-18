import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runRouterCli } from '../src/cli.js';
import { OperationJournal } from '../src/journal.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    },
  };
}

test('router CLI checkpoints and restores a workspace with an owner-only key file and records journal status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-test-'));
  tempDirs.push(root);

  const workspace = join(root, 'ws-src');
  const restored = join(root, 'ws-dst');
  const storeDir = join(root, 'store');
  const journalDir = join(root, 'journal');
  const keyFile = join(root, 'master.key');

  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, 'hello.txt'), 'cli-portable-payload\n', { mode: 0o600 });

  // World-readable key file must fail closed
  await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o644 });
  await chmod(keyFile, 0o644);
  const badCapture = captureIo();
  const badExit = await runRouterCli(
    ['checkpoint', '--workspace', workspace, '--store', storeDir, '--key-file', keyFile, '--journal-dir', journalDir],
    badCapture.io,
  );
  expect(badExit).toBe(1);
  expect(badCapture.err.join('\n')).toMatch(/owner-only|0600/i);

  // Tighten to 0600 and run checkpoint -> restore -> status
  await chmod(keyFile, 0o600);
  const cpIo = captureIo();
  expect(
    await runRouterCli(
      ['checkpoint', '--workspace', workspace, '--store', storeDir, '--key-file', keyFile, '--journal-dir', journalDir],
      cpIo.io,
    ),
  ).toBe(0);
  const cpJson = JSON.parse(cpIo.out.join('\n')) as { checkpointId: string };
  expect(cpJson.checkpointId).toMatch(/^chk_[a-f0-9]{32}$/);

  const rsIo = captureIo();
  expect(
    await runRouterCli(
      [
        'restore',
        '--checkpoint',
        cpJson.checkpointId,
        '--target',
        restored,
        '--store',
        storeDir,
        '--key-file',
        keyFile,
        '--journal-dir',
        journalDir,
      ],
      rsIo.io,
    ),
  ).toBe(0);
  expect(await readFile(join(restored, 'hello.txt'), 'utf8')).toBe('cli-portable-payload\n');

  const stIo = captureIo();
  expect(await runRouterCli(['status', '--journal-dir', journalDir], stIo.io)).toBe(0);
  const stJson = JSON.parse(stIo.out.join('\n')) as { totalOperations: number; blockingCount: number };
  expect(stJson.totalOperations).toBe(2);
  expect(stJson.blockingCount).toBe(0);
});

test('router CLI reconciles blocking journal entries and runs oci:simulate-lifecycle with zero OCID leakage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cli-reconcile-'));
  tempDirs.push(root);
  const journalDir = join(root, 'journal');
  const journal = new OperationJournal(journalDir);
  const op = await journal.begin({
    kind: 'HANDOFF',
    workspaceKey: 'ws-manual',
    summary: 'Interrupted handoff test',
  });
  await journal.markNeedsReconcile(op.operationId, 'Interrupted after source fence');

  const recIo = captureIo();
  expect(
    await runRouterCli(
      ['reconcile', '--operation', op.operationId, '--summary', 'Verified target clean', '--journal-dir', journalDir],
      recIo.io,
    ),
  ).toBe(0);
  const recJson = JSON.parse(recIo.out.join('\n')) as { status: string };
  expect(recJson.status).toBe('COMPLETED');

  const simIo = captureIo();
  expect(await runRouterCli(['oci:simulate-lifecycle', '--workspace-key', 'ws-sim-01'], simIo.io)).toBe(0);
  const rawSim = simIo.out.join('\n');
  expect(rawSim).not.toContain('ocid1.');
  const simJson = JSON.parse(rawSim) as {
    status: string;
    launchCount: number;
    reconcileOutcome: string;
    fenced: boolean;
    remnants: { instances: number; bootVolumes: number; blockVolumes: number; reservedPublicIps: number };
  };
  expect(simJson).toMatchObject({
    status: 'SIMULATION_VERIFIED',
    launchCount: 1,
    reconcileOutcome: 'ADOPTED_EXISTING_INSTANCE',
    fenced: true,
    remnants: {
      instances: 0,
      bootVolumes: 0,
      blockVolumes: 0,
      reservedPublicIps: 0,
    },
  });
});

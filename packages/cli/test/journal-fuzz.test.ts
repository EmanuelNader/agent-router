import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { OperationJournal } from '../src/journal.js';

test('journal-fuzz fails closed when the journal path is not a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-fuzz-'));
  try {
    const file = join(root, 'journal');
    await writeFile(file, 'unreadable-journal');
    await expect(new OperationJournal(file).listBlocking()).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal-fuzz rejects a symlink before changing the target permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-link-'));
  try {
    await mkdir(join(root, 'outside'), { mode: 0o755 });
    const before = (await lstat(join(root, 'outside'))).mode;
    await symlink('outside', join(root, 'journal'));
    await expect(new OperationJournal(join(root, 'journal')).listBlocking()).rejects.toThrow();
    expect((await lstat(join(root, 'outside'))).mode).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([1, 8, 16, 32, 64, 96, 128, 192])('journal-fuzz preserves authoritative pending state after a %i-byte partial temporary write', async bytes => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-partial-'));
  try {
    const journal = new OperationJournal(root);
    const pending = await journal.begin({ workspaceKey: 'ws-fuzz', kind: 'HANDOFF', summary: 'Pending handoff' });
    const next = JSON.stringify({ ...pending, status: 'COMPLETED' }).slice(0, bytes);
    await writeFile(join(root, `.${pending.operationId}.0000000000000000.tmp`), next);
    expect(await new OperationJournal(root).listBlocking()).toEqual([pending]);
    await expect(new OperationJournal(root).begin({ workspaceKey: 'ws-fuzz', kind: 'HANDOFF', summary: 'Duplicate' })).rejects.toThrow(/blocked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal-fuzz blocks an orphaned initial write instead of reporting an empty journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-orphan-'));
  try {
    await writeFile(join(root, '.op_0000000000000001.0000000000000000.tmp'), '{"status":"PENDING"');
    await expect(new OperationJournal(root).listBlocking()).rejects.toThrow('JOURNAL_INCOMPLETE_WRITE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(['begin', 'complete'])('journal-fuzz recovers fail-closed after a real process exits before %s rename', async action => {
  const root = await mkdtemp(join(tmpdir(), 'router-journal-crash-'));
  try {
    const directory = join(root, 'journal');
    const journal = new OperationJournal(directory);
    const pending = action === 'complete' ? await journal.begin({ workspaceKey: 'ws-crash', kind: 'HANDOFF', summary: 'Pending fixture' }) : undefined;
    const script = join(root, 'crash.mjs');
    await writeFile(script, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const rename=fs.promises.rename;
fs.promises.rename=async (from,to)=>{if(String(from).startsWith(${JSON.stringify(directory)}) && String(from).endsWith('.tmp')) process.exit(73);return rename(from,to);};
syncBuiltinESMExports();
const {OperationJournal}=await import(${JSON.stringify(pathToFileURL(resolve('packages/cli/src/journal.ts')).href)});
const journal=new OperationJournal(${JSON.stringify(directory)});
${action === 'begin' ? "await journal.begin({workspaceKey:'ws-crash',kind:'HANDOFF',summary:'Pending fixture'});" : `await journal.complete(${JSON.stringify(pending!.operationId)},'Completed fixture');`}
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, script], {
      stdio: 'ignore', timeout: 10_000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
    });
    expect(child.status).toBe(73);
    if (pending) expect(await new OperationJournal(directory).listBlocking()).toEqual([pending]);
    else await expect(new OperationJournal(directory).listBlocking()).rejects.toThrow('JOURNAL_INCOMPLETE_WRITE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

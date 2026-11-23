import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startIsolatedServer } from '../packages/agent-opencode/src/server.js';

// Observes how the pinned OpenCode treats pending inbox items across export/import.
// Every prompt is admitted with resume:false, so no model inference runs and no API key is needed.
process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/inbox-probe-'));
const source = join(run, 'source'); const target = join(run, 'target');
const shape = (items: { id: string; type: string; delivery: string }[]) => items.map(i => [i.id, i.type, i.delivery]);
let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
try {
  await cp(resolve('fixtures/workspace'), source, { recursive: true });
  server = await startIsolatedServer(source, join(run, 'source-agent'));
  const id = await server.client.createSession(source, 'Inbox probe fixture');
  await server.client.runShellCommand(id, "printf 'x\\n'");
  assert.deepEqual((await server.client.listInbox(id)).map(i => i.type), ['synthetic'], 'a shell turn leaves one synthetic item');
  await server.client.admitInboxItem(id, { type: 'user', delivery: 'queue', payload: { text: 'queued fixture' } });
  await server.client.admitInboxItem(id, { type: 'user', delivery: 'steer', payload: { text: 'steer fixture' } });
  const before = await server.client.listInbox(id);
  assert.deepEqual(before.map(i => i.type), ['synthetic', 'user', 'user']);
  const transfer = await server.client.exportSession(id);
  assert.equal(JSON.stringify(transfer).includes('queued fixture'), false, 'export must not contain pending prompts');
  await server.stop(); server = undefined;

  server = await startIsolatedServer(source, join(run, 'source-agent'));
  assert.deepEqual(shape(await server.client.listInbox(id)), shape(before), 'inbox survives a restart on the same state');
  await server.stop(); server = undefined;

  await cp(source, target, { recursive: true });
  server = await startIsolatedServer(target, join(run, 'target-agent'));
  assert.equal(await server.client.importSession(transfer, target), id);
  assert.deepEqual(await server.client.listInbox(id), [], 'import does not carry the inbox');
  for (let pass = 0; pass < 2; pass++) for (const item of before) await server.client.admitInboxItem(id, item);
  const after = await server.client.listInbox(id);
  assert.deepEqual(shape(after), shape(before), 'admission keeps IDs, order and delivery, and is idempotent');
  assert.deepEqual(after.map(i => i.payload.text), before.map(i => i.payload.text));
  console.log(JSON.stringify({ status: 'INBOX_READMISSION_OBSERVED', items: after.length }));
} finally {
  await server?.stop().catch(() => {});
  await rm(run, { recursive: true, force: true });
}


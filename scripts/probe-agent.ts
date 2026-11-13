import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { OPENCODE_VERSION, startIsolatedServer } from '../packages/agent-opencode/src/server.js';

process.umask(0o077);
await mkdir('.work', { recursive: true, mode: 0o700 });
const run = await mkdtemp(resolve('.work/probe-'));
let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
try {
  const workspace = join(run, 'workspace'); await mkdir(workspace);
  const ancestorMarker = 'router-ancestor-config-fixture';
  await writeFile(join(run, 'opencode.json'), JSON.stringify({ instructions: [ancestorMarker] }));
  server = await startIsolatedServer(workspace, join(run, 'agent'));
  const config = await server.client.configuration(workspace);
  if (JSON.stringify(config).includes(ancestorMarker)) throw new Error('Ancestor project configuration leaked into isolated agent');
  const unauthenticated = await fetch(`${server.baseUrl}/api/session?limit=1`, { signal: AbortSignal.timeout(5_000) });
  await unauthenticated.body?.cancel();
  if (unauthenticated.status !== 401) throw new Error('Unauthenticated access was not rejected');
  console.log(JSON.stringify({
    status: 'PASS', packageVersion: OPENCODE_VERSION,
    authenticatedApi: 'PASS', rejectsUnauthenticatedRequests: 'PASS',
    rejectsAncestorConfiguration: 'PASS',
    cloudProvisioning: 'UNTESTED', modelInference: 'UNTESTED',
  }, null, 2));
} finally { await server?.stop(); await rm(run, { recursive: true, force: true }); }

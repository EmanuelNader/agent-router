import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AcpClient } from '../src/client.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'router-acp-'));
  roots.push(root);
  const file = join(root, 'agent.mjs');
  await writeFile(file, `import {createInterface} from 'node:readline';
const mode = ${JSON.stringify(mode)};
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if (!m.method) return;
 if(mode==='hang') return;
 if(mode==='oversize') {process.stdout.write('x'.repeat(1025)+'\\n');return;}
 if(mode==='invalid-utf8') {process.stdout.write(Buffer.from([255,10]));return;}
 if(mode==='unknown-id') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id+1,result:{}})+'\\n');return;}
 if(mode==='malformed') {process.stdout.write('invalid\\n');return;}
 if(mode==='error') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'private-upstream-value'}})+'\\n');return;}
 const result=m.method==='initialize'?{protocolVersion:mode==='wrong-version'?2:1,agentCapabilities:{loadSession:mode!=='no-load'}}:m.method==='session/new'?{sessionId:'fixture-session'}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  return { root, client: new AcpClient({ command: process.execPath, args: [file], cwd: root, env: { PATH: process.env.PATH, HOME: root }, timeoutMs: mode === 'hang' ? 100 : 3000, maxFrameBytes: 1024 }) };
}

test('negotiates ACP v1 before creating and loading sessions', async () => {
  const { root, client } = await fixture();
  try {
    await expect(client.newSession(root)).rejects.toThrow('ACP_NOT_INITIALIZED');
    expect((await client.initialize()).protocolVersion).toBe(1);
    expect(await client.newSession(root)).toBe('fixture-session');
    await expect(client.loadSession('fixture-session', root)).resolves.toBeUndefined();
  } finally { await client.close(); }
});

test.each(['wrong-version', 'no-load', 'malformed', 'error', 'hang', 'oversize', 'invalid-utf8', 'unknown-id'])('fails closed for %s', async mode => {
  const { root, client } = await fixture(mode);
  try {
    if (mode === 'no-load') {
      await client.initialize();
      await expect(client.loadSession('fixture-session', root)).rejects.toThrow('ACP_LOAD_UNSUPPORTED');
    } else {
      await expect(client.initialize()).rejects.toThrow(/^ACP_/);
    }
  } finally { await client.close(); }
});

test('rejects missing explicit environment before spawning an agent', () => {
  expect(() => new AcpClient({ command: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: undefined as unknown as NodeJS.ProcessEnv })).toThrow('ACP_ISOLATED_ENV_REQUIRED');
});

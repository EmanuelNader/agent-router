import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeClient } from './client.js';

export const OPENCODE_VERSION = '2.2.7';

export function isolatedEnvironment(state: string, password: string, path: string): NodeJS.ProcessEnv {
  return {
    PATH: path, LANG: 'en_US.UTF-8', HOME: join(state, 'home'),
    XDG_DATA_HOME: join(state, 'data'), XDG_CONFIG_HOME: join(state, 'config'),
    XDG_STATE_HOME: join(state, 'state'), XDG_CACHE_HOME: join(state, 'cache'),
    TMPDIR: join(state, 'tmp'), OPENCODE_TEST_HOME: join(state, 'home'),
    OPENCODE_CONFIG_DIR: join(state, 'config'), OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
  };
}

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Local verification harness only; not a production process supervisor. */
export async function startIsolatedServer(workspace: string, stateDirectory: string) {
  const state = resolve(stateDirectory);
  const password = randomBytes(32).toString('hex');
  const env = isolatedEnvironment(state, password, process.env.PATH ?? '/usr/bin:/bin');
  for (const name of ['home', 'data', 'config', 'state', 'cache', 'tmp']) {
    await mkdir(join(state, name), { recursive: true, mode: 0o700 });
  }
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const binary = resolve('node_modules/.bin/opencode');
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: resolve(workspace), env, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  });
  let exited = false;
  child.once('error', () => { exited = true; });
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  async function stop() {
    if (exited || !child.pid) return;
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-child.pid!, value); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    signal('SIGTERM');
    await Promise.race([closed, delay(3_000)]);
    if (!exited) { signal('SIGKILL'); await closed; }
  }
  const client = new OpenCodeClient(baseUrl, password);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !exited) {
    try { await client.listSessions(); return { client, baseUrl, stop }; }
    catch { await delay(200); }
  }
  await stop();
  throw new Error('Isolated OpenCode server failed to become ready');
}

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FlyMachinesApi } from '../src/api.js';
import { ApiFlyGateway, FlyMachineLifecycle } from '../src/provider.js';
import { flyDemoEvidence } from '../src/guard.js';
import { OperationJournal } from '../../cli/src/journal.js';

test('tokenless Unix socket permits only the configured Machines self-suspend endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fly-sock-'));
  const socket = join(root, 'api.sock');
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBeUndefined();
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const api = new FlyMachinesApi({ appName: 'fixture-app', machineId: 'abcd1234', connection: { kind: 'self', socketPath: socket } });
    await api.suspend();
    await expect(api.start()).rejects.toThrow('FLY_SELF_SOCKET_SCOPE');
    await expect(api.destroy()).rejects.toThrow('FLY_SELF_SOCKET_SCOPE');
    expect(seen).toEqual(['POST /v1/apps/fixture-app/machines/abcd1234/suspend']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['../escape', 'app/name', 'app?token=value', 'app\nheader'])('rejects path/header injection before any API request: %s', appName => {
  expect(() => new FlyMachinesApi({ appName, machineId: 'abcd1234', connection: { kind: 'https', token: 'fixture-token' } })).toThrow('FLY_INVALID_SCOPE');
});

test('HTTPS contract acquires leases, binds evidence, waits, and reconciles a lost response without retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fly-contract-'));
  const journal = new OperationJournal(root);
  let state = 'suspended';
  let mutations = 0;
  let loseResponse = false;
  const requests: string[] = [];
  const api = new FlyMachinesApi({ appName: 'fixture-app', machineId: 'abcd1234', connection: { kind: 'https', token: 'fixture-only' },
    transport: async request => {
      requests.push(`${request.method} ${request.path}`);
      expect(request.headers.Authorization).toBe('Bearer fixture-only');
      let status = 200;
      let body: unknown = { ok: true };
      if (request.path.endsWith('/lease') && request.method === 'POST') {
        expect(JSON.parse(request.body!).description).toMatch(/^rt_/);
        status = 201; body = { data: { nonce: 'fixture-nonce', expires_at: Date.now() / 1000 + 60 } };
      } else if (request.method === 'GET' && !request.path.includes('/wait?')) {
        if (state === 'destroyed') status = 404;
        else body = { id: 'abcd1234', instance_id: 'fixture-instance', state,
          config: { metadata: { 'agent-router-workspace': 'ws-fly' }, guest: { memory_mb: 512 } } };
      } else if (!request.path.endsWith('/lease') && request.method !== 'GET') {
        expect(request.headers['fly-machine-lease-nonce']).toBe('fixture-nonce');
        mutations++;
        state = request.path.endsWith('/start') ? 'started' : request.path.endsWith('/suspend') ? 'suspended' : 'destroyed';
        if (loseResponse) { loseResponse = false; throw new Error('private-response-body'); }
      }
      return { status, body: Buffer.from(JSON.stringify(body)) };
    },
  });
  try {
    const gateway = new ApiFlyGateway(api, 'ws-fly');
    const lifecycle = new FlyMachineLifecycle({ journal, gateway });
    await expect(lifecycle.transition('ws-fly', 'abcd1234', 'start', flyDemoEvidence())).rejects.toThrow('FLY_START_EVIDENCE_NOT_BOUND');
    expect(mutations).toBe(0);
    const evidence = { ...flyDemoEvidence(), source: 'READ_ONLY_INSPECTION', target: { appName: 'fixture-app', machineId: 'abcd1234', instanceId: 'fixture-instance' } };
    await lifecycle.transition('ws-fly', 'abcd1234', 'start', evidence);
    loseResponse = true;
    await expect(lifecycle.transition('ws-fly', 'abcd1234', 'suspend')).rejects.toThrow('FLY_ACTION_UNCERTAIN');
    const [operation] = await journal.listBlocking();
    expect(await lifecycle.reconcile(operation!.operationId)).toBe('RECONCILED');
    expect(mutations).toBe(2);
    await lifecycle.transition('ws-fly', 'abcd1234', 'delete');
    expect(state).toBe('destroyed');
    expect(await journal.listBlocking()).toEqual([]);
    expect(requests.some(r => r.includes('/wait?state=started&instance_id=fixture-instance&timeout=20'))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses redirects and suppresses raw upstream error bodies', async () => {
  let calls = 0;
  const api = new FlyMachinesApi({ appName: 'fixture-app', machineId: 'abcd1234', connection: { kind: 'https', token: 'fixture-only' },
    transport: async () => { calls++; return { status: 302, body: Buffer.from('private-upstream-value') }; },
  });
  await expect(api.inspect()).rejects.toThrow('FLY_API_REQUEST_FAILED');
  expect(calls).toBe(1);
});

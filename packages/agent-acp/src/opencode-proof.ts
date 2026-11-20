import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedEnvironment, OPENCODE_VERSION, startIsolatedServer } from '../../agent-opencode/src/server.js';
import { requireCompletedShellOutput } from '../../agent-opencode/src/history.js';
import { AcpClient } from './client.js';

/** Credential-free live compatibility proof. No prompts or model requests. */
export async function verifyOpenCodeAcp() {
  const root = await mkdtemp(join(tmpdir(), 'router-acp-live-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  let acp: AcpClient | undefined;
  let http: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
  try {
    await mkdir(workspace, { mode: 0o700 });
    for (const name of ['home', 'data', 'config', 'state', 'cache', 'tmp']) await mkdir(join(state, name), { recursive: true, mode: 0o700 });
    const connect = (stateDir: string, onSessionUpdate?: (params: unknown) => void) => new AcpClient({
      command: resolve('node_modules/.bin/opencode'), args: ['acp'], cwd: workspace,
      env: isolatedEnvironment(stateDir, 'local-proof-no-network-password', process.env.PATH ?? '/usr/bin:/bin'),
      timeoutMs: 45_000, ...(onSessionUpdate ? { onSessionUpdate } : {}),
    });
    acp = connect(state);
    const first = await acp.initialize();
    assert.equal(first.agentInfo?.version, OPENCODE_VERSION);
    assert.equal(first.agentCapabilities.loadSession, true);
    const sessionId = await acp.newSession(workspace);
    await acp.close(); acp = undefined;

    // Seed settled history through the supported HTTP shell endpoint, then stop
    // that process before reopening ACP against the same isolated saved state.
    http = await startIsolatedServer(workspace, state);
    await http.client.runShellCommand(sessionId, "printf 'router-acp-history-fixture\\n'");
    const history = await http.client.exportSession(sessionId);
    requireCompletedShellOutput(history.messages, 'router-acp-history-fixture\n');
    await http.stop(); http = undefined;

    // ACP intentionally omits top-level shell messages. Import an explicitly
    // synthetic saved user message into fresh state to prove nonempty replay.
    const targetState = join(root, 'target-state');
    http = await startIsolatedServer(workspace, targetState);
    await http.client.importSession({ ...history, messages: [...history.messages, {
      id: 'msg_router_acp_fixture_user', type: 'user', time: { created: Date.now() },
      text: 'router-acp-conversation-fixture', files: [], agents: [], skills: [],
    }] }, workspace);
    const imported = await http.client.exportSession(sessionId);
    requireCompletedShellOutput(imported.messages, 'router-acp-history-fixture\n');
    await http.stop(); http = undefined;

    const replay: unknown[] = [];
    acp = connect(targetState, params => { replay.push(params); });
    await acp.initialize();
    await acp.loadSession(sessionId, workspace);
    assert.ok(replay.length > 0, 'ACP load must replay nonempty settled history');
    assert.ok(JSON.stringify(replay).includes('router-acp-conversation-fixture'), 'ACP replay must contain the imported saved user fixture');
    for (const update of replay) assert.equal((update as { sessionId?: unknown }).sessionId, sessionId);
    await acp.close(); acp = undefined;

    // session/resume must reattach the same saved session without replaying it.
    const resumed: unknown[] = [];
    acp = connect(targetState, params => { resumed.push(params); });
    await acp.initialize();
    assert.equal(await acp.reconnectSession(sessionId, workspace), 'resume');
    assert.ok(!JSON.stringify(resumed).includes('router-acp-conversation-fixture'), 'ACP resume must not replay history');
    return { status: 'ACP_VERIFIED' as const, protocolVersion: 1, agentVersion: OPENCODE_VERSION,
      coldResume: true, settledHistoryReplayed: true, resumeWithoutReplay: true, historyFixture: 'IMPORTED_USER_MESSAGE' as const,
      shellHistoryReplay: 'UNSUPPORTED' as const, modelInference: 'UNTESTED' as const };
  } finally {
    await acp?.close();
    await http?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

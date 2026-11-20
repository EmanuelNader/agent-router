import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findClaudeBinary } from '../../packages/agent-claude-code/src/adapter.js';
import { findCodexBinary, SUPPORTED_CODEX_MAJOR_MINOR } from '../../packages/agent-codex/src/adapter.js';
import { startIsolatedServer } from '../../packages/agent-opencode/src/server.js';
import { parseMcpConfig, translateMcpConfig } from '../../packages/workspace/src/mcp-portability.js';

export async function verifyMcpLoaders() {
  const root = await mkdtemp(join(tmpdir(), 'router-mcp-live-'));
  let server: Awaited<ReturnType<typeof startIsolatedServer>> | undefined;
  try {
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex');
    const claudeHome = join(root, 'claude');
    const state = join(root, 'opencode');
    for (const dir of [workspace, codexHome, claudeHome, join(state, 'config')]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const servers = parseMcpConfig(JSON.stringify({ mcp: { servers: { router_fixture: {
      type: 'local', command: ['node', '--version'], environment: { MCP_FIXTURE_TOKEN: '{env:MCP_FIXTURE_TOKEN}' },
    } } } }), 'opencode-v2');
    const codex = findCodexBinary();
    const claude = findClaudeBinary();
    assert.ok(codex && claude, 'Both pinned native CLIs are required');
    function run(binary: string, args: string[], home: string): string {
      try {
        return execFileSync(binary, args, { cwd: workspace, encoding: 'utf8', timeout: 25_000,
          stdio: ['ignore', 'pipe', 'pipe'], env: {
            PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
            XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home,
            TMPDIR: root, MCP_FIXTURE_TOKEN: 'fixture-only',
          },
        });
      } catch { throw new Error('MCP_NATIVE_LOADER_FAILED'); }
    }
    const codexVersion = run(codex, ['--version'], codexHome).trim();
    const claudeVersion = run(claude, ['--version'], claudeHome).trim();
    assert.ok(codexVersion.startsWith(`codex-cli ${SUPPORTED_CODEX_MAJOR_MINOR}`), 'Codex CLI is not the supported release line');
    assert.match(claudeVersion, /^2\.1\.[0-9]+ \(Claude Code\)$/);
    await writeFile(join(codexHome, 'config.toml'), translateMcpConfig(servers, 'codex-cli'), { mode: 0o600 });
    const listed = JSON.parse(run(codex, ['mcp', 'list', '--json'], codexHome));
    assert.ok(Array.isArray(listed));
    const nativeCodex = listed.find((entry: { name?: string }) => entry.name === 'router_fixture');
    assert.ok(nativeCodex, 'Codex must load the translated server');
    assert.equal(nativeCodex.transport.command, 'node');
    assert.deepEqual(nativeCodex.transport.args, ['--version']);
    assert.deepEqual(nativeCodex.transport.env_vars, ['MCP_FIXTURE_TOKEN']);

    await writeFile(join(workspace, '.mcp.json'), translateMcpConfig(servers, 'claude-code'), { mode: 0o600 });
    const nativeClaude = run(claude, ['mcp', 'get', 'router_fixture'], claudeHome);
    assert.ok(nativeClaude.includes('router_fixture') && nativeClaude.includes('node') && nativeClaude.includes('--version'), 'Claude must load translated command/args');

    // Disabled prevents a connection attempt; configuration endpoint proves the
    // pinned native schema, including the v2 disabled field, accepts translation.
    await writeFile(join(state, 'config/opencode.json'), translateMcpConfig(servers.map(s => ({ ...s, enabled: false })), 'opencode-v2'), { mode: 0o600 });
    server = await startIsolatedServer(workspace, state);
    const effective = await server.client.configuration(workspace);
    const candidates: Record<string, unknown>[] = [];
    function visit(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'router_fixture' && child && typeof child === 'object') candidates.push(child as Record<string, unknown>);
        visit(child);
      }
    }
    visit(effective);
    assert.ok(candidates.some(value => value.type === 'local' && value.disabled === true && JSON.stringify(value.command) === '["node","--version"]'), 'OpenCode must load the translated disabled server');
    return { status: 'MCP_LOADERS_VERIFIED' as const, isolatedState: true,
      opencode: '2.3.2', codex: codexVersion.replace('codex-cli ', ''), claude: claudeVersion.split(' ')[0],
      scope: 'CONFIGURATION_LOADING_ONLY' as const };
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

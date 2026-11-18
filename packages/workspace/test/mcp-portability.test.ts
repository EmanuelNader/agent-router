import { expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpConfig, translateMcpConfig, inspectWorkspaceMcp } from '../src/mcp-portability.js';
import { captureAgentCheckpoint } from '../../snapshots/src/checkpoint.js';

const source = JSON.stringify({ mcp: { servers: { fixture: {
  type: 'local', command: ['node', 'server.mjs'], environment: { API_TOKEN: '{env:API_TOKEN}' },
} } } });

test.each(['opencode-v1', 'opencode-v2', 'claude-code', 'codex-cli'] as const)('portable stdio roundtrip through %s preserves environment indirection', format => {
  const servers = parseMcpConfig(source, 'opencode-v2');
  const rendered = translateMcpConfig(servers, format);
  expect(rendered).not.toContain('fixture-secret');
  expect(parseMcpConfig(rendered, format)).toEqual(servers);
});

test.each(['fixture-secret', 'Bearer fixture-secret', '${TOKEN:-fixture-secret}'])('blocks literal credentials without reflecting them: %s', token => {
  const config = JSON.stringify({ mcpServers: { test: { command: 'node', env: { API_TOKEN: token } } } });
  expect(() => parseMcpConfig(config, 'claude-code')).toThrow('MCP_SECRET_LITERAL');
  try { parseMcpConfig(config, 'claude-code'); } catch (error) { expect(String(error)).not.toContain(token); }
});

test.each(['/opt/homebrew/bin/node', '/Users/example/server.mjs'])('blocks macOS stdio paths before Linux handoff: %s', command => {
  expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { test: { command } } }), 'claude-code')).toThrow('MCP_NONPORTABLE_PATH');
});

test('translates a remote bearer environment reference across all formats', () => {
  const servers = parseMcpConfig('[mcp_servers.fixture]\nurl = "https://example.invalid/mcp"\nbearer_token_env_var = "API_TOKEN"\n', 'codex-cli');
  for (const format of ['opencode-v1', 'opencode-v2', 'claude-code', 'codex-cli'] as const) {
    expect(parseMcpConfig(translateMcpConfig(servers, format), format)).toEqual(servers);
  }
});

test('doctor refuses a symlinked Codex config directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-mcp-link-'));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'outside'));
    await symlink('../outside', join(root, 'workspace/.codex'));
    await expect(inspectWorkspaceMcp(join(root, 'workspace'))).rejects.toThrow('MCP_INVALID_CONFIG');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint rescans MCP configuration after quiescing and never stores a late secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-mcp-flush-'));
  let stored = false;
  try {
    await expect(captureAgentCheckpoint({
      workspace: root, agent: { kind: 'none' },
      store: { put: async () => { stored = true; }, get: async () => [] },
      quiesceSource: async () => {
        await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { API_KEY: 'late-secret' } } } }));
      },
    })).rejects.toThrow('MCP_SECRET_LITERAL');
    expect(stored).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  { command: 'node', args: ['--token', 'fixture-secret'] },
  { type: 'http', url: 'https://example.invalid/mcp', headers: { 'X-Custom': 'fixture-secret' } },
  { command: 'node', args: ['--password=fixture-secret'] },
])('blocks credential-bearing arguments or headers', server => {
  expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { fixture: server } }), 'claude-code')).toThrow('MCP_SECRET_LITERAL');
});

test('retains implicit OAuth for a remote server without headers', () => {
  const config = JSON.stringify({ mcp: { servers: { fixture: { type: 'remote', url: 'https://example.invalid/mcp' } } } });
  const parsed = parseMcpConfig(config, 'opencode-v2');
  expect(translateMcpConfig(parsed, 'opencode-v2')).not.toContain('"oauth": false');
});

test('doctor parses JSONC and rejects syntax errors instead of trusting partial data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-mcp-jsonc-'));
  try {
    await writeFile(join(root, 'opencode.jsonc'), '{ // shared server\n "mcp": { "servers": { "fixture": { "type": "local", "command": ["node", "server.mjs"], }, }, }, }');
    expect(await inspectWorkspaceMcp(root)).toEqual({ configsChecked: 1, serversChecked: 1 });
    await writeFile(join(root, 'opencode.jsonc'), '{ "mcp": { "servers": {} }, invalid');
    await expect(inspectWorkspaceMcp(root)).rejects.toThrow('MCP_INVALID_CONFIG');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects duplicate JSON keys rather than losing a hidden literal credential', () => {
  const config = '{"mcpServers":{"fixture":{"command":"node","env":{"API_TOKEN":"hidden-secret","API_TOKEN":"${API_TOKEN}"}}}}';
  expect(() => parseMcpConfig(config, 'claude-code')).toThrow('MCP_DUPLICATE_KEY');
});

test('doctor scans nested project MCP configs too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-mcp-nested-'));
  try {
    await mkdir(join(root, 'packages/nested'), { recursive: true });
    await writeFile(join(root, 'packages/nested/.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { TOKEN: 'nested-secret' } } } }));
    await expect(inspectWorkspaceMcp(root)).rejects.toThrow('MCP_SECRET_LITERAL');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects command expansion that cannot preserve semantics across agents', () => {
  expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['${SERVER_ROOT}/server.js'] } } }), 'claude-code')).toThrow('MCP_COMMAND_EXPANSION_UNSUPPORTED');
  const entries = parseMcpConfig(source, 'opencode-v2');
  entries[0]!.command = ['node', '{env:SERVER_ROOT}/server.js'];
  expect(() => translateMcpConfig(entries, 'codex-cli')).toThrow('MCP_COMMAND_EXPANSION_UNSUPPORTED');
});

test('rejects stdio args on an HTTP server rather than silently dropping them', () => {
  expect(() => parseMcpConfig(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.invalid/mcp', args: ['ignored'] } } }), 'claude-code')).toThrow('MCP_INVALID_CONFIG');
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpConfig, translateMcpConfig } from '../../packages/workspace/src/mcp-portability.js';

execFileSync('pnpm', ['exec', 'vitest', 'run', 'packages/workspace/test/mcp-portability.test.ts', 'packages/workspace/test/mcp-live.test.ts'], {
  stdio: 'ignore', timeout: 120_000,
});
const root = await mkdtemp(join(tmpdir(), 'router-doctor-gate-'));
try {
  const servers = parseMcpConfig(JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['--version'] } } }), 'claude-code');
  await writeFile(join(root, '.mcp.json'), translateMcpConfig(servers, 'claude-code'), { mode: 0o600 });
  const result = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'scripts/router.ts', 'mcp:doctor', '--workspace', root], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
  }));
  assert.equal(result.status, 'MCP_PORTABLE');
  assert.equal(result.configsChecked, 1);
  assert.equal(result.serversChecked, 1);
  console.log('GATE_2_MCP_PORTABILITY_VERIFIED');
} finally { await rm(root, { recursive: true, force: true }); }

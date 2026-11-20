import { expect, test } from 'vitest';
import { isClaudeCodeAvailable } from '../../agent-claude-code/src/adapter.js';
import { isCodexCliAvailable } from '../../agent-codex/src/adapter.js';
import { verifyMcpLoaders } from '../../../scripts/lib/mcp-proof.js';

test.runIf(isCodexCliAvailable() && isClaudeCodeAvailable())('real installed OpenCode, Codex, and Claude loaders recognize translated isolated MCP configs', async () => {
  expect(await verifyMcpLoaders()).toMatchObject({ status: 'MCP_LOADERS_VERIFIED', isolatedState: true });
}, 120_000);

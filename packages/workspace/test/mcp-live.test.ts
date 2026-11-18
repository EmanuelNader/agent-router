import { expect, test } from 'vitest';
import { verifyMcpLoaders } from '../../../scripts/lib/mcp-proof.js';

test('real installed OpenCode, Codex, and Claude loaders recognize translated isolated MCP configs', async () => {
  expect(await verifyMcpLoaders()).toMatchObject({ status: 'MCP_LOADERS_VERIFIED', isolatedState: true });
}, 120_000);

import { expect, test } from 'vitest';
import { verifyOpenCodeAcp } from '../src/opencode-proof.js';

test('real OpenCode 2.2.7 cold-loads settled history over ACP v1', async () => {
  expect(await verifyOpenCodeAcp()).toMatchObject({ status: 'ACP_VERIFIED', coldResume: true, settledHistoryReplayed: true });
}, 120_000);

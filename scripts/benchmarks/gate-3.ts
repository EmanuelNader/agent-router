import assert from 'node:assert/strict';
import { verifyOpenCodeAcp } from '../../packages/agent-acp/src/opencode-proof.js';

const result = await verifyOpenCodeAcp();
assert.equal(result.protocolVersion, 1);
assert.equal(result.agentVersion, '2.3.2');
assert.equal(result.coldResume, true);
assert.equal(result.settledHistoryReplayed, true);
console.log('GATE_3_ACP_V1_VERIFIED');

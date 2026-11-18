import { verifyOpenCodeAcp } from '../packages/agent-acp/src/opencode-proof.js';

try { console.log(JSON.stringify(await verifyOpenCodeAcp(), null, 2)); }
catch { console.error('ACP_PROOF_FAILED'); process.exitCode = 1; }

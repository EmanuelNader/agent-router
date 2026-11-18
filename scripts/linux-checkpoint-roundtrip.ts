import { verifyLinuxCheckpoint } from './lib/linux-checkpoint-proof.js';

try { console.log(JSON.stringify(await verifyLinuxCheckpoint(), null, 2)); }
catch { console.error('LINUX_CHECKPOINT_PROOF_FAILED'); process.exitCode = 1; }

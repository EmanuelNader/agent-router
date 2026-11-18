import { execFileSync } from 'node:child_process';

// Includes native restoration after source deletion, confined/escaping symlinks,
// configurable exclusions, legacy compatibility, and real Ubuntu arm64 restore.
execFileSync('pnpm', ['exec', 'vitest', 'run',
  'packages/snapshots/test/checkpoint.test.ts',
  'packages/snapshots/test/portable.test.ts',
  'packages/snapshots/test/linux-roundtrip.test.ts',
], { stdio: 'ignore', timeout: 120_000 });
console.log('GATE_1_V3_NATIVE_AND_LINUX_RESTORE_VERIFIED');

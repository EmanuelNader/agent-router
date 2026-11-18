import { expect, test } from 'vitest';
import { verifyLinuxCheckpoint } from '../../../scripts/lib/linux-checkpoint-proof.js';

test('restores a dirty linked v3 checkpoint inside real Ubuntu 24.04 arm64 after deleting its source repository', async () => {
  expect(await verifyLinuxCheckpoint()).toMatchObject({ status: 'LINUX_V3_RESTORED', architecture: 'linux/aarch64' });
}, 120_000);

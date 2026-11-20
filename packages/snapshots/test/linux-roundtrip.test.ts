import { expect, test } from 'vitest';
import { CHECKPOINT_LINUX_IMAGE, verifyLinuxCheckpoint } from '../../../scripts/lib/linux-checkpoint-proof.js';
import { isDockerImageAvailable } from '../../cloud-oci/src/linux-guest.js';

test.runIf(isDockerImageAvailable(CHECKPOINT_LINUX_IMAGE))('restores a dirty linked v3 checkpoint inside real Ubuntu 24.04 arm64 after deleting its source repository', async () => {
  expect(await verifyLinuxCheckpoint()).toMatchObject({ status: 'LINUX_V3_RESTORED', architecture: 'linux/aarch64' });
}, 120_000);

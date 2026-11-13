import { expect, test } from 'vitest';
import { DeployError } from '../src/errors.js';
import type { ImageRecord } from '../src/gateway.js';
import { OciImageSelector } from '../src/images.js';

const ubuntu = (patch: Partial<ImageRecord> = {}): ImageRecord => ({
  id: 'ocid1.image.oc1..ubuntu', displayName: 'Canonical-Ubuntu-24.04-aarch64-2026.01.31-0',
  operatingSystem: 'Canonical Ubuntu', operatingSystemVersion: '24.04', lifecycleState: 'AVAILABLE',
  listingType: 'NONE', timeCreated: '2026-01-31T00:00:00.000Z', ...patch,
});

test('selects the newest free Ubuntu aarch64 platform image', () => {
  const chosen = OciImageSelector.select([
    ubuntu({ id: 'old', operatingSystemVersion: '22.04', displayName: 'Canonical-Ubuntu-22.04-aarch64-2025.01.01-0', timeCreated: '2025-01-01T00:00:00.000Z' }),
    ubuntu({ id: 'community', listingType: 'COMMUNITY', timeCreated: '2026-03-01T00:00:00.000Z' }),
    ubuntu({ id: 'billable', billableSizeInGBs: 10 }),
    ubuntu({ id: 'windows', operatingSystem: 'Windows', displayName: 'Windows-Server-2022' }),
    ubuntu(),
  ]);
  expect(chosen.id).toBe('ocid1.image.oc1..ubuntu');
});

test('refuses when every image is paid or the wrong architecture', () => {
  expect(() => OciImageSelector.select([ubuntu({ displayName: 'Canonical-Ubuntu-24.04-x86_64' })])).toThrow(DeployError);
});

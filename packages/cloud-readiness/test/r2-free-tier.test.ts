import { expect, test } from 'vitest';
import { evaluateR2FreeTierGuardrails } from '../src/r2-free-tier.js';

const fixedNow = new Date('2026-11-18T00:00:00.000Z');

test('approves private Cloudflare R2 STANDARD bucket within 85% of 10 GB / 1M Class A / 10M Class B free tier', () => {
  const res = evaluateR2FreeTierGuardrails(
    {
      observedAt: '2026-11-17T23:55:00.000Z',
      storageClass: 'STANDARD',
      storedGbMonth: 3.25,
      monthlyClassAOps: 42_000,
      monthlyClassBOps: 180_000,
      publicDevelopmentUrlEnabled: false,
    },
    { now: fixedNow },
  );

  expect(res).toEqual({
    status: 'GUARDED_FREE_ELIGIBLE',
    blockers: [],
    remainingStorageBufferGb: 5.25,
    remainingClassABuffer: 808_000,
    remainingClassBBuffer: 8_320_000,
  });
});

test('blocks Cloudflare R2 bill traps: Infrequent Access, >8.5 GB storage, Class A/B ops spikes, public r2.dev URL, and stale evidence', () => {
  const traps = evaluateR2FreeTierGuardrails(
    {
      observedAt: '2026-11-17T23:55:00.000Z',
      storageClass: 'INFREQUENT_ACCESS',
      storedGbMonth: 9.1,
      monthlyClassAOps: 900_000,
      monthlyClassBOps: 9_200_000,
      publicDevelopmentUrlEnabled: true,
    },
    { now: fixedNow },
  );

  expect(traps.status).toBe('BLOCKED');
  expect(traps.blockers).toEqual([
    'NON_FREE_R2_STORAGE_CLASS',
    'NEAR_OR_OVER_10GB_R2_CAP',
    'NEAR_OR_OVER_1M_CLASS_A_CAP',
    'NEAR_OR_OVER_10M_CLASS_B_CAP',
    'PUBLIC_R2_BUCKET_EXPOSED',
  ]);

  const stale = evaluateR2FreeTierGuardrails(
    {
      observedAt: '2026-11-17T23:30:00.000Z',
      storageClass: 'STANDARD',
      storedGbMonth: 1.0,
      monthlyClassAOps: 100,
      monthlyClassBOps: 200,
      publicDevelopmentUrlEnabled: false,
    },
    { now: fixedNow },
  );
  expect(stale.status).toBe('BLOCKED');
  expect(stale.blockers).toContain('STALE_R2_EVIDENCE');
});

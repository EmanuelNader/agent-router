import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { perRequestTimeout } from '../src/oci-sdk.js';

test('each request copied from the options gets a fresh deadline', async () => {
  const options = perRequestTimeout(20);
  const first = { ...options }.signal;
  await delay(60);
  expect(first.aborted).toBe(true);
  const later = { ...options }.signal;
  expect(later).not.toBe(first);
  expect(later.aborted).toBe(false);
});

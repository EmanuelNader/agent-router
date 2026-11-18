import { expect, test } from 'vitest';
import { assertSafeRelativePath } from '../src/manifest.js';

const unsafe = Array.from({ length: 8 }, (_, depth) => {
  const prefix = 'nested/'.repeat(depth);
  return [`${prefix}../payload`, `${prefix}./payload`, `${prefix}/payload`, `${prefix}bad\\name`, `${prefix}bad\0name`];
}).flat();
test.each([...unsafe, '', '/', '.', '..'])('path-fuzz rejects unsafe archive path %j', value => {
  expect(() => assertSafeRelativePath(value)).toThrow();
});

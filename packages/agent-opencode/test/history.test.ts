import { expect, test } from 'vitest';
import { requireCompletedShellOutput } from '../src/history.js';

const completed = {
  type: 'shell', status: 'exited', exit: 0, time: { completed: 1 },
  command: "printf 'fixture\\n'", output: { output: 'fixture\n' },
};

test('accepts completed successful shell output', () => {
  expect(() => requireCompletedShellOutput([completed], 'fixture\n')).not.toThrow();
});

test('rejects command-text matches when actual output is absent or incorrect', () => {
  expect(() => requireCompletedShellOutput([{ ...completed, output: { output: '' } }], 'fixture\n')).toThrow();
  expect(() => requireCompletedShellOutput([], 'fixture\n')).toThrow();
});

test('rejects failed and unfinished shell turns even when output matches', () => {
  expect(() => requireCompletedShellOutput([{ ...completed, exit: 1 }], 'fixture\n')).toThrow();
  expect(() => requireCompletedShellOutput([{ ...completed, status: 'running' }], 'fixture\n')).toThrow();
  expect(() => requireCompletedShellOutput([{ ...completed, time: {} }], 'fixture\n')).toThrow();
});

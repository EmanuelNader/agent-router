import { expect, test } from 'vitest';
import { isolatedEnvironment } from '../src/server.js';

test('isolates user state and does not inherit cloud or model credentials', () => {
  const env = isolatedEnvironment('/sandbox/agent', 'temporary-password', '/usr/bin');
  expect(env.HOME).toBe('/sandbox/agent/home');
  expect(env.XDG_DATA_HOME).toBe('/sandbox/agent/data');
  expect(env.XDG_CONFIG_HOME).toBe('/sandbox/agent/config');
  expect(env.OPENCODE_PASSWORD).toBe('temporary-password');
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
  expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
  expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(env).not.toHaveProperty('OPENAI_API_KEY');
});

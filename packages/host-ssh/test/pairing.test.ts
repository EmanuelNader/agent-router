import { expect, test } from 'vitest';
import { buildRemotePairingCommands, runRemotePairingOverSsh } from '../src/pairing.js';

test('builds non-interactive remote pairing commands for OpenCode, Codex CLI, and Claude Code', () => {
  expect(buildRemotePairingCommands('opencode')).toEqual([['opencode', 'pair', '--remote', '--yes']]);
  expect(buildRemotePairingCommands('codex-cli')).toEqual([
    ['codex', 'remote-control', 'start', '--json'],
    ['codex', 'remote-control', 'pair', '--json'],
  ]);
  expect(buildRemotePairingCommands('claude-code', { sessionName: 'worker-nbg1' })).toEqual([
    ['claude', 'remote-control', '--name', 'worker-nbg1'],
  ]);
  expect(() => buildRemotePairingCommands('claude-code', { sessionName: 'bad name;rm' })).toThrow(/sessionName/i);
});

test('executes multi-step Codex remote-control pairing over SSH runner and parses JSON pairing payload', async () => {
  const seen: string[][] = [];
  const res = await runRemotePairingOverSsh(
    {
      async runRemoteCommand(cmd) {
        seen.push(cmd);
        if (cmd.includes('start')) {
          return { stdout: '{"status":"ready"}\n' };
        }
        return {
          stdout:
            '{"pairingCode":"ABCD-1234","manualPairingCode":"ABCD-1234","environmentId":"env_99","expiresAt":"2026-11-18T05:00:00Z"}\n',
        };
      },
    },
    'codex-cli',
  );

  expect(seen).toHaveLength(2);
  expect(res.codexPairing).toEqual({
    pairingCode: 'ABCD-1234',
    manualPairingCode: 'ABCD-1234',
    environmentId: 'env_99',
    expiresAt: '2026-11-18T05:00:00Z',
  });
});

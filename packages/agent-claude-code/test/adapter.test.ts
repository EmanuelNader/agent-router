import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  encodeClaudeProjectSlug,
  exportClaudeProjectBundle,
  importClaudeProjectBundle,
  isClaudeCodeAvailable,
  rebindClaudeTranscriptLine,
  verifyClaudeProjectRecognition,
} from '../src/adapter.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('encodes Claude project slugs and remaps top-level transcript cwd without altering user prose', () => {
  expect(encodeClaudeProjectSlug('/Users/alice/.work_dir/my.app')).toBe('-Users-alice--work-dir-my-app');

  const line = JSON.stringify({
    type: 'user',
    uuid: '11111111-2222-4333-8444-555555555555',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    cwd: '/Users/alice/app/packages/web',
    message: {
      role: 'user',
      content: 'Check /Users/alice/app/packages/web please',
    },
  });

  const rebound = JSON.parse(rebindClaudeTranscriptLine(line, '/Users/alice/app', '/var/lib/router/app')) as {
    cwd: string;
    message: { content: string };
  };
  expect(rebound.cwd).toBe('/var/lib/router/app/packages/web');
  expect(rebound.message.content).toBe('Check /Users/alice/app/packages/web please');
});

describe.runIf(isClaudeCodeAvailable())('Live Claude Code CLI project-store compatibility', () => {
  test(
    'exports isolated CLAUDE_CONFIG_DIR transcripts, relocates slug + cwd, and proves live claude binary recognition',
    async () => {
      const rawRoot = await mkdtemp(join(tmpdir(), 'router-claude-live-'));
      tempDirs.push(rawRoot);
      const root = await realpath(rawRoot);

      const srcWs = join(root, 'laptop.workspace_a');
      const dstWs = join(root, 'cloud.workspace_b');
      await mkdir(srcWs, { recursive: true, mode: 0o700 });
      await mkdir(dstWs, { recursive: true, mode: 0o700 });

      const claudeConfigA = join(root, 'claude-config-a');
      const srcSlugDir = join(claudeConfigA, 'projects', encodeClaudeProjectSlug(srcWs));
      await mkdir(srcSlugDir, { recursive: true, mode: 0o700 });

      const sessionId = '93bc0449-4ff1-474a-bc36-876654f935c2';
      await writeFile(
        join(srcSlugDir, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: 'summary', summary: 'Portable Claude session', leafUuid: 'u2' }),
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            sessionId,
            cwd: srcWs,
            message: { role: 'user', content: 'run tests' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'u2',
            parentUuid: 'u1',
            sessionId,
            cwd: srcWs,
            message: { role: 'assistant', content: [{ type: 'text', text: 'All tests passed.' }] },
          }),
        ].join('\n') + '\n',
        { mode: 0o600 },
      );

      const bundle = await exportClaudeProjectBundle(claudeConfigA, srcWs);
      expect(bundle.sessions).toHaveLength(1);
      expect(bundle.sessions[0]?.sessionId).toBe(sessionId);

      const claudeConfigB = join(root, 'claude-config-b');
      const importedIds = await importClaudeProjectBundle(bundle, claudeConfigB, dstWs);
      expect(importedIds).toEqual([sessionId]);

      // Refuses overwriting an already-populated destination project store
      await expect(importClaudeProjectBundle(bundle, claudeConfigB, dstWs)).rejects.toMatchObject({
        code: 'EEXIST',
      });

      const relocatedFile = join(
        claudeConfigB,
        'projects',
        encodeClaudeProjectSlug(dstWs),
        `${sessionId}.jsonl`,
      );
      const relocatedLines = (await readFile(relocatedFile, 'utf8')).trim().split('\n');
      expect((JSON.parse(relocatedLines[1]!) as { cwd: string }).cwd).toBe(dstWs);

      // Verify the real installed `claude` CLI recognizes the relocated project transcript directory!
      const verified = await verifyClaudeProjectRecognition({
        isolatedHome: join(root, 'home-b'),
        claudeConfigDir: claudeConfigB,
        workspace: dstWs,
      });
      expect(verified.recognized).toBe(true);
      expect(verified.expectedSlugDirectory).toBe(
        join(claudeConfigB, 'projects', encodeClaudeProjectSlug(dstWs)),
      );
    },
    15_000,
  );
});

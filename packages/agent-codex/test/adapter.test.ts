import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  exportCodexRolloutBundle,
  importCodexRolloutBundle,
  isCodexCliAvailable,
  rebindCodexRolloutLine,
  startIsolatedCodexAppServer,
} from '../src/adapter.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('rebinds Codex rollout JSONL cwd and runtime_workspace_roots without altering message text', () => {
  const line = JSON.stringify({
    timestamp: '2026-11-18T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: '01a1ec9c-0000-7000-8000-000000000001',
      cwd: '/Users/laptop/project',
      runtime_workspace_roots: ['/Users/laptop/project', '/Users/laptop/project/packages/api'],
      note: 'User mentioned /Users/laptop/project in prose',
    },
  });

  const rebound = JSON.parse(rebindCodexRolloutLine(line, '/Users/laptop/project', '/var/lib/router/project')) as {
    payload: { cwd: string; runtime_workspace_roots: string[]; note: string };
  };
  expect(rebound.payload.cwd).toBe('/var/lib/router/project');
  expect(rebound.payload.runtime_workspace_roots).toEqual([
    '/var/lib/router/project',
    '/var/lib/router/project/packages/api',
  ]);
  expect(rebound.payload.note).toBe('User mentioned /Users/laptop/project in prose');
});

describe.runIf(isCodexCliAvailable())('Live Codex CLI app-server compatibility', () => {
  test(
    'records a settled shell turn in isolated CODEX_HOME and cold-resumes in a fresh CODEX_HOME + relocated workspace',
    async () => {
      const rawRoot = await mkdtemp(join(tmpdir(), 'router-codex-live-'));
      tempDirs.push(rawRoot);
      const root = await realpath(rawRoot);

      const srcWorkspace = join(root, 'ws-laptop');
      const dstWorkspace = join(root, 'ws-cloud');
      await mkdir(srcWorkspace, { recursive: true, mode: 0o700 });
      await mkdir(dstWorkspace, { recursive: true, mode: 0o700 });

      const serverA = await startIsolatedCodexAppServer({
        isolatedHome: join(root, 'home-a'),
        codexHome: join(root, 'codex-a'),
      });
      let threadId: string;
      try {
        threadId = await serverA.startThread(srcWorkspace);
        await serverA.runShellCommand(threadId, "printf 'codex-portable-turn-42\\n'");
      } finally {
        await serverA.stop();
      }

      const bundle = await exportCodexRolloutBundle(join(root, 'codex-a'), srcWorkspace);
      expect(bundle.rollouts).toHaveLength(1);
      expect(bundle.rollouts[0]?.threadId).toBe(threadId);

      await importCodexRolloutBundle(bundle, join(root, 'codex-b'), dstWorkspace);

      const serverB = await startIsolatedCodexAppServer({
        isolatedHome: join(root, 'home-b'),
        codexHome: join(root, 'codex-b'),
      });
      try {
        const resumed = await serverB.resumeThread(threadId, dstWorkspace);
        expect(resumed.cwd).toBe(dstWorkspace);

        const thread = await serverB.readThread(threadId);
        expect(thread.cwd).toBe(dstWorkspace);
        expect(thread.turns).toHaveLength(1);
        expect(thread.turns[0]?.status).toBe('completed');
        expect(JSON.stringify(thread.turns[0]?.items)).toContain('codex-portable-turn-42');
      } finally {
        await serverB.stop();
      }
    },
    25_000,
  );
});

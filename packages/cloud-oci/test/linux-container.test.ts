import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { encodeClaudeProjectSlug } from '../../agent-claude-code/src/adapter.js';
import { captureAgentCheckpoint, restoreAgentCheckpoint } from '../../snapshots/src/checkpoint.js';
import { LocalEncryptedStore } from '../../snapshots/src/store.js';
import { buildWorkerBootstrapScript } from '../src/cloud-init.js';
import { isDockerImageAvailable, runLinuxWorkerContainerCheck } from '../src/linux-guest.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.runIf(isDockerImageAvailable('ubuntu:24.04'))('Live Ubuntu 24.04 aarch64 container verification', () => {
  test(
    'validates bootstrap script under Ubuntu dash, enforces 0700 agentrouter dirs, and executes darwin -> linux -> darwin roundtrip',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'router-linux-guest-'));
      tempDirs.push(root);

      const macSrc = join(root, 'mac-src');
      const linuxMount = join(root, 'linux-mount');
      await mkdir(join(macSrc, 'scripts'), { recursive: true, mode: 0o700 });
      await writeFile(
        join(macSrc, 'scripts/probe.sh'),
        '#!/bin/sh\nset -eu\nprintf "%s/%s\\n" "$(uname -s)" "$(uname -m)" > linux-output.txt\n',
        { mode: 0o755 },
      );
      await chmod(join(macSrc, 'scripts/probe.sh'), 0o755);

      const claudeMac = join(root, 'claude-mac');
      const slugMac = join(claudeMac, 'projects', encodeClaudeProjectSlug(macSrc));
      await mkdir(slugMac, { recursive: true, mode: 0o700 });
      const uuid = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
      await writeFile(
        join(slugMac, `${uuid}.jsonl`),
        `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: uuid, cwd: macSrc, message: { role: 'user', content: 'cross-os' } })}\n`,
        { mode: 0o600 },
      );

      const store = new LocalEncryptedStore(join(root, 'store'), randomBytes(32));
      const manifest = await captureAgentCheckpoint({
        workspace: macSrc,
        store,
        agent: { kind: 'claude-code', claudeConfigDir: claudeMac },
      });

      const restoredTarget = join(linuxMount, 'ws');
      const claudeLinux = join(linuxMount, 'claude-cfg');
      await restoreAgentCheckpoint({
        checkpointId: manifest.checkpointId,
        targetWorkspace: restoredTarget,
        store,
        agent: { kind: 'claude-code', targetClaudeConfigDir: claudeLinux },
      });

      const guestResult = await runLinuxWorkerContainerCheck({
        image: 'ubuntu:24.04',
        bootstrapScript: buildWorkerBootstrapScript('2.2.7'),
        hostWorkspaceDir: restoredTarget,
      });

      expect(guestResult.dashSyntaxValid).toBe(true);
      expect(guestResult.spoolStat).toBe('700:agentrouter:agentrouter');
      expect(guestResult.workspacesStat).toBe('700:agentrouter:agentrouter');
      expect(guestResult.probeOutput).toMatch(/^Linux\/(aarch64|x86_64)$/);

      // Capture updated Linux workspace back into encrypted store and restore to a second macOS workspace
      const returnManifest = await captureAgentCheckpoint({
        workspace: restoredTarget,
        store,
        agent: { kind: 'claude-code', claudeConfigDir: claudeLinux },
      });
      const macFinal = join(root, 'mac-final');
      const claudeMacFinal = join(root, 'claude-mac-final');
      await restoreAgentCheckpoint({
        checkpointId: returnManifest.checkpointId,
        targetWorkspace: macFinal,
        store,
        agent: { kind: 'claude-code', targetClaudeConfigDir: claudeMacFinal },
      });

      expect((await readFile(join(macFinal, 'linux-output.txt'), 'utf8')).trim()).toMatch(
        /^Linux\/(aarch64|x86_64)$/,
      );
    },
    30_000,
  );
});

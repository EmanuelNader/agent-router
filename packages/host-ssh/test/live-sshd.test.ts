import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildResticRemoteConfig, isResticAvailable, ResticRepositoryStore } from '../../snapshots/src/restic.js';
import { isLocalSshdAvailable, startEphemeralSshd, type EphemeralSshd } from '../src/ephemeral-sshd.js';
import { SshCliTransport } from '../src/transport.js';

const tempDirs: string[] = [];
const daemons: EphemeralSshd[] = [];

afterEach(async () => {
  while (daemons.length > 0) {
    const daemon = daemons.pop();
    if (daemon) await daemon.close();
  }
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe.runIf(isLocalSshdAvailable())('Live non-root OpenSSH daemon integration', () => {
  test('transfers checkpoints over real /usr/bin/ssh + /usr/bin/scp and rejects host-key mismatch or overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'router-live-sshd-'));
    tempDirs.push(root);

    const sshd = await startEphemeralSshd(join(root, 'sshd-state'));
    daemons.push(sshd);

    const remoteSpool = join(root, 'remote-spool');
    const transport = new SshCliTransport({
      target: `${sshd.username}@127.0.0.1`,
      port: sshd.port,
      remoteSpoolDirectory: remoteSpool,
      identityFile: sshd.clientPrivateKeyPath,
      knownHostsFile: sshd.knownHostsPath,
    });

    const versionCheck = await transport.runRemoteCommand(['echo', 'live-sshd-ok']);
    expect(versionCheck.stdout.trim()).toBe('live-sshd-ok');

    const payload = Buffer.concat([Buffer.from('AR01-live-openssh-'), randomBytes(64)]);
    const checkpointId = 'chk_0123456789abcdef';

    await transport.transferEncryptedCheckpoint(checkpointId, payload);
    const downloaded = await transport.readTransferredCheckpoint(checkpointId);
    expect(downloaded).toEqual(payload);

    // Second upload of the same checkpoint ID must fail closed with EEXIST over real SSH
    await expect(transport.transferEncryptedCheckpoint(checkpointId, payload)).rejects.toMatchObject({
      code: 'EEXIST',
    });

    // Empty/mismatched known_hosts must fail closed under StrictHostKeyChecking=yes
    const badKnownHostsTransport = new SshCliTransport({
      target: `${sshd.username}@127.0.0.1`,
      port: sshd.port,
      remoteSpoolDirectory: remoteSpool,
      identityFile: sshd.clientPrivateKeyPath,
      knownHostsFile: join(root, 'empty-known-hosts'),
    });
    await expect(
      badKnownHostsTransport.runRemoteCommand(['echo', 'should-not-connect']),
    ).rejects.toThrow(/SSH remote command/i);
  }, 20_000);

  test.runIf(isResticAvailable())(
    'backs up, checks, and restores a snapshot over real restic sftp:// against live sshd',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'router-live-restic-sftp-'));
      tempDirs.push(root);

      const sshd = await startEphemeralSshd(join(root, 'sshd-state'));
      daemons.push(sshd);

      const remoteRepoDir = join(root, 'sftp-restic-repo');
      const sftpConfig = buildResticRemoteConfig({
        kind: 'sftp',
        target: `${sshd.username}@127.0.0.1`,
        port: sshd.port,
        path: remoteRepoDir,
        identityFile: sshd.clientPrivateKeyPath,
        knownHostsFile: sshd.knownHostsPath,
      });

      const store = ResticRepositoryStore.fromRemoteConfig(
        sftpConfig,
        randomBytes(32).toString('hex'),
      );
      const checkpointId = 'chk_fedcba9876543210';
      await store.put(checkpointId, [
        { path: 'workspace/run.sh', executable: true, data: Buffer.from('#!/bin/sh\necho sftp-ok\n') },
        { path: 'workspace/notes.md', executable: false, data: Buffer.from('verified over live sftp\n') },
      ]);

      await store.verifyIntegrity();
      const restored = await store.get(checkpointId);
      expect(restored).toEqual([
        { path: 'workspace/notes.md', executable: false, data: Buffer.from('verified over live sftp\n') },
        { path: 'workspace/run.sh', executable: true, data: Buffer.from('#!/bin/sh\necho sftp-ok\n') },
      ]);
    },
    30_000,
  );
});

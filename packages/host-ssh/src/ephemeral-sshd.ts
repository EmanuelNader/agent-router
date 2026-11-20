import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface EphemeralSshd {
  port: number;
  username: string;
  clientPrivateKeyPath: string;
  clientPublicKeyPath: string;
  knownHostsPath: string;
  close(): Promise<void>;
}

function findSshdBinary(): string | null {
  for (const candidate of ['/usr/sbin/sshd', '/sbin/sshd']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findSftpSubsystem(): string {
  for (const candidate of [
    '/usr/libexec/sftp-server',
    '/usr/lib/openssh/sftp-server',
    '/usr/lib64/misc/sftp-server',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'internal-sftp';
}

export function isLocalSshdAvailable(): boolean {
  return findSshdBinary() !== null && existsSync('/usr/bin/ssh') && existsSync('/usr/bin/scp');
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close();
        reject(new Error('Failed to bind ephemeral loopback port'));
        return;
      }
      const { port } = address;
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForSshBanner(port: number, proc: ChildProcess, getLogs: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`sshd exited prematurely (code ${proc.exitCode}): ${getLogs()}`);
    }
    const ready = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(500, () => done(false));
      socket.once('error', () => done(false));
      socket.on('data', chunk => {
        if (chunk.toString('utf8').startsWith('SSH-2.0-')) done(true);
      });
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, 75));
  }
  throw new Error(`Timed out waiting for ephemeral sshd banner: ${getLogs()}`);
}

export async function startEphemeralSshd(stateDirectory: string): Promise<EphemeralSshd> {
  const sshdBinary = findSshdBinary();
  if (!sshdBinary) throw new Error('Local sshd binary not available');

  const dir = path.resolve(stateDirectory);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const hostKeyPath = path.join(dir, 'ssh_host_ed25519_key');
  const clientPrivateKeyPath = path.join(dir, 'id_ed25519');
  const clientPublicKeyPath = `${clientPrivateKeyPath}.pub`;
  const authorizedKeysPath = path.join(dir, 'authorized_keys');
  const knownHostsPath = path.join(dir, 'known_hosts');
  const pidPath = path.join(dir, 'sshd.pid');
  const configPath = path.join(dir, 'sshd_config');

  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKeyPath]);
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientPrivateKeyPath]);
  await chmod(hostKeyPath, 0o600);
  await chmod(clientPrivateKeyPath, 0o600);

  const clientPub = (await readFile(clientPublicKeyPath, 'utf8')).trim();
  await writeFile(authorizedKeysPath, `${clientPub}\n`, { mode: 0o600 });
  await chmod(authorizedKeysPath, 0o600);

  const hostPubParts = (await readFile(`${hostKeyPath}.pub`, 'utf8')).trim().split(/\s+/);
  const hostKeyEntry = `${hostPubParts[0]} ${hostPubParts[1]}`;
  const port = await allocateLoopbackPort();
  await writeFile(knownHostsPath, `[127.0.0.1]:${port} ${hostKeyEntry}\n`, { mode: 0o600 });
  await chmod(knownHostsPath, 0o600);

  const username = os.userInfo().username;
  const sftpSubsystem = findSftpSubsystem();
  const configBody = [
    `ListenAddress 127.0.0.1:${port}`,
    `HostKey ${hostKeyPath}`,
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    `PidFile ${pidPath}`,
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PermitRootLogin no',
    // StrictModes rejects key files below a world-writable ancestor such as Linux /tmp.
    'StrictModes no',
    `AllowUsers ${username}`,
    `Subsystem sftp ${sftpSubsystem}`,
    '',
  ].join('\n');

  await writeFile(configPath, configBody, { mode: 0o600 });
  execFileSync(sshdBinary, ['-t', '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderrLog = '';
  const child = spawn(sshdBinary, ['-D', '-e', '-f', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrLog = (stderrLog + chunk.toString('utf8')).slice(-4096);
  });

  try {
    await waitForSshBanner(port, child, () => stderrLog);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  return {
    port,
    username,
    clientPrivateKeyPath,
    clientPublicKeyPath,
    knownHostsPath,
    async close() {
      if (child.exitCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
}

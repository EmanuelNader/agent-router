import { spawn, type ChildProcess } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';

export interface TunnelTarget {
  host: string;
  privateKeyPath: string;
  knownHostsPath: string;
  user?: string;
  remotePort?: number;
  freshHost?: boolean;
}

/** Presents the instance loopback server as 127.0.0.1 so the existing client can use HTTP. */
export class SshLoopbackTunnel {
  static commandArgs(input: TunnelTarget & { localPort: number }): string[] {
    if (!this.ipv4(input.host)) throw new Error('SSH_TUNNEL_FAILED');
    const user = input.user ?? 'ubuntu';
    const remotePort = input.remotePort ?? 4096;
    return [
      '-i', input.privateKeyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${input.knownHostsPath}`,
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=15',
      '-N',
      '-L', `127.0.0.1:${input.localPort}:127.0.0.1:${remotePort}`,
      `${user}@${input.host}`,
    ];
  }

  static async forgetHost(knownHostsPath: string, host: string): Promise<void> {
    if (!this.ipv4(host)) throw new Error('SSH_TUNNEL_FAILED');
    try { await lstat(knownHostsPath); } catch { return; }
    const child = spawn('ssh-keygen', ['-R', host, '-f', knownHostsPath], { stdio: 'ignore' });
    await new Promise<void>(resolve => child.once('close', () => resolve()));
  }

  /** Password stays on stdin. The remote argv is root-only and does not include the secret. */
  static remoteInstallCommand(): string {
    return 'sudo -n sh -c \'install -d -m 0755 /etc/agent-router && cat > /etc/agent-router/opencode.env && chmod 0600 /etc/agent-router/opencode.env && systemctl daemon-reload && systemctl enable --now agent-router-opencode\'';
  }

  static async deliverPassword(input: TunnelTarget & { password: string }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.password)) throw new Error('SSH_TUNNEL_FAILED');
    if (input.freshHost) await this.forgetHost(input.knownHostsPath, input.host);
    const child = spawn('ssh', this.remoteArgs(input).concat(this.remoteInstallCommand()), { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin?.end(`OPENCODE_PASSWORD=${input.password}\n`);
    await this.finished(child);
  }

  static async open(input: TunnelTarget): Promise<{ baseUrl: string; close(): Promise<void> }> {
    if (input.freshHost) await this.forgetHost(input.knownHostsPath, input.host);
    const localPort = await this.port();
    const child = spawn('ssh', this.commandArgs({ ...input, localPort }), { stdio: 'ignore' });
    let exited = false;
    const closed = new Promise<void>(resolve => {
      child.once('error', () => { exited = true; resolve(); });
      child.once('close', () => { exited = true; resolve(); });
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !exited) {
      if (await this.accepts(localPort)) {
        return {
          baseUrl: `http://127.0.0.1:${localPort}`,
          async close() {
            if (!exited && child.pid) child.kill('SIGTERM');
            await closed;
          },
        };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!exited && child.pid) child.kill('SIGTERM');
    await closed;
    throw new Error('SSH_TUNNEL_FAILED');
  }

  private static remoteArgs(input: TunnelTarget): string[] {
    if (!this.ipv4(input.host)) throw new Error('SSH_TUNNEL_FAILED');
    const user = input.user ?? 'ubuntu';
    return [
      '-i', input.privateKeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${input.knownHostsPath}`,
      '-o', 'ConnectTimeout=15', `${user}@${input.host}`,
    ];
  }

  private static finished(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('SSH_TUNNEL_FAILED')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error('SSH_TUNNEL_FAILED')));
    });
  }

  private static ipv4(host: string): boolean {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return Boolean(match && [match[1], match[2], match[3], match[4]].every(part => Number(part) <= 255));
  }

  private static async port(): Promise<number> {
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', resolve);
    });
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('SSH_TUNNEL_FAILED');
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    return address.port;
  }

  private static async accepts(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const done = (value: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }
}

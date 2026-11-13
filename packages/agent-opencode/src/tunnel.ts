import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

export interface TunnelTarget {
  host: string;
  privateKeyPath: string;
  knownHostsPath: string;
  user?: string;
  remotePort?: number;
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

  static async open(input: TunnelTarget): Promise<{ baseUrl: string; close(): Promise<void> }> {
    const localPort = await this.port();
    const child = spawn('ssh', this.commandArgs({ ...input, localPort }), { stdio: 'ignore' });
    let exited = false;
    child.once('error', () => { exited = true; });
    child.once('close', () => { exited = true; });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !exited) {
      if (await this.accepts(localPort)) {
        return {
          baseUrl: `http://127.0.0.1:${localPort}`,
          async close() {
            if (!exited && child.pid) child.kill('SIGTERM');
          },
        };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!exited && child.pid) child.kill('SIGTERM');
    throw new Error('SSH_TUNNEL_FAILED');
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

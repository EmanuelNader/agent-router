import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashWorkspace } from '../../workspace/src/manifest.js';

const execFileAsync = promisify(execFile);

export function isDockerImageAvailable(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface LinuxWorkerContainerCheckResult {
  dashSyntaxValid: boolean;
  sha256VerifiedInGuest: boolean;
  spoolStat: string;
  workspacesStat: string;
  probeOutput: string;
}

/**
 * Boots an air-gapped (`--rm --network none`) Linux container (e.g. `ubuntu:24.04` `aarch64`),
 * validates our `#cloud-config` bootstrap script under Ubuntu's strict POSIX `dash` (`/bin/sh -n`),
 * verifies SHA-256 digests via `sha256sum -c` inside Linux, provisions the non-root `agentrouter`
 * user + `0700` directories, and executes the restored workspace probe script as `agentrouter`.
 */
export async function runLinuxWorkerContainerCheck(options: {
  image: string;
  bootstrapScript: string;
  hostWorkspaceDir: string;
}): Promise<LinuxWorkerContainerCheckResult> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'router-docker-check-'));
  const containerName = `agent-router-verify-${randomBytes(6).toString('hex')}`;

  try {
    await chmod(scratch, 0o700);
    const localBootstrap = path.join(scratch, 'bootstrap.sh');
    await writeFile(localBootstrap, options.bootstrapScript, { mode: 0o700 });

    const bootstrapSha = createHash('sha256').update(options.bootstrapScript, 'utf8').digest('hex');
    const wsReceipts = await hashWorkspace(options.hostWorkspaceDir);
    const shaManifestLines = [
      `${bootstrapSha}  /tmp/bootstrap.sh`,
      ...wsReceipts.map(r => `${r.sha256}  /var/lib/agent-router/workspaces/active/${r.path}`),
    ];
    const localShaSums = path.join(scratch, 'SHASUMS256.txt');
    await writeFile(localShaSums, `${shaManifestLines.join('\n')}\n`, { mode: 0o600 });

    await execFileAsync(
      'docker',
      ['run', '-d', '--rm', '--network', 'none', '--name', containerName, options.image, 'sleep', '60'],
      { timeout: 20_000 },
    );

    await execFileAsync('docker', ['cp', localBootstrap, `${containerName}:/tmp/bootstrap.sh`], {
      timeout: 10_000,
    });
    await execFileAsync('docker', ['cp', localShaSums, `${containerName}:/tmp/SHASUMS256.txt`], {
      timeout: 10_000,
    });
    await execFileAsync(
      'docker',
      ['cp', `${path.resolve(options.hostWorkspaceDir)}/.`, `${containerName}:/tmp/in-ws`],
      { timeout: 10_000 },
    );

    const verifyScript = [
      'set -eu',
      '/bin/sh -n /tmp/bootstrap.sh',
      'id -u agentrouter >/dev/null 2>&1 || useradd -m -s /bin/bash agentrouter',
      'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router',
      'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router/spool',
      'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router/workspaces',
      'cp -R /tmp/in-ws /var/lib/agent-router/workspaces/active',
      'sha256sum -c /tmp/SHASUMS256.txt >/dev/null',
      'chown -R agentrouter:agentrouter /var/lib/agent-router/workspaces/active',
      'su -s /bin/sh agentrouter -c "cd /var/lib/agent-router/workspaces/active && ./scripts/probe.sh"',
      'printf "SPOOL=%s\\n" "$(stat -c \'%a:%U:%G\' /var/lib/agent-router/spool)"',
      'printf "WORKSPACES=%s\\n" "$(stat -c \'%a:%U:%G\' /var/lib/agent-router/workspaces)"',
    ].join('\n');

    const { stdout } = await execFileAsync('docker', ['exec', containerName, '/bin/sh', '-ceu', verifyScript], {
      timeout: 15_000,
    });

    const returnedFile = path.join(options.hostWorkspaceDir, 'linux-output.txt');
    await execFileAsync(
      'docker',
      ['cp', `${containerName}:/var/lib/agent-router/workspaces/active/linux-output.txt`, returnedFile],
      { timeout: 10_000 },
    );
    await chmod(returnedFile, 0o600);

    const lines = stdout.trim().split('\n');
    const spoolLine = lines.find(l => l.startsWith('SPOOL='))?.slice('SPOOL='.length) ?? '';
    const workspacesLine = lines.find(l => l.startsWith('WORKSPACES='))?.slice('WORKSPACES='.length) ?? '';
    const probeOutput = (await readFile(returnedFile, 'utf8')).trim();

    return {
      dashSyntaxValid: true,
      sha256VerifiedInGuest: true,
      spoolStat: spoolLine,
      workspacesStat: workspacesLine,
      probeOutput,
    };
  } finally {
    await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 10_000 }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

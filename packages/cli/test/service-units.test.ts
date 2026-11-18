import { expect, test } from 'vitest';
import { renderLaunchdPlist, renderSystemdUserUnits } from '../src/service-units.js';

test('renders hardened systemd --user service + timer and macOS launchd plist with isolated HOME and 0077 umask', () => {
  const systemd = renderSystemdUserUnits({
    serviceName: 'agent-router-watch',
    nodeExecutable: '/usr/local/bin/node',
    cliEntrypoint: '/opt/agent-router/bin/agent-router.mjs',
    workingDirectory: '/var/lib/agent-router',
    routerArgs: ['watch:simulate', '--workspace-key', 'ws-prod'],
    intervalSec: 120,
  });

  expect(systemd.serviceUnitName).toBe('agent-router-watch.service');
  expect(systemd.timerUnitName).toBe('agent-router-watch.timer');
  expect(systemd.serviceContent).toContain('NoNewPrivileges=true');
  expect(systemd.serviceContent).toContain('PrivateTmp=true');
  expect(systemd.serviceContent).toContain('UMask=0077');
  expect(systemd.serviceContent).toContain('Environment="HOME=/var/lib/agent-router/isolated-home"');
  expect(systemd.timerContent).toContain('OnUnitActiveSec=120s');

  const launchd = renderLaunchdPlist({
    serviceName: 'agent-router-watch',
    nodeExecutable: '/opt/homebrew/bin/node',
    cliEntrypoint: '/opt/agent-router/bin/agent-router.mjs',
    workingDirectory: '/var/lib/agent-router',
    routerArgs: ['watch:simulate', '--workspace-key', 'ws-prod&1'],
    intervalSec: 300,
  });

  expect(launchd.label).toBe('dev.agentrouter.agent-router-watch');
  expect(launchd.plistContent).toContain('<string>ws-prod&amp;1</string>');
  expect(launchd.plistContent).toContain('<integer>300</integer>');
  expect(launchd.plistContent).toContain('<string>/var/lib/agent-router/isolated-home</string>');

  expect(() =>
    renderSystemdUserUnits({
      nodeExecutable: '/usr/local/bin/node',
      cliEntrypoint: '/opt/agent-router/bin/agent-router.mjs',
      workingDirectory: 'relative/dir',
      routerArgs: ['status'],
    }),
  ).toThrow(/absolute/i);
});

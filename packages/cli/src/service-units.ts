import { homedir } from 'node:os';
import path from 'node:path';

const safeServiceNamePattern = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export interface ServiceUnitSpec {
  serviceName?: string;
  nodeExecutable?: string;
  cliEntrypoint: string;
  workingDirectory: string;
  routerArgs: string[];
  intervalSec?: number;
}

export interface RenderedSystemdUnits {
  serviceUnitName: string;
  timerUnitName: string;
  serviceContent: string;
  timerContent: string;
}

export interface RenderedLaunchdPlist {
  label: string;
  plistFileName: string;
  plistContent: string;
}

function validateSafeAbsolutePath(filePath: string, label: string): string {
  if (
    !path.posix.isAbsolute(filePath) ||
    /[\s\r\n\0"'%\\]/.test(filePath) ||
    filePath.split('/').includes('..')
  ) {
    throw new Error(`Invalid ${label}: expected clean POSIX absolute path without whitespace, quotes, or ..`);
  }
  const normalized = path.posix.normalize(filePath).replace(/\/+$/, '');
  if (!normalized || normalized === '/') {
    throw new Error(`Invalid ${label}: must not be filesystem root`);
  }
  return normalized;
}

function normalizeSpec(spec: ServiceUnitSpec) {
  const serviceName = spec.serviceName ?? 'agent-router-watch';
  if (!safeServiceNamePattern.test(serviceName)) {
    throw new Error('Invalid serviceName: expected lowercase alphanumeric/dash/dot/underscore');
  }
  const nodeExecutable = validateSafeAbsolutePath(spec.nodeExecutable ?? process.execPath, 'nodeExecutable');
  const cliEntrypoint = validateSafeAbsolutePath(spec.cliEntrypoint, 'cliEntrypoint');
  const workingDirectory = validateSafeAbsolutePath(spec.workingDirectory, 'workingDirectory');
  if (workingDirectory === path.posix.normalize(homedir()).replace(/\/+$/, '')) {
    throw new Error('Invalid workingDirectory: must be an isolated directory, not personal $HOME');
  }
  if (spec.routerArgs.length === 0 || spec.routerArgs.some(arg => !arg || /[\r\n\0"']/.test(arg))) {
    throw new Error('Invalid routerArgs: expected non-empty argument list without quotes or control characters');
  }
  const intervalSec = spec.intervalSec ?? 300;
  if (!Number.isInteger(intervalSec) || intervalSec < 15 || intervalSec > 86_400) {
    throw new Error('Invalid intervalSec: expected integer between 15 and 86400');
  }
  const isolatedHome = `${workingDirectory}/isolated-home`;
  return {
    serviceName,
    nodeExecutable,
    cliEntrypoint,
    workingDirectory,
    isolatedHome,
    routerArgs: spec.routerArgs,
    intervalSec,
  };
}

function quoteSystemdArg(arg: string): string {
  if (/^[A-Za-z0-9._/:=-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$])/g, '\\$1')}"`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSystemdUserUnits(spec: ServiceUnitSpec): RenderedSystemdUnits {
  const n = normalizeSpec(spec);
  const execStart = [n.nodeExecutable, n.cliEntrypoint, ...n.routerArgs].map(quoteSystemdArg).join(' ');

  const serviceContent = [
    '[Unit]',
    `Description=Agent Router Autonomous Allowance Monitor (${n.serviceName})`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${n.workingDirectory}`,
    `Environment="HOME=${n.isolatedHome}"`,
    'UMask=0077',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    `ExecStartPre=/usr/bin/install -d -m 0700 ${n.isolatedHome} ${n.workingDirectory}/logs`,
    `ExecStart=${execStart}`,
    '',
  ].join('\n');

  const timerContent = [
    '[Unit]',
    `Description=Periodic Timer for ${n.serviceName}`,
    '',
    '[Timer]',
    'OnBootSec=30s',
    `OnUnitActiveSec=${n.intervalSec}s`,
    'Persistent=true',
    `Unit=${n.serviceName}.service`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');

  return {
    serviceUnitName: `${n.serviceName}.service`,
    timerUnitName: `${n.serviceName}.timer`,
    serviceContent,
    timerContent,
  };
}

export function renderLaunchdPlist(spec: ServiceUnitSpec): RenderedLaunchdPlist {
  const n = normalizeSpec(spec);
  const label = `dev.agentrouter.${n.serviceName}`;
  const argvXml = [n.nodeExecutable, n.cliEntrypoint, ...n.routerArgs]
    .map(arg => `      <string>${escapeXml(arg)}</string>`)
    .join('\n');

  const plistContent = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    <string>${escapeXml(label)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argvXml,
    '    </array>',
    '    <key>WorkingDirectory</key>',
    `    <string>${escapeXml(n.workingDirectory)}</string>`,
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    '      <key>HOME</key>',
    `      <string>${escapeXml(n.isolatedHome)}</string>`,
    '    </dict>',
    '    <key>ProcessType</key>',
    '    <string>Background</string>',
    '    <key>StartInterval</key>',
    `    <integer>${n.intervalSec}</integer>`,
    '    <key>StandardOutPath</key>',
    `    <string>${escapeXml(`${n.workingDirectory}/logs/${n.serviceName}.out.log`)}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${escapeXml(`${n.workingDirectory}/logs/${n.serviceName}.err.log`)}</string>`,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');

  return {
    label,
    plistFileName: `${label}.plist`,
    plistContent,
  };
}

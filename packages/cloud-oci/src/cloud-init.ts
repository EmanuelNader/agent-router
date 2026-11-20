export interface WorkerCloudInitOptions {
  sshAuthorizedKey: string;
  opencodeVersion?: string;
  loopbackPort?: number;
}

const sshPublicKeyPattern =
  /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{32,}(?: [A-Za-z0-9._@-]{1,128})?$/;
const semverPattern = /^\d+\.\d+\.\d+$/;

const NODE_VERSION = '24.18.1';
const NODE_ARM64_SHA256 = '7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c';
const NODE_X64_SHA256 = 'd6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0';

export function validateSshPublicKey(key: string): string {
  const trimmed = key.trim();
  if (!sshPublicKeyPattern.test(trimmed) || /[\r\n\0"']/.test(trimmed)) {
    throw new Error('Invalid SSH public key: expected single-line OpenSSH ed25519/ecdsa/rsa public key');
  }
  return trimmed;
}

export function buildWorkerBootstrapScript(opencodeVersion = '2.3.2'): string {
  if (!semverPattern.test(opencodeVersion)) {
    throw new Error('Invalid OpenCode version: expected exact X.Y.Z semver');
  }
  return [
    '#!/bin/sh',
    'set -eu',
    '',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update -y',
    '  apt-get install -y --no-install-recommends ca-certificates curl git tar xz-utils',
    'elif command -v dnf >/dev/null 2>&1; then',
    '  dnf install -y ca-certificates curl git tar xz',
    'fi',
    '',
    'arch="$(uname -m)"',
    'case "$arch" in',
    '  aarch64|arm64)',
    `    node_tar="node-v${NODE_VERSION}-linux-arm64.tar.xz"`,
    `    node_sha="${NODE_ARM64_SHA256}"`,
    '    ;;',
    '  x86_64|amd64)',
    `    node_tar="node-v${NODE_VERSION}-linux-x64.tar.xz"`,
    `    node_sha="${NODE_X64_SHA256}"`,
    '    ;;',
    '  *)',
    '    echo "Unsupported architecture: $arch" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    '',
    'tmp_dir="$(mktemp -d)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    `curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$node_tar" -o "$tmp_dir/$node_tar"`,
    'printf "%s  %s\\n" "$node_sha" "$tmp_dir/$node_tar" | sha256sum -c -',
    'tar -xJf "$tmp_dir/$node_tar" -C /usr/local --strip-components=1',
    '',
    'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router',
    'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router/spool',
    'install -d -m 0700 -o agentrouter -g agentrouter /var/lib/agent-router/workspaces',
    '',
    `/usr/local/bin/npm install -g "@opencode/cli@${opencodeVersion}"`,
    'systemctl daemon-reload',
    'systemctl enable --now agent-router-opencode.service',
    'systemctl reload-or-restart ssh 2>/dev/null || systemctl reload-or-restart sshd',
    '',
  ].join('\n');
}

/**
 * Generates an immutable, minimal #cloud-config (< 32 KiB) for OCI Always Free ARM64 and Hetzner CAX11 workers.
 * Security invariants:
 * - Non-root `agentrouter` user with no sudo privileges and key-only SSH.
 * - Root SSH and password authentication disabled.
 * - SHA-256 verified Node 24.18.1 + pinned `@opencode/cli` bound strictly to 127.0.0.1.
 * - Zero cloud provider credentials or tenancy identifiers placed on the worker filesystem.
 */
export function renderWorkerCloudInit(options: WorkerCloudInitOptions): string {
  const sshKey = validateSshPublicKey(options.sshAuthorizedKey);
  const opencodeVersion = options.opencodeVersion ?? '2.3.2';
  const bootstrapScript = buildWorkerBootstrapScript(opencodeVersion);
  const loopbackPort = options.loopbackPort ?? 4096;
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1024 || loopbackPort > 65_535) {
    throw new Error('Invalid loopback port: expected integer in 1024..65535');
  }

  const indentedBootstrap = bootstrapScript
    .trimEnd()
    .split('\n')
    .map(line => (line ? `      ${line}` : ''))
    .join('\n');

  return [
    '#cloud-config',
    'disable_root: true',
    'ssh_pwauth: false',
    'users:',
    '  - name: agentrouter',
    '    gecos: Agent Router Worker',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '    sudo: false',
    '    ssh_authorized_keys:',
    `      - ${sshKey}`,
    'write_files:',
    '  - path: /etc/ssh/sshd_config.d/99-agent-router.conf',
    '    permissions: "0644"',
    '    owner: root:root',
    '    content: |',
    '      PermitRootLogin no',
    '      PasswordAuthentication no',
    '      KbdInteractiveAuthentication no',
    '  - path: /usr/local/libexec/agent-router-bootstrap.sh',
    '    permissions: "0700"',
    '    owner: root:root',
    '    content: |',
    indentedBootstrap,
    '  - path: /etc/systemd/system/agent-router-opencode.service',
    '    permissions: "0644"',
    '    owner: root:root',
    '    content: |',
    '      [Unit]',
    '      Description=Agent Router OpenCode Loopback Server',
    '      After=network-online.target',
    '      Wants=network-online.target',
    '',
    '      [Service]',
    '      Type=simple',
    '      User=agentrouter',
    '      Group=agentrouter',
    '      WorkingDirectory=/var/lib/agent-router/workspaces',
    '      Environment=HOME=/var/lib/agent-router',
    `      ExecStart=/usr/local/bin/opencode serve --hostname 127.0.0.1 --port ${loopbackPort}`,
    '      Restart=on-failure',
    '      RestartSec=5',
    '      NoNewPrivileges=true',
    '      PrivateTmp=true',
    '      ProtectSystem=strict',
    '      ReadWritePaths=/var/lib/agent-router',
    '',
    '      [Install]',
    '      WantedBy=multi-user.target',
    'runcmd:',
    '  - [ /usr/local/libexec/agent-router-bootstrap.sh ]',
    '',
  ].join('\n');
}

export function encodeWorkerCloudInitBase64(options: WorkerCloudInitOptions): string {
  return Buffer.from(renderWorkerCloudInit(options), 'utf8').toString('base64');
}

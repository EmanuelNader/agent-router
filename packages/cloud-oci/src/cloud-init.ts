export interface WorkerCloudInitOptions {
  sshAuthorizedKey: string;
  opencodeVersion?: string;
  loopbackPort?: number;
}

const sshPublicKeyPattern =
  /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{32,}(?: [A-Za-z0-9._@-]{1,128})?$/;
const semverPattern = /^\d+\.\d+\.\d+$/;

export function validateSshPublicKey(key: string): string {
  const trimmed = key.trim();
  if (!sshPublicKeyPattern.test(trimmed) || /[\r\n\0"']/.test(trimmed)) {
    throw new Error('Invalid SSH public key: expected single-line OpenSSH ed25519/ecdsa/rsa public key');
  }
  return trimmed;
}

/**
 * Generates an immutable, minimal #cloud-config for an OCI Always Free ARM64 worker.
 * Security invariants:
 * - Non-root `agentrouter` user with no sudo privileges and key-only SSH.
 * - Root SSH and password authentication disabled.
 * - OpenCode server bound strictly to 127.0.0.1 (accessed over Tailscale or SSH local forward).
 * - Zero cloud provider credentials or tenancy identifiers placed on the worker filesystem.
 */
export function renderWorkerCloudInit(options: WorkerCloudInitOptions): string {
  const sshKey = validateSshPublicKey(options.sshAuthorizedKey);
  const opencodeVersion = options.opencodeVersion ?? '2.2.7';
  if (!semverPattern.test(opencodeVersion)) {
    throw new Error('Invalid OpenCode version: expected exact X.Y.Z semver');
  }
  const loopbackPort = options.loopbackPort ?? 4096;
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1024 || loopbackPort > 65_535) {
    throw new Error('Invalid loopback port: expected integer in 1024..65535');
  }

  return [
    '#cloud-config',
    'package_update: true',
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
    '  - [ install, -d, -m, "0700", -o, agentrouter, -g, agentrouter, /var/lib/agent-router ]',
    '  - [ install, -d, -m, "0700", -o, agentrouter, -g, agentrouter, /var/lib/agent-router/spool ]',
    '  - [ install, -d, -m, "0700", -o, agentrouter, -g, agentrouter, /var/lib/agent-router/workspaces ]',
    `  - [ npm, install, -g, "@opencode/cli@${opencodeVersion}" ]`,
    '  - [ systemctl, daemon-reload ]',
    '  - [ systemctl, reload-or-restart, ssh ]',
    '',
  ].join('\n');
}

export function encodeWorkerCloudInitBase64(options: WorkerCloudInitOptions): string {
  return Buffer.from(renderWorkerCloudInit(options), 'utf8').toString('base64');
}

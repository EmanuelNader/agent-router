import { randomBytes } from 'node:crypto';
import { OPENCODE_VERSION } from './server.js';
import { OpenCodeClient } from './client.js';

const nodeVersion = '24.22.3';
const nodeSha256 = '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c';

export interface AgentEndpoint {
  baseUrl: string;
  close(): Promise<void>;
}

/** Idempotent cloud-init for one loopback OpenCode server. No cloud credentials are embedded. */
export class OpenCodeBootstrap {
  static password(): string {
    return randomBytes(32).toString('hex');
  }

  static cloudInit(password: string): string {
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid OpenCode password');
    return `#!/bin/bash
set -euo pipefail
export PATH="/usr/local/bin:\${PATH}"
if systemctl is-active --quiet agent-router-opencode; then
  exit 0
fi
if [ "$(uname -m)" != "aarch64" ]; then
  echo "arm64 required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates xz-utils
fi
NODE_VERSION=${nodeVersion}
TARBALL="node-v\${NODE_VERSION}-linux-arm64.tar.xz"
if ! /usr/local/bin/node --version 2>/dev/null | grep -qx "v\${NODE_VERSION}"; then
  curl -fsSL "https://nodejs.org/dist/v\${NODE_VERSION}/\${TARBALL}" -o "/tmp/\${TARBALL}"
  echo "${nodeSha256}  /tmp/\${TARBALL}" | sha256sum -c -
  tar -xJf "/tmp/\${TARBALL}" -C /usr/local --strip-components=1
  rm -f "/tmp/\${TARBALL}"
fi
if ! /usr/local/bin/opencode --version 2>/dev/null | grep -q '${OPENCODE_VERSION}'; then
  npm install -g @opencode/cli@${OPENCODE_VERSION}
fi
install -d -m 0755 /etc/agent-router /var/lib/agent-router
if ! id opencode >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/agent-router/home --shell /usr/sbin/nologin opencode
fi
install -d -m 0700 -o opencode -g opencode \\
  /var/lib/agent-router/home /var/lib/agent-router/config /var/lib/agent-router/data \\
  /var/lib/agent-router/state /var/lib/agent-router/cache /var/lib/agent-router/workspace
cat > /etc/agent-router/opencode.env <<'EOF'
OPENCODE_PASSWORD=${password}
EOF
chmod 0600 /etc/agent-router/opencode.env
cat > /etc/systemd/system/agent-router-opencode.service <<'EOF'
[Unit]
Description=Agent Router OpenCode
After=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/agent-router/opencode.env
Environment=OPENCODE_DISABLE_PROJECT_CONFIG=1
Environment=OPENCODE_DISABLE_CLAUDE_CODE=1
Environment=HOME=/var/lib/agent-router/home
Environment=XDG_CONFIG_HOME=/var/lib/agent-router/config
Environment=XDG_DATA_HOME=/var/lib/agent-router/data
Environment=XDG_STATE_HOME=/var/lib/agent-router/state
Environment=XDG_CACHE_HOME=/var/lib/agent-router/cache
WorkingDirectory=/var/lib/agent-router/workspace
ExecStart=/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096
Restart=on-failure
RestartSec=2
User=opencode
Group=opencode
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agent-router-opencode
`;
  }

  /** Authenticated readiness check used by the local harness. */
  static async verify(baseUrl: string, password: string): Promise<void> {
    const client = new OpenCodeClient(baseUrl, password);
    try { await client.listSessions(); }
    catch (error) {
      if (error instanceof Error && error.message.includes('(401)')) throw new Error('AGENT_UNAUTHORIZED');
      throw error;
    }
  }

  static async verifyThroughTunnel(
    host: string,
    password: string,
    open: (host: string) => Promise<AgentEndpoint>,
  ): Promise<void> {
    const endpoint = await open(host);
    try { await this.verify(endpoint.baseUrl, password); }
    finally { await endpoint.close(); }
  }
}

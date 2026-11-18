import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OperationJournal } from '../../cli/src/journal.js';
import { renderWorkerCloudInit } from '../../cloud-oci/src/cloud-init.js';
import { workspaceKeySchema } from '../../cloud-oci/src/provider.js';

export const hetznerLocationSchema = z.enum(['fsn1', 'nbg1', 'hel1', 'sin', 'ash', 'hil']);
export type HetznerLocation = z.infer<typeof hetznerLocationSchema>;

export type HetznerServerStatus =
  | 'initializing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'off'
  | 'deleting'
  | 'deleted';

export interface HetznerServerRecord {
  serverId: number;
  name: string;
  status: HetznerServerStatus;
  serverType: string;
  location: string;
  labels: Record<string, string>;
}

export interface HetznerCreateServerPayload {
  name: string;
  server_type: 'cax11';
  image: 'ubuntu-24.04';
  location: HetznerLocation;
  start_after_create: true;
  user_data: string;
  labels: Record<string, string>;
  firewalls: { firewall: number }[];
  public_net: {
    enable_ipv4: boolean;
    enable_ipv6: true;
  };
}

export interface HetznerRemnantCounts {
  servers: number;
  volumes: number;
  primaryIps: number;
}

export interface HetznerCloudGateway {
  inspectFirewallSecurity(firewallId: number): Promise<{ ingressRuleCount: number }>;
  listServers(filter: { workspaceKey?: string; operationId?: string }): Promise<HetznerServerRecord[]>;
  createServer(payload: HetznerCreateServerPayload): Promise<HetznerServerRecord>;
  powerOffServer(serverId: number): Promise<HetznerServerRecord>;
  deleteServer(serverId: number): Promise<void>;
  listWorkspaceRemnants(workspaceKey: string): Promise<HetznerRemnantCounts>;
}

export function fingerprintHetznerServer(serverId: number): string {
  return `hcloud_${createHash('sha256').update(String(serverId)).digest('hex').slice(0, 16)}`;
}

export interface ProvisionHetznerWorkerInput {
  workspaceKey: string;
  location: HetznerLocation;
  firewallId: number;
  sshAuthorizedKey: string;
  enableIpv4?: boolean;
  opencodeVersion?: string;
}

export interface ProvisionHetznerWorkerResult {
  status: 'PROVISIONED';
  operationId: string;
  workspaceKey: string;
  serverFingerprint: string;
  serverType: 'cax11';
  architecture: 'arm64';
  location: HetznerLocation;
  ipv4Enabled: boolean;
  ipv6Enabled: true;
}

export class HetznerWorkerProvisioner {
  private readonly journal: OperationJournal;
  private readonly gateway: HetznerCloudGateway;

  constructor(deps: { journal: OperationJournal; gateway: HetznerCloudGateway }) {
    this.journal = deps.journal;
    this.gateway = deps.gateway;
  }

  async provision(input: ProvisionHetznerWorkerInput): Promise<ProvisionHetznerWorkerResult> {
    const workspaceKey = workspaceKeySchema.parse(input.workspaceKey);
    const location = hetznerLocationSchema.parse(input.location);
    if (!Number.isSafeInteger(input.firewallId) || input.firewallId <= 0) {
      throw new Error('Invalid Hetzner firewall ID');
    }

    const fw = await this.gateway.inspectFirewallSecurity(input.firewallId);
    if (fw.ingressRuleCount > 0) {
      throw new Error(
        `UNSAFE_FIREWALL_INGRESS_RULES: expected 0 inbound rules on Hetzner firewall, found ${fw.ingressRuleCount}`,
      );
    }

    const userData = renderWorkerCloudInit({
      sshAuthorizedKey: input.sshAuthorizedKey,
      ...(input.opencodeVersion ? { opencodeVersion: input.opencodeVersion } : {}),
    });
    if (Buffer.byteLength(userData, 'utf8') > 32 * 1024) {
      throw new Error('Hetzner user_data exceeds 32 KiB limit');
    }

    const operation = await this.journal.begin({
      kind: 'PROVISION',
      workspaceKey,
      summary: `Provisioning Hetzner CAX11 ARM64 worker in ${location}`,
    });

    const active = (await this.gateway.listServers({ workspaceKey })).filter(s => s.status !== 'deleted');
    if (active.length > 0) {
      await this.journal.abortUnfenced(operation.operationId);
      throw new Error(`WORKSPACE_SERVER_ALREADY_EXISTS: workspace "${workspaceKey}" already has a Hetzner server`);
    }

    const enableIpv4 = input.enableIpv4 ?? false;

    try {
      const created = await this.gateway.createServer({
        name: `agent-router-${workspaceKey}`,
        server_type: 'cax11',
        image: 'ubuntu-24.04',
        location,
        start_after_create: true,
        user_data: userData,
        labels: {
          'agent-router-managed': 'true',
          'agent-router-workspace': workspaceKey,
          'agent-router-operation-id': operation.operationId,
        },
        firewalls: [{ firewall: input.firewallId }],
        public_net: {
          enable_ipv4: enableIpv4,
          enable_ipv6: true,
        },
      });

      const fingerprint = fingerprintHetznerServer(created.serverId);
      await this.journal.complete(
        operation.operationId,
        `Provisioned Hetzner CAX11 worker ${fingerprint} for ${workspaceKey}`,
      );

      return {
        status: 'PROVISIONED',
        operationId: operation.operationId,
        workspaceKey,
        serverFingerprint: fingerprint,
        serverType: 'cax11',
        architecture: 'arm64',
        location,
        ipv4Enabled: enableIpv4,
        ipv6Enabled: true,
      };
    } catch (err) {
      await this.journal.markNeedsReconcile(
        operation.operationId,
        `Hetzner provision interrupted for ${workspaceKey}; reconcile via operation label before retry`,
      );
      throw err;
    }
  }

  async reconcile(workspaceKeyInput: string): Promise<
    | { outcome: 'ADOPTED_EXISTING_SERVER'; operationId: string; workspaceKey: string; serverFingerprint: string }
    | { outcome: 'CONFIRMED_ABSENT'; operationId: string; workspaceKey: string }
  > {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const records = await this.journal.list();
    const pending = records.find(
      r =>
        r.workspaceKey === workspaceKey &&
        r.kind === 'PROVISION' &&
        (r.status === 'NEEDS_RECONCILE' || r.status === 'PENDING'),
    );
    if (!pending) {
      throw new Error(`No interrupted PROVISION operation found for workspace "${workspaceKey}"`);
    }

    const matches = (await this.gateway.listServers({ operationId: pending.operationId })).filter(
      s => s.status !== 'deleted',
    );
    if (matches.length > 1) {
      throw new Error(`AMBIGUOUS_RECONCILE: multiple Hetzner servers matched ${pending.operationId}`);
    }
    if (matches.length === 1) {
      const fingerprint = fingerprintHetznerServer(matches[0]!.serverId);
      await this.journal.reconcile(
        pending.operationId,
        `Reconciled and adopted existing Hetzner CAX11 worker ${fingerprint}`,
      );
      return {
        outcome: 'ADOPTED_EXISTING_SERVER',
        operationId: pending.operationId,
        workspaceKey,
        serverFingerprint: fingerprint,
      };
    }

    await this.journal.reconcile(
      pending.operationId,
      `Reconciled Hetzner provision for ${workspaceKey}: confirmed zero servers created`,
    );
    return {
      outcome: 'CONFIRMED_ABSENT',
      operationId: pending.operationId,
      workspaceKey,
    };
  }

  async fence(workspaceKeyInput: string): Promise<{
    workspaceKey: string;
    fenced: true;
    poweredOffCount: number;
  }> {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const active = (await this.gateway.listServers({ workspaceKey })).filter(
      s => s.status !== 'deleted' && s.status !== 'deleting',
    );
    let poweredOffCount = 0;
    for (const srv of active) {
      if (srv.status === 'off') continue;
      const updated = await this.gateway.powerOffServer(srv.serverId);
      if (updated.status !== 'off') {
        throw new Error(`FENCE_INCOMPLETE: Hetzner worker ${fingerprintHetznerServer(srv.serverId)} is ${updated.status}`);
      }
      poweredOffCount += 1;
    }
    return { workspaceKey, fenced: true, poweredOffCount };
  }

  async teardown(workspaceKeyInput: string): Promise<{
    workspaceKey: string;
    deletedCount: number;
    remnants: HetznerRemnantCounts;
  }> {
    const workspaceKey = workspaceKeySchema.parse(workspaceKeyInput);
    const existing = (await this.gateway.listServers({ workspaceKey })).filter(s => s.status !== 'deleted');
    let deletedCount = 0;
    for (const srv of existing) {
      await this.gateway.deleteServer(srv.serverId);
      deletedCount += 1;
    }

    const remnants = await this.gateway.listWorkspaceRemnants(workspaceKey);
    if (remnants.servers > 0 || remnants.volumes > 0 || remnants.primaryIps > 0) {
      throw new Error(
        `LEAKED_RESOURCES_DETECTED: servers=${remnants.servers}, volumes=${remnants.volumes}, primaryIps=${remnants.primaryIps}`,
      );
    }
    return { workspaceKey, deletedCount, remnants };
  }
}

/**
 * Live Hetzner Cloud API v1 client (`https://api.hetzner.cloud/v1`).
 * Never invoked by local unit tests or CI.
 */
export class HttpHetznerCloudGateway implements HetznerCloudGateway {
  private readonly apiToken: string;
  private readonly baseUrl: string;

  constructor(apiToken: string, baseUrl = 'https://api.hetzner.cloud/v1') {
    if (!apiToken.trim() || /[\s\r\n\0]/.test(apiToken)) {
      throw new Error('Invalid Hetzner API token');
    }
    this.apiToken = apiToken;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Hetzner API ${method} ${route.split('?')[0]} failed with HTTP ${response.status}`);
    }
    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  async inspectFirewallSecurity(firewallId: number): Promise<{ ingressRuleCount: number }> {
    const data = await this.request<{ firewall: { rules?: { direction: string }[] } }>(
      'GET',
      `/firewalls/${firewallId}`,
    );
    const ingressRuleCount = (data.firewall.rules ?? []).filter(r => r.direction === 'in').length;
    return { ingressRuleCount };
  }

  async listServers(filter: { workspaceKey?: string; operationId?: string }): Promise<HetznerServerRecord[]> {
    const selectors: string[] = [];
    if (filter.workspaceKey) selectors.push(`agent-router-workspace=${filter.workspaceKey}`);
    if (filter.operationId) selectors.push(`agent-router-operation-id=${filter.operationId}`);
    const query = selectors.length > 0 ? `?label_selector=${encodeURIComponent(selectors.join(','))}` : '';
    const data = await this.request<{
      servers: {
        id: number;
        name: string;
        status: HetznerServerStatus;
        server_type: { name: string };
        datacenter?: { location?: { name?: string } };
        labels?: Record<string, string>;
      }[];
    }>('GET', `/servers${query}`);

    return data.servers.map(srv => ({
      serverId: srv.id,
      name: srv.name,
      status: srv.status,
      serverType: srv.server_type.name,
      location: srv.datacenter?.location?.name ?? 'unknown',
      labels: { ...(srv.labels ?? {}) },
    }));
  }

  async createServer(payload: HetznerCreateServerPayload): Promise<HetznerServerRecord> {
    const data = await this.request<{
      server: {
        id: number;
        name: string;
        status: HetznerServerStatus;
        server_type: { name: string };
        labels?: Record<string, string>;
      };
    }>('POST', '/servers', payload);
    return {
      serverId: data.server.id,
      name: data.server.name,
      status: data.server.status,
      serverType: data.server.server_type.name,
      location: payload.location,
      labels: { ...(data.server.labels ?? {}) },
    };
  }

  async powerOffServer(serverId: number): Promise<HetznerServerRecord> {
    await this.request('POST', `/servers/${serverId}/actions/poweroff`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const data = await this.request<{
        server: {
          id: number;
          name: string;
          status: HetznerServerStatus;
          server_type: { name: string };
          datacenter?: { location?: { name?: string } };
          labels?: Record<string, string>;
        };
      }>('GET', `/servers/${serverId}`);
      if (data.server.status === 'off') {
        return {
          serverId: data.server.id,
          name: data.server.name,
          status: 'off',
          serverType: data.server.server_type.name,
          location: data.server.datacenter?.location?.name ?? 'unknown',
          labels: { ...(data.server.labels ?? {}) },
        };
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('Hetzner server poweroff did not settle within timeout');
  }

  async deleteServer(serverId: number): Promise<void> {
    await this.request('DELETE', `/servers/${serverId}`);
  }

  async listWorkspaceRemnants(workspaceKey: string): Promise<HetznerRemnantCounts> {
    const selector = encodeURIComponent(`agent-router-workspace=${workspaceKey}`);
    const [serversRes, volumesRes, ipsRes] = await Promise.all([
      this.request<{ servers: unknown[] }>('GET', `/servers?label_selector=${selector}`),
      this.request<{ volumes: unknown[] }>('GET', `/volumes?label_selector=${selector}`),
      this.request<{ primary_ips: unknown[] }>('GET', `/primary_ips?label_selector=${selector}`),
    ]);
    return {
      servers: serversRes.servers.length,
      volumes: volumesRes.volumes.length,
      primaryIps: ipsRes.primary_ips.length,
    };
  }
}

export class InMemoryHetznerCloudGateway implements HetznerCloudGateway {
  private readonly firewallIngressRules: number;
  private crashAfterCreate: boolean;
  private nextId = 4100;
  private readonly servers = new Map<number, HetznerServerRecord>();
  private readonly orphanVolumes = new Map<string, number>();
  public createCount = 0;
  public lastCreatePayload: HetznerCreateServerPayload | null = null;

  constructor(options: { firewallIngressRules?: number; crashAfterCreate?: boolean } = {}) {
    this.firewallIngressRules = options.firewallIngressRules ?? 0;
    this.crashAfterCreate = options.crashAfterCreate ?? false;
  }

  setCrashAfterCreate(enabled: boolean): void {
    this.crashAfterCreate = enabled;
  }

  injectOrphanVolume(workspaceKey: string): void {
    this.orphanVolumes.set(workspaceKey, (this.orphanVolumes.get(workspaceKey) ?? 0) + 1);
  }

  clearOrphanVolumes(workspaceKey: string): void {
    this.orphanVolumes.delete(workspaceKey);
  }

  async inspectFirewallSecurity(_firewallId: number): Promise<{ ingressRuleCount: number }> {
    return { ingressRuleCount: this.firewallIngressRules };
  }

  async listServers(filter: { workspaceKey?: string; operationId?: string }): Promise<HetznerServerRecord[]> {
    return [...this.servers.values()].filter(srv => {
      if (filter.workspaceKey && srv.labels['agent-router-workspace'] !== filter.workspaceKey) return false;
      if (filter.operationId && srv.labels['agent-router-operation-id'] !== filter.operationId) return false;
      return true;
    });
  }

  async createServer(payload: HetznerCreateServerPayload): Promise<HetznerServerRecord> {
    this.createCount += 1;
    this.lastCreatePayload = payload;
    const serverId = this.nextId++;
    const record: HetznerServerRecord = {
      serverId,
      name: payload.name,
      status: 'running',
      serverType: payload.server_type,
      location: payload.location,
      labels: { ...payload.labels },
    };
    this.servers.set(serverId, record);
    if (this.crashAfterCreate) {
      throw new Error('Simulated Hetzner post-create crash before journal completion');
    }
    return record;
  }

  async powerOffServer(serverId: number): Promise<HetznerServerRecord> {
    const existing = this.servers.get(serverId);
    if (!existing) throw new Error('Server not found');
    const updated: HetznerServerRecord = { ...existing, status: 'off' };
    this.servers.set(serverId, updated);
    return updated;
  }

  async deleteServer(serverId: number): Promise<void> {
    this.servers.delete(serverId);
  }

  async listWorkspaceRemnants(workspaceKey: string): Promise<HetznerRemnantCounts> {
    const activeServers = [...this.servers.values()].filter(
      s => s.labels['agent-router-workspace'] === workspaceKey && s.status !== 'deleted',
    ).length;
    return {
      servers: activeServers,
      volumes: this.orphanVolumes.get(workspaceKey) ?? 0,
      primaryIps: 0,
    };
  }
}

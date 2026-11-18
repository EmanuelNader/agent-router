import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { validateSshTarget } from './transport.js';

const execFileAsync = promisify(execFile);

const rawPeerSchema = z
  .object({
    HostName: z.string().default(''),
    DNSName: z.string().default(''),
    OS: z.string().default('unknown'),
    TailscaleIPs: z.array(z.string()).default([]),
    Online: z.boolean().default(false),
    Relay: z.string().default(''),
  })
  .passthrough();

const rawStatusSchema = z
  .object({
    BackendState: z.string(),
    Peer: z.record(z.string(), rawPeerSchema).nullable().optional(),
  })
  .passthrough();

export interface TailscalePeerSummary {
  hostName: string;
  dnsName: string;
  tailscaleIps: string[];
  os: string;
  online: boolean;
  relay: string;
  recommendedSshTarget: string;
}

export function parseTailscaleStatusJson(
  rawJson: string,
  options: { includeOffline?: boolean; sshUser?: string } = {},
): TailscalePeerSummary[] {
  const parsed = rawStatusSchema.parse(JSON.parse(rawJson));
  if (parsed.BackendState !== 'Running') {
    throw new Error(`Tailscale backend is not running (state: ${parsed.BackendState})`);
  }

  const includeOffline = options.includeOffline ?? false;
  const sshUser = options.sshUser?.trim() || 'agentrouter';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sshUser)) {
    throw new Error('Invalid SSH username for Tailscale target');
  }

  const summaries: TailscalePeerSummary[] = [];
  for (const peer of Object.values(parsed.Peer ?? {})) {
    if (!includeOffline && !peer.Online) continue;
    const dnsName = peer.DNSName.replace(/\.+$/, '');
    const hostAddress = dnsName || peer.TailscaleIPs[0] || peer.HostName;
    if (!hostAddress) continue;
    const recommendedSshTarget = validateSshTarget(`${sshUser}@${hostAddress}`);
    summaries.push({
      hostName: peer.HostName,
      dnsName,
      tailscaleIps: [...peer.TailscaleIPs],
      os: peer.OS,
      online: peer.Online,
      relay: peer.Relay,
      recommendedSshTarget,
    });
  }

  return summaries.sort((a, b) => a.hostName.localeCompare(b.hostName));
}

export async function discoverTailscalePeers(
  options: {
    includeOffline?: boolean;
    sshUser?: string;
    tailscaleBinary?: string;
    runStatusJson?: () => Promise<string>;
  } = {},
): Promise<TailscalePeerSummary[]> {
  const raw = options.runStatusJson
    ? await options.runStatusJson()
    : (
        await execFileAsync(options.tailscaleBinary ?? 'tailscale', ['status', '--json'], {
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;

  return parseTailscaleStatusJson(raw, {
    ...(options.includeOffline !== undefined ? { includeOffline: options.includeOffline } : {}),
    ...(options.sshUser !== undefined ? { sshUser: options.sshUser } : {}),
  });
}

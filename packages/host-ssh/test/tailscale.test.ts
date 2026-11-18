import { expect, test } from 'vitest';
import { discoverTailscalePeers, parseTailscaleStatusJson } from '../src/tailscale.js';

const sampleStatus = JSON.stringify({
  BackendState: 'Running',
  Self: {
    HostName: 'macbook-pro',
    DNSName: 'macbook-pro.tail99.ts.net.',
    TailscaleIPs: ['100.64.0.1'],
  },
  Peer: {
    'nodekey:secret-node-key-111': {
      ID: 'n1',
      PublicKey: 'nodekey:secret-node-key-111',
      UserID: 99999,
      HostName: 'oci-worker-01',
      DNSName: 'oci-worker-01.tail99.ts.net.',
      OS: 'linux',
      TailscaleIPs: ['100.64.0.42', 'fd7a:115c:a1e0::42'],
      Online: true,
      Relay: 'iad',
    },
    'nodekey:secret-node-key-222': {
      ID: 'n2',
      PublicKey: 'nodekey:secret-node-key-222',
      HostName: 'sleeping-vps',
      DNSName: 'sleeping-vps.tail99.ts.net.',
      OS: 'linux',
      TailscaleIPs: ['100.64.0.55'],
      Online: false,
      Relay: '',
    },
  },
});

test('parses online Tailscale peers, strips trailing DNS dot, and scrubs node keys and user IDs', async () => {
  const peers = await discoverTailscalePeers({
    sshUser: 'agentrouter',
    runStatusJson: async () => sampleStatus,
  });

  expect(peers).toEqual([
    {
      hostName: 'oci-worker-01',
      dnsName: 'oci-worker-01.tail99.ts.net',
      tailscaleIps: ['100.64.0.42', 'fd7a:115c:a1e0::42'],
      os: 'linux',
      online: true,
      relay: 'iad',
      recommendedSshTarget: 'agentrouter@oci-worker-01.tail99.ts.net',
    },
  ]);
  expect(JSON.stringify(peers)).not.toContain('secret-node-key');
  expect(JSON.stringify(peers)).not.toContain('99999');

  const withOffline = parseTailscaleStatusJson(sampleStatus, { includeOffline: true });
  expect(withOffline).toHaveLength(2);

  expect(() => parseTailscaleStatusJson(JSON.stringify({ BackendState: 'Stopped', Peer: {} }))).toThrow(
    /not running/i,
  );

  const ipv6AndInvalidPeers = parseTailscaleStatusJson(
    JSON.stringify({
      BackendState: 'Running',
      Peer: {
        'nodekey:ipv6-only': {
          HostName: 'v6-worker',
          DNSName: '',
          OS: 'linux',
          TailscaleIPs: ['fd7a:115c:a1e0::99'],
          Online: true,
        },
        'nodekey:bad-host': {
          HostName: 'bad host with spaces',
          DNSName: '',
          OS: 'linux',
          TailscaleIPs: [],
          Online: true,
        },
      },
    }),
    { sshUser: 'agentrouter' },
  );
  expect(ipv6AndInvalidPeers).toEqual([
    {
      hostName: 'v6-worker',
      dnsName: '',
      tailscaleIps: ['fd7a:115c:a1e0::99'],
      os: 'linux',
      online: true,
      relay: '',
      recommendedSshTarget: 'agentrouter@[fd7a:115c:a1e0::99]',
    },
  ]);
});

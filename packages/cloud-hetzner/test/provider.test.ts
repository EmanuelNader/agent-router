import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import {
  HetznerWorkerProvisioner,
  InMemoryHetznerCloudGateway,
} from '../src/provider.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const sampleSshPubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9exampleKeyMaterial0123456789abcdef router@laptop';

test('provisions CAX11 ARM64 with IPv6-only default, zero-inbound firewall, crash reconciliation, and leak-free teardown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-hcloud-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));

  // Reject firewalls that expose inbound public ports
  const openFwGateway = new InMemoryHetznerCloudGateway({ firewallIngressRules: 1 });
  const openFwProvisioner = new HetznerWorkerProvisioner({ journal, gateway: openFwGateway });
  await expect(
    openFwProvisioner.provision({
      workspaceKey: 'ws-hcloud-unsafe',
      location: 'fsn1',
      firewallId: 101,
      sshAuthorizedKey: sampleSshPubKey,
    }),
  ).rejects.toThrow(/UNSAFE_FIREWALL_INGRESS_RULES/);

  // Simulate post-create transport crash and prove label-based reconciliation adopts without duplicate server
  const gateway = new InMemoryHetznerCloudGateway({
    firewallIngressRules: 0,
    crashAfterCreate: true,
  });
  const provisioner = new HetznerWorkerProvisioner({ journal, gateway });

  await expect(
    provisioner.provision({
      workspaceKey: 'ws-hcloud-01',
      location: 'nbg1',
      firewallId: 202,
      sshAuthorizedKey: sampleSshPubKey,
    }),
  ).rejects.toThrow(/Simulated Hetzner post-create crash/);
  expect(gateway.createCount).toBe(1);
  expect(gateway.lastCreatePayload?.server_type).toBe('cax11');
  expect(gateway.lastCreatePayload?.public_net).toEqual({ enable_ipv4: false, enable_ipv6: true });
  expect('datacenter' in (gateway.lastCreatePayload ?? {})).toBe(false);

  gateway.setCrashAfterCreate(false);
  const reconciled = await provisioner.reconcile('ws-hcloud-01');
  expect(reconciled.outcome).toBe('ADOPTED_EXISTING_SERVER');
  expect(gateway.createCount).toBe(1);

  const fenced = await provisioner.fence('ws-hcloud-01');
  expect(fenced).toEqual({ workspaceKey: 'ws-hcloud-01', fenced: true, poweredOffCount: 1 });

  gateway.injectOrphanVolume('ws-hcloud-01');
  await expect(provisioner.teardown('ws-hcloud-01')).rejects.toThrow(/LEAKED_RESOURCES_DETECTED/);

  gateway.clearOrphanVolumes('ws-hcloud-01');
  const tornDown = await provisioner.teardown('ws-hcloud-01');
  expect(tornDown.remnants).toEqual({ servers: 0, volumes: 0, primaryIps: 0 });
});

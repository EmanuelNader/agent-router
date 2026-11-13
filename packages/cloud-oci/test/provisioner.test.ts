import { expect, test } from 'vitest';
import { OpenCodeBootstrap } from '../../agent-opencode/src/bootstrap.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { DeployError } from '../src/errors.js';
import { OciFreeTierGate } from '../src/gate.js';
import type { InstanceRecord } from '../src/gateway.js';
import { OciResourcePlan } from '../src/plan.js';
import { OciProvisioner, type DeployClock } from '../src/provisioner.js';
import { OciDeployState } from '../src/state.js';
import { MemoryCloud } from './memory-cloud.js';

const now = new Date('2026-11-13T12:00:00Z');
const clock: DeployClock = { now: () => now.getTime(), wait: async () => {} };
const compartmentId = 'ocid1.compartment.oc1..examplecompartment';
const sshPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly router';
const known = (limit: number, used: number, available: number) => ({ status: 'KNOWN' as const, limit, used, available });
function inspection(): OciInspection {
  return {
    schemaVersion: 1, source: 'OCI_API', observedAt: now.toISOString(),
    homeRegion: 'us-example-1', region: 'us-example-1', availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: known(2, 0, 2), a1RegionalMemoryGb: known(12, 0, 12),
      a1AdOcpus: known(2, 0, 2), a1AdMemoryGb: known(12, 0, 12),
      microInstances: known(2, 0, 2), freeStorageGb: known(200, 50, 150),
    }, issues: [],
  };
}
const eligibility = {
  schemaVersion: 1 as const, evidence: 'RECORDED' as const, accountClass: 'ALWAYS_FREE' as const,
  monthlyUsage: 'WITHIN_ALLOTMENT' as const, imageCharge: 'NONE' as const, networkCharge: 'NONE' as const,
  storageCharge: 'NONE' as const, capacity: 'AVAILABLE' as const, compartmentQuota: 'FITS' as const,
};

function own(cloud: MemoryCloud, deploymentId: string, patch: Partial<InstanceRecord> = {}) {
  const id = `ocid1.instance.oc1..owned${cloud.instances.length}`;
  const vnicId = `vnic-${id}`;
  cloud.instances.push({
    id, displayName: OciResourcePlan.displayName, freeformTags: OciResourcePlan.tags(deploymentId), lifecycleState: 'RUNNING',
    shape: OciResourcePlan.shape, availabilityDomain: 'kIdk:PHX-AD-1', ocpus: 1, memoryInGBs: 4, ...patch,
  });
  cloud.vnics.push({ id: vnicId, subnetId: 'subnet', isPrimary: true, publicIp: '203.0.113.20' });
  cloud.vnicAttachments.push({ id: `att-${id}`, instanceId: id, vnicId, lifecycleState: 'ATTACHED' });
  return id;
}

async function run(cloud: MemoryCloud, state = OciDeployState.create()) {
  const seen: string[] = [];
  let current = state;
  const authorization = OciFreeTierGate.evaluate({ report: inspection(), eligibility, mode: 'LIVE', now });
  const receipt = await OciProvisioner.deploy({
    gateway: cloud, authorization, compartmentId, sshPublicKey, sshCidr: '203.0.113.10/32',
    cloudInit: OpenCodeBootstrap.cloudInit(), state: current, clock, deadlineMs: 60_000,
    installAgent: async () => {},
    verify: async (ip, password) => { seen.push(`${ip}:${password}`); },
    saveState: async next => { current = next; },
  });
  return { receipt, seen, state: current };
}

test('launches one free Ubuntu A1 host and checks it with the OpenCode client path', async () => {
  const cloud = new MemoryCloud();
  const { receipt, seen, state } = await run(cloud);
  expect(receipt).toMatchObject({
    executed: true, instanceSource: 'created', publicIp: '203.0.113.20', publicIpAssignment: 'EPHEMERAL',
    shape: 'VM.Standard.A1.Flex', ocpus: 1, memoryGb: 4, bootGb: 50, imageId: 'ocid1.image.oc1..ubuntu', agentReady: true,
  });
  expect(cloud.calls.launch).toEqual(['ocid1.image.oc1..ubuntu']);
  expect(seen).toEqual([`203.0.113.20:${state.password}`]);
  expect(JSON.stringify(receipt)).not.toContain(state.password);
  const again = await run(cloud, state);
  expect(again.receipt.instanceSource).toBe('reused');
  expect(cloud.calls.launch).toHaveLength(1);
  expect(cloud.calls.createVcn).toBe(1);
});

test('a launch that succeeds after the response is lost is not started a second time', async () => {
  const cloud = new MemoryCloud();
  cloud.failLaunch = 'after-create';
  const first = await run(cloud);
  expect(first.receipt.instanceSource).toBe('recovered');
  cloud.failLaunch = 'none';
  const second = await run(cloud, first.state);
  expect(second.receipt.instanceSource).toBe('reused');
  expect(cloud.calls.launch).toHaveLength(1);
});

test('out of host capacity does not fall back to another shape', async () => {
  const cloud = new MemoryCloud();
  cloud.failLaunch = 'capacity';
  await expect(run(cloud)).rejects.toMatchObject({ code: 'OUT_OF_HOST_CAPACITY' });
  expect(cloud.attempts).toHaveLength(1);
  expect(cloud.attempts[0]).toMatchObject({ imageId: 'ocid1.image.oc1..ubuntu', shape: 'VM.Standard.A1.Flex' });
  expect(cloud.instances.filter(instance => instance.displayName === OciResourcePlan.displayName)).toEqual([]);
});

test('refuses a second active agent, a paid shape, and an untagged name collision', async () => {
  const paired = new MemoryCloud();
  const pairedState = OciDeployState.create();
  own(paired, pairedState.deploymentId); own(paired, pairedState.deploymentId);
  await expect(run(paired, pairedState)).rejects.toMatchObject({ code: 'MULTIPLE_ACTIVE_AGENTS' });
  expect(paired.attempts).toEqual([]);

  const paid = new MemoryCloud();
  const paidState = OciDeployState.create();
  own(paid, paidState.deploymentId, { shape: 'VM.Standard.E4.Flex' });
  await expect(run(paid, paidState)).rejects.toMatchObject({ code: 'SHAPE_MISMATCH' });
  expect(paid.calls.terminate).toEqual([]);

  const named = new MemoryCloud();
  const namedState = OciDeployState.create();
  own(named, namedState.deploymentId, { freeformTags: {} });
  await expect(run(named, namedState)).rejects.toMatchObject({ code: 'INSTANCE_NAME_CONFLICT' });
  expect(named.instances[0]?.lifecycleState).toBe('RUNNING');
});

test('reuses an owned network and a stopped owned instance', async () => {
  const cloud = new MemoryCloud();
  const state = OciDeployState.create();
  const tags = OciResourcePlan.tags(state.deploymentId);
  const routeId = 'ocid1.routetable.oc1..ours';
  const vcnId = 'ocid1.vcn.oc1..ours';
  const igwId = 'ocid1.igw.oc1..ours';
  cloud.vcns.push({
    id: vcnId, displayName: OciResourcePlan.displayName, freeformTags: tags,
    lifecycleState: 'AVAILABLE', defaultRouteTableId: routeId, cidrBlock: OciResourcePlan.vcnCidr,
  });
  cloud.routes.set(routeId, [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: igwId }]);
  cloud.igws.push({
    id: igwId, displayName: OciResourcePlan.internetGatewayName, freeformTags: tags,
    lifecycleState: 'AVAILABLE', vcnId, isEnabled: true,
  });
  cloud.lists.push({
    id: 'ocid1.seclist.oc1..ours', displayName: OciResourcePlan.displayName, freeformTags: tags,
    lifecycleState: 'AVAILABLE', vcnId,
  });
  cloud.subnets.push({
    id: 'ocid1.subnet.oc1..ours', displayName: OciResourcePlan.displayName, freeformTags: tags,
    lifecycleState: 'AVAILABLE', vcnId, cidrBlock: OciResourcePlan.subnetCidr, prohibitPublicIpOnVnic: false,
  });
  own(cloud, state.deploymentId, { lifecycleState: 'STOPPED' });
  const { receipt } = await run(cloud, state);
  expect(receipt.instanceSource).toBe('reused');
  expect(receipt.reusedNetwork).toBe(true);
  expect(cloud.calls.createVcn).toBe(0);
  expect(cloud.calls.launch).toEqual([]);
  expect(cloud.calls.updateSecurity).toBe(1);
  expect(cloud.instances.find(instance => instance.lifecycleState === 'RUNNING')?.shape).toBe('VM.Standard.A1.Flex');
});

test('destroy removes only saved IDs and leaves discord-bot alone even with our tag or our name', async () => {
  const cloud = new MemoryCloud();
  cloud.seedDiscord();
  const { state } = await run(cloud);
  cloud.instances.push({
    id: 'ocid1.instance.oc1..discordtagged', displayName: 'discord-bot', freeformTags: OciResourcePlan.tags(state.deploymentId),
    lifecycleState: 'RUNNING', shape: 'VM.Standard.E2.1.Micro', availabilityDomain: 'kIdk:PHX-AD-1',
  });
  cloud.instances.push({
    id: 'ocid1.instance.oc1..samename', displayName: OciResourcePlan.displayName, freeformTags: {},
    lifecycleState: 'RUNNING', shape: OciResourcePlan.shape, availabilityDomain: 'kIdk:PHX-AD-1', ocpus: 1, memoryInGBs: 4,
  });
  const plan = await OciProvisioner.planDestroy({ gateway: cloud, state });
  expect(plan.executed).toBe(false);
  expect(plan.wouldDelete.map(item => item.id)).not.toContain('ocid1.instance.oc1..discordtagged');
  expect(plan.wouldDelete.map(item => item.id)).not.toContain('ocid1.instance.oc1..samename');
  expect(plan.preserved).toEqual(expect.arrayContaining([
    expect.objectContaining({ displayName: 'discord-bot', reason: 'NOT_RECORDED' }),
    expect.objectContaining({ displayName: 'discord-bot', reason: 'TAG_OR_NAME_MISMATCH' }),
    expect.objectContaining({ displayName: OciResourcePlan.displayName, reason: 'TAG_OR_NAME_MISMATCH' }),
  ]));
  const receipt = await OciProvisioner.destroy({ gateway: cloud, state, clock, deadlineMs: 60_000 });
  expect(receipt.deleted.instances).not.toContain('ocid1.instance.oc1..discordbot');
  expect(receipt.deleted.instances).not.toContain('ocid1.instance.oc1..discordtagged');
  expect(receipt.deleted.instances).not.toContain('ocid1.instance.oc1..samename');
  expect(cloud.calls.terminate).not.toContain('ocid1.instance.oc1..discordbot');
  expect(cloud.calls.terminate).not.toContain('ocid1.instance.oc1..discordtagged');
  expect(cloud.calls.terminate).not.toContain('ocid1.instance.oc1..samename');
  expect(cloud.calls.deleteVolume).not.toContain('ocid1.bootvolume.oc1..discord');
  expect(cloud.instances.find(instance => instance.id === 'ocid1.instance.oc1..discordtagged')?.lifecycleState).toBe('RUNNING');
  expect(cloud.instances.find(instance => instance.id === 'ocid1.instance.oc1..samename')?.lifecycleState).toBe('RUNNING');
  expect(cloud.vcns.map(vcn => vcn.displayName)).toEqual(['other-vcn']);
  const again = await OciProvisioner.destroy({ gateway: cloud, state: { ...state, resources: {} }, clock, deadlineMs: 60_000 });
  expect(again.deleted.instances).toEqual([]);
});

test('destroy does not delete a network still used by another instance', async () => {
  const cloud = new MemoryCloud();
  cloud.seedDiscord();
  const { state } = await run(cloud);
  const subnet = cloud.subnets.find(item => item.id === state.resources.subnetId);
  cloud.vnics.push({ id: 'vnic-foreign', subnetId: subnet?.id ?? '', isPrimary: true, publicIp: '203.0.113.50' });
  cloud.vnicAttachments.push({
    id: 'att-foreign', instanceId: 'ocid1.instance.oc1..discordbot', vnicId: 'vnic-foreign', lifecycleState: 'ATTACHED',
  });
  await expect(OciProvisioner.destroy({ gateway: cloud, state, clock, deadlineMs: 60_000 }))
    .rejects.toMatchObject({ code: 'NETWORK_IN_USE' });
  expect(cloud.vcns.some(vcn => vcn.id === state.resources.vcnId)).toBe(true);
  expect(cloud.instances.find(instance => instance.displayName === 'discord-bot')?.lifecycleState).toBe('RUNNING');
});

test('an untagged network with the same name is not adopted', async () => {
  const cloud = new MemoryCloud();
  cloud.vcns.push({
    id: 'ocid1.vcn.oc1..foreign', displayName: OciResourcePlan.displayName, freeformTags: { owner: 'someone-else' },
    lifecycleState: 'AVAILABLE', defaultRouteTableId: 'ocid1.routetable.oc1..foreign', cidrBlock: '10.9.0.0/16',
  });
  cloud.routes.set('ocid1.routetable.oc1..foreign', [{ destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: 'ocid1.igw.oc1..foreign' }]);
  await expect(run(cloud)).rejects.toBeInstanceOf(DeployError);
  await expect(run(cloud)).rejects.toMatchObject({ code: 'NETWORK_NAME_CONFLICT' });
  expect(cloud.calls.createVcn).toBe(0);
  expect(cloud.routes.get('ocid1.routetable.oc1..foreign')).toEqual([
    { destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: 'ocid1.igw.oc1..foreign' },
  ]);
});

test('a world-open SSH cidr is refused before any create', async () => {
  const cloud = new MemoryCloud();
  const authorization = OciFreeTierGate.evaluate({ report: inspection(), eligibility, mode: 'LIVE', now });
  await expect(OciProvisioner.deploy({
    gateway: cloud, authorization, compartmentId, sshPublicKey, sshCidr: '0.0.0.0/0',
    cloudInit: '#!/bin/bash\n', state: OciDeployState.create(), clock, deadlineMs: 1_000,
    installAgent: async () => {}, verify: async () => {}, saveState: async () => {},
  })).rejects.toMatchObject({ code: 'SSH_CIDR_TOO_WIDE' });
  expect(cloud.calls.createVcn).toBe(0);
});

test('a permission failure is not treated as a deleted instance', async () => {
  const cloud = new MemoryCloud();
  const first = await run(cloud);
  cloud.denyGets.add(first.receipt.instanceId);
  await expect(run(cloud, first.state)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(cloud.attempts).toHaveLength(1);
});

test('listing confirms a missing instance before another launch', async () => {
  const cloud = new MemoryCloud();
  const first = await run(cloud);
  cloud.instances = cloud.instances.filter(item => item.id !== first.receipt.instanceId);
  cloud.denyGets.add(first.receipt.instanceId);
  const second = await run(cloud, first.state);
  expect(second.receipt.instanceSource).toBe('created');
  expect(cloud.attempts).toHaveLength(2);
  expect(cloud.attempts.every(attempt => attempt.shape === 'VM.Standard.A1.Flex')).toBe(true);
});

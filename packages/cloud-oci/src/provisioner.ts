import { DeployError } from './errors.js';
import type { DeploymentAuthorization } from './gate.js';
import type { InstanceRecord, OciGateway, TaggedRecord } from './gateway.js';
import { OciImageSelector } from './images.js';
import { OciResourcePlan } from './plan.js';
import { OciDeployState, type DeployRecord } from './state.js';

export interface DeployClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface DeployReceipt {
  action: 'deploy';
  executed: true;
  instanceSource: 'created' | 'reused' | 'recovered';
  instanceId: string;
  publicIp: string;
  publicIpAssignment: 'EPHEMERAL';
  reusedNetwork: boolean;
  agentReady: true;
  shape: string;
  ocpus: number;
  memoryGb: number;
  bootGb: number;
  region: string;
  availabilityDomain: string;
  imageId: string;
  compartmentId: string;
}

export interface DestroyReceipt {
  action: 'destroy';
  executed: true;
  deleted: {
    instances: string[]; bootVolumes: string[]; subnets: string[];
    internetGateways: string[]; securityLists: string[]; vcns: string[];
  };
  preservedDisplayNames: string[];
  networkDeleted: boolean;
}

const systemClock: DeployClock = {
  now: () => Date.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Creates one free A1 host, or deletes only the resources this deployer tagged. */
export class OciProvisioner {
  static async deploy(input: {
    gateway: OciGateway;
    authorization: DeploymentAuthorization;
    compartmentId: string;
    sshPublicKey: string;
    sshCidr: string;
    cloudInit: string;
    state: DeployRecord;
    verify: (publicIp: string, password: string) => Promise<void>;
    saveState?: (state: DeployRecord) => Promise<void>;
    clock?: DeployClock;
    deadlineMs?: number;
  }): Promise<DeployReceipt> {
    if (!input.authorization.provisioningAllowed || !input.authorization.region || !input.authorization.availabilityDomain) {
      throw new DeployError('NOT_AUTHORIZED');
    }
    const region = input.authorization.region;
    const sshPublicKey = OciResourcePlan.sshPublicKey(input.sshPublicKey);
    const sshCidr = OciResourcePlan.sshCidr(input.sshCidr);
    const compartmentId = OciResourcePlan.compartmentId(input.compartmentId);
    const userData = Buffer.from(input.cloudInit, 'utf8').toString('base64');
    if (Buffer.byteLength(userData) + Buffer.byteLength(sshPublicKey) > 30_000) throw new DeployError('CLOUD_INIT_TOO_LARGE');
    const clock = input.clock ?? systemClock;
    const deadline = clock.now() + (input.deadlineMs ?? 15 * 60_000);
    input.gateway.useRegion(region);
    await this.compartment(input.gateway, compartmentId);
    const availabilityDomain = OciResourcePlan.availabilityDomain(
      await input.gateway.listAvailabilityDomains(compartmentId), input.authorization.availabilityDomain,
    );
    let state = input.state;
    if (state.instanceId) {
      const previous = await input.gateway.getInstance(state.instanceId);
      if (!previous || previous.lifecycleState === 'TERMINATED') {
        state = OciDeployState.withoutInstance(state);
        await input.saveState?.(state);
      }
    }
    const network = await this.network(input.gateway, clock, deadline, compartmentId, sshCidr, state);
    const image = OciImageSelector.select(await input.gateway.listImages(compartmentId));
    const resolved = await this.instance(input.gateway, clock, deadline, {
      compartmentId, availabilityDomain, subnetId: network.subnet.id, imageId: image.id, sshPublicKey, userData, state,
    }, async next => { await input.saveState?.(next); });
    state = resolved.state;
    const attachment = (await input.gateway.listBootVolumeAttachments(compartmentId, availabilityDomain, resolved.instance.id))
      .find(item => item.lifecycleState !== 'DETACHED');
    if (attachment) {
      await input.gateway.tagBootVolume(attachment.bootVolumeId);
      state = { ...state, instanceId: resolved.instance.id, bootVolumeId: attachment.bootVolumeId };
    } else {
      state = { ...state, instanceId: resolved.instance.id };
    }
    await input.saveState?.(state);
    const publicIp = await this.publicIp(input.gateway, clock, deadline, compartmentId, resolved.instance.id);
    const password = OciDeployState.passwordFromUserData(resolved.instance.userData) ?? state.password;
    if (password !== state.password) {
      state = { ...state, password };
      await input.saveState?.(state);
    }
    await this.verifyReady(input.verify, publicIp, password, clock, deadline);
    return {
      action: 'deploy', executed: true, instanceSource: resolved.source, instanceId: resolved.instance.id,
      publicIp, publicIpAssignment: 'EPHEMERAL', reusedNetwork: !network.created, agentReady: true,
      shape: OciResourcePlan.shape, ocpus: OciResourcePlan.ocpus, memoryGb: OciResourcePlan.memoryGb,
      bootGb: OciResourcePlan.bootGb, region, availabilityDomain, imageId: image.id, compartmentId,
    };
  }

  static async destroy(input: {
    gateway: OciGateway;
    compartmentId: string;
    region?: string;
    state?: DeployRecord;
    saveState?: (state: DeployRecord) => Promise<void>;
    clock?: DeployClock;
    deadlineMs?: number;
  }): Promise<DestroyReceipt> {
    const compartmentId = OciResourcePlan.compartmentId(input.compartmentId);
    const clock = input.clock ?? systemClock;
    const deadline = clock.now() + (input.deadlineMs ?? 15 * 60_000);
    if (input.region) input.gateway.useRegion(input.region);
    await this.compartment(input.gateway, compartmentId);
    const deleted = { instances: [] as string[], bootVolumes: [] as string[], subnets: [] as string[], internetGateways: [] as string[], securityLists: [] as string[], vcns: [] as string[] };
    const before = await input.gateway.listInstances(compartmentId);
    const preservedDisplayNames = before
      .filter(instance => instance.lifecycleState !== 'TERMINATED' && !OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName]))
      .map(instance => instance.displayName);
    const ownedIds = new Set(before.filter(instance => OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName])).map(instance => instance.id));
    const volumeIds = new Set<string>();
    for (const instance of before.filter(item => ownedIds.has(item.id))) {
      const attachments = await input.gateway.listBootVolumeAttachments(compartmentId, instance.availabilityDomain, instance.id);
      for (const attachment of attachments) volumeIds.add(attachment.bootVolumeId);
      if (instance.lifecycleState === 'TERMINATED') continue;
      if (instance.lifecycleState === 'TERMINATING') {
        await this.waitGone(clock, deadline, () => input.gateway.getInstance(instance.id));
        continue;
      }
      await input.gateway.terminateInstance(instance.id);
      deleted.instances.push(instance.id);
      await this.waitGone(clock, deadline, () => input.gateway.getInstance(instance.id));
    }
    const domains = await input.gateway.listAvailabilityDomains(compartmentId);
    for (const domain of domains) {
      await this.waitBootDetached(input.gateway, clock, deadline, compartmentId, domain, volumeIds);
      const attachments = await input.gateway.listBootVolumeAttachments(compartmentId, domain);
      for (const volume of await input.gateway.listBootVolumes(compartmentId, domain)) {
        const ours = volumeIds.has(volume.id) || OciResourcePlan.isOwned(volume, [OciResourcePlan.bootVolumeName]);
        if (!ours || volume.lifecycleState === 'TERMINATED') continue;
        if (attachments.some(attachment => attachment.bootVolumeId === volume.id && !ownedIds.has(attachment.instanceId) && attachment.lifecycleState !== 'DETACHED')) {
          throw new DeployError('BOOT_VOLUME_ATTACHED_ELSEWHERE', { deleted, preservedDisplayNames, networkDeleted: false });
        }
        await input.gateway.deleteBootVolume(volume.id);
        deleted.bootVolumes.push(volume.id);
      }
    }
    const networkDeleted = await this.deleteNetwork(input.gateway, clock, deadline, compartmentId, ownedIds, deleted, preservedDisplayNames);
    if (input.state && input.saveState && ownedIds.size > 0) await input.saveState(OciDeployState.create());
    return { action: 'destroy', executed: true, deleted, preservedDisplayNames, networkDeleted };
  }

  private static async compartment(gateway: OciGateway, compartmentId: string) {
    const compartment = await gateway.getCompartment(compartmentId);
    if (compartment.id !== compartmentId || compartment.lifecycleState !== 'ACTIVE') throw new DeployError('COMPARTMENT_UNAVAILABLE');
  }

  private static ownedInstances(instances: readonly InstanceRecord[]) {
    return instances.filter(instance => instance.lifecycleState !== 'TERMINATED' && OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName]));
  }

  private static async network(
    gateway: OciGateway, clock: DeployClock, deadline: number, compartmentId: string, sshCidr: string, state: DeployRecord,
  ) {
    const vcn = await this.one(gateway, clock, deadline, {
      list: () => gateway.listVcns(compartmentId),
      create: () => gateway.createVcn(compartmentId, state.tokens.vcn),
      read: id => gateway.getVcn(id),
      names: [OciResourcePlan.displayName],
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    if (!vcn.resource.defaultRouteTableId) throw new DeployError('ROUTE_TABLE_MISSING');
    const igw = await this.one(gateway, clock, deadline, {
      list: () => gateway.listInternetGateways(compartmentId, vcn.resource.id),
      create: () => gateway.createInternetGateway(compartmentId, vcn.resource.id, state.tokens.internetGateway),
      read: id => gateway.getInternetGateway(id),
      names: [OciResourcePlan.internetGatewayName],
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    const table = await gateway.getRouteTable(vcn.resource.defaultRouteTableId);
    if (table.routeRules.some(rule => rule.destination === '0.0.0.0/0' && rule.networkEntityId !== igw.resource.id)) {
      throw new DeployError('ROUTE_CONFLICT');
    }
    if (!table.routeRules.some(rule => rule.destination === '0.0.0.0/0' && rule.networkEntityId === igw.resource.id)) {
      await gateway.updateRouteTable(vcn.resource.defaultRouteTableId, [
        ...table.routeRules,
        { destination: '0.0.0.0/0', destinationType: 'CIDR_BLOCK', networkEntityId: igw.resource.id, description: OciResourcePlan.displayName },
      ]);
    }
    const securityList = await this.one(gateway, clock, deadline, {
      list: () => gateway.listSecurityLists(compartmentId, vcn.resource.id),
      create: () => gateway.createSecurityList(compartmentId, vcn.resource.id, sshCidr, state.tokens.securityList),
      read: id => gateway.getSecurityList(id),
      names: [OciResourcePlan.displayName],
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    if (!securityList.created) await gateway.updateSecurityList(securityList.resource.id, sshCidr);
    const subnet = await this.one(gateway, clock, deadline, {
      list: () => gateway.listSubnets(compartmentId, vcn.resource.id),
      create: () => gateway.createSubnet({
        compartmentId, vcnId: vcn.resource.id, routeTableId: vcn.resource.defaultRouteTableId, securityListId: securityList.resource.id,
      }, state.tokens.subnet),
      read: id => gateway.getSubnet(id),
      names: [OciResourcePlan.displayName],
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    return { ...subnet, created: vcn.created, subnet: subnet.resource, vcn: vcn.resource, igw: igw.resource, securityList: securityList.resource };
  }

  private static async one<T extends TaggedRecord>(
    gateway: OciGateway, clock: DeployClock, deadline: number,
    input: { list: () => Promise<T[]>; create: () => Promise<T>; read: (id: string) => Promise<T | null>; names: string[]; conflict: string },
  ): Promise<{ resource: T; created: boolean }> {
    const choose = (resources: T[]) => {
      const alive = resources.filter(resource => resource.lifecycleState !== 'TERMINATED');
      const owned = alive.filter(resource => OciResourcePlan.isOwned(resource, input.names));
      const clash = alive.filter(resource => input.names.includes(resource.displayName) && !OciResourcePlan.isOwned(resource, input.names));
      if (clash.length) throw new DeployError(input.conflict);
      if (owned.length > 1) throw new DeployError('AMBIGUOUS_NETWORK');
      return owned[0] ?? null;
    };
    const existing = choose(await input.list());
    if (existing) {
      const ready = await this.waitReady(clock, deadline, () => input.read(existing.id));
      return { resource: ready, created: false };
    }
    let created: T;
    try { created = await input.create(); }
    catch (error) {
      const recovered = choose(await input.list());
      if (!recovered) throw error;
      created = recovered;
    }
    return { resource: await this.waitReady(clock, deadline, () => input.read(created.id)), created: true };
  }

  private static async instance(
    gateway: OciGateway, clock: DeployClock, deadline: number,
    input: { compartmentId: string; availabilityDomain: string; subnetId: string; imageId: string; sshPublicKey: string; userData: string; state: DeployRecord },
    save: (state: DeployRecord) => Promise<void>,
  ): Promise<{ instance: InstanceRecord; state: DeployRecord; source: DeployReceipt['instanceSource'] }> {
    const present = this.ownedInstances(await gateway.listInstances(input.compartmentId));
    const clash = (await gateway.listInstances(input.compartmentId)).filter(instance => instance.lifecycleState !== 'TERMINATED'
      && instance.displayName === OciResourcePlan.displayName && !OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName]));
    if (clash.length) throw new DeployError('INSTANCE_NAME_CONFLICT');
    if (present.length > 1) throw new DeployError('MULTIPLE_ACTIVE_AGENTS');
    if (present.some(instance => instance.lifecycleState === 'TERMINATING')) throw new DeployError('DESTROY_IN_PROGRESS');
    const current = present[0];
    if (current) {
      const running = await this.running(gateway, clock, deadline, current);
      this.assertFreeInstance(running, input.availabilityDomain);
      return { instance: running, state: { ...input.state, instanceId: running.id }, source: 'reused' };
    }
    let state = input.state;
    await save(state);
    let source: DeployReceipt['instanceSource'] = 'created';
    let launched: InstanceRecord;
    try {
      launched = await gateway.launchInstance({
        compartmentId: input.compartmentId, availabilityDomain: input.availabilityDomain, subnetId: input.subnetId,
        imageId: input.imageId, sshPublicKey: input.sshPublicKey, userData: input.userData,
      }, state.tokens.instance);
    } catch (error) {
      const recovered = this.ownedInstances(await gateway.listInstances(input.compartmentId));
      if (recovered.length !== 1 || !recovered[0]) throw error;
      launched = recovered[0];
      source = 'recovered';
    }
    const running = await this.running(gateway, clock, deadline, launched);
    this.assertFreeInstance(running, input.availabilityDomain);
    state = { ...state, instanceId: running.id };
    await save(state);
    return { instance: running, state, source };
  }

  private static assertFreeInstance(instance: InstanceRecord, availabilityDomain: string) {
    if (instance.shape !== OciResourcePlan.shape) throw new DeployError('SHAPE_MISMATCH');
    if (instance.ocpus !== undefined && instance.ocpus !== OciResourcePlan.ocpus) throw new DeployError('SHAPE_MISMATCH');
    if (instance.memoryInGBs !== undefined && instance.memoryInGBs !== OciResourcePlan.memoryGb) throw new DeployError('SHAPE_MISMATCH');
    if (instance.availabilityDomain !== availabilityDomain) throw new DeployError('AD_MISMATCH');
  }

  private static async running(gateway: OciGateway, clock: DeployClock, deadline: number, instance: InstanceRecord) {
    let current = instance;
    if (current.lifecycleState === 'STOPPED') {
      await gateway.startInstance(current.id);
      current = await this.waitReady(clock, deadline, () => gateway.getInstance(current.id), 'RUNNING');
      return current;
    }
    if (current.lifecycleState === 'RUNNING') return current;
    return this.waitReady(clock, deadline, () => gateway.getInstance(current.id), 'RUNNING');
  }

  private static async publicIp(gateway: OciGateway, clock: DeployClock, deadline: number, compartmentId: string, instanceId: string) {
    for (;;) {
      const attachments = await gateway.listVnicAttachments(compartmentId, instanceId);
      const vnics = [];
      for (const attachment of attachments) {
        if (attachment.lifecycleState === 'DETACHED' || !attachment.vnicId) continue;
        const vnic = await gateway.getVnic(attachment.vnicId);
        if (vnic?.publicIp) vnics.push(vnic);
      }
      const selected = vnics.find(vnic => vnic.isPrimary) ?? vnics[0];
      if (selected?.publicIp) return selected.publicIp;
      if (clock.now() >= deadline) throw new DeployError('TIMED_OUT');
      await clock.wait(2_000);
    }
  }

  private static async verifyReady(
    verify: (publicIp: string, password: string) => Promise<void>,
    publicIp: string, password: string, clock: DeployClock, deadline: number,
  ) {
    for (;;) {
      try {
        await verify(publicIp, password);
        return;
      } catch (error) {
        const code = error instanceof Error && error.message === 'AGENT_UNAUTHORIZED' ? 'AGENT_UNAUTHORIZED'
          : error instanceof Error && error.message === 'SSH_TUNNEL_FAILED' ? 'SSH_TUNNEL_FAILED' : 'AGENT_NOT_READY';
        if (code === 'AGENT_UNAUTHORIZED' || clock.now() >= deadline) throw new DeployError(code);
        await clock.wait(2_000);
      }
    }
  }

  private static async deleteNetwork(
    gateway: OciGateway, clock: DeployClock, deadline: number, compartmentId: string,
    ownedIds: Set<string>, deleted: DestroyReceipt['deleted'], preservedDisplayNames: string[],
  ) {
    const vcns = (await gateway.listVcns(compartmentId)).filter(vcn => vcn.lifecycleState !== 'TERMINATED' && OciResourcePlan.isOwned(vcn, [OciResourcePlan.displayName]));
    if (vcns.length === 0) return false;
    for (const vcn of vcns) {
      const subnets = (await gateway.listSubnets(compartmentId, vcn.id)).filter(subnet => subnet.lifecycleState !== 'TERMINATED');
      if (subnets.some(subnet => !OciResourcePlan.isOwned(subnet, [OciResourcePlan.displayName]))) {
        throw new DeployError('NETWORK_IN_USE', { deleted, preservedDisplayNames, networkDeleted: false });
      }
      const attachments = await gateway.listVnicAttachments(compartmentId);
      for (const attachment of attachments) {
        if (attachment.lifecycleState === 'DETACHED' || !attachment.vnicId) continue;
        const vnic = await gateway.getVnic(attachment.vnicId);
        if (!vnic || !subnets.some(subnet => subnet.id === vnic.subnetId)) continue;
        if (!ownedIds.has(attachment.instanceId)) throw new DeployError('NETWORK_IN_USE', { deleted, preservedDisplayNames, networkDeleted: false });
      }
      for (const subnet of subnets) {
        await gateway.deleteSubnet(subnet.id);
        deleted.subnets.push(subnet.id);
        await this.waitGone(clock, deadline, () => gateway.getSubnet(subnet.id));
      }
      if (vcn.defaultRouteTableId) {
        const table = await gateway.getRouteTable(vcn.defaultRouteTableId);
        const igws = (await gateway.listInternetGateways(compartmentId, vcn.id)).filter(igw => OciResourcePlan.isOwned(igw, [OciResourcePlan.internetGatewayName]));
        const igwIds = new Set(igws.map(igw => igw.id));
        const kept = table.routeRules.filter(rule => !(rule.destination === '0.0.0.0/0' && igwIds.has(rule.networkEntityId)));
        if (kept.length !== table.routeRules.length) await gateway.updateRouteTable(vcn.defaultRouteTableId, kept);
        for (const igw of igws) {
          await gateway.deleteInternetGateway(igw.id);
          deleted.internetGateways.push(igw.id);
          await this.waitGone(clock, deadline, () => gateway.getInternetGateway(igw.id));
        }
      }
      for (const list of (await gateway.listSecurityLists(compartmentId, vcn.id)).filter(list => OciResourcePlan.isOwned(list, [OciResourcePlan.displayName]))) {
        await gateway.deleteSecurityList(list.id);
        deleted.securityLists.push(list.id);
        await this.waitGone(clock, deadline, () => gateway.getSecurityList(list.id));
      }
      await gateway.deleteVcn(vcn.id);
      deleted.vcns.push(vcn.id);
      await this.waitGone(clock, deadline, () => gateway.getVcn(vcn.id));
    }
    return true;
  }

  private static async waitBootDetached(
    gateway: OciGateway, clock: DeployClock, deadline: number, compartmentId: string, domain: string, volumeIds: Set<string>,
  ) {
    if (volumeIds.size === 0) return;
    for (;;) {
      const attachments = await gateway.listBootVolumeAttachments(compartmentId, domain);
      const stuck = attachments.some(attachment => volumeIds.has(attachment.bootVolumeId) && attachment.lifecycleState === 'ATTACHED');
      if (!stuck) return;
      if (clock.now() >= deadline) throw new DeployError('TIMED_OUT');
      await clock.wait(2_000);
    }
  }

  private static async waitReady<T extends { lifecycleState: string }>(
    clock: DeployClock, deadline: number, read: () => Promise<T | null>, ready = 'AVAILABLE',
  ): Promise<T> {
    for (;;) {
      const current = await read();
      if (!current) throw new DeployError('RESOURCE_MISSING');
      if (current.lifecycleState === ready) return current;
      if (current.lifecycleState === 'TERMINATED' || current.lifecycleState === 'FAILED') throw new DeployError('RESOURCE_FAILED');
      if (clock.now() >= deadline) throw new DeployError('TIMED_OUT');
      await clock.wait(2_000);
    }
  }

  private static async waitGone(clock: DeployClock, deadline: number, read: () => Promise<{ lifecycleState: string } | null>) {
    for (;;) {
      const current = await read();
      if (!current || current.lifecycleState === 'TERMINATED') return;
      if (clock.now() >= deadline) throw new DeployError('TIMED_OUT');
      await clock.wait(2_000);
    }
  }
}

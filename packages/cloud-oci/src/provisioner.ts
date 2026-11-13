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
  preserved: { id: string; displayName: string; reason: 'NOT_RECORDED' | 'TAG_OR_NAME_MISMATCH' }[];
  networkDeleted: boolean;
}

export class SystemClock {
  static now(): number { return Date.now(); }
  static wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
}

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
    installAgent: (publicIp: string, password: string, freshHost: boolean) => Promise<void>;
    verify: (publicIp: string, password: string, freshHost: boolean) => Promise<void>;
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
    const clock = input.clock ?? SystemClock;
    const deadline = clock.now() + (input.deadlineMs ?? 15 * 60_000);
    input.gateway.useRegion(region);
    input.gateway.useDeployment(input.state.deploymentId);
    await this.compartment(input.gateway, compartmentId);
    const availabilityDomain = OciResourcePlan.availabilityDomain(
      await input.gateway.listAvailabilityDomains(compartmentId), input.authorization.availabilityDomain,
    );
    let state = OciDeployState.locate(input.state, region, compartmentId);
    await input.saveState?.(state);
    if (state.resources.instanceId) {
      const previous = await this.readRecord(
        () => input.gateway.getInstance(state.resources.instanceId!),
        () => input.gateway.listInstances(compartmentId),
        state.resources.instanceId,
      );
      if (!previous || previous.lifecycleState === 'TERMINATED') {
        state = OciDeployState.withoutInstance(state);
        await input.saveState?.(state);
      }
    }
    const network = await this.network(input.gateway, clock, deadline, compartmentId, sshCidr, state);
    state = OciDeployState.remember(state, {
      vcnId: network.vcn.id, internetGatewayId: network.igw.id, securityListId: network.securityList.id,
      subnetId: network.subnet.id, routeTableId: network.vcn.defaultRouteTableId,
    });
    await input.saveState?.(state);
    const image = OciImageSelector.select(await input.gateway.listImages(compartmentId));
    const resolved = await this.instance(input.gateway, clock, deadline, {
      compartmentId, availabilityDomain, subnetId: network.subnet.id, imageId: image.id, sshPublicKey, userData, state,
    }, async next => { await input.saveState?.(next); });
    state = resolved.state;
    const attachment = (await input.gateway.listBootVolumeAttachments(compartmentId, availabilityDomain, resolved.instance.id))
      .find(item => item.lifecycleState !== 'DETACHED');
    if (attachment) await input.gateway.tagBootVolume(attachment.bootVolumeId);
    state = OciDeployState.remember(state, {
      instanceId: resolved.instance.id, ...(attachment ? { bootVolumeId: attachment.bootVolumeId } : {}),
    });
    await input.saveState?.(state);
    const publicIp = await this.publicIp(input.gateway, clock, deadline, compartmentId, resolved.instance.id);
    const freshHost = resolved.source !== 'reused';
    await this.bringUp(input.installAgent, input.verify, publicIp, state.password, freshHost, clock, deadline);
    return {
      action: 'deploy', executed: true, instanceSource: resolved.source, instanceId: resolved.instance.id,
      publicIp, publicIpAssignment: 'EPHEMERAL', reusedNetwork: !network.created, agentReady: true,
      shape: OciResourcePlan.shape, ocpus: OciResourcePlan.ocpus, memoryGb: OciResourcePlan.memoryGb,
      bootGb: OciResourcePlan.bootGb, region, availabilityDomain, imageId: image.id, compartmentId,
    };
  }

  static async planDestroy(input: {
    gateway: OciGateway; state: DeployRecord; includeUnrecorded?: boolean;
  }) {
    const located = this.located(input.state);
    input.gateway.useRegion(located.region);
    input.gateway.useDeployment(located.deploymentId);
    await this.compartment(input.gateway, located.compartmentId);
    const recorded = await this.recordedResources(input.gateway, located);
    const extras = await this.unrecorded(input.gateway, located, recorded.map(item => item.id));
    const instances = await input.gateway.listInstances(located.compartmentId);
    const deleting = new Set([...recorded, ...(input.includeUnrecorded ? extras : [])].map(item => item.id));
    return {
      action: 'destroy' as const, executed: false as const, queriedOracle: true as const,
      region: located.region, compartmentId: located.compartmentId, deploymentId: located.deploymentId,
      wouldDelete: [...recorded, ...(input.includeUnrecorded ? extras : [])],
      preserved: instances.filter(instance => instance.lifecycleState !== 'TERMINATED' && !deleting.has(instance.id)).map(instance => ({
        id: instance.id, displayName: instance.displayName,
        reason: extras.some(item => item.id === instance.id) ? 'NOT_RECORDED' as const : 'TAG_OR_NAME_MISMATCH' as const,
      })),
      deletionRequires: '--yes' as const,
    };
  }

  static async destroy(input: {
    gateway: OciGateway; state: DeployRecord; includeUnrecorded?: boolean;
    saveState?: (state: DeployRecord) => Promise<void>; clock?: DeployClock; deadlineMs?: number;
  }): Promise<DestroyReceipt> {
    const plan = await this.planDestroy(input);
    const clock = input.clock ?? SystemClock;
    const deadline = clock.now() + (input.deadlineMs ?? 15 * 60_000);
    const deleted = { instances: [] as string[], bootVolumes: [] as string[], subnets: [] as string[], internetGateways: [] as string[], securityLists: [] as string[], vcns: [] as string[] };
    const chosen = plan.wouldDelete;
    const instances = chosen.filter(item => item.type === 'instance');
    for (const instance of instances) {
      if (instance.lifecycleState === 'TERMINATED') continue;
      if (instance.lifecycleState !== 'TERMINATING') {
        const domain = instance.availabilityDomain;
        if (!domain) throw new DeployError('AD_NOT_RESOLVED');
        const attachments = await input.gateway.listBootVolumeAttachments(plan.compartmentId, domain, instance.id);
        for (const attachment of attachments) {
          if (!chosen.some(item => item.id === attachment.bootVolumeId) && input.state.resources.bootVolumeId === attachment.bootVolumeId) {
            chosen.push({ type: 'boot-volume', id: attachment.bootVolumeId, displayName: OciResourcePlan.bootVolumeName, recorded: true, lifecycleState: 'AVAILABLE', availabilityDomain: domain });
          }
        }
        await this.deleteConfirmed(
          () => input.gateway.terminateInstance(instance.id),
          () => input.gateway.listInstances(plan.compartmentId),
          instance.id,
        );
        deleted.instances.push(instance.id);
      }
      await this.waitGone(clock, deadline, () => this.readRecord(
        () => input.gateway.getInstance(instance.id), () => input.gateway.listInstances(plan.compartmentId), instance.id,
      ));
    }
    const volumeIds = new Set(chosen.filter(item => item.type === 'boot-volume').map(item => item.id));
    const domains = [...new Set(chosen.map(item => item.availabilityDomain).filter((domain): domain is string => Boolean(domain)))];
    for (const domain of domains) await this.waitBootDetached(input.gateway, clock, deadline, plan.compartmentId, domain, volumeIds);
    for (const volume of chosen.filter(item => item.type === 'boot-volume')) {
      await this.deleteConfirmed(
        () => input.gateway.deleteBootVolume(volume.id),
        async () => {
          const domains = await input.gateway.listAvailabilityDomains(plan.compartmentId);
          const volumes = [];
          for (const domain of domains) volumes.push(...await input.gateway.listBootVolumes(plan.compartmentId, domain));
          return volumes;
        },
        volume.id,
      );
      deleted.bootVolumes.push(volume.id);
    }
    const subnet = chosen.find(item => item.type === 'subnet');
    if (subnet) {
      const attachments = await input.gateway.listVnicAttachments(plan.compartmentId);
      for (const attachment of attachments) {
        if (attachment.lifecycleState === 'DETACHED' || !attachment.vnicId) continue;
        const vnic = await input.gateway.getVnic(attachment.vnicId);
        if (vnic?.subnetId === subnet.id && !instances.some(item => item.id === attachment.instanceId)) {
          throw new DeployError('NETWORK_IN_USE', { deleted, preserved: plan.preserved, networkDeleted: false });
        }
      }
      const vcnId = input.state.resources.vcnId ?? '';
      await this.deleteConfirmed(
        () => input.gateway.deleteSubnet(subnet.id),
        () => input.gateway.listSubnets(plan.compartmentId, vcnId),
        subnet.id,
      );
      deleted.subnets.push(subnet.id);
      await this.waitGone(clock, deadline, () => this.readRecord(
        () => input.gateway.getSubnet(subnet.id),
        () => input.gateway.listSubnets(plan.compartmentId, vcnId),
        subnet.id,
      ));
    }
    const vcn = chosen.find(item => item.type === 'vcn');
    if (input.state.resources.routeTableId && chosen.some(item => item.type === 'internet-gateway')) {
      const table = await input.gateway.getRouteTable(input.state.resources.routeTableId);
      const igwIds = new Set(chosen.filter(item => item.type === 'internet-gateway').map(item => item.id));
      const kept = table.routeRules.filter(rule => !(rule.destination === '0.0.0.0/0' && igwIds.has(rule.networkEntityId)));
      if (kept.length !== table.routeRules.length) await input.gateway.updateRouteTable(input.state.resources.routeTableId, kept);
    }
    for (const igw of chosen.filter(item => item.type === 'internet-gateway')) {
      await this.deleteConfirmed(
        () => input.gateway.deleteInternetGateway(igw.id),
        () => input.gateway.listInternetGateways(plan.compartmentId, input.state.resources.vcnId ?? ''),
        igw.id,
      );
      deleted.internetGateways.push(igw.id);
      await this.waitGone(clock, deadline, () => this.readRecord(
        id => input.gateway.getInternetGateway(id),
        () => input.gateway.listInternetGateways(plan.compartmentId, input.state.resources.vcnId ?? ''),
        igw.id,
      ));
    }
    for (const list of chosen.filter(item => item.type === 'security-list')) {
      await this.deleteConfirmed(
        () => input.gateway.deleteSecurityList(list.id),
        () => input.gateway.listSecurityLists(plan.compartmentId, input.state.resources.vcnId ?? ''),
        list.id,
      );
      deleted.securityLists.push(list.id);
      await this.waitGone(clock, deadline, () => this.readRecord(
        id => input.gateway.getSecurityList(id),
        () => input.gateway.listSecurityLists(plan.compartmentId, input.state.resources.vcnId ?? ''),
        list.id,
      ));
    }
    if (vcn) {
      await this.deleteConfirmed(() => input.gateway.deleteVcn(vcn.id), () => input.gateway.listVcns(plan.compartmentId), vcn.id);
      deleted.vcns.push(vcn.id);
      await this.waitGone(clock, deadline, () => this.readRecord(
        id => input.gateway.getVcn(id), () => input.gateway.listVcns(plan.compartmentId), vcn.id,
      ));
    }
    if (input.saveState) await input.saveState(OciDeployState.afterDestroy(input.state));
    return { action: 'destroy', executed: true, deleted, preserved: plan.preserved, networkDeleted: deleted.vcns.length > 0 };
  }

  private static async compartment(gateway: OciGateway, compartmentId: string) {
    const compartment = await gateway.getCompartment(compartmentId);
    if (compartment.id !== compartmentId || compartment.lifecycleState !== 'ACTIVE') throw new DeployError('COMPARTMENT_UNAVAILABLE');
  }

  private static ownedInstances(instances: readonly InstanceRecord[], deploymentId: string) {
    return instances.filter(instance => instance.lifecycleState !== 'TERMINATED' && OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName], deploymentId));
  }

  private static async network(
    gateway: OciGateway, clock: DeployClock, deadline: number, compartmentId: string, sshCidr: string, state: DeployRecord,
  ) {
    const vcn = await this.one(gateway, clock, deadline, {
      list: () => gateway.listVcns(compartmentId),
      create: () => gateway.createVcn(compartmentId, state.tokens.vcn),
      read: id => gateway.getVcn(id),
      names: [OciResourcePlan.displayName],
      deploymentId: state.deploymentId,
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    if (!vcn.resource.defaultRouteTableId) throw new DeployError('ROUTE_TABLE_MISSING');
    const igw = await this.one(gateway, clock, deadline, {
      list: () => gateway.listInternetGateways(compartmentId, vcn.resource.id),
      create: () => gateway.createInternetGateway(compartmentId, vcn.resource.id, state.tokens.internetGateway),
      read: id => gateway.getInternetGateway(id),
      names: [OciResourcePlan.internetGatewayName],
      deploymentId: state.deploymentId,
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
      deploymentId: state.deploymentId,
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
      deploymentId: state.deploymentId,
      conflict: 'NETWORK_NAME_CONFLICT',
    });
    return { ...subnet, created: vcn.created, subnet: subnet.resource, vcn: vcn.resource, igw: igw.resource, securityList: securityList.resource };
  }

  private static async one<T extends TaggedRecord>(
    gateway: OciGateway, clock: DeployClock, deadline: number,
    input: { list: () => Promise<T[]>; create: () => Promise<T>; read: (id: string) => Promise<T | null>; names: string[]; deploymentId: string; conflict: string },
  ): Promise<{ resource: T; created: boolean }> {
    const choose = (resources: T[]) => {
      const alive = resources.filter(resource => resource.lifecycleState !== 'TERMINATED');
      const owned = alive.filter(resource => OciResourcePlan.isOwned(resource, input.names, input.deploymentId));
      const clash = alive.filter(resource => input.names.includes(resource.displayName) && !OciResourcePlan.isOwned(resource, input.names, input.deploymentId));
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
    const listed = await gateway.listInstances(input.compartmentId);
    const present = this.ownedInstances(listed, input.state.deploymentId);
    const clash = listed.filter(instance => instance.lifecycleState !== 'TERMINATED'
      && instance.displayName === OciResourcePlan.displayName && !OciResourcePlan.isOwned(instance, [OciResourcePlan.displayName], input.state.deploymentId));
    if (clash.length) throw new DeployError('INSTANCE_NAME_CONFLICT');
    if (present.length > 1) throw new DeployError('MULTIPLE_ACTIVE_AGENTS');
    if (present.some(instance => instance.lifecycleState === 'TERMINATING')) throw new DeployError('DESTROY_IN_PROGRESS');
    const current = present[0];
    if (current) {
      const running = await this.running(gateway, clock, deadline, current);
      this.assertFreeInstance(running, input.availabilityDomain);
      return { instance: running, state: OciDeployState.remember(input.state, { instanceId: running.id }), source: 'reused' };
    }
    let state = input.state;
    await save(state);
    let source: DeployReceipt['instanceSource'] = 'created';
    let launched: InstanceRecord;
    try {
      launched = await gateway.launchInstance({
        compartmentId: input.compartmentId, availabilityDomain: input.availabilityDomain, subnetId: input.subnetId,
        imageId: input.imageId, sshPublicKey: input.sshPublicKey, userData: input.userData, deploymentId: state.deploymentId,
      }, state.tokens.instance);
    } catch (error) {
      const recovered = this.ownedInstances(await gateway.listInstances(input.compartmentId), state.deploymentId);
      if (recovered.length !== 1 || !recovered[0]) throw error;
      launched = recovered[0];
      source = 'recovered';
    }
    const running = await this.running(gateway, clock, deadline, launched);
    this.assertFreeInstance(running, input.availabilityDomain);
    state = OciDeployState.remember(state, { instanceId: running.id });
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

  private static located(state: DeployRecord): DeployRecord & { region: string; compartmentId: string } {
    if (!state.region || !state.compartmentId) throw new DeployError('STATE_INCOMPLETE');
    return { ...state, region: state.region, compartmentId: state.compartmentId };
  }

  private static async recordedResources(gateway: OciGateway, state: DeployRecord & { compartmentId: string }) {
    const deploymentId = state.deploymentId;
    const specs: { type: string; id: string | undefined; names: string[]; list: () => Promise<{ id: string }[]>; read: (id: string) => Promise<TaggedRecord | InstanceRecord | null> }[] = [
      { type: 'instance', id: state.resources.instanceId, names: [OciResourcePlan.displayName], list: () => gateway.listInstances(state.compartmentId), read: id => gateway.getInstance(id) },
      { type: 'boot-volume', id: state.resources.bootVolumeId, names: [OciResourcePlan.bootVolumeName], list: async () => {
        const domains = await gateway.listAvailabilityDomains(state.compartmentId);
        const volumes = [];
        for (const domain of domains) volumes.push(...await gateway.listBootVolumes(state.compartmentId, domain));
        return volumes;
      }, read: id => gateway.getBootVolume(id) },
      { type: 'subnet', id: state.resources.subnetId, names: [OciResourcePlan.displayName], list: () => gateway.listSubnets(state.compartmentId, state.resources.vcnId ?? ''), read: id => gateway.getSubnet(id) },
      { type: 'internet-gateway', id: state.resources.internetGatewayId, names: [OciResourcePlan.internetGatewayName], list: () => gateway.listInternetGateways(state.compartmentId, state.resources.vcnId ?? ''), read: id => gateway.getInternetGateway(id) },
      { type: 'security-list', id: state.resources.securityListId, names: [OciResourcePlan.displayName], list: () => gateway.listSecurityLists(state.compartmentId, state.resources.vcnId ?? ''), read: id => gateway.getSecurityList(id) },
      { type: 'vcn', id: state.resources.vcnId, names: [OciResourcePlan.displayName], list: () => gateway.listVcns(state.compartmentId), read: id => gateway.getVcn(id) },
    ];
    const found = [];
    for (const spec of specs) {
      if (!spec.id) continue;
      const resource = await this.readRecord(spec.read, spec.list, spec.id);
      if (!resource || resource.lifecycleState === 'TERMINATED') continue;
      if (!OciResourcePlan.isOwned(resource, spec.names, deploymentId)) throw new DeployError('REFUSING_UNOWNED_ID');
      found.push({
        type: spec.type, id: resource.id, displayName: resource.displayName, recorded: true, lifecycleState: resource.lifecycleState,
        ...('availabilityDomain' in resource && resource.availabilityDomain ? { availabilityDomain: resource.availabilityDomain } : {}),
      });
    }
    return found;
  }

  private static async unrecorded(gateway: OciGateway, state: DeployRecord & { compartmentId: string }, recordedIds: string[]) {
    const saved = new Set(recordedIds);
    const instances = await gateway.listInstances(state.compartmentId);
    return instances.filter(instance => instance.lifecycleState !== 'TERMINATED' && !saved.has(instance.id)
      && instance.freeformTags?.[OciResourcePlan.deploymentKey] === state.deploymentId).map(instance => ({
      type: 'instance', id: instance.id, displayName: instance.displayName, recorded: false, lifecycleState: instance.lifecycleState,
      availabilityDomain: instance.availabilityDomain,
    }));
  }

  private static async deleteConfirmed(remove: () => Promise<void>, list: () => Promise<{ id: string }[]>, id: string) {
    try { await remove(); }
    catch (error) {
      if (!(error instanceof DeployError) || error.code !== 'NOT_AUTHORIZED') throw error;
      if ((await list()).some(item => item.id === id && !('lifecycleState' in item && item.lifecycleState === 'TERMINATED'))) throw error;
    }
  }

  private static async readRecord<T extends { id: string; lifecycleState: string }>(
    read: (id: string) => Promise<T | null>, list: () => Promise<{ id: string }[]>, id: string,
  ): Promise<T | null> {
    try { return await read(id); }
    catch (error) {
      if (!(error instanceof DeployError) || error.code !== 'NOT_AUTHORIZED') throw error;
      if ((await list()).some(item => item.id === id)) throw error;
      return null;
    }
  }

  private static async bringUp(
    installAgent: (publicIp: string, password: string, freshHost: boolean) => Promise<void>,
    verify: (publicIp: string, password: string, freshHost: boolean) => Promise<void>,
    publicIp: string, password: string, freshHost: boolean, clock: DeployClock, deadline: number,
  ) {
    for (;;) {
      try {
        await installAgent(publicIp, password, freshHost);
        await verify(publicIp, password, freshHost);
        return;
      } catch (error) {
        const code = error instanceof Error && error.message === 'AGENT_UNAUTHORIZED' ? 'AGENT_UNAUTHORIZED'
          : error instanceof Error && error.message === 'SSH_TUNNEL_FAILED' ? 'SSH_TUNNEL_FAILED' : 'AGENT_NOT_READY';
        if (code === 'AGENT_UNAUTHORIZED' || clock.now() >= deadline) throw new DeployError(code);
        await clock.wait(2_000);
      }
    }
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

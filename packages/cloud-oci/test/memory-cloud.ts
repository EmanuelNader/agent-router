import { DeployError } from '../src/errors.js';
import type {
  BootAttachmentRecord, BootVolumeRecord, IgwRecord, ImageRecord, InstanceRecord, LaunchTarget,
  OciGateway, RouteRuleRecord, SecurityListRecord, SubnetRecord, VcnRecord, VnicAttachmentRecord, VnicRecord,
} from '../src/gateway.js';
import { OciResourcePlan } from '../src/plan.js';

/** In-memory Oracle account for provisioner tests. It never opens a socket. */
export class MemoryCloud implements OciGateway {
  readonly calls = { launch: [] as string[], terminate: [] as string[], deleteVolume: [] as string[], createVcn: 0, updateSecurity: 0 };
  readonly attempts: { imageId: string; shape: string; deploymentId: string }[] = [];
  deploymentId = '';
  denyGets = new Set<string>();
  failLaunch: 'none' | 'capacity' | 'after-create' = 'none';
  closed = false;
  domains = ['kIdk:PHX-AD-1'];
  compartment = { id: 'ocid1.compartment.oc1..examplecompartment', lifecycleState: 'ACTIVE' };
  vcns: VcnRecord[] = [];
  igws: IgwRecord[] = [];
  lists: SecurityListRecord[] = [];
  subnets: SubnetRecord[] = [];
  instances: InstanceRecord[] = [];
  volumes: BootVolumeRecord[] = [];
  bootAttachments: BootAttachmentRecord[] = [];
  vnicAttachments: VnicAttachmentRecord[] = [];
  vnics: VnicRecord[] = [];
  routes = new Map<string, RouteRuleRecord[]>();
  images: ImageRecord[] = [
    { id: 'ocid1.image.oc1..windows', displayName: 'Windows-Server-2022', operatingSystem: 'Windows', operatingSystemVersion: '2022', lifecycleState: 'AVAILABLE', timeCreated: '2026-01-01T00:00:00.000Z' },
    { id: 'ocid1.image.oc1..paid', displayName: 'Canonical-Ubuntu-24.04-aarch64-paid', operatingSystem: 'Canonical Ubuntu', operatingSystemVersion: '24.04', lifecycleState: 'AVAILABLE', listingType: 'COMMUNITY', timeCreated: '2026-02-01T00:00:00.000Z' },
    { id: 'ocid1.image.oc1..ubuntu', displayName: 'Canonical-Ubuntu-24.04-aarch64-2026.01.31-0', operatingSystem: 'Canonical Ubuntu', operatingSystemVersion: '24.04', lifecycleState: 'AVAILABLE', listingType: 'NONE', timeCreated: '2026-01-31T00:00:00.000Z' },
  ];
  private sequence = 1;
  private tokens = new Map<string, string>();

  useRegion() {}
  useDeployment(deploymentId: string) { this.deploymentId = deploymentId; }
  private tags() { return OciResourcePlan.tags(this.deploymentId); }
  close() { this.closed = true; }
  async listAvailabilityDomains() { return this.domains; }
  async getCompartment() { return this.compartment; }
  async listVcns() { return this.vcns; }
  async createVcn(_compartmentId: string, token: string) {
    const existing = this.remember(token, this.vcns);
    if (existing) return existing;
    const routeId = this.next('routetable');
    const vcn: VcnRecord = {
      id: this.next('vcn'), displayName: OciResourcePlan.displayName, freeformTags: this.tags(),
      lifecycleState: 'AVAILABLE', defaultRouteTableId: routeId, cidrBlock: OciResourcePlan.vcnCidr,
    };
    this.vcns.push(vcn);
    this.routes.set(routeId, []);
    this.tokens.set(token, vcn.id);
    this.calls.createVcn += 1;
    return vcn;
  }
  async getVcn(id: string) { return this.vcns.find(item => item.id === id) ?? null; }
  async deleteVcn(id: string) { this.vcns = this.vcns.filter(item => item.id !== id); }
  async listInternetGateways(_compartmentId: string, vcnId: string) { return this.igws.filter(item => item.vcnId === vcnId); }
  async createInternetGateway(compartmentId: string, vcnId: string, token: string) {
    const existing = this.remember(token, this.igws);
    if (existing) return existing;
    const igw: IgwRecord = {
      id: this.next('igw'), displayName: OciResourcePlan.internetGatewayName, freeformTags: this.tags(),
      lifecycleState: 'AVAILABLE', vcnId, isEnabled: true,
    };
    void compartmentId;
    this.igws.push(igw);
    this.tokens.set(token, igw.id);
    return igw;
  }
  async getInternetGateway(id: string) { return this.igws.find(item => item.id === id) ?? null; }
  async deleteInternetGateway(id: string) { this.igws = this.igws.filter(item => item.id !== id); }
  async getRouteTable(id: string) { return { id, routeRules: this.routes.get(id) ?? [] }; }
  async updateRouteTable(id: string, routeRules: RouteRuleRecord[]) { this.routes.set(id, routeRules); }
  async listSecurityLists(_compartmentId: string, vcnId: string) { return this.lists.filter(item => item.vcnId === vcnId); }
  async createSecurityList(compartmentId: string, vcnId: string, _sshCidr: string, token: string) {
    const existing = this.remember(token, this.lists);
    if (existing) return existing;
    void compartmentId;
    const list: SecurityListRecord = {
      id: this.next('seclist'), displayName: OciResourcePlan.displayName, freeformTags: this.tags(),
      lifecycleState: 'AVAILABLE', vcnId,
    };
    this.lists.push(list);
    this.tokens.set(token, list.id);
    return list;
  }
  async updateSecurityList() { this.calls.updateSecurity += 1; }
  async getSecurityList(id: string) { return this.lists.find(item => item.id === id) ?? null; }
  async deleteSecurityList(id: string) { this.lists = this.lists.filter(item => item.id !== id); }
  async listSubnets(_compartmentId: string, vcnId: string) { return this.subnets.filter(item => item.vcnId === vcnId); }
  async createSubnet(input: { compartmentId: string; vcnId: string; routeTableId: string; securityListId: string }, token: string) {
    const existing = this.remember(token, this.subnets);
    if (existing) return existing;
    void input.compartmentId; void input.routeTableId; void input.securityListId;
    const subnet: SubnetRecord = {
      id: this.next('subnet'), displayName: OciResourcePlan.displayName, freeformTags: this.tags(),
      lifecycleState: 'AVAILABLE', vcnId: input.vcnId, cidrBlock: OciResourcePlan.subnetCidr, prohibitPublicIpOnVnic: false,
    };
    this.subnets.push(subnet);
    this.tokens.set(token, subnet.id);
    return subnet;
  }
  async getSubnet(id: string) { return this.subnets.find(item => item.id === id) ?? null; }
  async deleteSubnet(id: string) { this.subnets = this.subnets.filter(item => item.id !== id); }
  async listImages() { return this.images; }
  async listInstances() { return this.instances; }
  async launchInstance(input: LaunchTarget, token: string) {
    const existing = this.instances.find(item => item.id === this.tokens.get(token));
    if (existing) return existing;
    this.attempts.push({ imageId: input.imageId, shape: OciResourcePlan.shape, deploymentId: input.deploymentId });
    if (this.failLaunch === 'capacity') throw new DeployError('OUT_OF_HOST_CAPACITY');
    const id = this.next('instance');
    const volumeId = this.next('bootvolume');
    const vnicId = this.next('vnic');
    const instance: InstanceRecord = {
      id, displayName: OciResourcePlan.displayName, freeformTags: this.tags(),
      lifecycleState: 'RUNNING', shape: OciResourcePlan.shape,
      availabilityDomain: input.availabilityDomain, ocpus: 1, memoryInGBs: 4, userData: input.userData,
    };
    this.instances.push(instance);
    this.volumes.push({
      id: volumeId, displayName: 'boot', freeformTags: {}, lifecycleState: 'AVAILABLE', availabilityDomain: input.availabilityDomain,
    });
    this.bootAttachments.push({ instanceId: id, bootVolumeId: volumeId, lifecycleState: 'ATTACHED' });
    this.vnics.push({ id: vnicId, subnetId: input.subnetId, isPrimary: true, publicIp: '203.0.113.20' });
    this.vnicAttachments.push({ id: this.next('attachment'), instanceId: id, vnicId, lifecycleState: 'ATTACHED' });
    this.tokens.set(token, id);
    this.calls.launch.push(input.imageId);
    if (this.failLaunch === 'after-create') throw new DeployError('REQUEST_FAILED');
    return instance;
  }
  async getInstance(id: string) {
    if (this.denyGets.has(id)) throw new DeployError('NOT_AUTHORIZED');
    return this.instances.find(item => item.id === id) ?? null;
  }
  async startInstance(id: string) {
    const instance = await this.getInstance(id);
    if (instance) instance.lifecycleState = 'RUNNING';
  }
  async terminateInstance(id: string) {
    const instance = await this.getInstance(id);
    if (!instance) return;
    instance.lifecycleState = 'TERMINATED';
    for (const attachment of this.bootAttachments) if (attachment.instanceId === id) attachment.lifecycleState = 'DETACHED';
    for (const attachment of this.vnicAttachments) if (attachment.instanceId === id) attachment.lifecycleState = 'DETACHED';
    this.calls.terminate.push(id);
  }
  async listBootVolumeAttachments(_compartmentId: string, availabilityDomain: string, instanceId?: string) {
    return this.bootAttachments.filter(attachment => {
      if (instanceId && attachment.instanceId !== instanceId) return false;
      const volume = this.volumes.find(item => item.id === attachment.bootVolumeId);
      return volume?.availabilityDomain === availabilityDomain;
    });
  }
  async getBootVolume(id: string) { return this.volumes.find(item => item.id === id) ?? null; }
  async tagBootVolume(id: string) {
    const volume = await this.getBootVolume(id);
    if (!volume) return;
    volume.displayName = OciResourcePlan.bootVolumeName;
    volume.freeformTags = { ...volume.freeformTags, ...this.tags() };
  }
  async listBootVolumes(_compartmentId: string, availabilityDomain: string) {
    return this.volumes.filter(volume => volume.availabilityDomain === availabilityDomain);
  }
  async deleteBootVolume(id: string) {
    this.calls.deleteVolume.push(id);
    this.volumes = this.volumes.filter(volume => volume.id !== id);
  }
  async listVnicAttachments(_compartmentId: string, instanceId?: string) {
    return this.vnicAttachments.filter(attachment => !instanceId || attachment.instanceId === instanceId);
  }
  async getVnic(id: string) { return this.vnics.find(item => item.id === id) ?? null; }

  seedDiscord() {
    const id = 'ocid1.instance.oc1..discordbot';
    this.instances.push({
      id, displayName: 'discord-bot', freeformTags: {}, lifecycleState: 'RUNNING',
      shape: 'VM.Standard.E2.1.Micro', availabilityDomain: 'kIdk:PHX-AD-1',
    });
    this.volumes.push({
      id: 'ocid1.bootvolume.oc1..discord', displayName: 'discord-bot-boot', freeformTags: {},
      lifecycleState: 'AVAILABLE', availabilityDomain: 'kIdk:PHX-AD-1',
    });
    this.bootAttachments.push({ instanceId: id, bootVolumeId: 'ocid1.bootvolume.oc1..discord', lifecycleState: 'ATTACHED' });
    this.vcns.push({
      id: 'ocid1.vcn.oc1..other', displayName: 'other-vcn', freeformTags: {}, lifecycleState: 'AVAILABLE',
      defaultRouteTableId: 'ocid1.routetable.oc1..other', cidrBlock: '10.8.0.0/16',
    });
    this.routes.set('ocid1.routetable.oc1..other', []);
  }

  private next(kind: string) { return `ocid1.${kind}.oc1..n${this.sequence++}`; }
  private remember<T extends { id: string }>(token: string, items: T[]): T | null {
    const id = this.tokens.get(token);
    return id ? items.find(item => item.id === id) ?? null : null;
  }
}

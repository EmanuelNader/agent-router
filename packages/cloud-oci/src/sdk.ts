import { core, common, identity, OciError } from 'oci-sdk';
import { DeployError } from './errors.js';
import type {
  BootAttachmentRecord, BootVolumeRecord, IgwRecord, ImageRecord, InstanceRecord, LaunchTarget,
  OciGateway, RouteRuleRecord, SecurityListRecord, SubnetRecord, VcnRecord, VnicAttachmentRecord, VnicRecord,
} from './gateway.js';
import { OciResourcePlan } from './plan.js';

interface Clients {
  compute: core.ComputeClient;
  network: core.VirtualNetworkClient;
  block: core.BlockstorageClient;
  identity: identity.IdentityClient;
}

/** Official SDK adapter. It can build only the free A1 launch request. */
export class OciSdkGateway implements OciGateway {
  constructor(private readonly clients: Clients) {}

  static fromConfig(configPath: string, profile = 'DEFAULT'): OciSdkGateway {
    const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
    const configuration: common.ClientConfiguration = { retryConfiguration: common.NoRetryConfigurationDetails };
    return new OciSdkGateway({
      compute: new core.ComputeClient({ authenticationDetailsProvider: auth }, configuration),
      network: new core.VirtualNetworkClient({ authenticationDetailsProvider: auth }, configuration),
      block: new core.BlockstorageClient({ authenticationDetailsProvider: auth }, configuration),
      identity: new identity.IdentityClient({ authenticationDetailsProvider: auth }, configuration),
    });
  }

  /** Hardcodes the free shape so a caller cannot pass a paid launch. */
  static launchRequest(input: LaunchTarget & { retryToken: string }) {
    OciResourcePlan.sshPublicKey(input.sshPublicKey);
    if (!/^ar[a-f0-9]{32}$/.test(input.retryToken)) throw new DeployError('RETRY_TOKEN_INVALID');
    if (Buffer.byteLength(input.userData) + Buffer.byteLength(input.sshPublicKey) > 30_000) throw new DeployError('CLOUD_INIT_TOO_LARGE');
    return {
      opcRetryToken: input.retryToken,
      launchInstanceDetails: {
        compartmentId: input.compartmentId,
        availabilityDomain: input.availabilityDomain,
        displayName: OciResourcePlan.displayName,
        shape: OciResourcePlan.shape,
        shapeConfig: { ocpus: OciResourcePlan.ocpus, memoryInGBs: OciResourcePlan.memoryGb },
        sourceDetails: {
          sourceType: core.models.InstanceSourceViaImageDetails.sourceType,
          imageId: input.imageId,
          bootVolumeSizeInGBs: OciResourcePlan.bootGb,
        },
        createVnicDetails: {
          subnetId: input.subnetId,
          assignPublicIp: true,
          displayName: OciResourcePlan.displayName,
          freeformTags: OciResourcePlan.tags(),
        },
        metadata: { ssh_authorized_keys: input.sshPublicKey, user_data: input.userData },
        freeformTags: OciResourcePlan.tags(),
      },
    };
  }

  useRegion(region: string) {
    this.clients.compute.regionId = region;
    this.clients.network.regionId = region;
    this.clients.block.regionId = region;
    this.clients.identity.regionId = region;
  }

  close() {
    for (const client of [this.clients.compute, this.clients.network, this.clients.block, this.clients.identity]) {
      try { client.close(); } catch { /* already closed */ }
    }
  }

  async listAvailabilityDomains(compartmentId: string) {
    const response = await this.call(() => this.clients.identity.listAvailabilityDomains({ compartmentId }));
    if (response.opcNextPage) throw new DeployError('AD_DISCOVERY_FAILED');
    const names = response.items.map(item => item.name ?? '');
    if (names.some(name => !name)) throw new DeployError('AD_DISCOVERY_FAILED');
    return names;
  }

  async getCompartment(compartmentId: string) {
    const response = await this.call(() => this.clients.identity.getCompartment({ compartmentId }));
    return { id: response.compartment.id, lifecycleState: String(response.compartment.lifecycleState) };
  }

  listVcns(compartmentId: string) {
    return this.pages(page => this.clients.network.listVcns({ compartmentId, ...(page ? { page } : {}) }), response => response.items.map(item => this.vcn(item)));
  }

  async createVcn(compartmentId: string, retryToken: string) {
    const response = await this.call(() => this.clients.network.createVcn({
      opcRetryToken: retryToken,
      createVcnDetails: {
        compartmentId, cidrBlocks: [OciResourcePlan.vcnCidr], displayName: OciResourcePlan.displayName,
        dnsLabel: 'agentrt', freeformTags: OciResourcePlan.tags(), isIpv6Enabled: false,
      },
    }));
    return this.vcn(response.vcn);
  }

  async getVcn(id: string) {
    return this.missing(() => this.clients.network.getVcn({ vcnId: id }).then(response => this.vcn(response.vcn)));
  }

  deleteVcn(id: string) { return this.remove(() => this.clients.network.deleteVcn({ vcnId: id })); }

  listInternetGateways(compartmentId: string, vcnId: string) {
    return this.pages(page => this.clients.network.listInternetGateways({ compartmentId, vcnId, ...(page ? { page } : {}) }), response => response.items.map(item => this.igw(item)));
  }

  async createInternetGateway(compartmentId: string, vcnId: string, retryToken: string) {
    const response = await this.call(() => this.clients.network.createInternetGateway({
      opcRetryToken: retryToken,
      createInternetGatewayDetails: {
        compartmentId, vcnId, isEnabled: true, displayName: OciResourcePlan.internetGatewayName, freeformTags: OciResourcePlan.tags(),
      },
    }));
    return this.igw(response.internetGateway);
  }

  async getInternetGateway(id: string) {
    return this.missing(() => this.clients.network.getInternetGateway({ igId: id }).then(response => this.igw(response.internetGateway)));
  }

  deleteInternetGateway(id: string) { return this.remove(() => this.clients.network.deleteInternetGateway({ igId: id })); }

  async getRouteTable(id: string) {
    const response = await this.call(() => this.clients.network.getRouteTable({ rtId: id }));
    return {
      id: response.routeTable.id,
      routeRules: (response.routeTable.routeRules ?? []).map(rule => this.route(rule)),
    };
  }

  async updateRouteTable(id: string, routeRules: RouteRuleRecord[]) {
    await this.call(() => this.clients.network.updateRouteTable({
      rtId: id,
      updateRouteTableDetails: { routeRules: routeRules.map(rule => this.routeRequest(rule)) },
    }));
  }

  listSecurityLists(compartmentId: string, vcnId: string) {
    return this.pages(page => this.clients.network.listSecurityLists({ compartmentId, vcnId, ...(page ? { page } : {}) }), response => response.items.map(item => this.securityList(item)));
  }

  async createSecurityList(compartmentId: string, vcnId: string, sshCidr: string, retryToken: string) {
    const response = await this.call(() => this.clients.network.createSecurityList({
      opcRetryToken: retryToken,
      createSecurityListDetails: this.securityListDetails(compartmentId, vcnId, sshCidr),
    }));
    return this.securityList(response.securityList);
  }

  async updateSecurityList(id: string, sshCidr: string) {
    const rules = OciResourcePlan.securityRules(sshCidr);
    await this.call(() => this.clients.network.updateSecurityList({
      securityListId: id,
      updateSecurityListDetails: { ingressSecurityRules: this.ingress(rules), egressSecurityRules: this.egress(rules) },
    }));
  }

  async getSecurityList(id: string) {
    return this.missing(() => this.clients.network.getSecurityList({ securityListId: id }).then(response => this.securityList(response.securityList)));
  }

  deleteSecurityList(id: string) { return this.remove(() => this.clients.network.deleteSecurityList({ securityListId: id })); }

  listSubnets(compartmentId: string, vcnId: string) {
    return this.pages(page => this.clients.network.listSubnets({ compartmentId, vcnId, ...(page ? { page } : {}) }), response => response.items.map(item => this.subnet(item)));
  }

  async createSubnet(input: { compartmentId: string; vcnId: string; routeTableId: string; securityListId: string }, retryToken: string) {
    const response = await this.call(() => this.clients.network.createSubnet({
      opcRetryToken: retryToken,
      createSubnetDetails: {
        compartmentId: input.compartmentId, vcnId: input.vcnId, cidrBlock: OciResourcePlan.subnetCidr,
        displayName: OciResourcePlan.displayName, dnsLabel: 'agentsub', prohibitPublicIpOnVnic: false,
        routeTableId: input.routeTableId, securityListIds: [input.securityListId], freeformTags: OciResourcePlan.tags(),
      },
    }));
    return this.subnet(response.subnet);
  }

  async getSubnet(id: string) {
    return this.missing(() => this.clients.network.getSubnet({ subnetId: id }).then(response => this.subnet(response.subnet)));
  }

  deleteSubnet(id: string) { return this.remove(() => this.clients.network.deleteSubnet({ subnetId: id })); }

  listImages(compartmentId: string) {
    return this.pages(page => this.clients.compute.listImages({
      compartmentId, operatingSystem: 'Canonical Ubuntu', shape: OciResourcePlan.shape, ...(page ? { page } : {}),
    }), response => response.items.map(item => this.image(item)));
  }

  listInstances(compartmentId: string) {
    return this.pages(page => this.clients.compute.listInstances({ compartmentId, ...(page ? { page } : {}) }), response => response.items.map(item => this.instance(item)));
  }

  async launchInstance(input: LaunchTarget, retryToken: string) {
    const request = OciSdkGateway.launchRequest({ ...input, retryToken });
    const response = await this.call(() => this.clients.compute.launchInstance(request));
    return this.instance(response.instance);
  }

  async getInstance(id: string) {
    return this.missing(() => this.clients.compute.getInstance({ instanceId: id }).then(response => this.instance(response.instance)));
  }

  async startInstance(id: string) {
    await this.call(() => this.clients.compute.instanceAction({ instanceId: id, action: 'START' }));
  }

  async terminateInstance(id: string) {
    await this.remove(() => this.clients.compute.terminateInstance({
      instanceId: id, preserveBootVolume: false, preserveDataVolumesCreatedAtLaunch: false,
    }));
  }

  listBootVolumeAttachments(compartmentId: string, availabilityDomain: string, instanceId?: string) {
    return this.pages(page => this.clients.compute.listBootVolumeAttachments({
      compartmentId, availabilityDomain, ...(instanceId ? { instanceId } : {}), ...(page ? { page } : {}),
    }), response => response.items.map(item => ({
      instanceId: item.instanceId, bootVolumeId: item.bootVolumeId, lifecycleState: String(item.lifecycleState),
    })));
  }

  async getBootVolume(id: string) {
    return this.missing(() => this.clients.block.getBootVolume({ bootVolumeId: id }).then(response => this.bootVolume(response.bootVolume)));
  }

  async tagBootVolume(id: string) {
    const current = await this.getBootVolume(id);
    if (!current) return;
    await this.call(() => this.clients.block.updateBootVolume({
      bootVolumeId: id,
      updateBootVolumeDetails: {
        displayName: OciResourcePlan.bootVolumeName,
        freeformTags: { ...current.freeformTags, ...OciResourcePlan.tags() },
      },
    }));
  }

  listBootVolumes(compartmentId: string, availabilityDomain: string) {
    return this.pages(page => this.clients.block.listBootVolumes({ compartmentId, availabilityDomain, ...(page ? { page } : {}) }), response => response.items.map(item => this.bootVolume(item)));
  }

  deleteBootVolume(id: string) { return this.remove(() => this.clients.block.deleteBootVolume({ bootVolumeId: id })); }

  listVnicAttachments(compartmentId: string, instanceId?: string) {
    return this.pages(page => this.clients.compute.listVnicAttachments({
      compartmentId, ...(instanceId ? { instanceId } : {}), ...(page ? { page } : {}),
    }), response => response.items.flatMap(item => item.vnicId ? [{
      id: item.id, instanceId: item.instanceId, vnicId: item.vnicId, lifecycleState: String(item.lifecycleState),
    }] : []));
  }

  async getVnic(id: string) {
    return this.missing(() => this.clients.network.getVnic({ vnicId: id }).then(response => this.vnic(response.vnic)));
  }

  private securityListDetails(compartmentId: string, vcnId: string, sshCidr: string) {
    const rules = OciResourcePlan.securityRules(sshCidr);
    return {
      compartmentId, vcnId, displayName: OciResourcePlan.displayName, freeformTags: OciResourcePlan.tags(),
      ingressSecurityRules: this.ingress(rules), egressSecurityRules: this.egress(rules),
    };
  }

  private ingress(rules: ReturnType<typeof OciResourcePlan.securityRules>) {
    return rules.ingress.map(rule => ({
      protocol: rule.protocol, source: rule.source, sourceType: core.models.IngressSecurityRule.SourceType.CidrBlock,
      tcpOptions: rule.tcpOptions, description: rule.description,
    }));
  }

  private egress(rules: ReturnType<typeof OciResourcePlan.securityRules>) {
    return rules.egress.map(rule => ({
      protocol: rule.protocol, destination: rule.destination,
      destinationType: core.models.EgressSecurityRule.DestinationType.CidrBlock, description: rule.description,
    }));
  }

  private route(rule: core.models.RouteRule): RouteRuleRecord {
    return {
      destination: rule.destination ?? '',
      destinationType: String(rule.destinationType ?? 'CIDR_BLOCK'),
      networkEntityId: rule.networkEntityId,
      ...(rule.description ? { description: rule.description } : {}),
      ...(rule.routeType ? { routeType: String(rule.routeType) } : {}),
    };
  }

  private routeRequest(rule: RouteRuleRecord) {
    if (!rule.destination || !rule.networkEntityId) throw new DeployError('ROUTE_CONFLICT');
    const destinationType = rule.destinationType === 'SERVICE_CIDR_BLOCK'
      ? core.models.RouteRule.DestinationType.ServiceCidrBlock
      : rule.destinationType === 'CIDR_BLOCK' ? core.models.RouteRule.DestinationType.CidrBlock : undefined;
    if (!destinationType) throw new DeployError('ROUTE_CONFLICT');
    const routeType = rule.routeType === 'LOCAL' ? core.models.RouteRule.RouteType.Local
      : rule.routeType === 'STATIC' ? core.models.RouteRule.RouteType.Static : undefined;
    return {
      destination: rule.destination, destinationType, networkEntityId: rule.networkEntityId,
      ...(rule.description ? { description: rule.description } : {}),
      ...(routeType ? { routeType } : {}),
    };
  }

  private vcn(value: core.models.Vcn): VcnRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), defaultRouteTableId: value.defaultRouteTableId ?? '', cidrBlock: value.cidrBlock ?? '',
    };
  }

  private igw(value: core.models.InternetGateway): IgwRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), vcnId: value.vcnId, isEnabled: value.isEnabled === true,
    };
  }

  private securityList(value: core.models.SecurityList): SecurityListRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), vcnId: value.vcnId,
    };
  }

  private subnet(value: core.models.Subnet): SubnetRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), vcnId: value.vcnId, cidrBlock: value.cidrBlock ?? '',
      prohibitPublicIpOnVnic: value.prohibitPublicIpOnVnic === true,
    };
  }

  private image(value: core.models.Image): ImageRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', operatingSystem: value.operatingSystem,
      operatingSystemVersion: value.operatingSystemVersion, lifecycleState: String(value.lifecycleState),
      timeCreated: value.timeCreated.toISOString(),
      ...(value.listingType ? { listingType: String(value.listingType) } : {}),
      ...(value.billableSizeInGBs !== undefined ? { billableSizeInGBs: value.billableSizeInGBs } : {}),
    };
  }

  private instance(value: core.models.Instance): InstanceRecord {
    const userData = value.metadata?.user_data;
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), shape: value.shape ?? '', availabilityDomain: value.availabilityDomain,
      ...(value.shapeConfig?.ocpus !== undefined ? { ocpus: value.shapeConfig.ocpus } : {}),
      ...(value.shapeConfig?.memoryInGBs !== undefined ? { memoryInGBs: value.shapeConfig.memoryInGBs } : {}),
      ...(userData ? { userData } : {}),
    };
  }

  private bootVolume(value: core.models.BootVolume): BootVolumeRecord {
    return {
      id: value.id, displayName: value.displayName ?? '', freeformTags: { ...(value.freeformTags ?? {}) },
      lifecycleState: String(value.lifecycleState), availabilityDomain: value.availabilityDomain,
    };
  }

  private vnic(value: core.models.Vnic): VnicRecord {
    return {
      id: value.id, subnetId: value.subnetId ?? '', isPrimary: value.isPrimary === true,
      ...(value.publicIp ? { publicIp: value.publicIp } : {}),
    };
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DeployError('REQUEST_FAILED')), 30_000);
        }),
      ]);
    } catch (error) {
      throw OciSdkGateway.failure(error);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async missing<T>(work: () => Promise<T>): Promise<T | null> {
    try { return await this.call(work); }
    catch (error) {
      if (error instanceof DeployError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  private async remove(work: () => Promise<unknown>): Promise<void> {
    try { await this.call(work); }
    catch (error) {
      if (error instanceof DeployError && error.code === 'NOT_FOUND') return;
      throw error;
    }
  }

  private async pages<TResponse extends { opcNextPage?: string }, TItem>(
    read: (page?: string) => Promise<TResponse>,
    map: (response: TResponse) => TItem[],
  ): Promise<TItem[]> {
    const items: TItem[] = [];
    const seen = new Set<string>();
    let page: string | undefined;
    do {
      const response = await this.call(() => read(page));
      items.push(...map(response));
      const next = response.opcNextPage || undefined;
      if (!next) return items;
      if (seen.has(next) || seen.size >= 20) throw new DeployError('PAGINATION_INCOMPLETE');
      seen.add(next);
      page = next;
    } while (page);
    return items;
  }

  private static failure(error: unknown): DeployError {
    if (error instanceof DeployError) return error;
    if (error instanceof OciError) {
      if (error.statusCode === 404) return new DeployError('NOT_FOUND');
      if (error.statusCode === 401 || error.statusCode === 403) return new DeployError('NOT_AUTHORIZED');
      if (error.serviceCode === 'LimitExceeded' || error.serviceCode === 'QuotaExceeded') return new DeployError('QUOTA_EXCEEDED');
      if (/out of host capacity/i.test(error.message)) return new DeployError('OUT_OF_HOST_CAPACITY');
    }
    return new DeployError('REQUEST_FAILED');
  }
}

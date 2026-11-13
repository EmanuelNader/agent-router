export interface RouteRuleRecord {
  destination: string;
  destinationType: string;
  networkEntityId: string;
  description?: string;
  routeType?: string;
}

export interface TaggedRecord {
  id: string;
  displayName: string;
  freeformTags: Record<string, string>;
  lifecycleState: string;
}

export interface VcnRecord extends TaggedRecord {
  defaultRouteTableId: string;
  cidrBlock: string;
}

export interface IgwRecord extends TaggedRecord {
  vcnId: string;
  isEnabled: boolean;
}

export interface SecurityListRecord extends TaggedRecord {
  vcnId: string;
}

export interface SubnetRecord extends TaggedRecord {
  vcnId: string;
  cidrBlock: string;
  prohibitPublicIpOnVnic: boolean;
}

export interface ImageRecord {
  id: string;
  displayName: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  lifecycleState: string;
  timeCreated: string;
  listingType?: string;
  billableSizeInGBs?: number;
}

export interface InstanceRecord extends TaggedRecord {
  shape: string;
  availabilityDomain: string;
  ocpus?: number;
  memoryInGBs?: number;
  userData?: string;
}

export interface BootVolumeRecord extends TaggedRecord {
  availabilityDomain: string;
}

export interface BootAttachmentRecord {
  instanceId: string;
  bootVolumeId: string;
  lifecycleState: string;
}

export interface VnicAttachmentRecord {
  id: string;
  instanceId: string;
  vnicId: string;
  lifecycleState: string;
}

export interface VnicRecord {
  id: string;
  subnetId: string;
  isPrimary: boolean;
  publicIp?: string;
}

export interface LaunchTarget {
  compartmentId: string;
  availabilityDomain: string;
  subnetId: string;
  imageId: string;
  sshPublicKey: string;
  userData: string;
  deploymentId: string;
}

/** Mutation surface used by the provisioner. Live calls go through OciSdkGateway. */
export interface OciGateway {
  useRegion(region: string): void;
  useDeployment(deploymentId: string): void;
  close(): void;
  listAvailabilityDomains(compartmentId: string): Promise<string[]>;
  getCompartment(compartmentId: string): Promise<{ id: string; lifecycleState: string }>;
  listVcns(compartmentId: string): Promise<VcnRecord[]>;
  createVcn(compartmentId: string, retryToken: string): Promise<VcnRecord>;
  getVcn(id: string): Promise<VcnRecord | null>;
  deleteVcn(id: string): Promise<void>;
  listInternetGateways(compartmentId: string, vcnId: string): Promise<IgwRecord[]>;
  createInternetGateway(compartmentId: string, vcnId: string, retryToken: string): Promise<IgwRecord>;
  getInternetGateway(id: string): Promise<IgwRecord | null>;
  deleteInternetGateway(id: string): Promise<void>;
  getRouteTable(id: string): Promise<{ id: string; routeRules: RouteRuleRecord[] }>;
  updateRouteTable(id: string, routeRules: RouteRuleRecord[]): Promise<void>;
  listSecurityLists(compartmentId: string, vcnId: string): Promise<SecurityListRecord[]>;
  createSecurityList(compartmentId: string, vcnId: string, sshCidr: string, retryToken: string): Promise<SecurityListRecord>;
  updateSecurityList(id: string, sshCidr: string): Promise<void>;
  getSecurityList(id: string): Promise<SecurityListRecord | null>;
  deleteSecurityList(id: string): Promise<void>;
  listSubnets(compartmentId: string, vcnId: string): Promise<SubnetRecord[]>;
  createSubnet(input: { compartmentId: string; vcnId: string; routeTableId: string; securityListId: string }, retryToken: string): Promise<SubnetRecord>;
  getSubnet(id: string): Promise<SubnetRecord | null>;
  deleteSubnet(id: string): Promise<void>;
  listImages(compartmentId: string): Promise<ImageRecord[]>;
  listInstances(compartmentId: string): Promise<InstanceRecord[]>;
  launchInstance(input: LaunchTarget, retryToken: string): Promise<InstanceRecord>;
  getInstance(id: string): Promise<InstanceRecord | null>;
  startInstance(id: string): Promise<void>;
  terminateInstance(id: string): Promise<void>;
  listBootVolumeAttachments(compartmentId: string, availabilityDomain: string, instanceId?: string): Promise<BootAttachmentRecord[]>;
  getBootVolume(id: string): Promise<BootVolumeRecord | null>;
  tagBootVolume(id: string): Promise<void>;
  listBootVolumes(compartmentId: string, availabilityDomain: string): Promise<BootVolumeRecord[]>;
  deleteBootVolume(id: string): Promise<void>;
  listVnicAttachments(compartmentId: string, instanceId?: string): Promise<VnicAttachmentRecord[]>;
  getVnic(id: string): Promise<VnicRecord | null>;
}

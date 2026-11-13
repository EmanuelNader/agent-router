import { DeployError } from './errors.js';

/** Names and tags that identify resources this deployer created. */
export class OciResourcePlan {
  static readonly displayName = 'agent-router-opencode';
  static readonly internetGatewayName = 'agent-router-opencode-igw';
  static readonly bootVolumeName = 'agent-router-opencode-boot';
  static readonly tagKey = 'agent-router-managed';
  static readonly tagValue = 'opencode';
  static readonly shape = 'VM.Standard.A1.Flex';
  static readonly architecture = 'arm64';
  static readonly ocpus = 1;
  static readonly memoryGb = 4;
  static readonly bootGb = 50;
  static readonly vcnCidr = '10.0.0.0/16';
  static readonly subnetCidr = '10.0.1.0/24';
  static readonly agentPort = 4096;
  static readonly sshUser = 'ubuntu';
  static readonly refusedResources = [
    'nat-gateway', 'service-gateway', 'reserved-public-ip', 'extra-block-volume',
    'volume-backup', 'load-balancer', 'paid-image', 'non-a1-shape',
  ] as const;

  static tags(): Record<string, string> {
    return { [this.tagKey]: this.tagValue };
  }

  static isOwned(resource: { displayName?: string; freeformTags?: Record<string, string> }, names: readonly string[]): boolean {
    const name = resource.displayName ?? '';
    return names.includes(name) && resource.freeformTags?.[this.tagKey] === this.tagValue;
  }

  static compartmentId(value: string): string {
    if (!/^ocid1\.(compartment|tenancy)\.oc1\.\.[a-z0-9]+$/.test(value)) throw new DeployError('COMPARTMENT_INVALID');
    return value;
  }

  static sshCidr(value: string): string {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
    if (!match) throw new DeployError('SSH_CIDR_INVALID');
    const octets = [match[1], match[2], match[3], match[4]].map(part => Number(part));
    const prefix = Number(match[5]);
    if (octets.some(part => part > 255) || prefix > 32) throw new DeployError('SSH_CIDR_INVALID');
    if (value === '0.0.0.0/0') throw new DeployError('SSH_CIDR_TOO_WIDE');
    return value;
  }

  static sshPublicKey(value: string): string {
    const key = value.trim();
    if (key.includes('\n') || key.length > 16_384 || /private key/i.test(key)) throw new DeployError('SSH_PUBLIC_KEY_INVALID');
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519) [A-Za-z0-9+/]+={0,3}( .+)?$/.test(key)) {
      throw new DeployError('SSH_PUBLIC_KEY_INVALID');
    }
    return key;
  }

  static availabilityDomain(domains: readonly string[], suffix: string): string {
    const matches = domains.filter(name => name === suffix || name.endsWith(`-${suffix}`));
    if (matches.length !== 1 || !matches[0]) throw new DeployError('AD_NOT_RESOLVED');
    return matches[0];
  }

  static securityRules(sshCidr: string) {
    const source = this.sshCidr(sshCidr);
    return {
      ingress: [{
        protocol: '6',
        source,
        sourceType: 'CIDR_BLOCK',
        tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
        description: `${this.displayName} ssh`,
      }],
      egress: [{
        protocol: 'all',
        destination: '0.0.0.0/0',
        destinationType: 'CIDR_BLOCK',
        description: `${this.displayName} egress`,
      }],
    };
  }

  static deployDryRun(input: {
    compartmentId: string; sshCidr: string; region: string | null; availabilityDomain: string | null; agentVersion: string;
  }) {
    const sshCidr = this.sshCidr(input.sshCidr);
    const rules = this.securityRules(sshCidr);
    return {
      mode: 'DRY_RUN' as const,
      action: 'deploy' as const,
      executed: false as const,
      provisioningAllowed: true as const,
      note: 'Dry run only. No Oracle API call was made.',
      compartmentId: input.compartmentId,
      profile: {
        shape: this.shape, architecture: this.architecture, ocpus: this.ocpus,
        memoryGb: this.memoryGb, bootGb: this.bootGb, region: input.region, availabilityDomain: input.availabilityDomain,
      },
      wouldCreate: [
        { type: 'vcn', displayName: this.displayName, cidr: this.vcnCidr, freeformTags: this.tags(), reuseIfExists: true },
        { type: 'internet-gateway', displayName: this.internetGatewayName, freeformTags: this.tags(), reuseIfExists: true },
        { type: 'route-rule', destination: '0.0.0.0/0', target: this.internetGatewayName, description: this.displayName },
        { type: 'security-list', displayName: this.displayName, freeformTags: this.tags(), ingress: rules.ingress, egress: rules.egress, reuseIfExists: true },
        { type: 'subnet', displayName: this.displayName, cidr: this.subnetCidr, public: true, freeformTags: this.tags(), reuseIfExists: true },
        {
          type: 'instance', displayName: this.displayName, shape: this.shape,
          shapeConfig: { ocpus: this.ocpus, memoryInGBs: this.memoryGb }, bootVolumeSizeInGBs: this.bootGb,
          bootVolumeDisplayName: this.bootVolumeName, assignPublicIp: true, publicIpAssignment: 'EPHEMERAL',
          freeformTags: this.tags(),
          image: { operatingSystem: 'Canonical Ubuntu', architecture: 'aarch64', versions: ['24.04', '22.04'], listingType: 'NONE', charge: 'NONE' },
          agent: { name: 'opencode', version: input.agentVersion, bind: `127.0.0.1:${this.agentPort}`, sshUser: this.sshUser },
        },
      ],
      wouldNotCreate: this.refusedResources,
      singleAgent: 'Reuse one owned instance. Refuse to launch when more than one owned instance is active.',
      health: 'OpenCodeClient.listSessions through an SSH local forward to 127.0.0.1. The agent port is not opened on the security list.',
    };
  }

  static destroyDryRun() {
    return {
      mode: 'DRY_RUN' as const,
      action: 'destroy' as const,
      executed: false as const,
      note: 'Dry run only. No Oracle API call was made.',
      wouldDelete: [
        { type: 'instance', displayName: this.displayName, freeformTags: this.tags(), preserveBootVolume: false },
        { type: 'boot-volume', displayName: this.bootVolumeName, freeformTags: this.tags() },
        { type: 'subnet', displayName: this.displayName, freeformTags: this.tags() },
        { type: 'internet-gateway', displayName: this.internetGatewayName, freeformTags: this.tags() },
        { type: 'security-list', displayName: this.displayName, freeformTags: this.tags() },
        { type: 'vcn', displayName: this.displayName, freeformTags: this.tags() },
      ],
      deleteOnly: { freeformTag: this.tags(), displayNames: [this.displayName, this.internetGatewayName, this.bootVolumeName] },
      neverDelete: 'A resource is deleted only when its display name and freeform tag both match. An existing instance named discord-bot is outside this set.',
    };
  }
}

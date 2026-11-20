import { common, core, identity } from 'oci-sdk';
import { perRequestTimeout } from '../../cloud-readiness/src/oci-sdk.js';
import type {
  LaunchOciWorkerParams,
  OciComputeGateway,
  OciInstanceLifecycle,
  OciInstanceRecord,
  SubnetSecurityInspection,
  TerminateOciWorkerParams,
  WorkspaceRemnantCounts,
} from './provider.js';

const compartmentOcidPattern = /^ocid1\.(?:compartment|tenancy)\.[a-z0-9]+\.\.[a-z0-9]+$/;
const resourceOcidPattern = /^ocid1\.[a-z0-9]+\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9]+$/;

function mapLifecycle(raw: string): OciInstanceLifecycle {
  switch (raw) {
    case 'PROVISIONING':
    case 'RUNNING':
    case 'STARTING':
    case 'STOPPING':
    case 'STOPPED':
    case 'TERMINATING':
    case 'TERMINATED':
      return raw;
    default:
      return 'PROVISIONING';
  }
}

/**
 * Live OCI Core Services gateway (`ComputeClient`, `BlockstorageClient`, `VirtualNetworkClient`).
 * Never invoked by unit tests or CI. Requires explicit compartment OCID and pre-verified guardrails.
 */
export function createOciComputeSdkGateway(
  configPath: string,
  targetCompartmentId: string,
  profile = 'DEFAULT',
) {
  if (!compartmentOcidPattern.test(targetCompartmentId)) {
    throw new Error('Invalid target compartment OCID');
  }
  const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
  const configuration: common.ClientConfiguration = {
    retryConfiguration: common.NoRetryConfigurationDetails,
    httpOptions: perRequestTimeout(30_000),
  };

  const compute = new core.ComputeClient({ authenticationDetailsProvider: auth }, configuration);
  const blockstorage = new core.BlockstorageClient({ authenticationDetailsProvider: auth }, configuration);
  const network = new core.VirtualNetworkClient({ authenticationDetailsProvider: auth }, configuration);
  const identities = new identity.IdentityClient({ authenticationDetailsProvider: auth }, configuration);
  const tenancyId = auth.getTenantId();

  async function resolveFullAvailabilityDomain(shortOrFullAd: string): Promise<string> {
    const response = await identities.listAvailabilityDomains({ compartmentId: tenancyId });
    if (response.opcNextPage || response.items.some(item => !item.name)) {
      throw new Error('Incomplete availability domain discovery');
    }
    const matches = response.items
      .map(item => item.name!)
      .filter(name => name === shortOrFullAd || name.endsWith(`:${shortOrFullAd}`) || name.endsWith(`-${shortOrFullAd}`));
    if (matches.length !== 1) {
      throw new Error('Could not uniquely resolve OCI availability domain');
    }
    return matches[0]!;
  }

  async function waitForInstanceState(
    instanceId: string,
    targetState: 'STOPPED' | 'TERMINATED',
    maxAttempts = 24,
    delayMs = 2_500,
  ): Promise<OciInstanceRecord> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = (await compute.getInstance({ instanceId })).instance;
      const mapped = mapLifecycle(String(current.lifecycleState));
      if (mapped === targetState) {
        return {
          instanceId: current.id,
          lifecycleState: mapped,
          shape: current.shape,
          availabilityDomain: current.availabilityDomain,
          freeformTags: { ...(current.freeformTags ?? {}) },
        };
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const finalInst = (await compute.getInstance({ instanceId })).instance;
    return {
      instanceId: finalInst.id,
      lifecycleState: mapLifecycle(String(finalInst.lifecycleState)),
      shape: finalInst.shape,
      availabilityDomain: finalInst.availabilityDomain,
      freeformTags: { ...(finalInst.freeformTags ?? {}) },
    };
  }

  const gateway: OciComputeGateway = {
    selectRegion(region: string) {
      compute.regionId = region;
      blockstorage.regionId = region;
      network.regionId = region;
      identities.regionId = region;
    },

    async inspectSubnetSecurity(subnetRef: string): Promise<SubnetSecurityInspection> {
      if (!resourceOcidPattern.test(subnetRef)) {
        throw new Error('Invalid OCI subnet OCID');
      }
      const subnetResponse = await network.getSubnet({ subnetId: subnetRef });
      const subnet = subnetResponse.subnet;
      const subnetAvailable = String(subnet.lifecycleState) === 'AVAILABLE';
      let ingressRuleCount = 0;
      for (const securityListId of subnet.securityListIds ?? []) {
        const secResponse = await network.getSecurityList({ securityListId });
        if (String(secResponse.securityList.lifecycleState) !== 'AVAILABLE') {
          return { subnetAvailable: false, ingressRuleCount: 0 };
        }
        ingressRuleCount += secResponse.securityList.ingressSecurityRules.length;
      }
      return { subnetAvailable, ingressRuleCount };
    },

    async listInstances(filter: { workspaceKey?: string; operationId?: string }): Promise<OciInstanceRecord[]> {
      const items: OciInstanceRecord[] = [];
      const seenPages = new Set<string>();
      let page: string | undefined;
      do {
        const response = await compute.listInstances({
          compartmentId: targetCompartmentId,
          ...(page ? { page } : {}),
        });
        for (const inst of response.items) {
          const tags = inst.freeformTags ?? {};
          if (filter.workspaceKey && tags['agent-router-workspace'] !== filter.workspaceKey) continue;
          if (filter.operationId && tags['agent-router-operation-id'] !== filter.operationId) continue;
          items.push({
            instanceId: inst.id,
            lifecycleState: mapLifecycle(String(inst.lifecycleState)),
            shape: inst.shape,
            availabilityDomain: inst.availabilityDomain,
            freeformTags: { ...tags },
          });
        }
        page = response.opcNextPage || undefined;
        if (page && (seenPages.has(page) || seenPages.size >= 20)) {
          throw new Error('Incomplete instance pagination');
        }
        if (page) seenPages.add(page);
      } while (page);
      return items;
    },

    async launchInstance(params: LaunchOciWorkerParams): Promise<OciInstanceRecord> {
      if (!resourceOcidPattern.test(params.subnetRef) || !resourceOcidPattern.test(params.imageRef)) {
        throw new Error('Invalid OCI subnet or image OCID');
      }
      const fullAd = await resolveFullAvailabilityDomain(params.availabilityDomain);
      const sourceDetails: core.models.InstanceSourceViaImageDetails = {
        sourceType: 'image',
        imageId: params.imageRef,
        bootVolumeSizeInGBs: params.bootVolumeSizeInGBs,
        bootVolumeVpusPerGB: params.bootVolumeVpusPerGB,
      };
      const response = await compute.launchInstance({
        opcRetryToken: params.opcRetryToken,
        launchInstanceDetails: {
          availabilityDomain: fullAd,
          compartmentId: targetCompartmentId,
          displayName: params.displayName,
          shape: params.shape,
          shapeConfig: {
            ocpus: params.ocpus,
            memoryInGBs: params.memoryInGBs,
          },
          createVnicDetails: {
            subnetId: params.subnetRef,
            assignPublicIp: params.assignPublicIp,
            freeformTags: params.freeformTags,
          },
          sourceDetails,
          metadata: {
            user_data: params.userDataBase64,
          },
          freeformTags: params.freeformTags,
        },
      });
      const inst = response.instance;
      return {
        instanceId: inst.id,
        lifecycleState: mapLifecycle(String(inst.lifecycleState)),
        shape: inst.shape,
        availabilityDomain: inst.availabilityDomain,
        freeformTags: { ...(inst.freeformTags ?? {}) },
      };
    },

    async stopInstance(instanceId: string): Promise<OciInstanceRecord> {
      await compute.instanceAction({
        instanceId,
        action: 'SOFTSTOP',
      });
      return await waitForInstanceState(instanceId, 'STOPPED');
    },

    async terminateInstance(params: TerminateOciWorkerParams): Promise<void> {
      await compute.terminateInstance({
        instanceId: params.instanceId,
        preserveBootVolume: params.preserveBootVolume,
        preserveDataVolumesCreatedAtLaunch: params.preserveDataVolumesCreatedAtLaunch,
      });
      const settled = await waitForInstanceState(params.instanceId, 'TERMINATED');
      if (settled.lifecycleState !== 'TERMINATED') {
        throw new Error('OCI instance termination did not settle within timeout');
      }
    },

    async listWorkspaceRemnants(workspaceKey: string): Promise<WorkspaceRemnantCounts> {
      const workspaceInstances = await gateway.listInstances({ workspaceKey });
      const activeInstances = workspaceInstances.filter(
        inst => inst.lifecycleState !== 'TERMINATED',
      ).length;

      // Also track boot volumes via BootVolumeAttachment records (including recently terminated instances)
      // because OCI auto-created boot volumes do not always inherit LaunchInstanceDetails.freeformTags.
      const attachedBootVolumeIds = new Set<string>();
      for (const inst of workspaceInstances) {
        const attachResponse = await compute.listBootVolumeAttachments({
          availabilityDomain: inst.availabilityDomain,
          compartmentId: targetCompartmentId,
          instanceId: inst.instanceId,
        });
        for (const att of attachResponse.items) {
          if (att.bootVolumeId) attachedBootVolumeIds.add(att.bootVolumeId);
        }
      }

      const domainsResponse = await identities.listAvailabilityDomains({ compartmentId: tenancyId });
      let bootVolumes = 0;
      for (const ad of domainsResponse.items) {
        if (!ad.name) continue;
        const bvResponse = await blockstorage.listBootVolumes({
          compartmentId: targetCompartmentId,
          availabilityDomain: ad.name,
        });
        bootVolumes += bvResponse.items.filter(
          bv =>
            String(bv.lifecycleState) !== 'TERMINATED' &&
            ((bv.freeformTags ?? {})['agent-router-workspace'] === workspaceKey ||
              attachedBootVolumeIds.has(bv.id)),
        ).length;
      }

      const volResponse = await blockstorage.listVolumes({
        compartmentId: targetCompartmentId,
      });
      const blockVolumes = volResponse.items.filter(
        vol =>
          (vol.freeformTags ?? {})['agent-router-workspace'] === workspaceKey &&
          String(vol.lifecycleState) !== 'TERMINATED',
      ).length;

      const ipResponse = await network.listPublicIps({
        compartmentId: targetCompartmentId,
        scope: core.requests.ListPublicIpsRequest.Scope.Region,
        lifetime: core.requests.ListPublicIpsRequest.Lifetime.Reserved,
      });
      const reservedPublicIps = ipResponse.items.filter(
        ip =>
          (ip.freeformTags ?? {})['agent-router-workspace'] === workspaceKey &&
          String(ip.lifecycleState) !== 'TERMINATED',
      ).length;

      return {
        instances: activeInstances,
        bootVolumes,
        blockVolumes,
        reservedPublicIps,
      };
    },
  };

  return {
    gateway,
    close() {
      compute.close();
      blockstorage.close();
      network.close();
      identities.close();
    },
  };
}

import { expect, test } from 'vitest';
import { core, OciError } from 'oci-sdk';
import { OciSdkGateway } from '../src/sdk.js';
import { OciResourcePlan } from '../src/plan.js';

const deploymentId = `dep${'a'.repeat(16)}`;
const target = {
  compartmentId: 'ocid1.compartment.oc1..examplecompartment',
  availabilityDomain: 'kIdk:PHX-AD-1',
  subnetId: 'ocid1.subnet.oc1..subnet',
  imageId: 'ocid1.image.oc1..ubuntu',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly router',
  userData: Buffer.from('#!/bin/bash\necho ok\n').toString('base64'),
  deploymentId,
  retryToken: `ar${'b'.repeat(32)}`,
};

test('the launch request is the free A1 profile and nothing billable', () => {
  const request = OciSdkGateway.launchRequest(target);
  expect(request.launchInstanceDetails.shape).toBe('VM.Standard.A1.Flex');
  expect(request.launchInstanceDetails.shapeConfig).toEqual({ ocpus: 1, memoryInGBs: 4 });
  expect(request.launchInstanceDetails.sourceDetails).toEqual({
    sourceType: 'image', imageId: target.imageId, bootVolumeSizeInGBs: 50,
  });
  expect(request.launchInstanceDetails.createVnicDetails).toMatchObject({ assignPublicIp: true });
  expect(request.launchInstanceDetails.createVnicDetails).not.toHaveProperty('publicIpId');
  expect(request.launchInstanceDetails).not.toHaveProperty('licensingConfigs');
  expect(request.launchInstanceDetails).not.toHaveProperty('launchVolumeAttachments');
  expect(request.launchInstanceDetails.sourceDetails).not.toHaveProperty('bootVolumeVpusPerGB');
  expect(request.launchInstanceDetails.sourceDetails).not.toHaveProperty('kmsKeyId');
  expect(request.launchInstanceDetails.freeformTags).toEqual(OciResourcePlan.tags(deploymentId));
});

test('SDK failures become fixed codes and a missing delete is success', async () => {
  const seen: unknown[] = [];
  const compute = {
    regionId: '',
    close() {},
    async launchInstance(request: unknown) {
      seen.push(request);
      throw new OciError(500, 'InternalError', 'Out of host capacity.', null, 'compute', 'launchInstance', '', '', '');
    },
    async listInstances(request: { page?: string }) {
      if (!request.page) return { items: [instance('one')], opcNextPage: 'next' };
      return { items: [instance('two')], opcNextPage: '' };
    },
  };
  const network = {
    regionId: '',
    close() {},
    async deleteVcn() {
      throw new OciError(404, 'NotAuthorizedOrNotFound', 'gone', null, 'core', 'deleteVcn', '', '', '');
    },
    async getVcn() {
      throw new OciError(404, 'NotAuthorizedOrNotFound', 'gone', null, 'core', 'getVcn', '', '', '');
    },
  };
  const gateway = new OciSdkGateway({
    compute: compute as unknown as core.ComputeClient,
    network: network as unknown as core.VirtualNetworkClient,
    block: { regionId: '', close() {} } as unknown as core.BlockstorageClient,
    identity: { regionId: '', close() {} } as unknown as import('oci-sdk').identity.IdentityClient,
  });
  await expect(gateway.launchInstance(target, target.retryToken)).rejects.toMatchObject({ code: 'OUT_OF_HOST_CAPACITY' });
  expect(JSON.stringify(seen)).toContain('VM.Standard.A1.Flex');
  expect(JSON.stringify(seen)).not.toContain('Out of host capacity');
  await expect(gateway.deleteVcn('ocid1.vcn.oc1..missing')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  await expect(gateway.getVcn('ocid1.vcn.oc1..missing')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  const instances = await gateway.listInstances(target.compartmentId);
  expect(instances.map(item => item.id)).toEqual(['ocid1.instance.oc1..one', 'ocid1.instance.oc1..two']);
});

function instance(name: string) {
  return {
    id: `ocid1.instance.oc1..${name}`, displayName: OciResourcePlan.displayName, freeformTags: OciResourcePlan.tags(deploymentId),
    lifecycleState: 'RUNNING', shape: 'VM.Standard.A1.Flex', availabilityDomain: 'kIdk:PHX-AD-1',
    shapeConfig: { ocpus: 1, memoryInGBs: 4 }, metadata: {},
  };
}

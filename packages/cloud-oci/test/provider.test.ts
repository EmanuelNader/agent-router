import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OperationJournal } from '../../cli/src/journal.js';
import type { OciGuardrailReport } from '../../cloud-readiness/src/oci-guardrails.js';
import type { DeploymentRequest, OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { buildWorkerBootstrapScript, renderWorkerCloudInit } from '../src/cloud-init.js';
import {
  InMemoryOciComputeGateway,
  OciWorkerProvisioner,
} from '../src/provider.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const fixedNow = new Date('2026-11-18T00:00:00.000Z');
const sampleSshPubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb9exampleKeyMaterial0123456789abcdef router@laptop';

function makeValidInspection(source: 'OCI_API' | 'DEMO' = 'OCI_API'): OciInspection {
  return {
    schemaVersion: 1,
    source,
    observedAt: '2026-11-17T23:55:00.000Z',
    homeRegion: 'us-ashburn-1',
    region: 'us-ashburn-1',
    availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: { status: 'KNOWN', limit: 4, used: 0, available: 4 },
      a1RegionalMemoryGb: { status: 'KNOWN', limit: 24, used: 0, available: 24 },
      a1AdOcpus: { status: 'KNOWN', limit: 4, used: 0, available: 4 },
      a1AdMemoryGb: { status: 'KNOWN', limit: 24, used: 0, available: 24 },
      microInstances: { status: 'KNOWN', limit: 2, used: 0, available: 2 },
      freeStorageGb: { status: 'KNOWN', limit: 200, used: 0, available: 200 },
    },
    issues: [],
  };
}

function makeValidGuardrails(source: 'OCI_API' | 'DEMO' = 'OCI_API'): OciGuardrailReport {
  return {
    schemaVersion: 1,
    source,
    observedAt: '2026-11-17T23:56:00.000Z',
    compartmentName: 'agent-router-workers',
    compartmentQuota: {
      status: 'VERIFIED',
      zeroedOtherComputeShapes: true,
      maxA1Ocpus: 4,
      maxA1MemoryGb: 24,
      maxStorageGb: 200,
    },
    budgetAlert: {
      status: 'VERIFIED',
      lowestTripwireAmount: 1,
    },
  };
}

const defaultRequest: DeploymentRequest = {
  ocpus: 2,
  memoryGb: 12,
  bootGb: 50,
  additionalInstances: 1,
};

test('renders locked-down cloud-init with SHA-256 verified Node 24, systemd enable, and valid shell syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-cloud-init-'));
  tempDirs.push(root);

  const script = buildWorkerBootstrapScript('2.2.7');
  const scriptPath = join(root, 'bootstrap.sh');
  await writeFile(scriptPath, script, { mode: 0o700 });
  // Validate real POSIX/bash syntax using the OS shell parser
  execFileSync('/bin/sh', ['-n', scriptPath]);

  const cloudConfig = renderWorkerCloudInit({
    sshAuthorizedKey: sampleSshPubKey,
    opencodeVersion: '2.2.7',
    loopbackPort: 4096,
  });

  expect(cloudConfig.startsWith('#cloud-config\n')).toBe(true);
  expect(cloudConfig).toContain('disable_root: true');
  expect(cloudConfig).toContain('ssh_pwauth: false');
  expect(cloudConfig).toContain('node-v24.18.1-linux-arm64.tar.xz');
  expect(cloudConfig).toContain('7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c');
  expect(cloudConfig).toContain('127.0.0.1 --port 4096');
  expect(cloudConfig).toContain('@opencode/cli@2.2.7');
  expect(cloudConfig).toContain('systemctl enable --now agent-router-opencode.service');
  expect(cloudConfig).not.toContain('0.0.0.0');
  expect(cloudConfig).not.toContain('ocid1.');
  expect(Buffer.byteLength(cloudConfig, 'utf8')).toBeLessThan(32 * 1024);

  expect(() =>
    renderWorkerCloudInit({ sshAuthorizedKey: 'ssh-ed25519 bad\nwrite_files: []' }),
  ).toThrow(/SSH public key/i);
});

test('fails closed on DEMO evidence, stale guardrails, or subnets with inbound security rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-oci-gate-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));
  const gateway = new InMemoryOciComputeGateway({ ingressRuleCount: 0 });
  const provisioner = new OciWorkerProvisioner({ journal, gateway });

  await expect(
    provisioner.provision({
      workspaceKey: 'ws-alpha',
      inspection: makeValidInspection('DEMO'),
      guardrails: makeValidGuardrails('OCI_API'),
      request: defaultRequest,
      subnetRef: 'subnet-zero-ingress',
      imageRef: 'image-ubuntu-2404-arm64',
      sshAuthorizedKey: sampleSshPubKey,
      now: fixedNow,
    }),
  ).rejects.toThrow(/DEMO_EVIDENCE_FORBIDDEN/);

  const unsafeGateway = new InMemoryOciComputeGateway({ ingressRuleCount: 1 });
  const unsafeProvisioner = new OciWorkerProvisioner({ journal, gateway: unsafeGateway });
  await expect(
    unsafeProvisioner.provision({
      workspaceKey: 'ws-alpha',
      inspection: makeValidInspection('OCI_API'),
      guardrails: makeValidGuardrails('OCI_API'),
      request: defaultRequest,
      subnetRef: 'subnet-open-ssh',
      imageRef: 'image-ubuntu-2404-arm64',
      sshAuthorizedKey: sampleSshPubKey,
      now: fixedNow,
    }),
  ).rejects.toThrow(/UNSAFE_SUBNET_INGRESS_RULES/);
  expect(unsafeGateway.launchCount).toBe(0);
});

test('recovers from post-launch controller crash via operation-id tags without launching a duplicate VM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-oci-crash-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));
  const gateway = new InMemoryOciComputeGateway({
    ingressRuleCount: 0,
    faultMode: 'CRASH_AFTER_CREATE',
  });
  const provisioner = new OciWorkerProvisioner({ journal, gateway });

  await expect(
    provisioner.provision({
      workspaceKey: 'ws-crash-recover',
      inspection: makeValidInspection('OCI_API'),
      guardrails: makeValidGuardrails('OCI_API'),
      request: defaultRequest,
      subnetRef: 'subnet-private',
      imageRef: 'image-ubuntu-2404-arm64',
      sshAuthorizedKey: sampleSshPubKey,
      now: fixedNow,
    }),
  ).rejects.toThrow(/Simulated post-launch transport crash/);

  expect(gateway.launchCount).toBe(1);

  // Simulate >24h opcRetryToken expiration in OCI while journal is still NEEDS_RECONCILE
  gateway.expireRetryTokens();

  // Duplicate provision while un-reconciled must be blocked by the journal lock
  gateway.setFaultMode('NONE');
  await expect(
    provisioner.provision({
      workspaceKey: 'ws-crash-recover',
      inspection: makeValidInspection('OCI_API'),
      guardrails: makeValidGuardrails('OCI_API'),
      request: defaultRequest,
      subnetRef: 'subnet-private',
      imageRef: 'image-ubuntu-2404-arm64',
      sshAuthorizedKey: sampleSshPubKey,
      now: fixedNow,
    }),
  ).rejects.toThrow(/reconcile first/i);

  const reconciled = await provisioner.reconcile('ws-crash-recover');
  expect(reconciled.outcome).toBe('ADOPTED_EXISTING_INSTANCE');
  if (reconciled.outcome !== 'ADOPTED_EXISTING_INSTANCE') {
    throw new Error('Expected ADOPTED_EXISTING_INSTANCE');
  }
  expect(reconciled.instanceFingerprint).toMatch(/^inst_[a-f0-9]{16}$/);
  expect(JSON.stringify(reconciled)).not.toContain('ocid1.');
  // Zero duplicate VM launches occurred!
  expect(gateway.launchCount).toBe(1);
});

test('handles OutOfHostCapacity cleanly without leaving blocking journal entries or leaked VMs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-oci-capacity-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));
  const gateway = new InMemoryOciComputeGateway({
    ingressRuleCount: 0,
    faultMode: 'OUT_OF_CAPACITY',
  });
  const provisioner = new OciWorkerProvisioner({ journal, gateway });

  const result = await provisioner.provision({
    workspaceKey: 'ws-capacity',
    inspection: makeValidInspection('OCI_API'),
    guardrails: makeValidGuardrails('OCI_API'),
    request: defaultRequest,
    subnetRef: 'subnet-private',
    imageRef: 'image-ubuntu-2404-arm64',
    sshAuthorizedKey: sampleSshPubKey,
    now: fixedNow,
  });

  expect(result).toEqual({
    status: 'OUT_OF_CAPACITY',
    workspaceKey: 'ws-capacity',
    fallbackRecommended: true,
  });
  expect(await journal.list()).toEqual([]);
});

test('fences active workers, enforces volume deletion on teardown, and detects leaked storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-oci-teardown-'));
  tempDirs.push(root);
  const journal = new OperationJournal(join(root, 'journal'));
  const gateway = new InMemoryOciComputeGateway({ ingressRuleCount: 0 });
  const provisioner = new OciWorkerProvisioner({ journal, gateway });

  const created = await provisioner.provision({
    workspaceKey: 'ws-lifecycle',
    inspection: makeValidInspection('OCI_API'),
    guardrails: makeValidGuardrails('OCI_API'),
    request: defaultRequest,
    subnetRef: 'subnet-private',
    imageRef: 'image-ubuntu-2404-arm64',
    sshAuthorizedKey: sampleSshPubKey,
    now: fixedNow,
  });
  expect(created.status).toBe('PROVISIONED');
  if (created.status !== 'PROVISIONED') throw new Error('Expected PROVISIONED');
  expect(created.shape).toBe('VM.Standard.A1.Flex');
  expect(created.bootVolumeVpusPerGB).toBe(10);
  expect(created.assignPublicIp).toBe(false);
  expect(JSON.stringify(created)).not.toContain('ocid1.');

  const fenced = await provisioner.fence('ws-lifecycle');
  expect(fenced).toEqual({
    workspaceKey: 'ws-lifecycle',
    fenced: true,
    stoppedCount: 1,
  });

  // Inject a leaked boot volume to ensure teardown fails closed on leaked storage
  gateway.injectOrphanBootVolume('ws-lifecycle');
  await expect(provisioner.teardown('ws-lifecycle')).rejects.toThrow(/LEAKED_RESOURCES_DETECTED/);
  expect(gateway.lastTerminateOptions).toEqual({
    preserveBootVolume: false,
    preserveDataVolumesCreatedAtLaunch: false,
  });

  // Clear the simulated orphan volume and confirm zero-remnant teardown succeeds
  gateway.clearOrphanBootVolumes('ws-lifecycle');
  const tornDown = await provisioner.teardown('ws-lifecycle');
  expect(tornDown).toEqual({
    workspaceKey: 'ws-lifecycle',
    terminatedCount: 0,
    remnants: {
      instances: 0,
      bootVolumes: 0,
      blockVolumes: 0,
      reservedPublicIps: 0,
    },
  });
});

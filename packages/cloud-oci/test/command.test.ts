import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { liveHooks } from '../../../scripts/deploy-oci.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { OciHostCommand } from '../src/command.js';
import { OciResourcePlan } from '../src/plan.js';
import { MemoryCloud } from './memory-cloud.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = new Date('2026-11-13T12:00:00Z');
const clock = { now: () => now.getTime(), wait: async () => {} };

test('demo dry run prints the free host and destroy names the discord-bot exclusion', async () => {
  const deploy = await OciHostCommand.deploy(['--dry-run', '--demo'], { now, agentVersion: '2.2.7' });
  expect(deploy.code).toBe(0);
  const body = JSON.stringify(deploy.body);
  expect(body).toContain('VM.Standard.A1.Flex');
  expect(body).toContain('nat-gateway');
  expect(body).toContain('127.0.0.1:4096');
  expect(body).toContain('"executed":false');
  expect(body).not.toContain('OPENCODE_PASSWORD');
  const refused = await OciHostCommand.deploy(['--demo'], { now });
  expect(refused.code).toBe(2);
  expect(JSON.stringify(refused.body)).toContain('DEMO_CANNOT_AUTHORIZE');
  const destroy = await OciHostCommand.destroy(['--dry-run']);
  expect(destroy.code).toBe(0);
  expect(JSON.stringify(destroy.body)).toContain('discord-bot');
  expect(liveHooks().cloudInit('ab'.repeat(32))).toContain('2.2.7');
});

test('a live command uses the injected gateway and refuses uncertain eligibility before any call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-command-'));
  roots.push(root);
  const reportPath = join(root, 'report.json');
  const eligibilityPath = join(root, 'eligibility.json');
  const configPath = join(root, 'config');
  const publicKey = join(root, 'id.pub');
  const privateKey = join(root, 'id');
  const report: OciInspection = {
    schemaVersion: 1, source: 'OCI_API', observedAt: now.toISOString(),
    homeRegion: 'us-example-1', region: 'us-example-1', availabilityDomain: 'AD-1',
    metrics: {
      a1RegionalOcpus: { status: 'KNOWN', limit: 2, used: 0, available: 2 },
      a1RegionalMemoryGb: { status: 'KNOWN', limit: 12, used: 0, available: 12 },
      a1AdOcpus: { status: 'KNOWN', limit: 2, used: 0, available: 2 },
      a1AdMemoryGb: { status: 'KNOWN', limit: 12, used: 0, available: 12 },
      microInstances: { status: 'KNOWN', limit: 2, used: 0, available: 2 },
      freeStorageGb: { status: 'KNOWN', limit: 200, used: 0, available: 200 },
    }, issues: [],
  };
  await writeFile(reportPath, JSON.stringify(report));
  await writeFile(configPath, 'not-read');
  await writeFile(publicKey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly router\n', { mode: 0o600 });
  await writeFile(privateKey, 'private-key-material\n', { mode: 0o600 });
  await chmod(privateKey, 0o600);
  const cloud = new MemoryCloud();
  let opened = false;
  const args = [
    '--config', configPath, '--report', reportPath, '--eligibility', eligibilityPath,
    '--compartment', cloud.compartment.id, '--ssh-public-key', publicKey, '--ssh-private-key', privateKey,
    '--ssh-cidr', '203.0.113.10/32', '--state', join(root, 'state.json'),
  ];
  await writeFile(eligibilityPath, JSON.stringify({
    schemaVersion: 1, evidence: 'RECORDED', accountClass: 'ALWAYS_FREE', monthlyUsage: 'WITHIN_ALLOTMENT',
    imageCharge: 'NONE', networkCharge: 'NONE', storageCharge: 'NONE', capacity: 'UNKNOWN', compartmentQuota: 'FITS',
  }));
  const blocked = await OciHostCommand.deploy(args, {
    now, clock, hooks: { ...liveHooks(), openGateway: () => { opened = true; return cloud; } },
  });
  expect(blocked.code).toBe(2);
  expect(opened).toBe(false);
  await writeFile(eligibilityPath, JSON.stringify({
    schemaVersion: 1, evidence: 'RECORDED', accountClass: 'ALWAYS_FREE', monthlyUsage: 'WITHIN_ALLOTMENT',
    imageCharge: 'NONE', networkCharge: 'NONE', storageCharge: 'NONE', capacity: 'AVAILABLE', compartmentQuota: 'FITS',
  }));
  const verified: string[] = [];
  const launched = await OciHostCommand.deploy(args, {
    now, clock, agentVersion: '2.2.7',
    hooks: {
      cloudInit: password => liveHooks().cloudInit(password),
      openGateway: () => cloud,
      verify: async input => { verified.push(input.publicIp); },
    },
  });
  expect(launched.code).toBe(0);
  expect(launched.body).toMatchObject({ agentReady: true, publicIp: '203.0.113.20', shape: OciResourcePlan.shape });
  expect(verified).toEqual(['203.0.113.20']);
  expect(cloud.closed).toBe(true);
  expect(JSON.stringify(launched.body)).not.toContain('private-key-material');
});

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OciLiveHooks } from '../../../scripts/deploy-oci.js';
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
  const body = deploy.body as {
    executed: boolean; wouldCreate: { type: string; shape?: string; bootVolumeSizeInGBs?: number; agent?: { version: string; bind: string } }[];
    wouldNotCreate: string[];
  };
  expect(body.executed).toBe(false);
  expect(body.wouldCreate.map(item => item.type)).toEqual(['vcn', 'internet-gateway', 'route-rule', 'security-list', 'subnet', 'instance']);
  expect(body.wouldCreate.find(item => item.type === 'instance')).toMatchObject({
    shape: 'VM.Standard.A1.Flex', bootVolumeSizeInGBs: 50, agent: { version: '2.2.7', bind: '127.0.0.1:4096' },
  });
  expect(body.wouldNotCreate).toContain('nat-gateway');
  expect(JSON.stringify(body)).not.toContain('OPENCODE_PASSWORD');
  const refused = await OciHostCommand.deploy(['--demo'], { now });
  expect(refused.code).toBe(2);
  expect(refused.body).toMatchObject({ blockers: ['DEMO_CANNOT_AUTHORIZE'] });
  const destroy = await OciHostCommand.destroy(['--dry-run']);
  expect(destroy.code).toBe(0);
  expect(destroy.body).toMatchObject({ executed: false, queriedOracle: false, deletionRequires: '--yes', untouchedExamples: ['discord-bot'] });
  expect(OciLiveHooks.create().cloudInit()).toContain('npm install -g @opencode/cli@2.2.7');
  expect(OciLiveHooks.create().cloudInit()).not.toContain('OPENCODE_PASSWORD');
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
    '--config', configPath, '--eligibility', eligibilityPath,
    '--compartment', cloud.compartment.id, '--ssh-public-key', publicKey, '--ssh-private-key', privateKey,
    '--ssh-cidr', '203.0.113.10/32', '--state', join(root, 'state.json'),
  ];
  await writeFile(eligibilityPath, JSON.stringify({
    schemaVersion: 1, evidence: 'RECORDED', accountClass: 'ALWAYS_FREE', monthlyUsage: 'WITHIN_ALLOTMENT',
    imageCharge: 'NONE', networkCharge: 'NONE', storageCharge: 'NONE', capacity: 'UNKNOWN', compartmentQuota: 'FITS',
    observedAt: now.toISOString(),
  }));
  let inspected = false;
  const blocked = await OciHostCommand.deploy(args, {
    now, clock, hooks: {
      cloudInit: () => OciLiveHooks.create().cloudInit(),
      inspect: async () => { inspected = true; return report; },
      openGateway: () => { opened = true; return cloud; },
      installAgent: async () => {},
      verify: async () => {},
    },
  });
  expect(blocked.code).toBe(2);
  expect(inspected).toBe(true);
  expect(opened).toBe(false);
  expect(await readFile(reportPath, 'utf8')).toContain('OCI_API');
  await writeFile(eligibilityPath, JSON.stringify({
    schemaVersion: 1, evidence: 'RECORDED', accountClass: 'ALWAYS_FREE', monthlyUsage: 'WITHIN_ALLOTMENT',
    imageCharge: 'NONE', networkCharge: 'NONE', storageCharge: 'NONE', capacity: 'AVAILABLE', compartmentQuota: 'FITS',
    observedAt: now.toISOString(),
  }));
  const verified: string[] = [];
  const launched = await OciHostCommand.deploy(args, {
    now, clock, agentVersion: '2.2.7',
    hooks: {
      cloudInit: () => OciLiveHooks.create().cloudInit(),
      inspect: async () => report,
      openGateway: () => cloud,
      installAgent: async () => {},
      verify: async input => { verified.push(input.publicIp); },
    },
  });
  expect(launched.code).toBe(0);
  expect(launched.body).toMatchObject({ agentReady: true, publicIp: '203.0.113.20', shape: OciResourcePlan.shape });
  expect(verified).toEqual(['203.0.113.20']);
  expect(cloud.closed).toBe(true);
  expect(JSON.stringify(launched.body)).not.toContain('private-key-material');
});

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectionSchema, type OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { DeployError } from './errors.js';
import { OciFreeTierGate } from './gate.js';
import type { OciGateway } from './gateway.js';
import { OciResourcePlan } from './plan.js';
import { OciProvisioner, type DeployClock } from './provisioner.js';
import { OciDeployState } from './state.js';

export interface LiveHooks {
  cloudInit(): string;
  openGateway(configPath: string, profile: string): OciGateway;
  inspect(configPath: string, profile: string, availabilityDomain?: string): Promise<OciInspection>;
  installAgent(input: { publicIp: string; password: string; privateKeyPath: string; knownHostsPath: string; freshHost: boolean }): Promise<void>;
  verify(input: { publicIp: string; password: string; privateKeyPath: string; knownHostsPath: string; freshHost: boolean }): Promise<void>;
}

export interface CommandOptions {
  hooks?: LiveHooks;
  agentVersion?: string;
  now?: Date;
  clock?: DeployClock;
  deadlineMs?: number;
}

const deployHelp = `pnpm deploy:oci --dry-run --demo
pnpm deploy:oci --dry-run --report report.json --eligibility eligibility.json --compartment OCID --ssh-cidr ADDR/32
pnpm deploy:oci --config /absolute/oci-config --eligibility eligibility.json --compartment OCID --availability-domain AD --ssh-public-key /absolute/key.pub --ssh-private-key /absolute/key --ssh-cidr ADDR/32

A dry run does not call Oracle. A live launch inspects quota immediately before create and refuses a hand-written report. Pay As You Go needs --allow-payg.`;

const destroyHelp = `pnpm destroy:oci --dry-run
pnpm destroy:oci --config /absolute/oci-config
pnpm destroy:oci --config /absolute/oci-config --yes

Without --yes, destroy lists the resource IDs saved in the state file and does not delete them. --include-unrecorded also lists tagged resources that are not saved. Region and compartment come from that state file.`;

/** CLI for a free-only deploy and a state-scoped destroy. Live Oracle calls stay behind hooks. */
export class OciHostCommand {
  static async deploy(argv: string[], options: CommandOptions = {}): Promise<{ code: number; body?: unknown; text?: string }> {
    try {
      const { values } = parseArgs({ args: argv, options: {
        help: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, demo: { type: 'boolean' },
        config: { type: 'string' }, profile: { type: 'string', default: 'DEFAULT' }, report: { type: 'string' },
        eligibility: { type: 'string' }, compartment: { type: 'string' }, 'ssh-public-key': { type: 'string' },
        'ssh-private-key': { type: 'string' }, 'ssh-cidr': { type: 'string' }, state: { type: 'string' },
        'allow-payg': { type: 'boolean' }, 'availability-domain': { type: 'string' },
      } });
      if (values.help) return { code: 0, text: deployHelp };
      if (!/^[\w.-]+$/.test(values.profile ?? '')) return this.invalid();
      const demo = values.demo === true;
      const dryRun = values['dry-run'] === true;
      if (demo && !dryRun) return { code: 2, body: { action: 'deploy', executed: false, status: 'REFUSED', blockers: ['DEMO_CANNOT_AUTHORIZE'] } };
      if (demo && (values.report || values.eligibility)) return this.invalid();
      if (!dryRun && values.report) return this.invalid();
      const now = options.now ?? new Date();
      const eligibilityPath = demo ? new URL('../../../fixtures/oci/always-free-eligibility.json', import.meta.url) : values.eligibility;
      if (!eligibilityPath) return this.invalid();
      const eligibility: unknown = JSON.parse(await readFile(eligibilityPath, 'utf8'));
      const sshCidr = OciResourcePlan.sshCidr(values['ssh-cidr'] ?? (demo ? '203.0.113.10/32' : ''));
      const compartmentId = values.compartment ? OciResourcePlan.compartmentId(values.compartment) : demo ? 'DEMO' : '';
      if (!compartmentId) return this.invalid();
      if (dryRun) {
        const reportPath = demo ? new URL('../../../fixtures/oci/readiness-demo.json', import.meta.url) : values.report;
        if (!reportPath) return this.invalid();
        const report = inspectionSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')));
        if (demo) { report.source = 'DEMO'; report.observedAt = now.toISOString(); }
        const authorization = OciFreeTierGate.evaluate({ report, eligibility, mode: 'DRY_RUN', now, allowPayg: values['allow-payg'] === true });
        if (!authorization.provisioningAllowed) {
          return { code: 2, body: { action: 'deploy', executed: false, mode: 'DRY_RUN', ...this.publicAuthorization(authorization) } };
        }
        return { code: 0, body: { ...OciResourcePlan.deployDryRun({
          compartmentId, sshCidr, region: authorization.region, availabilityDomain: authorization.availabilityDomain,
          agentVersion: options.agentVersion ?? 'pinned',
        }), authorization: this.publicAuthorization(authorization) } };
      }
      if (!options.hooks?.inspect || !values['ssh-public-key'] || !values['ssh-private-key']) return this.invalid();
      const configPath = this.credentialPath(values.config ?? join(homedir(), '.oci', 'config'));
      if (!configPath || !(await this.existingFile(configPath))) return { code: 1, body: { action: 'deploy', executed: false, status: 'NOT_CONFIGURED' } };
      const report = await options.hooks.inspect(configPath, values.profile ?? 'DEFAULT', values['availability-domain']);
      const authorization = OciFreeTierGate.evaluate({ report, eligibility, mode: 'LIVE', now, allowPayg: values['allow-payg'] === true });
      if (!authorization.provisioningAllowed) {
        return { code: 2, body: { action: 'deploy', executed: false, mode: 'LIVE', inspected: true, ...this.publicAuthorization(authorization) } };
      }
      const privateKeyPath = this.credentialPath(values['ssh-private-key']);
      if (!privateKeyPath || !(await this.privateKey(privateKeyPath))) return this.invalid();
      const publicKeyPath = this.credentialPath(values['ssh-public-key']);
      if (!publicKeyPath) return this.invalid();
      const sshPublicKey = OciResourcePlan.sshPublicKey(await this.readKey(publicKeyPath));
      const statePath = resolve(values.state ?? join('.work', 'oci-deploy-state.json'));
      let state = await OciDeployState.load(statePath) ?? OciDeployState.create();
      await OciDeployState.save(statePath, state);
      const knownHostsPath = join(dirname(statePath), 'oci-known-hosts');
      const gateway = options.hooks.openGateway(configPath, values.profile ?? 'DEFAULT');
      try {
        const body = await OciProvisioner.deploy({
          gateway, authorization, compartmentId, sshPublicKey, sshCidr, state,
          cloudInit: options.hooks.cloudInit(),
          installAgent: (publicIp, password, freshHost) => options.hooks!.installAgent({ publicIp, password, privateKeyPath, knownHostsPath, freshHost }),
          verify: (publicIp, password, freshHost) => options.hooks!.verify({ publicIp, password, privateKeyPath, knownHostsPath, freshHost }),
          saveState: async next => { state = next; await OciDeployState.save(statePath, next); },
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
        });
        return { code: 0, body };
      } finally { gateway.close(); }
    } catch (error) { return this.failed('deploy', error); }
  }

  static async destroy(argv: string[], options: CommandOptions = {}): Promise<{ code: number; body?: unknown; text?: string }> {
    try {
      const { values } = parseArgs({ args: argv, options: {
        help: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' },
        'include-unrecorded': { type: 'boolean' }, config: { type: 'string' },
        profile: { type: 'string', default: 'DEFAULT' }, compartment: { type: 'string' },
        region: { type: 'string' }, state: { type: 'string' },
      } });
      if (values.help) return { code: 0, text: destroyHelp };
      if (!/^[\w.-]+$/.test(values.profile ?? '')) return this.invalid();
      const configPath = values.config ? this.credentialPath(values.config) : this.credentialPath(join(homedir(), '.oci', 'config'));
      const configured = Boolean(configPath && await this.existingFile(configPath));
      if (values['dry-run'] && !configured) return { code: 0, body: OciResourcePlan.destroyDryRun() };
      if (!configured || !configPath || !options.hooks) return { code: 1, body: { action: 'destroy', executed: false, status: 'NOT_CONFIGURED' } };
      const statePath = resolve(values.state ?? join('.work', 'oci-deploy-state.json'));
      const state = await OciDeployState.load(statePath);
      if (!state?.region || !state.compartmentId) return { code: 2, body: { action: 'destroy', executed: false, status: 'FAILED', code: 'STATE_REQUIRED' } };
      if (values.compartment && values.compartment !== state.compartmentId) return { code: 2, body: { action: 'destroy', executed: false, status: 'FAILED', code: 'COMPARTMENT_MISMATCH' } };
      if (values.region && values.region !== state.region) return { code: 2, body: { action: 'destroy', executed: false, status: 'FAILED', code: 'REGION_MISMATCH' } };
      const gateway = options.hooks.openGateway(configPath, values.profile ?? 'DEFAULT');
      try {
        const plan = await OciProvisioner.planDestroy({ gateway, state, includeUnrecorded: values['include-unrecorded'] === true });
        if (!values.yes || values['dry-run']) return { code: 0, body: plan };
        const body = await OciProvisioner.destroy({
          gateway, state, includeUnrecorded: values['include-unrecorded'] === true,
          saveState: async next => { await OciDeployState.save(statePath, next); },
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
        });
        return { code: 0, body };
      } finally { gateway.close(); }
    } catch (error) { return this.failed('destroy', error); }
  }

  private static publicAuthorization(authorization: ReturnType<typeof OciFreeTierGate.evaluate>) {
    return {
      status: authorization.status, provisioningAllowed: authorization.provisioningAllowed, blockers: authorization.blockers,
      quotaStatus: authorization.quotaStatus, source: authorization.source, evidence: authorization.evidence,
      region: authorization.region, availabilityDomain: authorization.availabilityDomain, profile: authorization.profile,
    };
  }

  private static credentialPath(value: string): string | null {
    return isAbsolute(value) && !/[\r\n\0]/.test(value) ? value : null;
  }

  private static async existingFile(path: string): Promise<boolean> {
    try { return (await lstat(path)).isFile(); } catch { return false; }
  }

  private static async privateKey(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      const uid = process.getuid?.();
      return info.isFile() && info.uid === uid && (info.mode & 0o007) === 0 && info.size > 0 && info.size < 16_384;
    } catch { return false; }
  }

  private static async readKey(path: string): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) throw new DeployError('SSH_PUBLIC_KEY_INVALID');
      return await handle.readFile({ encoding: 'utf8' });
    } finally { await handle.close(); }
  }

  private static invalid(): { code: number; text: string } {
    return { code: 1, text: 'Oracle command failed: check the eligibility file, compartment, and SSH options.' };
  }

  private static failed(action: string, error: unknown): { code: number; body?: unknown; text?: string } {
    if (error instanceof DeployError) {
      const operational = new Set(['REQUEST_FAILED', 'TIMED_OUT', 'AGENT_NOT_READY', 'SSH_TUNNEL_FAILED', 'NOT_FOUND', 'NOT_AUTHORIZED', 'RESOURCE_MISSING', 'RESOURCE_FAILED', 'PAGINATION_INCOMPLETE', 'AD_DISCOVERY_FAILED', 'AD_NOT_RESOLVED', 'STATE_INVALID', 'STATE_PERMISSIONS', 'RETRY_TOKEN_INVALID', 'CLOUD_INIT_TOO_LARGE', 'SSH_PUBLIC_KEY_INVALID', 'ROUTE_TABLE_MISSING']);
      return { code: operational.has(error.code) ? 1 : 2, body: { action, executed: false, status: 'FAILED', code: error.code, ...error.details } };
    }
    return this.invalid();
  }
}

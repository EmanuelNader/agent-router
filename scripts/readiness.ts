import { execFileSync } from 'node:child_process';
import { OPENCODE_VERSION } from '../packages/agent-opencode/src/server.js';

function version(command: string, args: string[]) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return 'UNAVAILABLE'; }
}

// No cloud credential discovery, network calls, or model configuration reads.
const checks = {
  node24: process.versions.node.split('.')[0] === '24',
  pnpm11: version('pnpm', ['--version']).startsWith('11.'),
  git: version('git', ['--version']).startsWith('git version'),
  pinnedOpenCode: version('node_modules/.bin/opencode', ['--version']) === `opencode v${OPENCODE_VERSION}`,
};
const localTools = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
console.log(JSON.stringify({
  localTools, checks, docker: version('docker', ['version', '--format', '{{.Server.Version}}']) === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE',
  cloudAccountInspection: 'UNTESTED', cloudProvisioning: 'NOT_IMPLEMENTED',
  allowanceMonitoring: 'NOT_IMPLEMENTED', modelInference: 'UNTESTED',
}, null, 2));
if (localTools !== 'PASS') process.exitCode = 1;

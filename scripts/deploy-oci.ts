import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCodeBootstrap } from '../packages/agent-opencode/src/bootstrap.js';
import { OPENCODE_VERSION } from '../packages/agent-opencode/src/server.js';
import { SshLoopbackTunnel } from '../packages/agent-opencode/src/tunnel.js';
import { OciHostCommand, type LiveHooks } from '../packages/cloud-oci/src/command.js';
import { OciSdkGateway } from '../packages/cloud-oci/src/sdk.js';

export function liveHooks(): LiveHooks {
  return {
    cloudInit: password => OpenCodeBootstrap.cloudInit(password),
    openGateway: (configPath, profile) => OciSdkGateway.fromConfig(configPath, profile),
    verify: input => OpenCodeBootstrap.verifyThroughTunnel(input.publicIp, input.password, host => SshLoopbackTunnel.open({
      host, privateKeyPath: input.privateKeyPath, knownHostsPath: input.knownHostsPath,
    })),
  };
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  try {
    const result = await OciHostCommand.deploy(process.argv.slice(2), { hooks: liveHooks(), agentVersion: OPENCODE_VERSION });
    if (result.text && result.code === 1) console.error(result.text);
    else if (result.text) console.log(result.text);
    else console.log(JSON.stringify(result.body, null, 2));
    process.exitCode = result.code;
  } catch {
    console.error('Oracle deploy failed.');
    process.exitCode = 1;
  }
}

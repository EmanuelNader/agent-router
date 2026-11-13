import { parseArgs } from 'node:util';
import { common, identity } from 'oci-sdk';
import { ociReadiness } from '../packages/cloud-readiness/src/reports.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, profile: { type: 'string', default: 'DEFAULT' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('pnpm inspect:oci --config /absolute/path/to/oci-config [--profile DEFAULT]\nRead-only region discovery. Does not establish free compute eligibility.');
} else if (!values.config) {
  console.log(JSON.stringify({ provider: 'oci', status: 'NOT_CONFIGURED', provisioningAllowed: false }));
  process.exitCode = 1;
} else {
  let client: identity.IdentityClient | undefined;
  try {
    const auth = new common.ConfigFileAuthenticationDetailsProvider(values.config, values.profile);
    client = new identity.IdentityClient({ authenticationDetailsProvider: auth });
    const response = await client.listRegionSubscriptions({ tenancyId: auth.getTenantId() });
    console.log(JSON.stringify(ociReadiness(response.items), null, 2));
  } catch {
    // SDK errors may contain account OCIDs, paths, and signed request details.
    console.error(JSON.stringify({ provider: 'oci', status: 'INSPECTION_FAILED', provisioningAllowed: false }));
    process.exitCode = 1;
  } finally { client?.close(); }
}

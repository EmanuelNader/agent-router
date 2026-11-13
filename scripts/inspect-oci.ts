import { parseArgs } from 'node:util';
import { createOciSdkReader } from '../packages/cloud-readiness/src/oci-sdk.js';
import { inspectOci } from '../packages/cloud-readiness/src/oci-inspect.js';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, profile: { type: 'string', default: 'DEFAULT' }, help: { type: 'boolean' },
  region: { type: 'string' }, 'availability-domain': { type: 'string' },
} });
if (values.help) {
  console.log('pnpm inspect:oci --config /absolute/path/to/oci-config [--profile DEFAULT] [--availability-domain exact-OCI-name]\nRead-only home-region, AD, compute quota and free-storage inspection. No launch authorization.');
} else if (!values.config) {
  console.log(JSON.stringify({ provider: 'oci', status: 'NOT_CONFIGURED', provisioningAllowed: false }));
  process.exitCode = 1;
} else {
  let connection: ReturnType<typeof createOciSdkReader> | undefined;
  try {
    connection = createOciSdkReader(values.config, values.profile);
    const report = await inspectOci(connection.reader, {
      ...(values.region ? { region: values.region } : {}),
      ...(values['availability-domain'] ? { availabilityDomain: values['availability-domain'] } : {}),
    });
    console.log(JSON.stringify({ ...report, provisioningAllowed: false }, null, 2));
    if (report.issues.length || Object.values(report.metrics).some(metric => metric.status === 'UNKNOWN')) process.exitCode = 1;
  } catch {
    // SDK errors may contain account OCIDs, paths, and signed request details.
    console.error(JSON.stringify({ provider: 'oci', status: 'INSPECTION_FAILED', provisioningAllowed: false }));
    process.exitCode = 1;
  } finally { connection?.close(); }
}

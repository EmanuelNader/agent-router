import { parseArgs } from 'node:util';
import { prepareOciKey, writeOciConfig } from '../packages/cloud-readiness/src/oci-connection.js';

const help = `Create a local key and config for a dedicated OCI inspection user.

pnpm connect:oci prepare --directory /absolute/new/private-directory
pnpm connect:oci configure --directory /absolute/private-directory --user USER_OCID --tenancy TENANCY_OCID --region HOME_REGION

Register the public PEM with the inspection user in Oracle before running inspect:oci.
Both commands use local files only and refuse to replace existing credentials.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, directory: { type: 'string' }, user: { type: 'string' },
    tenancy: { type: 'string' }, region: { type: 'string' },
  } });
  const [action] = positionals;
  if (values.help) console.log(help);
  else if (positionals.length === 1 && action === 'prepare' && values.directory) {
    const result = await prepareOciKey(values.directory);
    console.log(JSON.stringify({ status: 'PUBLIC_KEY_READY', ...result }, null, 2));
  } else if (positionals.length === 1 && action === 'configure' && values.directory && values.user && values.tenancy && values.region) {
    const result = await writeOciConfig(values.directory, { user: values.user, tenancy: values.tenancy, region: values.region });
    console.log(JSON.stringify({ status: 'LOCAL_CONFIG_READY', ...result }, null, 2));
  } else { console.error(help); process.exitCode = 1; }
} catch (error) {
  const alreadyExists = (error as NodeJS.ErrnoException).code === 'EEXIST';
  console.error(alreadyExists ? 'Destination already exists. Existing files were preserved.' : 'Oracle setup failed. Check the directory, key permissions, and required identifiers.');
  process.exitCode = 1;
}

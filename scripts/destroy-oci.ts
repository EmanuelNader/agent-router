import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OciHostCommand } from '../packages/cloud-oci/src/command.js';
import { liveHooks } from './deploy-oci.js';

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  try {
    const result = await OciHostCommand.destroy(process.argv.slice(2), { hooks: liveHooks() });
    if (result.text && result.code === 1) console.error(result.text);
    else if (result.text) console.log(result.text);
    else console.log(JSON.stringify(result.body, null, 2));
    process.exitCode = result.code;
  } catch {
    console.error('Oracle destroy failed.');
    process.exitCode = 1;
  }
}

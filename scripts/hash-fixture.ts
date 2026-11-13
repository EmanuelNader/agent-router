import { hashWorkspace } from '../packages/workspace/src/manifest.js';

const directory = process.argv[2];
if (!directory) {
  console.error('Usage: pnpm fixture:hash <directory>');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await hashWorkspace(directory), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Cannot hash workspace'); process.exitCode = 1; }
}

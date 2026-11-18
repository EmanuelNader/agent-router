import { runRouterCli } from '../packages/cli/src/cli.js';

const exitCode = await runRouterCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exitCode = exitCode;
}

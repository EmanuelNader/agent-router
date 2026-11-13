import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectionSchema } from '../packages/cloud-readiness/src/oci-report.js';
import { previewOciDeployment } from '../packages/cloud-readiness/src/oci-plan.js';

try {
  const { values } = parseArgs({ options: {
    report: { type: 'string' }, demo: { type: 'boolean' }, help: { type: 'boolean' },
    ocpus: { type: 'string', default: '1' }, 'memory-gb': { type: 'string', default: '4' },
    'boot-gb': { type: 'string', default: '50' }, 'additional-instances': { type: 'string', default: '1' },
  } });
  if (values.help) {
    console.log('pnpm plan:oci (--demo | --report file.json) [--ocpus 1] [--memory-gb 4] [--boot-gb 50] [--additional-instances 1]\nAdditional instances consume quota beyond already observed usage. This command cannot launch a VM.');
  } else {
    if (Boolean(values.report) === Boolean(values.demo)) throw new Error('Choose demo or report');
    const path = values.demo ? new URL('../fixtures/oci/readiness-demo.json', import.meta.url) : values.report!;
    const input: unknown = JSON.parse(await readFile(path, 'utf8'));
    const report = inspectionSchema.parse(input);
    // Demo time is refreshed solely to demonstrate the comparison; provenance is forcibly DEMO.
    const now = new Date();
    if (values.demo) { report.source = 'DEMO'; report.observedAt = now.toISOString(); }
    const plan = previewOciDeployment(report, {
      ocpus: Number(values.ocpus), memoryGb: Number(values['memory-gb']),
      bootGb: Number(values['boot-gb']), additionalInstances: Number(values['additional-instances']),
    }, now);
    console.log(JSON.stringify(plan, null, 2));
    if (plan.status === 'BLOCKED') process.exitCode = 2;
  }
} catch {
  console.error('Oracle preview failed: supply one valid report or --demo and a supported resource request.');
  process.exitCode = 1;
}

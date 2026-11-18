import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  evaluateOciPaygGuardrails,
  guardrailReportSchema,
  inspectOciGuardrails,
} from '../packages/cloud-readiness/src/oci-guardrails.js';
import { inspectOci } from '../packages/cloud-readiness/src/oci-inspect.js';
import { inspectionSchema } from '../packages/cloud-readiness/src/oci-report.js';
import { createOciGuardrailSdkReader, createOciSdkReader } from '../packages/cloud-readiness/src/oci-sdk.js';

const help = `pnpm guard:oci (--demo | --config /abs/path/config --compartment-id OCID --compartment-name NAME) [--ocpus 1] [--memory-gb 4] [--boot-gb 50] [--additional-instances 1]
Verifies Always Free quota headroom PLUS OCI Compartment Quota caps and an active <= $5 monthly Budget Alert tripwire for PAYG-safe operation. Cannot launch a VM.`;

try {
  const { values } = parseArgs({
    options: {
      demo: { type: 'boolean' },
      help: { type: 'boolean' },
      config: { type: 'string' },
      profile: { type: 'string', default: 'DEFAULT' },
      'compartment-id': { type: 'string' },
      'compartment-name': { type: 'string' },
      'availability-domain': { type: 'string' },
      ocpus: { type: 'string', default: '1' },
      'memory-gb': { type: 'string', default: '4' },
      'boot-gb': { type: 'string', default: '50' },
      'additional-instances': { type: 'string', default: '1' },
    },
  });

  if (values.help) {
    console.log(help);
  } else {
    const request = {
      ocpus: Number(values.ocpus),
      memoryGb: Number(values['memory-gb']),
      bootGb: Number(values['boot-gb']),
      additionalInstances: Number(values['additional-instances']),
    };
    const now = new Date();

    if (values.demo) {
      if (values.config || values['compartment-id']) throw new Error('Do not mix --demo with live config flags');
      const demoInspection = inspectionSchema.parse(
        JSON.parse(await readFile(new URL('../fixtures/oci/readiness-demo.json', import.meta.url), 'utf8')),
      );
      const demoGuardrails = guardrailReportSchema.parse(
        JSON.parse(await readFile(new URL('../fixtures/oci/guardrails-payg-demo.json', import.meta.url), 'utf8')),
      );
      demoInspection.source = 'DEMO';
      demoInspection.observedAt = now.toISOString();
      demoGuardrails.source = 'DEMO';
      demoGuardrails.observedAt = now.toISOString();

      const evaluation = evaluateOciPaygGuardrails(demoInspection, demoGuardrails, request, now);
      console.log(JSON.stringify(evaluation, null, 2));
      if (evaluation.status === 'BLOCKED') process.exitCode = 2;
    } else if (values.config && values['compartment-id'] && values['compartment-name']) {
      let baseConn: ReturnType<typeof createOciSdkReader> | undefined;
      let guardConn: ReturnType<typeof createOciGuardrailSdkReader> | undefined;
      try {
        baseConn = createOciSdkReader(values.config, values.profile);
        guardConn = createOciGuardrailSdkReader(values.config, values['compartment-id'], values.profile);
        const [inspection, guardrails] = await Promise.all([
          inspectOci(baseConn.reader, {
            ...(values['availability-domain'] ? { availabilityDomain: values['availability-domain'] } : {}),
          }),
          inspectOciGuardrails(guardConn.reader, values['compartment-name'], now),
        ]);
        const evaluation = evaluateOciPaygGuardrails(inspection, guardrails, request, now);
        console.log(JSON.stringify(evaluation, null, 2));
        if (evaluation.status === 'BLOCKED') process.exitCode = 2;
      } finally {
        baseConn?.close();
        guardConn?.close();
      }
    } else {
      console.error(help);
      process.exitCode = 1;
    }
  }
} catch {
  // Never echo OCIDs, paths, emails, or signed SDK request errors.
  console.error('OCI guardrail check failed: supply --demo or valid read-only OCI config and compartment identifiers.');
  process.exitCode = 1;
}

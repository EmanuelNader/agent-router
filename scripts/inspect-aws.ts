import { parseArgs } from 'node:util';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { FreeTierClient, GetAccountPlanStateCommand } from '@aws-sdk/client-freetier';
import { awsReadiness } from '../packages/cloud-readiness/src/reports.js';

const { values } = parseArgs({ options: {
  region: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('pnpm inspect:aws --region us-east-1\nUses the AWS SDK credential chain. Read-only identity and account-plan discovery.');
} else if (!values.region) {
  console.log(JSON.stringify({ provider: 'aws', status: 'NOT_CONFIGURED', provisioningAllowed: false }));
  process.exitCode = 1;
} else {
  const sts = new STSClient({ region: values.region, maxAttempts: 2 });
  const freeTier = new FreeTierClient({ region: values.region, maxAttempts: 2 });
  try {
    await sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(15_000) });
    const plan = await freeTier.send(new GetAccountPlanStateCommand({}), { abortSignal: AbortSignal.timeout(15_000) });
    console.log(JSON.stringify(awsReadiness(plan), null, 2));
  } catch {
    console.error(JSON.stringify({ provider: 'aws', status: 'INSPECTION_FAILED', provisioningAllowed: false }));
    process.exitCode = 1;
  } finally { sts.destroy(); freeTier.destroy(); }
}

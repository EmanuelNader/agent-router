import { expect, test } from 'vitest';
import { OciResourcePlan } from '../src/plan.js';

const deploymentId = `dep${'a'.repeat(16)}`;

test('SSH ingress must be an IPv4 /24 or tighter', () => {
  expect(OciResourcePlan.sshCidr('203.0.113.10/32')).toBe('203.0.113.10/32');
  expect(OciResourcePlan.sshCidr('203.0.113.0/24')).toBe('203.0.113.0/24');
  for (const cidr of ['0.0.0.0/0', '0.0.0.0/1', '203.0.113.10/0', '10.0.0.0/16']) {
    expect(() => OciResourcePlan.sshCidr(cidr)).toThrow(/SSH_CIDR_TOO_WIDE/);
  }
});

test('the launch compartment is a compartment OCID and not the tenancy root', () => {
  expect(OciResourcePlan.compartmentId('ocid1.compartment.oc1..examplecompartment')).toBe('ocid1.compartment.oc1..examplecompartment');
  expect(() => OciResourcePlan.compartmentId('ocid1.tenancy.oc1..exampletenancy')).toThrow(/COMPARTMENT_INVALID/);
  expect(OciResourcePlan.tags(deploymentId)).toEqual({
    'agent-router-managed': 'opencode', 'agent-router-deployment': deploymentId,
  });
});

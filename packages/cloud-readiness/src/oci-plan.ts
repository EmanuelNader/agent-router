import { deploymentRequestSchema, inspectionSchema, type DeploymentRequest, type OciInspection, type MetricKey } from './oci-report.js';

/** Quota comparison only. Never a permission or price guarantee. */
export function previewOciDeployment(input: OciInspection, requested: DeploymentRequest, now = new Date()) {
  const report = inspectionSchema.parse(input);
  const request = deploymentRequestSchema.parse(requested);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid preview clock');
  const blockers: string[] = [...report.issues];
  const age = now.getTime() - Date.parse(report.observedAt);
  if (age > 15 * 60_000) blockers.push('STALE_EVIDENCE');
  if (age < 0) blockers.push('FUTURE_EVIDENCE');
  if (!report.homeRegion) blockers.push('HOME_REGION_UNKNOWN');
  if (!report.region || report.region !== report.homeRegion) blockers.push('REGION_NOT_HOME');
  if (!report.availabilityDomain) blockers.push('AD_NOT_SELECTED');
  const needed: [MetricKey, number][] = [
    ['a1RegionalOcpus', request.ocpus], ['a1RegionalMemoryGb', request.memoryGb],
    ['a1AdOcpus', request.ocpus], ['a1AdMemoryGb', request.memoryGb], ['freeStorageGb', request.bootGb],
  ];
  const checks = needed.map(([resource, perInstance]) => {
    const metric = report.metrics[resource]; const required = perInstance * request.additionalInstances;
    const available = metric.status === 'KNOWN' ? metric.available : null;
    const result = available === null ? 'UNKNOWN' : required > available ? 'INSUFFICIENT' : 'FITS';
    if (result !== 'FITS') blockers.push(`${result}_${resource}`);
    return { resource, required, available, result };
  });
  return {
    status: blockers.length ? 'BLOCKED' as const : 'QUOTA_FITS' as const,
    source: report.source, observedAt: report.observedAt, provisioningAllowed: false as const,
    candidate: { shape: 'VM.Standard.A1.Flex', architecture: 'arm64', region: report.region, availabilityDomain: report.availabilityDomain, ...request },
    checks, blockers: [...new Set(blockers)],
    unverified: ['ACCOUNT_BENEFITS_AND_MONTHLY_USAGE', 'DESTINATION_COMPARTMENT_QUOTA', 'PHYSICAL_CAPACITY', 'IMAGE_COMPATIBILITY_AND_SIZE', 'NETWORK_AND_STORAGE_COSTS', 'PROVISIONER_NOT_IMPLEMENTED'],
  };
}

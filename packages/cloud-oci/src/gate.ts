import { z } from 'zod';
import { previewOciDeployment } from '../../cloud-readiness/src/oci-plan.js';
import type { OciInspection } from '../../cloud-readiness/src/oci-report.js';
import { OciResourcePlan } from './plan.js';

export const eligibilitySchema = z.object({
  schemaVersion: z.literal(1),
  evidence: z.enum(['FIXTURE', 'RECORDED']),
  accountClass: z.enum(['ALWAYS_FREE', 'PAYG', 'TRIAL', 'UNKNOWN']),
  monthlyUsage: z.enum(['WITHIN_ALLOTMENT', 'EXCEEDS', 'UNKNOWN']),
  imageCharge: z.enum(['NONE', 'KNOWN_CHARGE', 'UNKNOWN']),
  networkCharge: z.enum(['NONE', 'KNOWN_CHARGE', 'UNKNOWN']),
  storageCharge: z.enum(['NONE', 'KNOWN_CHARGE', 'UNKNOWN']),
  capacity: z.enum(['AVAILABLE', 'UNKNOWN']),
  compartmentQuota: z.enum(['FITS', 'INSUFFICIENT', 'UNKNOWN']),
  observedAt: z.iso.datetime(),
});
export type FreeTierEligibility = z.infer<typeof eligibilitySchema>;

export interface DeploymentAuthorization {
  status: 'ALLOWED' | 'REFUSED';
  provisioningAllowed: boolean;
  blockers: string[];
  quotaStatus: 'QUOTA_FITS' | 'BLOCKED';
  source: 'OCI_API' | 'DEMO';
  evidence: 'FIXTURE' | 'RECORDED';
  region: string | null;
  availabilityDomain: string | null;
  profile: { shape: string; architecture: 'arm64'; ocpus: number; memoryGb: number; bootGb: number };
}

/** Quota fit is not enough. Known charges and unknown eligibility refuse the launch. */
export class OciFreeTierGate {
  static readonly request = {
    ocpus: OciResourcePlan.ocpus, memoryGb: OciResourcePlan.memoryGb,
    bootGb: OciResourcePlan.bootGb, additionalInstances: 1,
  } as const;

  static evaluate(input: {
    report: OciInspection; eligibility: unknown; mode: 'DRY_RUN' | 'LIVE'; now?: Date; allowPayg?: boolean;
  }): DeploymentAuthorization {
    const eligibility = eligibilitySchema.parse(input.eligibility);
    const now = input.now ?? new Date();
    const preview = previewOciDeployment(input.report, this.request, now);
    const blockers = [...preview.blockers];
    const eligibilityAge = now.getTime() - Date.parse(eligibility.observedAt);
    if (eligibilityAge > 15 * 60_000) blockers.push('STALE_ELIGIBILITY');
    if (eligibilityAge < 0) blockers.push('FUTURE_ELIGIBILITY');
    if (input.mode === 'LIVE' && preview.source !== 'OCI_API') blockers.push('DEMO_CANNOT_AUTHORIZE');
    if (eligibility.evidence === 'FIXTURE' && preview.source !== 'DEMO') blockers.push('FIXTURE_CANNOT_AUTHORIZE');
    if (input.mode === 'LIVE' && eligibility.evidence !== 'RECORDED') blockers.push('FIXTURE_CANNOT_AUTHORIZE');
    if (eligibility.accountClass === 'TRIAL') blockers.push('TRIAL_NOT_FREE_ONLY');
    if (eligibility.accountClass === 'PAYG' && input.allowPayg !== true) blockers.push('PAYG_REQUIRES_OPT_IN');
    if (eligibility.accountClass === 'UNKNOWN') blockers.push('UNCERTAIN_ACCOUNT');
    if (eligibility.monthlyUsage === 'EXCEEDS') blockers.push('USAGE_EXCEEDS_FREE_ALLOTMENT');
    if (eligibility.monthlyUsage === 'UNKNOWN') blockers.push('UNCERTAIN_USAGE');
    if (eligibility.imageCharge === 'KNOWN_CHARGE') blockers.push('KNOWN_IMAGE_CHARGE');
    if (eligibility.imageCharge === 'UNKNOWN') blockers.push('UNCERTAIN_IMAGE_CHARGE');
    if (eligibility.networkCharge === 'KNOWN_CHARGE') blockers.push('KNOWN_NETWORK_CHARGE');
    if (eligibility.networkCharge === 'UNKNOWN') blockers.push('UNCERTAIN_NETWORK_CHARGE');
    if (eligibility.storageCharge === 'KNOWN_CHARGE') blockers.push('KNOWN_STORAGE_CHARGE');
    if (eligibility.storageCharge === 'UNKNOWN') blockers.push('UNCERTAIN_STORAGE_CHARGE');
    if (eligibility.capacity !== 'AVAILABLE') blockers.push('UNCERTAIN_CAPACITY');
    if (eligibility.compartmentQuota === 'INSUFFICIENT') blockers.push('COMPARTMENT_QUOTA_INSUFFICIENT');
    if (eligibility.compartmentQuota === 'UNKNOWN') blockers.push('UNCERTAIN_COMPARTMENT_QUOTA');
    const unique = [...new Set(blockers)];
    return {
      status: unique.length ? 'REFUSED' : 'ALLOWED',
      provisioningAllowed: unique.length === 0,
      blockers: unique,
      quotaStatus: preview.status,
      source: preview.source,
      evidence: eligibility.evidence,
      region: preview.candidate.region,
      availabilityDomain: preview.candidate.availabilityDomain,
      profile: {
        shape: OciResourcePlan.shape, architecture: 'arm64',
        ocpus: OciResourcePlan.ocpus, memoryGb: OciResourcePlan.memoryGb, bootGb: OciResourcePlan.bootGb,
      },
    };
  }
}

import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const metricSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('KNOWN'), limit: count, used: count, available: count })
    .refine(value => value.available <= value.limit, 'Availability exceeds service limit'),
  z.object({ status: z.literal('UNKNOWN'), reason: z.enum([
    'NOT_INSPECTED', 'REQUEST_FAILED', 'VALUE_MISSING', 'AMBIGUOUS_LIMIT', 'INVALID_DATA', 'PAGINATION_INCOMPLETE',
  ]) }),
]);
export type Metric = z.infer<typeof metricSchema>;
export const metricKeys = ['a1RegionalOcpus', 'a1RegionalMemoryGb', 'a1AdOcpus', 'a1AdMemoryGb', 'microInstances', 'freeStorageGb'] as const;
export type MetricKey = typeof metricKeys[number];
export const regionSchema = z.string().regex(/^[a-z]{2,3}-[a-z0-9-]+-\d+$/);
export const inspectionSchema = z.object({
  schemaVersion: z.literal(1), source: z.enum(['OCI_API', 'DEMO']).nullable(), observedAt: z.iso.datetime(),
  homeRegion: regionSchema.nullable(), region: regionSchema.nullable(),
  availabilityDomain: z.string().regex(/^AD-\d+$/).nullable(),
  metrics: z.object({
    a1RegionalOcpus: metricSchema, a1RegionalMemoryGb: metricSchema,
    a1AdOcpus: metricSchema, a1AdMemoryGb: metricSchema,
    microInstances: metricSchema, freeStorageGb: metricSchema,
  }),
  issues: z.array(z.enum([
    'AUTH_OR_REGION_DISCOVERY_FAILED', 'HOME_REGION_UNKNOWN', 'REGION_NOT_HOME',
    'AD_DISCOVERY_FAILED', 'AD_SELECTION_REQUIRED', 'AD_NOT_FOUND',
  ])),
});
export type OciInspection = z.infer<typeof inspectionSchema>;

/** Initial supported free-compute profile; these are preview limits, not shape maxima. */
export const deploymentRequestSchema = z.object({
  ocpus: z.number().int().min(1).max(2), memoryGb: z.number().int().min(1).max(12),
  bootGb: z.number().int().min(50).max(200), additionalInstances: z.number().int().min(1).max(4),
}).refine(value => value.memoryGb >= value.ocpus, 'Request at least 1 GB memory per OCPU');
export type DeploymentRequest = z.infer<typeof deploymentRequestSchema>;

export class OciReport {
  static emptyInspection(): OciInspection {
    return {
      schemaVersion: 1, source: null, observedAt: new Date().toISOString(),
      homeRegion: null, region: null, availabilityDomain: null,
      metrics: Object.fromEntries(metricKeys.map(key => [key, { status: 'UNKNOWN', reason: 'NOT_INSPECTED' }])) as OciInspection['metrics'],
      issues: [],
    };
  }

  static readonly empty = OciReport.emptyInspection;
}

export const emptyInspection = OciReport.emptyInspection;

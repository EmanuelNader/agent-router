import { emptyInspection, metricSchema, regionSchema, type Metric, type MetricKey } from './oci-report.js';

export interface MetricQuery {
  serviceName: 'compute' | 'block-storage'; name: string; scope: 'REGION' | 'AD'; availabilityDomain?: string;
}
interface LimitValue { name?: string; scopeType?: string; availabilityDomain?: string; value?: number }
export interface OciReader {
  regions(): Promise<{ regionName: string; isHomeRegion: boolean; status: string }[]>;
  domains(): Promise<string[]>;
  selectRegion(region: string): void;
  values(query: MetricQuery, page?: string): Promise<{ items: LimitValue[]; nextPage?: string }>;
  availability(query: MetricQuery): Promise<{ used?: number; available?: number }>;
}

export async function readMetric(reader: OciReader, query: MetricQuery): Promise<Metric> {
  try {
    const matches: LimitValue[] = [];
    const seen = new Set<string>(); let page: string | undefined;
    do {
      const response = await reader.values(query, page);
      matches.push(...response.items.filter(item => item.name === query.name && item.scopeType === query.scope
        && item.availabilityDomain === query.availabilityDomain));
      page = response.nextPage || undefined;
      if (page && (seen.has(page) || seen.size >= 20)) return { status: 'UNKNOWN', reason: 'PAGINATION_INCOMPLETE' };
      if (page) seen.add(page);
    } while (page);
    if (matches.length !== 1) return { status: 'UNKNOWN', reason: matches.length ? 'AMBIGUOUS_LIMIT' : 'VALUE_MISSING' };
    const availability = await reader.availability(query);
    // Select fields explicitly: no upstream metadata or account identifiers survive.
    const parsed = metricSchema.safeParse({ status: 'KNOWN', limit: matches[0]!.value, used: availability.used, available: availability.available });
    return parsed.success ? parsed.data : { status: 'UNKNOWN', reason: 'INVALID_DATA' };
  } catch { return { status: 'UNKNOWN', reason: 'REQUEST_FAILED' }; }
}

export async function inspectOci(reader: OciReader, options: { region?: string; availabilityDomain?: string } = {}) {
  const result = emptyInspection();
  let regions: Awaited<ReturnType<OciReader['regions']>>;
  try { regions = await reader.regions(); }
  catch { result.issues.push('AUTH_OR_REGION_DISCOVERY_FAILED'); return result; }
  const homes = regions.filter(region => region.isHomeRegion && region.status === 'READY' && regionSchema.safeParse(region.regionName).success);
  if (homes.length !== 1) { result.issues.push('HOME_REGION_UNKNOWN'); return result; }
  result.homeRegion = homes[0]!.regionName;
  result.region = options.region ?? result.homeRegion;
  if (result.region !== result.homeRegion) { result.issues.push('REGION_NOT_HOME'); result.region = null; return result; }
  reader.selectRegion(result.homeRegion);
  let ad: string | undefined;
  try {
    const domains = await reader.domains();
    ad = options.availabilityDomain ?? (domains.length === 1 ? domains[0] : undefined);
    if (!ad) result.issues.push('AD_SELECTION_REQUIRED');
    else if (!domains.includes(ad) || !/AD-\d+$/.test(ad)) { result.issues.push('AD_NOT_FOUND'); ad = undefined; }
    else result.availabilityDomain = ad.match(/AD-\d+$/)![0];
  } catch { result.issues.push('AD_DISCOVERY_FAILED'); }
  const queries: [MetricKey, MetricQuery][] = [
    ['a1RegionalOcpus', { serviceName: 'compute', name: 'standard-a1-core-regional-count', scope: 'REGION' }],
    ['a1RegionalMemoryGb', { serviceName: 'compute', name: 'standard-a1-memory-regional-count', scope: 'REGION' }],
    ['freeStorageGb', { serviceName: 'block-storage', name: 'total-free-storage-gb-regional', scope: 'REGION' }],
  ];
  if (ad) queries.push(
    ['a1AdOcpus', { serviceName: 'compute', name: 'standard-a1-core-count', scope: 'AD', availabilityDomain: ad }],
    ['a1AdMemoryGb', { serviceName: 'compute', name: 'standard-a1-memory-count', scope: 'AD', availabilityDomain: ad }],
    ['microInstances', { serviceName: 'compute', name: 'standard-e2-micro-core-count', scope: 'AD', availabilityDomain: ad }],
  );
  const responses = await Promise.allSettled(queries.map(([, query]) => readMetric(reader, query)));
  responses.forEach((response, index) => {
    result.metrics[queries[index]![0]] = response.status === 'fulfilled' ? response.value : { status: 'UNKNOWN', reason: 'REQUEST_FAILED' };
  });
  // Timestamp is when collection began, so long-running calls cannot make old data look fresh.
  return result;
}

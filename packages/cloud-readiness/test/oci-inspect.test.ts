import { expect, test } from 'vitest';
import { inspectOci, readMetric, type OciReader, type MetricQuery } from '../src/oci-inspect.js';

const query: MetricQuery = { serviceName: 'compute', name: 'standard-a1-core-regional-count', scope: 'REGION' };
const value = { name: query.name, scopeType: 'REGION', value: 2 };
function reader(overrides: Partial<OciReader> = {}): OciReader {
  return {
    regions: async () => [{ regionName: 'us-example-1', isHomeRegion: true, status: 'READY' }],
    domains: async () => ['private-prefix:US-EXAMPLE-1-AD-1'],
    selectRegion: () => {},
    values: async input => ({ items: [{ name: input.name, scopeType: input.scope, value: 2, ...(input.availabilityDomain ? { availabilityDomain: input.availabilityDomain } : {}) }] }),
    availability: async () => ({ used: 0, available: 2 }),
    ...overrides,
  };
}

test('follows metric pagination and selects the exact limit scope', async () => {
  const pages: (string | undefined)[] = [];
  const source = reader({ values: async (_query, page) => {
    pages.push(page);
    return page ? { items: [value] } : { items: [{ ...value, scopeType: 'AD' }], nextPage: 'next' };
  } });
  expect(await readMetric(source, query)).toEqual({ status: 'KNOWN', limit: 2, used: 0, available: 2 });
  expect(pages).toEqual([undefined, 'next']);
});

test('denied, empty, ambiguous, looping, or unavailable responses stay unknown', async () => {
  const variants: Partial<OciReader>[] = [
    { values: async () => { throw new Error('sensitive upstream identity'); } },
    { values: async () => ({ items: [] }) },
    { values: async () => ({ items: [value, value] }) },
    { values: async () => ({ items: [], nextPage: 'loop' }) },
    { availability: async () => ({}) },
    { availability: async () => ({ used: 0, available: -1 }) },
    { availability: async () => ({ used: 0, available: 3 }) },
  ];
  for (const variant of variants) {
    const result = await readMetric(reader(variant), query);
    expect(result.status).toBe('UNKNOWN');
    expect(JSON.stringify(result)).not.toContain('sensitive');
  }
});

test('inspects the home region and exact AD while omitting identities from the receipt', async () => {
  const queries: MetricQuery[] = [];
  const source = reader({ availability: async input => { queries.push(input); return { used: 0, available: 2 }; } });
  const result = await inspectOci(source);
  expect(result.source).toBe('OCI_API');
  expect(result.homeRegion).toBe('us-example-1');
  expect(result.availabilityDomain).toBe('AD-1');
  expect(queries.filter(input => input.scope === 'REGION').every(input => !input.availabilityDomain)).toBe(true);
  expect(queries.filter(input => input.scope === 'AD').every(input => input.availabilityDomain === 'private-prefix:US-EXAMPLE-1-AD-1')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-prefix');
});

test('does not guess a home region or AD and rejects a different region', async () => {
  expect((await inspectOci(reader({ regions: async () => [] }))).issues).toContain('HOME_REGION_UNKNOWN');
  expect((await inspectOci(reader(), { region: 'other-region' })).issues).toContain('REGION_NOT_HOME');
  expect((await inspectOci(reader({ domains: async () => ['a:AD-1', 'b:AD-2'] }))).issues).toContain('AD_SELECTION_REQUIRED');
});

test('keeps unrelated successful metrics when one API request fails', async () => {
  const source = reader({ availability: async input => {
    if (input.serviceName === 'block-storage') throw new Error('raw private details');
    return { used: 0, available: 2 };
  } });
  const result = await inspectOci(source);
  expect(result.metrics.freeStorageGb.status).toBe('UNKNOWN');
  expect(result.metrics.a1AdOcpus.status).toBe('KNOWN');
  expect(JSON.stringify(result)).not.toContain('raw private');
});

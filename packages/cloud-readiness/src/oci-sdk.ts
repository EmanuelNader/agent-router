import { common, identity, limits } from 'oci-sdk';
import type { OciReader } from './oci-inspect.js';

/** Only read methods are exposed to the inspector. No credentials enter its report. */
export function createOciSdkReader(configPath: string, profile = 'DEFAULT') {
  const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
  const configuration: common.ClientConfiguration = {
    retryConfiguration: common.NoRetryConfigurationDetails,
    httpOptions: { signal: AbortSignal.timeout(30_000) },
  };
  const identities = new identity.IdentityClient({ authenticationDetailsProvider: auth }, configuration);
  const quotas = new limits.LimitsClient({ authenticationDetailsProvider: auth }, configuration);
  const tenancyId = auth.getTenantId();
  const reader: OciReader = {
    async regions() {
      const response = await identities.listRegionSubscriptions({ tenancyId });
      return response.items.map(({ regionName, isHomeRegion, status }) => ({ regionName, isHomeRegion, status }));
    },
    selectRegion(region) { identities.regionId = region; quotas.regionId = region; },
    async domains() {
      const response = await identities.listAvailabilityDomains({ compartmentId: tenancyId });
      // This operation has no page input. Do not interpret an incomplete response as a complete AD inventory.
      if (response.opcNextPage || response.items.some(item => !item.name)) throw new Error('Incomplete AD discovery');
      return response.items.map(item => item.name!);
    },
    async values(query, page) {
      const response = await quotas.listLimitValues({
        compartmentId: tenancyId, serviceName: query.serviceName, name: query.name,
        scopeType: query.scope === 'REGION' ? limits.requests.ListLimitValuesRequest.ScopeType.Region : limits.requests.ListLimitValuesRequest.ScopeType.Ad,
        ...(query.availabilityDomain ? { availabilityDomain: query.availabilityDomain } : {}),
        ...(page ? { page } : {}),
      });
      return { items: response.items, ...(response.opcNextPage ? { nextPage: response.opcNextPage } : {}) };
    },
    async availability(query) {
      const response = await quotas.getResourceAvailability({
        compartmentId: tenancyId, serviceName: query.serviceName, limitName: query.name,
        ...(query.availabilityDomain ? { availabilityDomain: query.availabilityDomain } : {}),
      });
      return response.resourceAvailability;
    },
  };
  return { reader, close() { identities.close(); quotas.close(); } };
}

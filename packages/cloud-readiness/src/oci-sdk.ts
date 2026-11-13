import { common, identity, limits } from 'oci-sdk';
import type { OciReader } from './oci-inspect.js';

export interface OciSdkOptions {
  profile?: string;
  timeoutMs?: number;
}

export class OciSdkReader {
  static readonly DEFAULT_PROFILE = 'DEFAULT';
  static readonly DEFAULT_TIMEOUT_MS = 30_000;

  /**
   * Only read methods are exposed to the inspector. No credentials enter its report.
   * Uses a configurable per-request timeout via an AbortSignal getter in client httpOptions.
   */
  static create(
    configPath: string,
    profileOrOptions: string | OciSdkOptions = OciSdkReader.DEFAULT_PROFILE,
    optionsOrTimeout?: { timeoutMs?: number } | number,
  ) {
    let profile = OciSdkReader.DEFAULT_PROFILE;
    let timeoutMs = OciSdkReader.DEFAULT_TIMEOUT_MS;

    if (typeof profileOrOptions === 'string') {
      profile = profileOrOptions;
      if (typeof optionsOrTimeout === 'number') {
        timeoutMs = optionsOrTimeout;
      } else if (optionsOrTimeout && typeof optionsOrTimeout.timeoutMs === 'number') {
        timeoutMs = optionsOrTimeout.timeoutMs;
      }
    } else if (profileOrOptions && typeof profileOrOptions === 'object') {
      if (profileOrOptions.profile) profile = profileOrOptions.profile;
      if (typeof profileOrOptions.timeoutMs === 'number') timeoutMs = profileOrOptions.timeoutMs;
      if (typeof optionsOrTimeout === 'number') timeoutMs = optionsOrTimeout;
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Timeout must be a positive number');
    }

    const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
    const configuration: common.ClientConfiguration = {
      retryConfiguration: common.NoRetryConfigurationDetails,
      httpOptions: {
        get signal() {
          return AbortSignal.timeout(timeoutMs);
        },
      },
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

  static readonly createOciSdkReader = OciSdkReader.create;
}

export const createOciSdkReader = OciSdkReader.create;

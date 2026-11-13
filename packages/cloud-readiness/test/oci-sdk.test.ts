import { describe, expect, test, vi, beforeEach } from 'vitest';
import { common, identity, limits } from 'oci-sdk';
import { OciSdkReader, createOciSdkReader } from '../src/oci-sdk.js';

vi.mock('oci-sdk', () => {
  let capturedIdentityConfig: common.ClientConfiguration | undefined;
  let capturedLimitsConfig: common.ClientConfiguration | undefined;

  const mockIdentityClient = vi.fn(function (_auth: any, config?: common.ClientConfiguration) {
    capturedIdentityConfig = config;
    return {
      regionId: 'us-phoenix-1',
      listRegionSubscriptions: vi.fn().mockResolvedValue({
        items: [{ regionName: 'us-phoenix-1', isHomeRegion: true, status: 'READY' }],
      }),
      listAvailabilityDomains: vi.fn().mockResolvedValue({
        items: [{ name: 'AD-1' }, { name: 'AD-2' }],
      }),
      close: vi.fn(),
    };
  });

  const mockLimitsClient = vi.fn(function (_auth: any, config?: common.ClientConfiguration) {
    capturedLimitsConfig = config;
    return {
      regionId: 'us-phoenix-1',
      listLimitValues: vi.fn().mockResolvedValue({
        items: [{ name: 'test-limit', value: 10 }],
        opcNextPage: undefined,
      }),
      getResourceAvailability: vi.fn().mockResolvedValue({
        resourceAvailability: { used: 1, available: 9 },
      }),
      close: vi.fn(),
    };
  });

  const mockAuthProvider = vi.fn(function (configPath: string, profile: string) {
    return {
      getTenantId: () => 'ocid1.tenancy.oc1..testtenancy',
      configPath,
      profile,
    };
  });

  return {
    common: {
      ConfigFileAuthenticationDetailsProvider: mockAuthProvider,
      NoRetryConfigurationDetails: { retryPolicy: 'NONE' },
    },
    identity: {
      IdentityClient: mockIdentityClient,
    },
    limits: {
      LimitsClient: mockLimitsClient,
      requests: {
        ListLimitValuesRequest: {
          ScopeType: { Region: 'REGION', Ad: 'AD' },
        },
      },
    },
    __getCapturedConfigs: () => ({ capturedIdentityConfig, capturedLimitsConfig }),
  };
});

describe('OciSdkReader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('configures default 30s timeout and DEFAULT profile when unspecified', () => {
    const { reader, close } = createOciSdkReader('/mock/path');
    expect(reader).toBeDefined();
    expect(common.ConfigFileAuthenticationDetailsProvider).toHaveBeenCalledWith('/mock/path', 'DEFAULT');

    // Verify through OciSdkReader.create as well
    const created = OciSdkReader.create('/mock/path');
    expect(created.reader).toBeDefined();
    created.close();
    close();
  });

  test('per-request timeout produces a fresh AbortSignal on each request option access', () => {
    let capturedConfig: common.ClientConfiguration | undefined;
    vi.mocked(identity.IdentityClient).mockImplementationOnce(function (_auth: any, config?: common.ClientConfiguration) {
      capturedConfig = config;
      return {
        regionId: 'us-phoenix-1',
        listRegionSubscriptions: vi.fn(),
        listAvailabilityDomains: vi.fn(),
        close: vi.fn(),
      } as any;
    });

    const connection = OciSdkReader.create('/mock/path', 'CUSTOM_PROFILE', 5_000);
    expect(common.ConfigFileAuthenticationDetailsProvider).toHaveBeenCalledWith('/mock/path', 'CUSTOM_PROFILE');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig?.retryConfiguration).toBe(common.NoRetryConfigurationDetails);

    const httpOptions = capturedConfig?.httpOptions;
    expect(httpOptions).toBeDefined();

    // Access signal multiple times (as FetchHttpClient send() does via Object.assign on each request)
    const signal1 = httpOptions?.signal;
    const signal2 = httpOptions?.signal;

    expect(signal1).toBeInstanceOf(AbortSignal);
    expect(signal2).toBeInstanceOf(AbortSignal);
    expect(signal1).not.toBe(signal2);

    connection.close();
  });

  test('supports options object with custom profile and timeoutMs', () => {
    let capturedConfig: common.ClientConfiguration | undefined;
    vi.mocked(identity.IdentityClient).mockImplementationOnce(function (_auth: any, config?: common.ClientConfiguration) {
      capturedConfig = config;
      return { regionId: 'us-phoenix-1', close: vi.fn() } as any;
    });

    const connection = OciSdkReader.create('/mock/path', { profile: 'OPS', timeoutMs: 15_000 });
    expect(common.ConfigFileAuthenticationDetailsProvider).toHaveBeenCalledWith('/mock/path', 'OPS');

    const signal = capturedConfig?.httpOptions?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    connection.close();
  });

  test('rejects non-positive or invalid timeout values', () => {
    expect(() => OciSdkReader.create('/mock/path', 'DEFAULT', 0)).toThrow('Timeout must be a positive number');
    expect(() => OciSdkReader.create('/mock/path', 'DEFAULT', -100)).toThrow('Timeout must be a positive number');
    expect(() => OciSdkReader.create('/mock/path', 'DEFAULT', Number.NaN)).toThrow('Timeout must be a positive number');
  });

  test('reader delegates methods to identity and limits clients and closes them', async () => {
    let identityInstance: any;
    let limitsInstance: any;

    vi.mocked(identity.IdentityClient).mockImplementationOnce(function (_auth: any, _config?: any) {
      identityInstance = {
        regionId: 'us-ashburn-1',
        listRegionSubscriptions: vi.fn().mockResolvedValue({
          items: [{ regionName: 'us-ashburn-1', isHomeRegion: true, status: 'READY' }],
        }),
        listAvailabilityDomains: vi.fn().mockResolvedValue({
          items: [{ name: 'AD-1' }],
        }),
        close: vi.fn(),
      };
      return identityInstance;
    });

    vi.mocked(limits.LimitsClient).mockImplementationOnce(function (_auth: any, _config?: any) {
      limitsInstance = {
        regionId: 'us-ashburn-1',
        listLimitValues: vi.fn().mockResolvedValue({
          items: [{ name: 'test-limit', scopeType: 'REGION', value: 5 }],
          opcNextPage: 'page2',
        }),
        getResourceAvailability: vi.fn().mockResolvedValue({
          resourceAvailability: { used: 2, available: 3 },
        }),
        close: vi.fn(),
      };
      return limitsInstance;
    });

    const { reader, close } = OciSdkReader.create('/mock/path');

    const regions = await reader.regions();
    expect(regions).toEqual([{ regionName: 'us-ashburn-1', isHomeRegion: true, status: 'READY' }]);
    expect(identityInstance.listRegionSubscriptions).toHaveBeenCalledWith({ tenancyId: 'ocid1.tenancy.oc1..testtenancy' });

    reader.selectRegion('us-phoenix-1');
    expect(identityInstance.regionId).toBe('us-phoenix-1');
    expect(limitsInstance.regionId).toBe('us-phoenix-1');

    const domains = await reader.domains();
    expect(domains).toEqual(['AD-1']);

    const values = await reader.values({ serviceName: 'compute', name: 'test-limit', scope: 'REGION' });
    expect(values).toEqual({
      items: [{ name: 'test-limit', scopeType: 'REGION', value: 5 }],
      nextPage: 'page2',
    });

    const avail = await reader.availability({ serviceName: 'compute', name: 'test-limit', scope: 'REGION' });
    expect(avail).toEqual({ used: 2, available: 3 });

    close();
    expect(identityInstance.close).toHaveBeenCalled();
    expect(limitsInstance.close).toHaveBeenCalled();
  });
});

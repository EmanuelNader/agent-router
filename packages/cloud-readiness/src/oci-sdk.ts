import { budget, common, identity, limits } from 'oci-sdk';
import type { OciGuardrailReader, SanitizedBudgetInput } from './oci-guardrails.js';
import type { OciReader } from './oci-inspect.js';

/** The SDK copies httpOptions into every fetch, so the getter gives each request its own deadline. */
export function perRequestTimeout(timeoutMs: number): { readonly signal: AbortSignal } {
  return { get signal() { return AbortSignal.timeout(timeoutMs); } };
}

/** Only read methods are exposed to the inspector. No credentials enter its report. */
export function createOciSdkReader(configPath: string, profile = 'DEFAULT') {
  const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
  const configuration: common.ClientConfiguration = {
    retryConfiguration: common.NoRetryConfigurationDetails,
    httpOptions: perRequestTimeout(30_000),
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

/** Read-only compartment-quota and budget-alert collector. Scrubs OCIDs and email recipients. */
export function createOciGuardrailSdkReader(
  configPath: string,
  targetCompartmentId: string,
  profile = 'DEFAULT',
) {
  if (!/^ocid1\.(?:compartment|tenancy)\.[a-z0-9]+\.\.[a-z0-9]+$/.test(targetCompartmentId)) {
    throw new Error('Invalid target compartment OCID');
  }
  const auth = new common.ConfigFileAuthenticationDetailsProvider(configPath, profile);
  const configuration: common.ClientConfiguration = {
    retryConfiguration: common.NoRetryConfigurationDetails,
    httpOptions: perRequestTimeout(30_000),
  };
  const quotas = new limits.QuotasClient({ authenticationDetailsProvider: auth }, configuration);
  const budgets = new budget.BudgetClient({ authenticationDetailsProvider: auth }, configuration);
  const tenancyId = auth.getTenantId();

  const reader: OciGuardrailReader = {
    async quotaStatements() {
      const statements: string[] = [];
      const seenPages = new Set<string>();
      let page: string | undefined;
      do {
        const listResponse = await quotas.listQuotas({
          compartmentId: tenancyId,
          ...(page ? { page } : {}),
        });
        for (const summary of listResponse.items) {
          if (!summary.id || (summary.lifecycleState && String(summary.lifecycleState) !== 'ACTIVE')) continue;
          const detail = await quotas.getQuota({ quotaId: summary.id });
          if (!detail.quota.lifecycleState || String(detail.quota.lifecycleState) === 'ACTIVE') {
            statements.push(...detail.quota.statements);
          }
        }
        page = listResponse.opcNextPage || undefined;
        if (page && (seenPages.has(page) || seenPages.size >= 20)) throw new Error('Incomplete quota pagination');
        if (page) seenPages.add(page);
      } while (page);
      return statements;
    },
    async budgets() {
      const collected: SanitizedBudgetInput[] = [];
      const seenPages = new Set<string>();
      let page: string | undefined;
      do {
        const response = await budgets.listBudgets({
          compartmentId: tenancyId,
          targetType: budget.requests.ListBudgetsRequest.TargetType.All,
          ...(page ? { page } : {}),
        });
        for (const item of response.items) {
          const targets = item.targets ?? [];
          const coversTarget =
            String(item.targetType ?? 'COMPARTMENT') === 'COMPARTMENT' &&
            (targets.includes(targetCompartmentId) || targets.includes(tenancyId));
          const ruleResponse = await budgets.listAlertRules({ budgetId: item.id });
          if (ruleResponse.opcNextPage) throw new Error('Incomplete alert-rule pagination');
          collected.push({
            lifecycleState: String(item.lifecycleState),
            resetPeriod: String(item.resetPeriod),
            amount: item.amount,
            coversTarget,
            alerts: ruleResponse.items.map(rule => ({
              lifecycleState: String(rule.lifecycleState),
              type: String(rule.type),
              thresholdType: String(rule.thresholdType),
              threshold: rule.threshold,
              hasRecipients: Boolean(rule.recipients && rule.recipients.trim().length > 0),
            })),
          });
        }
        page = response.opcNextPage || undefined;
        if (page && (seenPages.has(page) || seenPages.size >= 20)) throw new Error('Incomplete budget pagination');
        if (page) seenPages.add(page);
      } while (page);
      return collected;
    },
  };

  return {
    reader,
    close() {
      quotas.close();
      budgets.close();
    },
  };
}

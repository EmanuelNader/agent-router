import { z } from 'zod';
import {
  codespacesAllowanceSnapshotSchema,
  type CodespacesAllowanceSnapshot,
} from './codespaces-allowance.js';

const githubUsageItemSchema = z
  .object({
    product: z.string().min(1),
    sku: z.string().min(1),
    unitType: z.string().min(1),
    grossQuantity: z.number().nonnegative().optional(),
    quantity: z.number().nonnegative().optional(),
  })
  .refine(item => item.grossQuantity !== undefined || item.quantity !== undefined, {
    message: 'GitHub billing usageItem must contain grossQuantity or quantity',
  });

export const githubBillingUsagePayloadSchema = z.object({
  usageItems: z.array(githubUsageItemSchema),
});

const computeCoreMap: Record<string, 2 | 4 | 8 | 16 | 32> = {
  codespaces_compute_d2: 2,
  codespaces_compute_d4: 4,
  codespaces_compute_d8: 8,
  codespaces_compute_d16: 16,
  codespaces_compute_d32: 32,
  'codespaces compute (2-core)': 2,
  'codespaces compute (4-core)': 4,
  'codespaces compute (8-core)': 8,
  'codespaces compute (16-core)': 16,
  'codespaces compute (32-core)': 32,
  'codespaces linux 2-core': 2,
  'codespaces linux 4-core': 4,
  'codespaces linux 8-core': 8,
  'codespaces linux 16-core': 16,
  'codespaces linux 32-core': 32,
};

const storageSkus = new Set([
  'codespaces_storage',
  'codespaces_prebuild_storage',
  'codespaces storage',
  'codespaces prebuild storage',
]);

export interface ParseGitHubCodespacesBillingOptions {
  observedAt: string;
  activeMachineCores: 2 | 4 | 8 | 16 | 32;
  includedCoreHours?: number;
  includedStorageGbMonth?: number;
  hoursInBillingMonth?: number;
}

function sanitizeLabel(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._ ()-]/g, '').slice(0, 64);
}

/**
 * Parses GitHub's 2026 Consolidated Billing Usage API (`GET /users/{username}/settings/billing/usage`
 * and `/usage/summary`) into a sanitized `CodespacesAllowanceSnapshot`, stripping repository/org names
 * and failing closed on unrecognized Codespaces SKUs or units so billable usage is never under-counted.
 */
export function parseGitHubCodespacesBillingUsage(
  payload: unknown,
  options: ParseGitHubCodespacesBillingOptions,
): z.output<typeof codespacesAllowanceSnapshotSchema> {
  const parsed = githubBillingUsagePayloadSchema.parse(payload);
  const hoursInBillingMonth = options.hoursInBillingMonth ?? 720;
  if (!Number.isFinite(hoursInBillingMonth) || hoursInBillingMonth <= 0) {
    throw new Error('hoursInBillingMonth must be positive');
  }

  let usedCoreHours = 0;
  let usedStorageGbMonth = 0;

  for (const item of parsed.usageItems) {
    if (item.product.trim().toLowerCase() !== 'codespaces') {
      continue;
    }

    const qty = Math.max(item.grossQuantity ?? 0, item.quantity ?? 0);
    const normalizedSku = item.sku.trim().toLowerCase();
    const normalizedUnit = item.unitType.trim().toLowerCase();

    const cores = computeCoreMap[normalizedSku];
    if (cores !== undefined) {
      if (normalizedUnit === 'hours' || normalizedUnit === 'hour') {
        usedCoreHours += qty * cores;
      } else if (normalizedUnit === 'minutes' || normalizedUnit === 'minute') {
        usedCoreHours += (qty / 60) * cores;
      } else if (normalizedUnit === 'core-hours' || normalizedUnit === 'core_hours' || normalizedUnit === 'corehours') {
        usedCoreHours += qty;
      } else {
        throw new Error(
          `Unsupported unitType "${sanitizeLabel(item.unitType)}" for Codespaces compute SKU "${sanitizeLabel(item.sku)}"`,
        );
      }
      continue;
    }

    if (storageSkus.has(normalizedSku)) {
      if (
        normalizedUnit === 'gb-month' ||
        normalizedUnit === 'gb_month' ||
        normalizedUnit === 'gbmonth' ||
        normalizedUnit === 'gigabyte-month' ||
        normalizedUnit === 'gigabyte-months' ||
        normalizedUnit === 'gigabytemonths' ||
        normalizedUnit === 'gigabytes'
      ) {
        usedStorageGbMonth += qty;
      } else if (
        normalizedUnit === 'gigabyte-hours' ||
        normalizedUnit === 'gigabytehours' ||
        normalizedUnit === 'gb-hours' ||
        normalizedUnit === 'gb_hours' ||
        normalizedUnit === 'gbhours'
      ) {
        usedStorageGbMonth += qty / hoursInBillingMonth;
      } else {
        throw new Error(
          `Unsupported unitType "${sanitizeLabel(item.unitType)}" for Codespaces storage SKU "${sanitizeLabel(item.sku)}"`,
        );
      }
      continue;
    }

    throw new Error(`Unrecognized Codespaces billing SKU "${sanitizeLabel(item.sku)}"`);
  }

  const snapshotInput: CodespacesAllowanceSnapshot = {
    observedAt: options.observedAt,
    usedCoreHours: Number(usedCoreHours.toFixed(4)),
    usedStorageGbMonth: Number(usedStorageGbMonth.toFixed(4)),
    activeMachineCores: options.activeMachineCores,
    ...(options.includedCoreHours !== undefined ? { includedCoreHours: options.includedCoreHours } : {}),
    ...(options.includedStorageGbMonth !== undefined
      ? { includedStorageGbMonth: options.includedStorageGbMonth }
      : {}),
  };

  return codespacesAllowanceSnapshotSchema.parse(snapshotInput);
}

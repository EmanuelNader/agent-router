# OCI PAYG-safe guardrail verification evidence

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `oci-sdk 2.146.0`). This validates the read-only OCI Compartment Quota and Monthly Budget Alert verifier designed to protect Pay-As-You-Go tenancies operating strictly within Always Free limits; live OCI API calls remain untested until the local inspector public key is registered in the Oracle Console.

| Check | Observed result | Scope |
| --- | --- | --- |
| Compartment quota parser (`evaluateQuotaStatements`) | PASS | Requires ordered `Zero compute-core quotas` before bounded `standard-a1-core-count` (`<= 4`), `standard-a1-memory-count` (`<= 24`), and `total-storage-gb` (`<= 200`); rejects `unset`, paid compute quotas, and missing caps |
| Monthly budget alert verifier (`evaluateBudgetAlerts`) | PASS | Requires `ACTIVE` `MONTHLY` budget covering target/root compartment with an `ACTIVE` `ACTUAL` or `FORECAST` alert rule `<= $5` and configured recipients |
| Combined PAYG-safe preview (`pnpm guard:oci --demo`) | PASS (exit 0) | Returns `GUARDED_QUOTA_FITS` (`DEMO` provenance) with `provisioningAllowed: false` |
| Compartment cap & storage enforcement (`--additional-instances 2`) | PASS (exit 2) | Blocks requests exceeding compartment caps or remaining regional free storage |
| Error & PII sanitization | PASS | Strips OCIDs, budget recipient emails, and raw SDK error strings on failure |
| Live OCI `QuotasClient` / `BudgetClient` calls | UNTESTED LIVE | Official `oci-sdk` `2.146.0` declarations typechecked; live tenancy read pending Console key registration |

## Reproduce

```sh
pnpm check
pnpm guard:oci --demo
pnpm guard:oci --demo --ocpus 2 --additional-instances 2
```

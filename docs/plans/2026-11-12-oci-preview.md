# Oracle readiness and deployment preview

This implements the read-only OCI discovery slice of the existing readiness plan. The public product remains agent hosting with portable state; this slice establishes the information a future provisioner needs. No account/resource mutation or new credential is part of this work.

## Design

Use the installed official OCI TypeScript SDK to discover the home region and availability domains, then inspect precise regional and AD resource limits through ListLimitValues and GetResourceAvailability. Query the tenancy root for allowance usage; a future destination compartment must also be checked before launch. Keep account OCIDs, keys, raw responses, and upstream errors out of receipts.

An explicit local API config is required for live inspection. If multiple ADs exist, require a selection instead of silently choosing an arbitrary one. Use the known metric names observed in the Console, retain the requested scope, follow pagination, and treat missing/ambiguous/denied/invalid data as UNKNOWN. Never turn missing usage into zero. The report identifies live API versus demo data and records its observation time.

A separate pure planner compares a requested A1 deployment with regional CPU/memory, AD CPU/memory, and remaining free storage. An optional count represents additional instances beyond those already included in current usage. Reject stale/future reports, non-home-region requests, incomplete evidence, and invalid resource requests. QUOTA_FITS is only a quota comparison: provisioningAllowed always remains false because entitlements/monthly use, physical capacity, image size/compatibility, network/storage costs, and actual provisioning remain unverified.

## Files and validation

- [x] Add `packages/cloud-readiness/src/oci-report.ts`: report/request schemas and whitelist-only metric normalization. Validate nonnegative safe integer limit/usage/availability, not arithmetic assumptions about compartment quotas.
- [x] Add `packages/cloud-readiness/src/oci-inspect.ts`: typed read-only reader boundary, paginated metric discovery, home-region/AD resolution, and sanitized partial reports. Test wrong scopes, duplicates, permission failures, missing usage, pagination, multi-AD selection, and region mismatch.
- [x] Add `packages/cloud-readiness/src/oci-sdk.ts`: adapt official IdentityClient/LimitsClient methods; use region scope without AD and AD scope with exact AD. No launch/update/delete methods. Close clients after use.
- [x] Add `packages/cloud-readiness/src/oci-plan.ts`: `previewOciDeployment(report, request, now)` returning whitelisted candidate details, individual checks, blockers, unresolved gates, and provisioningAllowed false. Test insufficient storage including retained volumes, regional and AD bounds, additional-instance multiplication, staleness/future timestamps, and demo provenance.
- [x] Extend `scripts/inspect-oci.ts`; add `scripts/plan-oci.ts`, `fixtures/oci/readiness-demo.json`, and `plan:oci`. Live calls are separately invoked; the demo never accesses credentials or clouds.
- [x] Update README, current evidence, and CI with a deterministic demo smoke check. Run `pnpm check`, the demo, help/missing-config paths, and `git diff --check`. Review before publishing.

## Current observations and remaining evidence

The browser inspection before the user's reported instance deletion showed a Free Tier account, a home region, two occupied micro slots, unused A1 quota, and retained storage usage. These are historical console observations, not live API fixtures or launch authorization. Deletion must be followed by refreshed compute and storage reads; the boot disk can be retained independently. The standard local OCI config file is absent. Therefore live SDK calls and creation remain untested.

Sources: [Oracle Limits API](https://docs.oracle.com/en-us/iaas/tools/typescript/latest/classes/_limits_lib_client_.limitsclient.html), [viewing limits and usage](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/view-tenancy.htm), [required Limits permissions](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/overview.htm), and [boot-volume retention](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/bootvolumes.htm). Match implementation signatures to installed `oci-sdk` 2.146.0 declarations.

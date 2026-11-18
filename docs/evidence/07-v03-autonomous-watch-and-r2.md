# Evidence 07: `v0.3.0` Autonomous Allowance Watch Loop, Codespaces SSH `-F` Bridge, GitHub 2026 Billing Parser, and Cloudflare R2 Free-Tier Guardrails

- **Date observed:** November 17, 2026
- **CLI version:** `0.3.0` (`bin/agent-router.mjs`)
- **Verification commands:** `pnpm build && pnpm check && pnpm e2e`

## Observed local & container verification (`VERIFIED`)

1. **Autonomous allowance watch loop (`packages/cli/src/watch.ts`, `scripts/e2e.ts`):**
   - `runAllowanceWatchLoop` checks `OperationJournal.listBlocking()` before every tick (`BLOCKED_BY_JOURNAL`), rejects missing/stale (`> 15m`) or malformed allowance payloads (`BLOCKED_BY_EVIDENCE`), stays passive on `HEALTHY` ticks (tick 1 in `pnpm e2e`), and automatically invokes `migrateWorkspace` on tick 2 (`MIGRATE_NOW`)—fencing the active `OpenCode 2.2.7` source server before activating `hetzner-cax11-fallback` (`maxConcurrentAgents: 1`, `watchOutcome: "EVACUATED"`, `watchTicksRun: 2`).
2. **GitHub 2026 Consolidated Billing Usage API parser (`packages/cloud-readiness/src/github-billing-api.ts`):**
   - Parses `usageItems[]` across `codespaces_compute_d2`..`d32`, `codespaces_storage`, and `codespaces_prebuild_storage` (`hours`, `minutes`, `core-hours`, `gb-month`, `GigabyteHours`), strips `repositoryName` / org identifiers, and fails closed on unrecognized Codespaces SKUs or units so billable usage is never under-counted.
3. **Isolated GitHub Codespaces OpenSSH `-F` bridge (`packages/host-ssh/src/codespaces-ssh.ts`):**
   - Generates `0600` isolated `ssh_config` and TOFU `known_hosts` (`StrictHostKeyChecking=accept-new`) without mutating `~/.ssh/config`, expands/validates `~/.ssh/codespaces.auto` (`cli/cli#9817`), rejects `/dev/*` `known_hosts` paths, and blocks `ProxyCommand` / `IdentityFile` shell or `%`-token injection.
4. **Cloudflare R2 2026 Free-Tier guardrails & journal-protected checkpoint pruning (`packages/cloud-readiness/src/r2-free-tier.ts`, `packages/snapshots/src/prune.ts`):**
   - Enforces explicit `publicDevelopmentUrlEnabled: false`, `STANDARD` storage class (blocking zero-free-tier `INFREQUENT_ACCESS`), and 85% buffers below `10 GB`, `1M` Class A ops, and `10M` Class B ops (`r2:guard`).
   - `pruneLocalCheckpoints` (`prune`) keeps the newest `keepLast` encrypted containers while preserving any `chk_*` ID referenced in `PENDING` or `NEEDS_RECONCILE` journal records.
5. **Rootless daemon templates (`packages/cli/src/service-units.ts`):**
   - `service:emit --platform systemd|launchd` emits hardened user units (`UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, isolated `HOME=<workDir>/isolated-home`, rejecting personal `$HOME`).

## Boundaries still requiring opt-in live credentials (`UNTESTED LIVE`)

- Live OCI API (`inspect:oci`, `guard:oci`, `oci:*`), live AWS STS/FreeTier (`inspect:aws`), live Hetzner Cloud API (`hetzner:*`), live `gh codespace ssh` against an active remote Codespace, and live Cloudflare R2 / OCI S3 bucket credentials remain opt-in operator checks outside automated local CI.

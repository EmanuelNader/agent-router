# Agent Router: execution plan (local-first BYOC CLI & portable checkpoints)

> For agentic workers: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute the active milestone task by task. Each milestone has explicit evidence gates; unverified cloud or agent API behavior must never be replaced with invented assumptions.

**Goal:** A developer runs a local-first CLI to inspect and provision safe, low-cost or $0-guarded compute in their own accounts (`OCI Always Free / PAYG-safe`, `SSH` / `Hetzner`, `AWS Free Plan`), run an isolated coding agent, and checkpoint or migrate unfinished workspaces + settled conversations cleanly across `laptop ↔ VPS ↔ cloud`.

**Architecture (updated November 17, 2026):** Rather than operating a multi-tenant hosted SaaS control plane (`Next.js`, `Fastify`, `PostgreSQL`, `DBOS`, and a custom `frp`/`Caddy` proxy), Agent Router is a **serverless, client-only TypeScript CLI and library** (see [2026-11-17-market-and-architecture-reassessment.md](../research/2026-11-17-market-and-architecture-reassessment.md)). A local atomic operation journal and persisted provider retry tokens (`opcRetryToken` / `ClientToken`) guarantee crash-recoverable idempotency. Encrypted `restic` snapshots and versioned manifests live in user-owned storage (local repository, OCI 20 GB Always Free Object Storage, Cloudflare R2, or S3). Remote client access uses Tailscale or OpenCode's built-in blind TLS relay (`opencode pair --remote` via [OpenTunnel](https://github.com/anomalyco/opentunnel)).

**Stack:** TypeScript; Node 24; `pnpm@11.25.0`; `zod`; `vitest`; pinned `@opencode/cli@2.2.7`; official OCI and AWS SDKs; SSH/cloud-init/systemd; `restic`; Tailscale or OpenCode `OpenTunnel`.

**Status on November 17, 2026:** All local engineering slices across **Milestones 0–4** are implemented and verified end-to-end against real local daemons (`pnpm check` + `pnpm e2e`): readiness & PAYG guardrails ([00-readiness.md](../evidence/00-readiness.md), [00-oci-guardrails.md](../evidence/00-oci-guardrails.md)), Milestone 1 encrypted local + remote-backend checkpoint/restore ([01-local-restore.md](../evidence/01-local-restore.md)), Milestone 2 fenced SSH handoff over real `OpenSSH` `sshd` / `ssh` / `scp` + `restic sftp://` ([02-ssh-handoff.md](../evidence/02-ssh-handoff.md)), Milestone 3 guarded OCI `VM.Standard.A1.Flex` + Hetzner `CAX11` ARM64 lifecycle adapters & unified `pnpm router` CLI ([03-oci-lifecycle.md](../evidence/03-oci-lifecycle.md)), and Milestone 4 AWS Free Plan credit/expiry-triggered cross-host `migrateWorkspace` ([04-cross-host-migration.md](../evidence/04-cross-host-migration.md)). Opt-in live external cloud account runs remain gated on user-owned credentials.

## Global constraints across every milestone

- **Initial workload:** Pinned `@opencode/cli` `2.2.7`. Additional CLIs (Claude Code, Codex CLI, OpenClaw) require separate adapters and real round-trip compatibility tests before claiming support.
- **User-owned accounts and credentials:** No multi-tenant hosted proxy for consumer AI subscriptions (respecting November 2026 provider Terms of Service), no personal `$HOME` copies, and no cloud-management credentials exposed inside the coding agent's environment.
- **Fail-closed free / budget guardrails:** Missing, stale (>15 minutes), or ambiguous entitlement, quota, storage, or cost evidence blocks automatic free-only provisioning. On OCI Pay-As-You-Go accounts, staying $0 requires verifying Always Free headroom, retained boot/block volumes, compartment quotas, and budget alert rules before launch.
- **Explicit migration boundary:** Planned handoffs preserve a quiesced workspace (tracked, modified, renamed, hidden, and untracked files plus Git state) and supported settled session history. Arbitrary live processes, open sockets, unexported pending inbox prompts, and in-flight external side effects are outside the promise; pending prompts must be drained or explicitly blocked before checkpointing.
- **Single active writer:** Never start a destination agent until the source agent is stopped or demonstrably fenced.
- **Recoverable mutations:** Persist immutable operation receipts and provider idempotency tokens locally before issuing any create/delete call, and reconcile inventory before retrying an interrupted run.
- **Evidence discipline:** Research and plans describe intended work; `docs/evidence/` records only observed results with secrets and account identifiers scrubbed.

## Repository boundaries

| Path | Owns |
| --- | --- |
| `packages/workspace/` | Deterministic file-content and executable-bit receipts (*implemented*) |
| `packages/agent-opencode/` | Pinned OpenCode `2.2.7` isolated server, v2 HTTP client, settled-history checks, quiescing, and export/import (*initial slice implemented*) |
| `packages/cloud-readiness/` | Read-only OCI/AWS inspection, local OCI key/config setup, pure A1 quota previews, and PAYG-safe guardrail checks (*implemented — Milestone 0*) |
| `packages/snapshots/` | Versioned checkpoint manifests, quiesced session + workspace capture, AES-256-GCM / `restic` encryption, and remote SFTP/OCI-S3/R2/AWS-S3 backend builders (*implemented — Milestones 1–2*) |
| `packages/host-ssh/` | Hardened OpenSSH/SCP argv builders, live `SshCliTransport`, loopback spool, and fenced cross-host workspace + session handoffs (`handoffWorkspace`) (*implemented — Milestone 2*) |
| `packages/cloud-oci/` | Locked-down `#cloud-config` renderer (SHA-256 verified Node 24), PAYG-guarded `VM.Standard.A1.Flex` provisioner, crash reconciliation, fencing, and zero-remnant teardown (*implemented — Milestone 3*) |
| `packages/cloud-hetzner/` | Zero-inbound firewall-checked Hetzner Cloud `CAX11` ARM64 fallback provisioner (`location`, IPv6-only default, label crash reconciliation, zero-remnant teardown) (*implemented — Milestone 4*) |
| `packages/cli/` | Atomic local operation journal (`OperationJournal`), allowance-aware `migrateWorkspace`, and unified `pnpm router` CLI (*implemented — Milestones 3–4*) |
| `scripts/` | Reproducible verification and inspection entrypoints (*implemented*) |
| `docs/evidence/` | Sanitized compatibility results and milestone gate receipts |

Provider adapters consume an explicit local credential configuration and persisted operation ID; they return entitlement/quota observations, candidate/resource IDs, fencing receipts, and cleanup verifications. Agent adapters consume a workspace path, isolated state directory, and pinned binary; they return health, pending-inbox status, session exports, and restore verifications.

---

## Milestone 0: prove access, compatibility, and OCI guardrails *(in progress)*

Detailed in [agent-router-first-milestone.md](./agent-router-first-milestone.md), [2026-11-12-oci-preview.md](./2026-11-12-oci-preview.md), and [2026-11-12-oci-connection.md](./2026-11-12-oci-connection.md).

- [x] Pin Node 24, `pnpm@11.25.0`, `@opencode/cli@2.2.7`, and official OCI/AWS SDKs with a frozen lockfile and CI checks.
- [x] Prove isolated loopback OpenCode authentication, ancestor config exclusion, and fresh-state session + workspace round-trip without model credentials.
- [x] Implement read-only OCI home-region/AD/A1/free-storage inspection, local RSA key preparation, and conservative deployment previews.
- [ ] Complete dedicated read-only `agent-router-inspector` registration in the Oracle Console and record live `pnpm inspect:oci` + `pnpm plan:oci` behavior (including whether Free Tier vs. PAYG capacity applies).
- [x] Add PAYG-safe guardrail inspection checks (compartment quota ceiling and budget alert presence) so PAYG tenancies can unlock A1 capacity without silent paid overages ([00-oci-guardrails.md](../evidence/00-oci-guardrails.md)).
- [ ] Verify supported model authentication and conversational recall across an OpenCode export/import round-trip without copying `$HOME`.

**Gate:** Sanitized live inspection evidence and model-recall compatibility are recorded in `docs/evidence/00-readiness.md`. Unknown or missing cloud evidence continues to block provisioning.

## Milestone 1: prove local encrypted checkpoint and restore *(completed locally)*

Detailed in [2026-11-17-local-checkpoint-restore.md](./2026-11-17-local-checkpoint-restore.md) and verified in [01-local-restore.md](../evidence/01-local-restore.md).

Files: `packages/snapshots/src/manifest.ts`, `packages/snapshots/src/store.ts`, `packages/snapshots/src/restic.ts`, `packages/snapshots/src/checkpoint.ts`, `packages/snapshots/test/*.test.ts`, `scripts/checkpoint-roundtrip.ts`, `docs/evidence/01-local-restore.md`.

- [x] Define a versioned Zod checkpoint manifest (`schemaVersion`, `checkpointId`, `createdAt`, `architecture`, `opencodeVersion`, `sessionIds`, `workspaceFiles`, `git`).
- [x] Quiesce/stop the source OpenCode server after exporting settled sessions and rejecting unfinished shell turns.
- [x] Capture an encrypted snapshot (`LocalEncryptedStore` AES-256-GCM and `ResticRepositoryStore` `restic`) of the staged workspace + session bundle.
- [x] Restore into a fresh directory and fresh isolated OpenCode state, verifying files and Git state before starting the target server.
- [x] Reject wrong-version, tampered, incomplete, or mismatched-hash checkpoints before starting the target agent.
- [x] Record measured capture/restore behavior in `docs/evidence/01-local-restore.md`.

**Gate:** Restored workspace hashes, Git working tree, session ID, and settled history match the pre-checkpoint receipt, and tampered archives fail closed.

## Milestone 2: prove `laptop ↔ SSH/VPS` handoff with native connectivity *(core & transports implemented locally)*

Files: `packages/host-ssh/src/`, `packages/snapshots/src/restic.ts`, `packages/cli/src/`, `scripts/ssh-handoff-roundtrip.ts`, `docs/evidence/02-ssh-handoff.md`.

- [x] Define non-root locked-down worker bootstrap (`renderWorkerCloudInit`) and hardened `SshCliTransport` / OpenSSH argv builders (`BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=15`, `--`).
- [x] Fence/stop the source OpenCode instance before activating the destination so two generations never act concurrently (`maxConcurrentAgents: 1` verified in `handoff:roundtrip`).
- [x] Implement encrypted remote `restic` backend builders (SFTP, OCI S3-compatible Object Storage, Cloudflare R2, AWS S3) with `0600` credential files, plus two-hop `laptop → VPS → laptop` checkpoint handoff.
- [ ] Run opt-in live network SSH host verification over Tailscale and OpenCode's native `opencode pair --remote` (`OpenTunnel`).

**Gate:** Uncommitted work and OpenCode session history move cleanly `laptop → SSH host → laptop` with a single active writer and zero leaked credentials.

## Milestone 3: prove guarded BYOC provisioning, crash reconciliation, and cleanup *(implemented & fault-injection verified locally)*

Files: `packages/cloud-oci/src/`, `packages/cli/src/journal.ts`, `packages/cli/src/cli.ts`, `scripts/router.ts`, `docs/evidence/03-oci-lifecycle.md`.

- [x] Persist an atomic local operation journal entry and `opcRetryToken` before every cloud mutation; test post-create crash + expired retry token with fault injection to prove zero duplicate VMs (`launchCount: 1`).
- [x] Enforce fail-closed pre-flight gates: `OCI_API` provenance, home-region match, fresh (<15m) quota/storage report, zero-inbound subnet security rules (`ingressRuleCount === 0`), and verified compartment quota + active `<= $5` budget alert tripwire.
- [x] Implement `VM.Standard.A1.Flex` provisioner (`bootVolumeVpusPerGB: 10`, `assignPublicIp: false`) using locked-down `#cloud-config` without embedding cloud keys on the VM, plus `OutOfHostCapacity` clean fallback.
- [x] Implement `fence` (`SOFTSTOP` → `STOPPED`) and leak-checked `teardown` (`preserveBootVolume: false`, `preserveDataVolumesCreatedAtLaunch: false`, plus compartment remnant audit); run opt-in live compartment smoke test once Console credentials are registered.

**Gate:** Interrupted operations reconcile cleanly without duplicate resources, and teardown leaves zero billable or quota-consuming remnants in `inspect:oci`.

## Milestone 4: prove cross-host exit and allowance-aware migration *(implemented & verified via `pnpm e2e`)*

Files: `packages/cli/src/migrate.ts`, `packages/cloud-readiness/src/aws-allowance.ts`, `packages/cloud-hetzner/src/provider.ts`, `scripts/e2e.ts`, `docs/evidence/04-cross-host-migration.md`.

- [x] Combine Milestone 1 checkpoints, Milestone 2 live `SshCliTransport` / `restic sftp://`, and Milestone 3 cloud provisioners into `migrateWorkspace` + `pnpm e2e`.
- [x] Trigger automatic migration from an expiring or low-credit AWS Free Plan host (`evaluateAwsFreePlanAllowance`) across ordered targets (`OCI A1` → `Hetzner CAX11 ARM64` → `SSH / laptop`), fencing source compute before enabling the target and verifying source cleanup.
- [x] Verify failure modes via TDD: interrupted transfer (`NEEDS_RECONCILE`), corrupt snapshot (aborts before tearing down source compute), target `OUT_OF_CAPACITY` (`Out of host capacity` skips to fallback or keeps source intact), and stale allowance telemetry.

**Gate:** Cross-host migration preserves all acknowledged saved work and settled sessions, never leaves two active agents running, and safely aborts without data loss when destination capacity or free headroom is unavailable.

---

## Risk register

| Uncertainty | Proof milestone | Fallback if blocked |
| --- | --- | --- |
| Un-upgraded OCI Free Tier has zero A1 capacity in user's home region | Milestone 0 live `inspect:oci` + launch test | Use OCI PAYG-safe mode (compartment quota + budget tripwire) or commodity SSH/Hetzner host (`~$4.50–$6.49/mo`) |
| OpenCode `2.2.7` drops pending prompts or drifts `opencode.db` paths across hosts | Milestones 0–1 | Quiesce + block/drain pending inbox prior to export; import into fresh isolated `XDG_*` state bound to target directory |
| Local CLI crashes mid-provisioning and orphans a cloud VM or 50 GB boot volume | Milestone 3 fault-injection test | Reconcile persisted operation journal + tags + `opcRetryToken` before new mutations; verify storage quota after delete |
| Model provider ToS restricts consumer OAuth routing | Architectural invariant (Nov 17, 2026) | Keep Agent Router strictly local-first/BYOC; never proxy or pool user model credentials through a hosted service |

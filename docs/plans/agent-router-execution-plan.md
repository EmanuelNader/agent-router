# Agent Router: execution plan (local-first BYOC CLI & portable checkpoints)

> For agentic workers: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute the active milestone task by task. Each milestone has explicit evidence gates; unverified cloud or agent API behavior must never be replaced with invented assumptions.

**Goal:** A developer runs a local-first CLI to inspect and provision safe, low-cost or $0-guarded compute in their own accounts (`OCI Always Free / PAYG-safe`, `SSH` / `Hetzner`, `AWS Free Plan`), run an isolated coding agent, and checkpoint or migrate unfinished workspaces + settled conversations cleanly across `laptop ↔ VPS ↔ cloud`.

**Architecture (updated November 17, 2026):** Rather than operating a multi-tenant hosted SaaS control plane (`Next.js`, `Fastify`, `PostgreSQL`, `DBOS`, and a custom `frp`/`Caddy` proxy), Agent Router is a **serverless, client-only TypeScript CLI and library** (see [2026-11-17-market-and-architecture-reassessment.md](../research/2026-11-17-market-and-architecture-reassessment.md)). A local atomic operation journal and persisted provider retry tokens (`opcRetryToken` / `ClientToken`) guarantee crash-recoverable idempotency. Encrypted `restic` snapshots and versioned manifests live in user-owned storage (local repository, OCI 20 GB Always Free Object Storage, Cloudflare R2, or S3). Remote client access uses Tailscale or OpenCode's built-in blind TLS relay (`opencode pair --remote` via [OpenTunnel](https://github.com/anomalyco/opentunnel)).

**Stack:** TypeScript; Node 24; `pnpm@11.25.0`; `zod`; `vitest`; pinned `@opencode/cli@2.2.7`; official OCI and AWS SDKs; SSH/cloud-init/systemd; `restic`; Tailscale or OpenCode `OpenTunnel`.

**Status on November 17, 2026:** The initial readiness and OCI preview slice is implemented and recorded in [00-readiness.md](../evidence/00-readiness.md): isolated OpenCode `2.2.7` portability, deterministic workspace hashing, local OCI inspector credential setup, read-only OCI/AWS inspection, and pure OCI A1 quota previews. Live cloud API verification, OCI PAYG-safe budget/quota guardrails, encrypted `restic` checkpoints, SSH/VPS handoffs, and VM provisioning remain open.

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
| `packages/cloud-readiness/` | Read-only OCI/AWS inspection, local OCI key/config setup, pure A1 quota previews, and PAYG-safe guardrail checks (*initial slice implemented*) |
| `packages/snapshots/` | Versioned checkpoint manifests, quiesced session + workspace capture, `restic` encryption, and verified restore (*planned — Milestone 1*) |
| `packages/host-ssh/` | Restricted remote lifecycle commands, fencing, and workspace/checkpoint transfer over SSH/Tailscale (*planned — Milestone 2*) |
| `packages/cloud-oci/` | Idempotent OCI VM/network/volume provisioning, reconciliation, fencing, and leak-free cleanup (*planned — Milestone 3*) |
| `packages/cli/` | Unified `agent-router` CLI commands wrapping the local operation journal (*planned — Milestones 1–3*) |
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
- [ ] Add PAYG-safe guardrail inspection checks (compartment quota ceiling and budget alert presence) so PAYG tenancies can unlock A1 capacity without silent paid overages.
- [ ] Verify supported model authentication and conversational recall across an OpenCode export/import round-trip without copying `$HOME`.

**Gate:** Sanitized live inspection evidence and model-recall compatibility are recorded in `docs/evidence/00-readiness.md`. Unknown or missing cloud evidence continues to block provisioning.

## Milestone 1: prove local encrypted checkpoint and restore *(next code slice)*

Detailed in [2026-11-17-local-checkpoint-restore.md](./2026-11-17-local-checkpoint-restore.md).

Files: `packages/snapshots/src/manifest.ts`, `packages/snapshots/src/restic.ts`, `packages/snapshots/src/checkpoint.ts`, `packages/snapshots/test/*.test.ts`, `scripts/checkpoint-roundtrip.ts`, `docs/evidence/01-local-restore.md`.

- [ ] Define a versioned Zod checkpoint manifest (`schemaVersion`, `checkpointId`, `createdAt`, `architecture`, `opencodeVersion`, `sessionIds`, `workspaceFiles`, `gitHead`, `gitStatusPorcelain`, `resticSnapshotId`).
- [ ] Quiesce/stop the source OpenCode server after exporting settled sessions and verifying no silent loss of unfinished state.
- [ ] Capture an encrypted `restic` snapshot of the staged workspace + session bundle into an isolated local repository (compatible with S3/R2/OCI Object Storage backends).
- [ ] Restore into a fresh directory and fresh isolated OpenCode state, rebinding the session directory cleanly without `opencode.db` path drift.
- [ ] Reject wrong-version, tampered, incomplete, or mismatched-hash checkpoints before starting the target agent.
- [ ] Record measured capture/restore behavior in `docs/evidence/01-local-restore.md`.

**Gate:** Restored workspace hashes, Git working tree, session ID, and settled history match the pre-checkpoint receipt, and tampered archives fail closed.

## Milestone 2: prove `laptop ↔ SSH/VPS` handoff with native connectivity

Files: `packages/host-ssh/src/`, `packages/cli/src/`, `tests/scenarios/ssh-handoff.test.ts`, `docs/evidence/02-ssh-handoff.md`.

- [ ] Bootstrap or verify an isolated non-root agent user and pinned OpenCode `2.2.7` runtime on any SSH target (local Linux VM/container in CI, Hetzner/OCI/VPS in live tests).
- [ ] Fence/stop the source OpenCode instance before activating the destination so two generations never act concurrently.
- [ ] Push a verified Milestone 1 checkpoint via encrypted object storage or direct SSH `restic` repo, restore on the remote host, and pull work back (`laptop → VPS → laptop`).
- [ ] Verify private remote client access via Tailscale (`--hostname` bound to tailnet IP or `ssh -L`) and OpenCode's native `opencode pair --remote` (`OpenTunnel`), without opening unauthenticated public ports.

**Gate:** Uncommitted work and OpenCode session history move cleanly `laptop → SSH host → laptop` with a single active writer and zero leaked credentials.

## Milestone 3: prove guarded BYOC provisioning, crash reconciliation, and cleanup

Files: `packages/cloud-oci/src/`, local operation journal in `packages/cli/src/journal.ts`, `infra/bootstrap/`, `docs/evidence/03-oci-lifecycle.md`.

- [ ] Persist an atomic local operation journal entry and `opcRetryToken` before every cloud mutation; test process kill/restart mid-create with a fake provider to prove zero duplicate VMs.
- [ ] Enforce fail-closed pre-flight gates: home-region match, fresh (<15m) quota/storage report, retained boot-volume accounting, and (on PAYG accounts) verified compartment quota + active budget alert tripwire.
- [ ] Provision one `VM.Standard.A1.Flex` host in a dedicated compartment using cloud-init without embedding long-lived cloud keys on the VM.
- [ ] Fence/stop the instance and perform complete teardown; verify zero orphaned boot volumes, block volumes, VNICs, or public IPs remain.

**Gate:** Interrupted operations reconcile cleanly without duplicate resources, and teardown leaves zero billable or quota-consuming remnants in `inspect:oci`.

## Milestone 4: prove cross-host exit and allowance-aware migration

Files: `packages/cli/src/migrate.ts`, optional secondary provider adapter (`Hetzner` or `AWS Free Plan`), `docs/evidence/04-cross-host-migration.md`.

- [ ] Combine Milestone 1 checkpoints, Milestone 2 SSH lifecycle, and Milestone 3 cloud provisioning into an end-to-end `agent-router migrate <source> <target>` command.
- [ ] Trigger a migration from an expiring or capacity-constrained host (simulated threshold + live two-host handoff) to an SSH/Hetzner or OCI target, fencing source compute before enabling the target and verifying source cleanup.
- [ ] Test failure modes: interrupted transfer, corrupt snapshot, target out-of-capacity (`Out of host capacity` keeps source intact rather than destroying it), and revoked credentials.

**Gate:** Cross-host migration preserves all acknowledged saved work and settled sessions, never leaves two active agents running, and safely aborts without data loss when destination capacity or free headroom is unavailable.

---

## Risk register

| Uncertainty | Proof milestone | Fallback if blocked |
| --- | --- | --- |
| Un-upgraded OCI Free Tier has zero A1 capacity in user's home region | Milestone 0 live `inspect:oci` + launch test | Use OCI PAYG-safe mode (compartment quota + budget tripwire) or commodity SSH/Hetzner host (`~$4.50–$6.49/mo`) |
| OpenCode `2.2.7` drops pending prompts or drifts `opencode.db` paths across hosts | Milestones 0–1 | Quiesce + block/drain pending inbox prior to export; import into fresh isolated `XDG_*` state bound to target directory |
| Local CLI crashes mid-provisioning and orphans a cloud VM or 50 GB boot volume | Milestone 3 fault-injection test | Reconcile persisted operation journal + tags + `opcRetryToken` before new mutations; verify storage quota after delete |
| Model provider ToS restricts consumer OAuth routing | Architectural invariant (Nov 17, 2026) | Keep Agent Router strictly local-first/BYOC; never proxy or pool user model credentials through a hosted service |

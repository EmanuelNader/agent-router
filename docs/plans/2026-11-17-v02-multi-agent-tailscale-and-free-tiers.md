# Agent Router v0.2 Plan: Polymorphic Multi-Agent Checkpoints, Tailscale & Pairing, Free-Tier Guardrails, and Live Linux Container Proof

## Global Constraints

- Node 24, `pnpm@11.25.0`, strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
- Keep provider adapters (`packages/cloud-*`, `packages/host-ssh`), snapshot adapters (`packages/snapshots`), and agent adapters (`packages/agent-opencode`, `packages/agent-codex`, `packages/agent-claude-code`) separate.
- Never read or copy personal `$HOME`, `~/.codex`, `~/.claude`, or `~/.ssh`. All tests use isolated `0700` temporary directories and `0600` secret files.
- Missing or stale (`> 15 minutes`) cloud entitlement, quota, disk, or egress telemetry must fail closed (`BLOCKED`).
- Never modify `.github/workflows/ci.yml`.
- Every task requires TDD (`RED` failing test -> minimal implementation -> `GREEN` + `pnpm typecheck`), atomic git commits, and an independent subagent spec + code quality review.

---

## Task 1: Polymorphic Multi-Agent Checkpoints (`v2` Manifest Compatible with `v1`) & Remote Pairing Vectors

- **Files:**
  - `packages/snapshots/src/manifest.ts` & `packages/snapshots/test/manifest.test.ts`
  - `packages/snapshots/src/checkpoint.ts` & `packages/snapshots/test/checkpoint.test.ts`
  - `packages/host-ssh/src/pairing.ts` & `packages/host-ssh/test/pairing.test.ts`
- **Requirements:**
  1. Extend `packages/snapshots/src/manifest.ts` to support polymorphic agent payloads (`agentPayloadSchema` discriminated on `agent`: `'none'`, `'opencode'`, `'codex-cli'`, `'claude-code'`) while keeping full backward compatibility with `v1` OpenCode checkpoints (`captureCheckpoint` / `restoreCheckpoint` existing callers continue working unchanged).
  2. Add `captureAgentCheckpoint` and `restoreAgentCheckpoint` in `packages/snapshots/src/checkpoint.ts` capable of capturing and restoring a workspace + settled agent state for:
     - `'none'` (workspace + Git state only)
     - `'opencode'` (`SessionTransfer[]`)
     - `'codex-cli'` (`CodexRolloutBundle` from `packages/agent-codex/src/adapter.ts`, relocating `CODEX_HOME` rollouts to `targetWorkspace`)
     - `'claude-code'` (`ClaudeProjectBundle` from `packages/agent-claude-code/src/adapter.ts`, relocating `CLAUDE_CONFIG_DIR` project slug + `cwd` to `targetWorkspace`)
  3. Create `packages/host-ssh/src/pairing.ts` providing `buildRemotePairingCommand(agent, options)` and `runRemotePairingOverSsh(transport, agent, options)` for zero-inbound-port remote pairing:
     - `'opencode'`: `['opencode', 'pair', '--remote', '--yes']` (non-interactive consent flag verified on `@opencode/cli@2.2.7`)
     - `'codex-cli'`: starts daemon `['codex', 'remote-control', 'start', '--json']` then requests pairing code `['codex', 'remote-control', 'pair', '--json']` and parses `{ pairingCode, manualPairingCode, environmentId, expiresAt }`
     - `'claude-code'`: `['claude', 'remote-control']` (or `--name <safeName>` validated `[A-Za-z0-9._-]{1,64}`)

---

## Task 2: Tailscale Peer Discovery & Live `agent-router` CLI `peers`, `pair`, `handoff`, and Polymorphic `--agent` Support

- **Files:**
  - `packages/host-ssh/src/tailscale.ts` & `packages/host-ssh/test/tailscale.test.ts`
  - `packages/cli/src/cli.ts` & `packages/cli/test/cli.test.ts`
  - `package.json` (bump `"version": "0.2.0"` and `ROUTER_CLI_VERSION = '0.2.0'`, update `packages/cli/test/build-bin.test.ts`)
- **Requirements:**
  1. Create `packages/host-ssh/src/tailscale.ts` parsing `tailscale status --json` (`BackendState === 'Running'`, `Peer` map) via Zod into sanitized `TailscalePeerSummary[]` (`hostName`, `dnsName` with trailing dot stripped, `tailscaleIps`, `os`, `online`, `recommendedSshTarget`), filtering to `online: true` peers by default and scrubbing any user emails/node keys. Support injectable `runStatusJson` for deterministic tests plus live `tailscale status --json` CLI execution.
  2. Upgrade `packages/cli/src/cli.ts` (`ROUTER_CLI_VERSION = '0.2.0'`):
     - `checkpoint` and `restore`: accept `--agent <none|opencode|codex-cli|claude-code>` (default `'none'`), `--codex-home <dir>`, and `--claude-config-dir <dir>` wired to `captureAgentCheckpoint` / `restoreAgentCheckpoint`.
     - `peers`: lists online Tailscale peers (`--status-file <json>` for offline/fixture inspection or live `tailscale status --json`).
     - `handoff`: performs a real fenced cross-host checkpoint transfer (`--workspace <dir> --target-workspace <remote-or-local-dir> --ssh-target <user@host> [--ssh-port <p>] [--identity-file <path>] [--known-hosts-file <path>] --remote-spool <posix-dir> --key-file <0600-path> [--agent <none|codex-cli|claude-code>] [--codex-home <dir>] [--target-codex-home <dir>] [--claude-config-dir <dir>] [--target-claude-config-dir <dir>]`) using `SshCliTransport` + `OperationJournal`!
     - `pair`: runs `runRemotePairingOverSsh` over `SshCliTransport`.

---

## Task 3: GCP Always Free (`e2-micro`) & GitHub Codespaces (`120 core-hrs`) Allowance & Cost-Trap Guardrails

- **Files:**
  - `packages/cloud-readiness/src/gcp-free-tier.ts` & `packages/cloud-readiness/test/gcp-free-tier.test.ts`
  - `packages/cloud-readiness/src/codespaces-allowance.ts` & `packages/cloud-readiness/test/codespaces-allowance.test.ts`
  - `packages/cli/src/cli.ts` (wire `gcp:guard` and `codespaces:allowance` subcommands with `--demo` and `--report <path>`)
- **Requirements:**
  1. `evaluateGcpAlwaysFreeGuardrails` (`gcp-free-tier.ts`):
     - Enforces fresh (`<= 15m`) evidence.
     - Allows **only** `machineType === 'e2-micro'`, `provisioningModel === 'STANDARD'` (non-preemptible), `region` in `['us-west1', 'us-central1', 'us-east1']`, `bootDiskType === 'pd-standard'` (blocks paid `pd-balanced` / `pd-ssd`!), `totalStandardDiskGb <= 30`, `gpuCount === 0`, `monthlyNorthAmericaEgressGb <= 0.85` (safety buffer below the `1.0 GB` monthly free cap), `allowPaidChinaOrAustraliaEgress === false`, and active billing budget alert `<= $5`.
     - Returns `{ status: 'GUARDED_FREE_ELIGIBLE' | 'BLOCKED', blockers: string[] }`.
  2. `evaluateCodespacesAllowance` (`codespaces-allowance.ts`):
     - Models GitHub Personal Free Codespaces monthly quota (`120` included core-hours, `15` GB-month storage; core multipliers `2 -> 2x`, `4 -> 4x`, `8 -> 8x`, `16 -> 16x`, `32 -> 32x`).
     - Rejects stale (`> 15m`) telemetry (`BLOCKED`).
     - Triggers `MIGRATE_NOW` (`shouldMigrate: true`) when remaining core-hours `<= minCoreHoursBuffer` (default `10` core-hours, i.e., 5 hours on a 2-core machine) or storage GB-month `>= maxStorageGbMonthBuffer` (default `13.5` GB-month), so workspaces evacuate before GitHub blocks/charges the Codespace.

---

## Task 4: Live Ubuntu 24.04 ARM64 Linux Container Verification (`macOS -> Linux -> macOS`) & v0.2 Documentation

- **Files:**
  - `packages/cloud-oci/test/linux-container.test.ts`
  - `scripts/e2e.ts`
  - `docs/evidence/06-v02-linux-and-free-tiers.md`, `README.md`, `docs/plans/agent-router-execution-plan.md`
- **Requirements:**
  1. Create `packages/cloud-oci/test/linux-container.test.ts` (`describe.runIf(isDockerDaemonRunning())`):
     - Boots a real `ubuntu:24.04` Linux (`arm64` / native arch) container via `docker run --rm -d`.
     - Verifies our worker bootstrap invariants inside real Ubuntu 24.04 Linux (`agentrouter` non-root user creation with `0700` `/var/lib/agent-router/{spool,workspaces}`, SHA-256 verification logic, OpenSSH `sshd` config validation inside Linux `sshd -t` or real cross-OS archive restore).
     - Captures a real polymorphic checkpoint on macOS (`darwin`), transfers it into the running Ubuntu 24.04 Linux container, verifies SHA-256 workspace hashes & executable permissions inside Linux (`uname -s === 'Linux'`), mutates the workspace inside Linux, captures/transfers back to macOS, and verifies round-trip integrity!
  2. Update `scripts/e2e.ts`, `docs/evidence/06-v02-linux-and-free-tiers.md`, `README.md`, and `docs/plans/agent-router-execution-plan.md`.

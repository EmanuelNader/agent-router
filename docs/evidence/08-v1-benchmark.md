# v1 benchmark evidence

Observed 2026-11-18. v1.0.0 engineering candidate; native read-only reviews and correction rechecks completed, and verified task commits were fast-forward merged into local main. GitHub publication remains pending; no push was performed.

## Current observed state

- Latest complete `pnpm benchmark`: **8/8 gates, 100/100**, exit **0**. Build, check, probe, agent roundtrip, master E2E, and all executable gate proofs passed. The earlier pre-documentation run was 7/8, 87.5/100, exit 1.
- Full check: **817 tests across 53 files, zero skipped files**. The adversarial corpus executes **642 attack vectors**, plus two controls.
- Native compatibility: OpenCode 2.2.7, Codex CLI 0.169.0, Claude Code 2.1.326. MCP receipt scope is `CONFIGURATION_LOADING_ONLY`; neither MCP tool execution nor OAuth is claimed.
- ACP v1 cold resume passes using an `IMPORTED_USER_MESSAGE` saved fixture. Shell-history replay is unsupported by the pinned upstream ACP implementation. No model inference is performed.
- v3 linked-worktree restore passes natively and inside real `ubuntu:24.04` Linux/aarch64 with Node 24, after deleting both original linked source and parent repository. It verifies staged index, dirty/untracked bytes, confined relative symlink, and cache exclusion.
- Master E2E passes real HTTP/ACP, doctor, linked Git worktree, SSH/SCP, restic SFTP, guest `sha256sum -c`, allowance watch with one active agent, zero simulated cloud remnants, and zero blocking journal entries.
- Fly guardrails, API transport contracts, lifecycle fault recovery, and migration integration pass local simulation. There were **zero live cloud mutations**. Paid stopped-rootfs costs are guarded; no free Fly entitlement or live account compatibility is claimed.
- A task-owned Lima engine runs with private ignored state, no mounts, no personal SSH keys, and no SSH agent forwarding. The user's Docker context and existing Docker Desktop containers were untouched. The verification Dockerfile pins and verifies the Node archive checksum.
- The user authorized native read-only subagents in place of `define_subagent`. Three scoped reviews and correction rechecks completed; the final corrected benchmark exits 0 with 8/8 and 100/100.

The following chronological notes preserve earlier RED/GREEN runs and superseded partial counts. Current observations above take precedence.

## Earlier implementation observations

- Runtime matches Node 24 and pnpm 11.25.0.
- Baseline `pnpm check`: 36 files, 92 passing tests.
- `pnpm build`, `pnpm agent:probe`, `pnpm agent:roundtrip`, and `pnpm e2e` passed.
- The existing v0.3 E2E exercised OpenCode HTTP, Codex, Claude Code, SSH/SCP,
  restic SFTP, and Linux/aarch64. It reported maximum concurrent agents 1 and
  zero simulated cloud remnants. This does not prove ACP or linked-worktree support.
- Checkpoint capture now materializes linked Git worktrees into standalone Git
  metadata via a bundle, HEAD, and independently reconstructed staged blobs/index.
  New captures now emit v3, preserve confined relative symlinks, and exclude
  `node_modules`, `.pnpm-store`, `.work`, and `.cache` by default. Exclusions are configurable
  by basename; overlapping tracked Git files block capture rather than changing
  staged state silently. Legacy v1/v2 restore remains supported.
- The benchmark runner is infrastructure only: dedicated executable proofs for
  gates 1–6 and 8 remain to be implemented. Missing proofs fail closed.
- Gate 7 runs all five required commands and requires a successful Vitest JSON
  report with at least 140 passing tests and no pending/todo tests or suites.
- The requested `define_subagent` read-only reviewer is unavailable in this
  session's tool inventory. Required reviews and local landing remain pending.
- Initial `pnpm benchmark` exited 1 with 0/8 gates, 0/100. All five build-bar
  commands passed; the 92-test baseline remains below 140.
- Gate 1 RED regression creates a real linked worktree with distinct
  committed, staged, dirty, and untracked bytes and requires restore after the
  source repository is deleted. It initially failed at the explicit
  unsupported-worktree exception. Both branch and detached-HEAD variants now
  pass, including staged binary blobs and exclusion of source config/hooks.
- Focused checkpoint suite: 6 tests passed. `pnpm agent:roundtrip` and
  `pnpm checkpoint:roundtrip` passed after the change.
- A subsequent `pnpm check` passed typechecking and 92 tests but skipped the
  Docker-dependent test file (35 files passed, 1 skipped). This run does not
  satisfy the zero-skipped-files bar; container availability must be resolved.
- v3 snapshot suite passed 26 tests before adding two legacy compatibility
  cases; the portable-file suite then passed all 11 tests, including both legacy
  versions. Typechecking passed. The new safe-symlink roundtrip was first observed
  RED at the prior symlink rejection before implementation.
- The full v3 `pnpm check` run passed 102 tests and skipped one Docker-dependent
  test. Checkpoint roundtrip, agent probe, agent roundtrip, and existing E2E passed.
  This E2E reported `linuxGuestVerified: null`, so it provides no current Linux
  evidence. Gate 1's required Linux restore proof remains outstanding.
- Archive extraction creates regular files before links and rejects overlapping
  link/file paths, link cycles, absolute/escaping targets, and Git-metadata links.
  Link target text participates in workspace receipts. Nested Git repositories
  require separate checkpoints.

No live cloud resources were created or modified. Model inference remains
unverified. Raw local tool reports stay in ignored scratch storage.

## Gate 1 upstream research

Retrieved with Firecrawl developer search and page scrape on 2026-11-18:

- [Git worktree](https://git-scm.com/docs/git-worktree): linked worktrees have
  private HEAD/index state and shared objects/refs; resolve metadata with Git
  commands rather than assuming directory layout.
- [Git bundle](https://git-scm.com/docs/git-bundle): bundles transfer objects
  and refs. They do not capture dirty worktree content or the staged index;
  those must be captured separately and verified on restore.

Linux restore, symlink confinement, staged blobs absent from HEAD, detached HEAD,
and configurable cache exclusions require explicit round-trip proofs.

## Gate 2 upstream research and partial implementation

Firecrawl developer searches and page scrapes retrieved on 2026-11-18:

- [OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/): current
  v2 uses `mcp.servers`, command arrays, `environment`, `disabled`, and `{env:NAME}`.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): project `mcpServers`,
  command/args/env, HTTP headers, and `${NAME}` substitution.
- [Codex MCP](https://developers.openai.com/codex/mcp/): `mcp_servers` TOML,
  `env_vars`, `env_http_headers`, and `bearer_token_env_var` retain indirection.
- [smol-toml upstream](https://github.com/squirrelchat/smol-toml): parser and
  serializer API verified; exact 1.9.0 dependency installed with lockfile and
  frozen-lockfile installation verified.

Sixteen focused tests pass for cross-format stdio/bearer-reference roundtrips,
secret diagnostics, nonportable paths, symlinked config-directory rejection,
credential arguments/headers, and post-quiesce rescanning. `mcp:doctor` is wired
to the CLI; it reads only workspace config and prints counts/fixed status codes.
Unknown options block, avoiding unverified translation. JSONC support was added
after a focused RED test reproduced the previous unsupported-format failure.
The Microsoft parser's error list is checked and duplicate keys are rejected;
doctor recursively scans project configs while honoring checkpoint exclusions.
Isolated live CLI compatibility and an executable gate proof remain outstanding.
No Gate 2 pass is claimed.

Additional Firecrawl sources inspected:

- [Pinned v1.2.27 schema](https://raw.githubusercontent.com/anomalyco/opencode/v1.2.27/packages/opencode/src/config/config.ts):
  local command arrays/environment/`enabled`; remote URL/headers/`enabled` and
  optional OAuth configuration. Complex OAuth options currently block translation.
- [Microsoft JSONC parser](https://github.com/microsoft/node-jsonc-parser): the
  parser tolerates invalid input, so every reported error must block. Exact
  jsonc-parser 3.3.1 installed; frozen-lockfile installation passed.

The second benchmark run again exited 1 at 0/8, 0/100. All five build-bar commands
passed, but the test-count/zero-skips requirements and dedicated gate proofs remain
unmet. Tests added afterward cover JSONC, duplicate credential keys, and nested
project configuration. The next full verification passed typechecking and 124
tests, with one Docker-dependent test skipped. Agent probe, agent roundtrip,
and checkpoint roundtrip also passed. Unsupported OAuth fallback combinations
block cross-agent translation rather than silently changing authentication.

## Gate 3 ACP v1

Firecrawl developer search and scrapes retrieved on 2026-11-18:

- [ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization):
  integer version 1, client/agent capabilities, and load capability negotiation.
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup):
  absolute cwd, new/load requests, and history replay before the load response.
- [ACP v1 transport](https://agentclientprotocol.com/protocol/v1/transports):
  newline-delimited UTF-8 JSON-RPC over stdio.
- [OpenCode ACP invocation](https://opencode.ai/docs/cli/acp/): `opencode acp`.
- [Pinned replay implementation](https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/packages/cli/src/acp/replay.ts):
  user/assistant replay; top-level shell messages are omitted.
- [Pinned saved-message schema](https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/packages/schema/src/session-message.ts):
  imported user fixture shape.

The initial live proof failed because shell-only history produced no ACP replay.
This was not treated as successful conversation resumption. The revised proof
separately verifies real completed shell history through HTTP and imports an
explicit synthetic saved user message into fresh isolated state. After stopping
HTTP and starting a fresh ACP process, `session/load` replays that saved message
with the expected session ID. No prompt/model API call occurs.

Seven ACP tests pass, including the real pinned 2.2.7 cold-load test. The adapter
negotiates initialize, rejects unsupported versions/load capability, bounds frames
and requests, ignores stderr, sanitizes upstream errors, denies unadvertised
client execution methods, and terminates its subprocess on failure/close.
`pnpm agent:acp-roundtrip` and the Gate 3 proof invoke the same live assertions;
normal checks include the live test, and E2E now invokes the proof as well.
Model inference/conversational recall remains unverified. Review remains pending.

The full check after ACP integration passed 131 tests and skipped one Linux
container test; probe, native roundtrip, and E2E passed. E2E emitted the ACP
cold-resume receipt. The benchmark then exited 1 with **1/8 gates, 12.5/100**:
Gate 3 passed, and all other gates remained fail-closed. Additional focused
transport cases cover oversized frames, invalid UTF-8, and unknown response IDs.

## Gate 4 Fly cost guard and simulated lifecycle

Retrieved through Firecrawl developer search and scrapes on 2026-11-18:

- [Pricing](https://docs.fly.io/about/pricing): stopped/suspended rootfs remains
  billable at $0.15/GB/month; volumes, IPs, snapshots, and transfer have separate costs.
- [Billing](https://docs.fly.io/about/billing): started compute and stopped rootfs
  are prorated per second.
- [Machines resource](https://docs.fly.io/machines/api/machines-resource): suspend,
  start, wait, and deletion endpoints.
- [Suspend/resume](https://docs.fly.io/reference/suspend-resume): local `/.fly/api`
  self-suspend socket, no swap/schedule, small-memory constraints, possible cold
  starts, and clock/network recovery limitations.

The guard reserves maximum rootfs size over the full horizon plus bounded running
seconds and ancillary costs. Unknown/non-finite, stale/future, unsupported suspend
configuration, and over-budget evidence block. Reports never authorize live
provisioning. The lifecycle is currently **simulation-only** for existing Machines:
it journals intent, sends a retry token to the test gateway, observes final state,
and reconciles lost responses without repeating mutations. Simulated token
deduplication is not a claim of native Fly API idempotency support.

Twenty-four focused tests pass. The full check passed typechecking and 158 tests,
with one Linux container test skipped. `fly:guard --demo` and
`fly:simulate-lifecycle` CLI commands exercise only synthetic data/local state.
At that point HTTP/Unix-socket transport and migration integration were unfinished.
The subsequent benchmark exited 1 at 1/8, 12.5/100. All five build-bar commands
passed, but Docker's skipped test still prevents Gate 7. Docker Desktop/backend
processes are present locally; their presence does not establish a responsive
engine. No engine restart or unrelated container interruption was attempted.

The subsequent implementation adds the fixed-origin HTTPS Machines API, lease
acquisition/release, instance-scoped waits, and a tokenless Unix-socket path
restricted to the configured Machine's self-suspend endpoint. It never follows
redirects, bounds response size/deadlines, and emits fixed error codes. No Machine
creation API is exposed. API starts require fresh read-only evidence bound to
app/Machine/instance and memory; demo evidence is accepted only by the test gateway.
The retry token is lease-description correlation; no native deduplication is
assumed. Reconciliation observes state and does not retry an uncertain mutation.

`createFlyMigrationCandidate` resumes an existing guarded Machine before normal
workspace cutover. The local migration test verifies restored bytes, source fencing
before agent activation, maximum concurrent agents one, and zero remnants/journal
blockers after teardown. Thirty-two focused Fly tests pass, including a real local
Unix HTTP socket and injected HTTPS contract/fault responses. These are local
compatibility proofs, not observations of a connected Fly account. No live cloud
requests or mutations occurred. The Gate 4 evaluator executes the entire Fly test
suite and both CLI demos. Required code review remains unavailable/pending.
The full check passed typechecking and 166 tests, with one Docker test skipped.
The subsequent benchmark exited 1 at **2/8 gates, 25/100**, with Gates 3 and 4
passing. Build, check, probe, native roundtrip, and E2E all exited zero; the skipped
Linux proof still prevents Gate 7. Remaining gates were not credited.

## Gate 5 adversarial corpus

Upstream references retrieved using Firecrawl developer search and scrapes on
2026-11-18:

- [Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html): GCM
  authentication/tag failure and additional authenticated data semantics.
- [OpenSSH configuration](https://man.openbsd.org/ssh_config): ProxyCommand,
  IdentityFile, shell execution, and token expansion boundaries.
- [Node 24 filesystem](https://nodejs.org/docs/latest-v24.x/api/fs.html): file
  sync and rename operations used by durable journal writes.

The executable Gate 5 proof reports **642 adversarial vectors across seven files**
(excluding two positive controls), all passing with no skipped corpus tests.
The vectors are fixed/table-generated; encrypted-store IVs remain random.
Coverage includes every bit in the AR01 header/nonce/tag/first ciphertext block,
16 AAD swaps, SSH target delimiters, ProxyCommand/IdentityFile injection,
archive paths, depth/chain symlink escapes, missing/nonfinite/cloud clock inputs,
partial journal writes, and actual subprocess exits immediately before rename.

Observed RED failures led to these fixes:

- Exact magic-byte comparison replaces ASCII decoding, which had accepted
  high-bit mutations in each of the four AR01 header bytes.
- Journal inspection propagates invalid-directory errors and validates directory
  symlinks before chmod. Records are checked before reading.
- Journal writes sync the temporary file before rename and the directory after
  rename. Existing authoritative pending records survive interrupted updates;
  orphaned initial temporary writes block with `JOURNAL_INCOMPLETE_WRITE` and need
  operator inspection rather than being silently treated as an empty journal.
- AWS allowance evaluation rejects nonfinite/negative thresholds and invalid
  evaluation clocks instead of returning HEALTHY/MIGRATE_NOW for malformed options.

No cloud calls, model inference, personal-state copies, or live account mutation
are part of this corpus. Required review remains pending.

Full verification passed typechecking and **810 tests across 50 files**, with
one Docker-dependent test/file skipped. The benchmark then exited 1 with
**3/8 gates, 37.5/100** (Gates 3, 4, and 5 passed). All five build-bar commands
exited zero. Separate read-only health requests to the two standard local Docker
socket locations timed out after four seconds each; no daemon restart or container
mutation was attempted. Linux restore and the zero-skipped-files bar remain open.

## Gate 2 native configuration-loader proof

The new isolated live test passes against OpenCode 2.2.7, installed Codex 0.169.x,
and installed Claude Code 2.1.x. It checks translated command/argument and
environment-reference fields through Codex's JSON MCP listing, Claude's project
MCP getter, and OpenCode's effective configuration endpoint. OpenCode's fixture
is disabled to avoid a server connection; Claude's project entry remains
unapproved. This proves native configuration loading, not MCP tool execution or
OAuth/model access. V1 input translation is checked against the pinned v1 schema
and cross-format tests; no live OpenCode v1 binary claim is made.

Additional Firecrawl references: [OpenCode config](https://opencode.ai/docs/config/),
[pinned server configuration override](https://raw.githubusercontent.com/anomalyco/opencode/v2.2.7/packages/cli/src/server-process.ts),
[Claude MCP](https://code.claude.com/docs/en/mcp), and
[Codex MCP](https://developers.openai.com/codex/mcp/). Effective config is read from
private temporary state, and raw responses stay out of logs and Git.

The Gate 2 evaluator passes the portability/live suites and exercises the doctor
CLI against a disposable config. Full check: 811 passing tests in 51 files, one
Docker test skipped. E2E now starts from a dirty linked Git worktree with staged
content, runs doctor, includes native MCP loader receipts, and asserts an empty
migration journal. Linux proof and native agent binaries are mandatory. The
native steps reach the Linux assertion, where E2E correctly fails while Docker
is unresponsive. No final E2E success receipt is emitted for that partial run.

The benchmark now exits 1 at **4/8, 50/100**: Gates 2–5 pass. E2E fails at its
mandatory Linux requirement; it no longer accepts a skipped Linux section.

## Task-owned Linux runtime preparation

To avoid restarting the unresponsive Docker Desktop, an independent Lima VZ
runtime is being prepared under ignored task state. The official Lima 2.3.0
Darwin/arm64 archive was verified against its GitHub release SHA-256 digest and
extracted locally. The intended VM uses one CPU, 1 GiB RAM, private HOME/cache/state,
no host mounts, no personal SSH keys, and no forwarded SSH agent. Creation is
complete after downloading/verifying its public Ubuntu base image. Configuration
was inspected before start: no mounts, no personal SSH keys, no agent forwarding.
Startup is in progress; no VM readiness or Linux restore success is claimed yet.
Docker Desktop and its containers were untouched.

Sources inspected through Firecrawl before setup:
[installation](https://lima-vm.io/docs/installation/),
[VZ](https://lima-vm.io/docs/config/vmtype/vz/),
[mounts](https://lima-vm.io/docs/config/mount/),
[plain-mode controls](https://lima-vm.io/docs/config/plain/), and
[Docker template](https://github.com/lima-vm/lima/blob/v2.3.0/templates/docker.yaml).
The official [2.3.0 release](https://github.com/lima-vm/lima/releases/tag/v2.3.0)
provided the archive digest. Runtime artifacts and raw setup output remain ignored.


## Linux proof completion and release gate

The private Lima VM started successfully. Its Docker engine pulled Ubuntu 24.04 ARM64 and built `agent-router-verification:ubuntu24-node24` from the checked-in Dockerfile. Node 24.18.1 archive SHA-256 was verified against the official distribution. Containers use no network and no host mounts for checkpoint restoration; only disposable fixture/runtime inputs are copied in.

The first combined native/Linux proof exposed a root-level cache pathspec mismatch in recorded Git status. Explicit root and nested exclusion patterns fixed it. A fresh typecheck and full test run passed 813 tests, with zero skipped files; the complete master E2E then passed all mandatory native and guest checks. A full benchmark exited 1 at 7/8, 87.5/100, with only absent Gate 8 failing.

Gate 8 was first observed RED because package version remained 0.3.0. Version/help, README, plan, and evidence are now aligned for the 1.0.0 candidate. Its evaluator checks the actual built executable, documented compatibility/boundaries, and absence of personal paths, private keys, token patterns, and actual OCIDs in release artifacts. Final all-gate verification exited 0 with 8/8 gates and 100/100. The latest Vitest JSON report confirms 813 passing tests across 53 passing files, no failures, pending, or todo tests. That earlier run preceded native read-only review authorization; the corrected reviewed result is recorded below.


## Native read-only review corrections

The user explicitly authorized native reviewers to replace the unavailable `define_subagent`. Three scoped reviews found MCP command expansion ambiguity and discarded HTTP arguments, an overlapping OpenCode/Codex E2E phase, an unenforced Fly runtime-cost assumption, and stale documentation-count checks. Regression tests first reproduced MCP/Fly failures. MCP rejects command/argument expansion and HTTP stdio-only fields; environment/header reference translation remains supported. E2E fences OpenCode before Codex and counts subsequent agent lifetimes. Fly reserves full-horizon compute plus maximum rootfs/ancillary costs, because no crash-proof stop deadline is implemented. Gate 8 compares current documentation counts to the fresh test/fuzz report. The fresh complete benchmark after these fixes exits 0: 8/8, 100/100. Its JSON report proves 817 passing tests in 53 files, zero skipped/pending/todo/failing tests. All three reviewers rechecked and approved their corrections. ACP also now rejects missing/nonobject environments before spawn, preventing accidental process.env inheritance; its regression was observed RED then GREEN. The v0.3 hardening commit was fast-forwarded into local main first. Verified v1 task commits were created on the feature branch and fast-forwarded into local main (release commit `f6b183e`). No push, live cloud mutation, or CI workflow edit was performed.

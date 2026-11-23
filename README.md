# Agent Router

Local-first CLI and TypeScript toolkit to run isolated coding agents on your own compute (`OCI Always Free / PAYG-safe`, `SSH` / `Hetzner` VPSes, `AWS Free Plan`), guard against surprise cloud bills, and move unfinished workspaces + settled conversations cleanly across `laptop ↔ VPS ↔ cloud`.

**Version: `1.0.0` local engineering candidate; verified local engineering release.** The latest full check passes **817 tests with zero skipped files**. Executable benchmark gates cover portable v3 checkpoints, MCP portability, ACP v1 cold resume, Fly lifecycle contracts, **642 adversarial vectors**, real local multi-hop E2E, build checks, and release evidence. See [current evidence](docs/evidence/08-v1-benchmark.md) and [execution plan](docs/plans/agent-router-execution-plan.md).

Compatibility is observed against OpenCode **2.3.2**, Codex CLI **0.171.0**, and Claude Code **2.1.329**. v3 snapshots materialize linked Git worktrees through a temporary Git bundle and reconstruct staged content independently; dirty/untracked files and confined relative symlinks survive restoration after source deletion. Configurable basename exclusions default to `node_modules`, `.pnpm-store`, and `.work`; excluding tracked content blocks capture.

`mcp:doctor` blocks plaintext credentials and nonportable host paths before checkpoints. Translation supports the verified common subset of OpenCode v1/v2, Claude project JSON, and Codex TOML, preserving environment references. Unknown or unrepresentable options fail closed. Native compatibility proves configuration loading only, with no MCP tool execution or OAuth claim. ACP initializes, negotiates capabilities, and creates/loads sessions over JSON-RPC stdio. Cold resume verifies an imported saved user-message fixture; OpenCode shell-history replay through ACP is unsupported and model inference is untested.

Fly is a paid scale-to-zero candidate for an existing owned Machine, with fresh cost/rootfs evidence and full-horizon compute reservation, lease-protected lifecycle operations, and crash reconciliation. Local simulations and injected API contracts pass; no live cloud account was mutated. Existing OCI/Hetzner, allowance watch, SSH/SCP, encrypted restic SFTP, and operation-journal paths remain covered by the master E2E. Saved work and supported settled history migrate after fencing the source; arbitrary running processes and pending side effects do not migrate.

## Run the local proof

Requires Node 24, pnpm 11.25.0, Git, native Codex/Claude binaries at the verified versions, OpenSSH (`sshd`, `ssh`, `scp`), restic 0.19.x (other release lines are refused), and a working local Docker engine supporting Linux ARM64. No cloud account or model API key is needed. The full benchmark requires Linux proofs; missing tools fail the gates.

Prepare both Linux images on your verification engine before running the full suite:

```sh
docker pull --platform linux/arm64 ubuntu:24.04
docker build --platform linux/arm64 -t agent-router-verification:ubuntu24-node24 -f infra/verification/Dockerfile .
```

The checked-in Dockerfile verifies the pinned Node 24 archive checksum. The container proof uses `ubuntu:24.04`, no network, and no host mounts; it verifies Git, staged/dirty bytes, symlinks, and cache exclusion after source deletion. A task-owned engine can be selected without changing the user's Docker context: ignored mode-0600 `.work/verification-docker.json` accepts a `socketPath` pointing to a Unix socket beneath this checkout's `.work/`. Its CLI configuration stays in `.work/verification-docker-cli`. Otherwise the normal Docker environment is used.

```sh
pnpm install --frozen-lockfile
pnpm build
node bin/agent-router.mjs --version
pnpm readiness
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
pnpm checkpoint:roundtrip
pnpm handoff:roundtrip
pnpm router oci:simulate-lifecycle
pnpm agent:acp-roundtrip
pnpm checkpoint:linux-roundtrip
pnpm router mcp:doctor --workspace .
pnpm router fly:guard --demo
pnpm router fly:simulate-lifecycle
pnpm e2e
pnpm benchmark
```

The probe starts a password-protected OpenCode 2.3.2 server on loopback and checks authenticated access, rejection without credentials, and exclusion of ancestor project configuration. The round trip creates a fixture with unfinished Git changes, records a completed shell turn in a real session, stops the source, copies the workspace, and imports the session into fresh agent state. It verifies successful shell output, target-directory binding, file hashes, executable flags, Git HEAD/index/status, session ID, and settled messages.

Each run uses private temporary directories under ignored `.work/`, a generated password, and isolated HOME/XDG directories. Project/Claude configuration discovery is disabled to prevent ancestor configuration from loading. It excludes inherited model/cloud credentials and removes its temporary state after stopping its own processes. The shell command is a fixed fixture; these checks perform no model inference. Native agent processes and disposable Linux verification containers are both exercised. Docker is mandatory for the full benchmark.

## Move a workspace to another host

```sh
agent-router move ./project user@host --key-file ./move.key
```

`move` captures an encrypted checkpoint, uploads it over SSH, and has the Agent Router on the remote host restore it. The remote host must already have the same Agent Router version installed (`--remote-router <command>` if it is not on the remote `PATH`); `move` refuses otherwise. The encryption key is sent on the SSH session's stdin for the restore and is not written to the remote disk.

- Defaults: the workspace is restored to `<remote login directory>/<workspace name>` and the checkpoint is spooled under `<remote login directory>/.agent-router/spool`. Override with `--remote-workspace` and `--remote-spool`.
- Agent history: `--agent claude-code --claude-config-dir <local> --target-claude-config-dir <remote>`, `--agent codex-cli --codex-home <local> --target-codex-home <remote>`, or `--agent opencode` with the local and `--target-opencode-*` options. Stop the agent first; `move` does not stop it for you.
- The source is kept unless you pass `--remove-source`. It is then removed only after the remote reports the same manifest, and only if the source still matches the checkpoint. Excluded folders such as `node_modules` are not moved.
- A failure before the remote restore starts leaves the source untouched. A failure after it starts is recorded as `NEEDS_RECONCILE`: check the remote workspace, then run `agent-router reconcile`.

See [move evidence](docs/evidence/13-move-command.md).

## Optional cloud inspection

These commands only read account metadata. Run them yourself with a dedicated cloud configuration. Do not paste keys into chat, commit them, or place them in a workspace that an agent can read.

```sh
pnpm inspect:oci --config /absolute/path/to/oci-config --profile DEFAULT
pnpm inspect:aws --region us-east-1
```

OCI requires an existing API-signing configuration and permission to list region subscriptions/availability domains and read tenancy-level limits and resource availability. It discovers the home region, reads regional and AD-level A1 quotas, micro quota, and remaining regional free storage (Oracle's Always Free A1 allowance is 1,500 OCPU-hours and 9,000 GB-hours/month, or 2 OCPUs / 12 GB, plus 200 GB combined boot/block storage). Multiple ADs require an explicit `--availability-domain` selection using the exact OCI name. Missing/denied/ambiguous data remains UNKNOWN; incomplete inspection exits 1. Requests have a shared 30-second deadline and do not retry automatically.

AWS uses the SDK credential chain and reads STS identity plus the Free Tier account plan (`GetAccountPlanState`). Both scripts omit account identifiers and always return `provisioningAllowed: false`. Live SDK account calls have not been verified for this project. Quota availability does not establish free allowance, physical capacity, or zero cost.

To prepare a local signing key for a dedicated OCI inspector, use the checked-in [inspection policy](infra/oci/inspection-policy.txt) for its group. Keep the directory outside any Git checkout. Its parent must already exist.

```sh
pnpm connect:oci prepare --directory /absolute/new/private-directory
```

In the inspector user's **Tokens and keys → Add API key**, choose the public key file printed by the command. Compare the Oracle fingerprint with the generated fingerprint. Then create a local SDK config with the inspector user and tenancy OCIDs shown in Oracle. [Oracle API signing instructions](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm).

```sh
pnpm connect:oci configure --directory /absolute/new/private-directory \
  --user USER_OCID --tenancy TENANCY_OCID --region HOME_REGION
pnpm inspect:oci --config /absolute/new/private-directory/config
```

The helper creates a private directory with mode `0700` and key and config files with mode `0600`. The private PEM has no passphrase and stays on the local machine. The helper refuses to replace existing files. Revoke the registered key in Oracle when the inspection connection is no longer needed.

## Preview an Oracle deployment

Try without credentials or cloud calls:

```sh
pnpm plan:oci --demo
pnpm plan:oci --demo --additional-instances 2
pnpm guard:oci --demo
```

The synthetic demo shows one A1 VM with 1 OCPU, 4 GB memory, and a 50 GB boot disk fitting quota, while `guard:oci --demo` additionally verifies the checked-in [PAYG compartment quota caps](infra/oci/payg-compartment-quota.txt) and an active `<= $5` monthly budget alert tripwire ([guardrail inspection policy](infra/oci/guardrail-inspection-policy.txt), [observed evidence](docs/evidence/00-oci-guardrails.md)). Two additional VMs fail the storage/compartment check. Demo results are labelled `DEMO` and do not reflect your account. `QUOTA_FITS` / `GUARDED_QUOTA_FITS` means only that the requested resources fit the recorded quotas and guardrails. Every preview keeps provisioning disabled and lists the remaining entitlement, capacity, image, and cost checks.

For a real report after configuring API access:

```sh
mkdir -p .work
pnpm inspect:oci --config /absolute/path/to/oci-config > .work/oci-readiness.json
pnpm plan:oci --report .work/oci-readiness.json
```

Refresh inspection after deleting instances; retained boot/block volumes still consume the 200 GB Always Free storage pool. Preview reports older than 15 minutes, reports from the future, non-home-region requests, and incomplete required metrics are blocked. `--additional-instances` means new VMs beyond the current observed usage, not the desired total instance count. The initial preview supports A1 requests with 1–2 OCPUs, 1–12 GB memory (at least 1 GB per OCPU), and 50–200 GB per boot disk. These conservative preview bounds are not shape maxima.

Exit codes for `plan:oci`: 0 = quota fits, 2 = quota comparison blocked, 1 = invalid inputs. Source reports contain only selected quota metadata, but should still stay under ignored `.work/`. No file import can authorize a launch.

## Boundaries and next steps

- **Settled history vs. pending inbox:** Export/import preserves supported settled history. OpenCode's pending prompt inbox is separate and is not included in transcript export; checkpointing must quiesce the server and drain or reject pending work before cutover.
- **Workspace receipts vs. encrypted backups:** `hashWorkspace` requires quiesced writers and rejects special files. Its default rejects symlinks; v3 checkpoints explicitly enable validated confined relative symlinks and hash their target text. Git metadata is verified separately from file receipts. Milestone 1 wraps workspace + session state into encrypted, verifiable `restic` checkpoints ([Milestone 1 plan](docs/plans/2026-11-17-local-checkpoint-restore.md)).
- **Local-first BYOC over hosted SaaS:** Consumer AI subscription policies prohibit third-party hosted credential proxies, OpenCode `2.2.x` already provides `opencode pair --remote` (`OpenTunnel`), and commodity VPSes cost ~$5/month. Agent Router therefore runs locally as a serverless BYOC CLI rather than a hosted control plane.
- **Next (opt-in live operator checks):** (1) Register a dedicated read-only OCI Console key via `pnpm connect:oci prepare` and record live `inspect:oci` / `guard:oci` output; (2) connect a dedicated OCI/Hetzner/Tailscale host for opt-in remote compatibility checks. Local Ubuntu ARM64 container proofs are already verified.

See [observed readiness evidence](docs/evidence/00-readiness.md), [OCI guardrail evidence](docs/evidence/00-oci-guardrails.md), [Milestone 1 local restore evidence](docs/evidence/01-local-restore.md), [Milestone 2 SSH handoff evidence](docs/evidence/02-ssh-handoff.md), [Milestone 3 OCI lifecycle evidence](docs/evidence/03-oci-lifecycle.md), [Milestone 4 cross-host migration evidence](docs/evidence/04-cross-host-migration.md), [Multi-agent CLI evidence](docs/evidence/05-multi-agent-adapters.md), [v0.2.0 Linux & free-tier evidence](docs/evidence/06-v02-linux-and-free-tiers.md), the [updated execution plan](docs/plans/agent-router-execution-plan.md), the [v0.2 plan](docs/plans/2026-11-17-v02-multi-agent-tailscale-and-free-tiers.md), the [Milestone 1 checkpoint/restore plan](docs/plans/2026-11-17-local-checkpoint-restore.md), the [November 2026 market & architecture reassessment](docs/research/2026-11-17-market-and-architecture-reassessment.md), and the earlier [first milestone brief](docs/plans/agent-router-first-milestone.md). Historical feasibility docs in `docs/research/` record earlier design inputs; `docs/evidence/` records current observed status.

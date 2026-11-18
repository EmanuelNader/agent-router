# Agent Router

Local-first CLI and TypeScript toolkit to run isolated coding agents on your own compute (`OCI Always Free / PAYG-safe`, `SSH` / `Hetzner` VPSes, `AWS Free Plan`), guard against surprise cloud bills, and move unfinished workspaces + settled conversations cleanly across `laptop ↔ VPS ↔ cloud`.

**Status: Milestones 0–4 implemented and verified end-to-end against real local daemons (`pnpm check`, `pnpm e2e`).** OpenCode `2.2.7` isolated portability, deterministic workspace receipts, AES-256-GCM and `restic 0.19.1` local + remote backends (SFTP verified live against non-root `OpenSSH_10.3p1` `sshd`, plus OCI S3-compatible Object Storage, Cloudflare R2, and AWS S3; [Milestone 1 evidence](docs/evidence/01-local-restore.md)), fenced `laptop ↔ SSH/VPS` handoffs over real `/usr/bin/ssh` + `/usr/bin/scp` ([Milestone 2 evidence](docs/evidence/02-ssh-handoff.md)), OCI PAYG-safe compartment-quota + budget-alert guardrails ([OCI guardrail evidence](docs/evidence/00-oci-guardrails.md)), crash-reconciled OCI `VM.Standard.A1.Flex` and Hetzner `CAX11` ARM64 lifecycle adapters + unified `pnpm router` CLI ([Milestone 3 evidence](docs/evidence/03-oci-lifecycle.md)), and AWS Free Plan credit/expiry-triggered cross-host `migrateWorkspace` with automatic `OutOfHostCapacity` fallback ([Milestone 4 evidence](docs/evidence/04-cross-host-migration.md)) are implemented. Live external cloud account calls remain strictly opt-in—without a hosted multi-tenant SaaS control plane or custom proxy gateway (remote access uses Tailscale or OpenCode's built-in `opencode pair --remote` / [OpenTunnel](https://github.com/anomalyco/opentunnel)). See the [November 2026 market & architecture reassessment](docs/research/2026-11-17-market-and-architecture-reassessment.md) and [updated execution plan](docs/plans/agent-router-execution-plan.md).

## Run the local proof

Requires Node 24, pnpm 11.25.0, Git, and macOS or Linux. No cloud account or model API key is needed.

```sh
pnpm install --frozen-lockfile
pnpm readiness
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
pnpm checkpoint:roundtrip
pnpm handoff:roundtrip
pnpm router oci:simulate-lifecycle
pnpm e2e
```

The probe starts a password-protected OpenCode 2.2.7 server on loopback and checks authenticated access, rejection without credentials, and exclusion of ancestor project configuration. The round trip creates a fixture with unfinished Git changes, records a completed shell turn in a real session, stops the source, copies the workspace, and imports the session into fresh agent state. It verifies successful shell output, target-directory binding, file hashes, executable flags, Git HEAD/index/status, session ID, and settled messages.

Each run uses private temporary directories under ignored `.work/`, a generated password, and isolated HOME/XDG directories. Project/Claude configuration discovery is disabled to prevent ancestor configuration from loading. It excludes inherited model/cloud credentials and removes its temporary state after stopping its own processes. The shell command is a fixed fixture; these checks perform no model inference. Docker is reported as an optional local tool; the scripts run native processes.

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
- **Workspace receipts vs. encrypted backups:** `hashWorkspace` requires quiesced writers, rejects symlinks and special files, excludes `.git` (verified separately), and records file bytes and executable flags. Milestone 1 wraps workspace + session state into encrypted, verifiable `restic` checkpoints ([Milestone 1 plan](docs/plans/2026-11-17-local-checkpoint-restore.md)).
- **Local-first BYOC over hosted SaaS:** Consumer AI subscription policies prohibit third-party hosted credential proxies, OpenCode `2.2.x` already provides `opencode pair --remote` (`OpenTunnel`), and commodity VPSes cost ~$5/month. Agent Router therefore runs locally as a serverless BYOC CLI rather than a hosted control plane.
- **Next (opt-in live operator checks):** (1) Register a dedicated read-only OCI Console key via `pnpm connect:oci prepare` and record live `inspect:oci` / `guard:oci` output; (2) run an opt-in live WAN/Tailscale/OCI/Hetzner smoke handoff with user-owned credentials; (3) optionally add additional coding-agent CLI adapters alongside `@opencode/cli@2.2.7`.

See [observed readiness evidence](docs/evidence/00-readiness.md), [OCI guardrail evidence](docs/evidence/00-oci-guardrails.md), [Milestone 1 local restore evidence](docs/evidence/01-local-restore.md), [Milestone 2 SSH handoff evidence](docs/evidence/02-ssh-handoff.md), [Milestone 3 OCI lifecycle evidence](docs/evidence/03-oci-lifecycle.md), [Milestone 4 cross-host migration evidence](docs/evidence/04-cross-host-migration.md), the [updated execution plan](docs/plans/agent-router-execution-plan.md), the [Milestone 1 checkpoint/restore plan](docs/plans/2026-11-17-local-checkpoint-restore.md), the [November 2026 market & architecture reassessment](docs/research/2026-11-17-market-and-architecture-reassessment.md), and the earlier [first milestone brief](docs/plans/agent-router-first-milestone.md). Historical feasibility docs in `docs/research/` record earlier design inputs; `docs/evidence/` records current observed status.

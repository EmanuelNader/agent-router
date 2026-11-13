# Agent Router

Run a coding agent on compute in your own cloud accounts, with portable saved work and allowance-aware host selection.

**Status: compatibility harness, local encrypted restore, and Oracle deployment preview.** Automatic VPS provisioning, allowance monitoring, provider switching, and a stable public connection are planned. They are not implemented yet. Oracle Cloud is the first intended provider; OpenCode is the first agent adapter.

## Run the local proof

Requires Node 24, pnpm 11.25.0, Git, and macOS or Linux. No cloud account or model API key is needed.

```sh
pnpm install --frozen-lockfile
bash scripts/install-restic.sh
pnpm readiness
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
pnpm agent:restore
```

The probe starts a password-protected OpenCode 2.2.7 server on loopback and checks authenticated access, rejection without credentials, and exclusion of ancestor project configuration. The round trip creates a fixture with unfinished Git changes, records a completed shell turn in a real session, stops the source, copies the workspace, and imports the session into fresh agent state. It verifies successful shell output, target-directory binding, file hashes, executable flags, Git HEAD/index/status, session ID, and settled messages.

`pnpm agent:restore` is the local recovery proof. It needs [restic 0.19.1](https://github.com/restic/restic/releases/tag/v0.19.1) on `PATH` (`bash scripts/install-restic.sh` checks the upstream checksum and installs it to `~/.local/bin`). The script stops the source agent, exports settled history, and stores the workspace plus that export in an encrypted restic repository. The repository password is a one-run file outside the Git checkout. Restore checks the repository, compares file hashes and the session digest, then starts a new OpenCode process and imports the session. A second shell command shows the restored session still accepts work. `node_modules` and `.cache` are left out on purpose. A corrupted pack, a manifest that does not match the restored bytes, and a wrong format, agent, or runtime version are refused.

Each run uses private temporary directories under ignored `.work/`, a generated password, and isolated HOME/XDG directories. Project/Claude configuration discovery is disabled to prevent ancestor configuration from loading. It excludes inherited model/cloud credentials and removes its temporary state after stopping its own processes. The shell command is a fixed fixture; these checks perform no model inference. Docker is reported as an optional local tool; the scripts run native processes.

## Optional cloud inspection

These commands only read account metadata. Run them yourself with a dedicated cloud configuration. Do not paste keys into chat, commit them, or place them in a workspace that an agent can read.

```sh
pnpm inspect:oci --config /absolute/path/to/oci-config --profile DEFAULT
pnpm inspect:aws --region us-east-1
```

OCI requires an existing API-signing configuration and permission to list region subscriptions/availability domains and read tenancy-level limits and resource availability. It discovers the home region, reads regional and AD-level A1 quotas, micro quota, and remaining regional free storage. Multiple ADs require an explicit `--availability-domain` selection using the exact OCI name. Missing/denied/ambiguous data remains UNKNOWN; incomplete inspection exits 1. Requests have a shared 30-second deadline and do not retry automatically.

AWS uses the SDK credential chain and reads STS identity plus the Free Tier account plan. Both scripts omit account identifiers and always return `provisioningAllowed: false`. Live SDK account calls have not been verified for this project. Quota availability does not establish free allowance, physical capacity, or zero cost.

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
```

The synthetic demo shows one A1 VM with 1 OCPU, 4 GB memory, and a 50 GB boot disk fitting quota. Two additional VMs fail its storage check. Demo results are labelled `DEMO` and do not reflect your account. `QUOTA_FITS` means only that the requested resources fit the recorded quotas. Every preview keeps provisioning disabled and lists the remaining entitlement, capacity, image, compartment, and cost checks.

For a real report after configuring API access:

```sh
mkdir -p .work
pnpm inspect:oci --config /absolute/path/to/oci-config > .work/oci-readiness.json
pnpm plan:oci --report .work/oci-readiness.json
```

Refresh inspection after deleting instances; retained boot/block volumes still consume storage. Preview reports older than 15 minutes, reports from the future, non-home-region requests, and incomplete required metrics are blocked. `--additional-instances` means new VMs beyond the current observed usage, not the desired total instance count. The initial preview supports A1 requests with 1–2 OCPUs, 1–12 GB memory (at least 1 GB per OCPU), and 50–200 GB per boot disk. These conservative preview bounds are not shape maxima.

Exit codes for `plan:oci`: 0 = quota fits, 2 = quota comparison blocked, 1 = invalid inputs. Source reports contain only selected quota metadata, but should still stay under ignored `.work/`. No file import can authorize a launch.

## Boundaries and next steps

- Export/import preserves supported settled history. OpenCode's pending prompt inbox is separate and is not included in the transcript export. Migration must drain or explicitly preserve pending work before cutover.
- A workspace copy requires quiesced writers. The content receipt rejects symlinks and special files, excludes `.git` from the hash, and records file bytes and executable flags. The local checkpoint also stores Git metadata and the exported session in restic. It is a single-host restore proof, not a cloud migration.
- Real model authentication/resumption, native CLI reconnection, and cloud migration remain untested. Pending prompts are still absent from the session export.
- Next: configure and verify live Oracle API access, verify entitlements/monthly usage, image compatibility, capacity and related costs, then add a narrowly scoped OCI provisioner with reconciliation and cleanup. Add a second eligible provider before testing cross-provider migration.

See [readiness evidence](docs/evidence/00-readiness.md), [local restore evidence](docs/evidence/01-local-restore.md), the [first milestone brief](docs/plans/agent-router-first-milestone.md), [execution plan](docs/plans/agent-router-execution-plan.md), and [technical research](docs/research/agent-router-technical-build-blueprint.md). The earlier plans are design inputs; the evidence reports are the current implementation status.

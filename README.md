# Agent Router

Run a coding agent on compute in your own cloud accounts, with portable saved work and allowance-aware host selection.

**Status: initial compatibility harness.** Automatic VPS provisioning, allowance monitoring, provider switching, and a stable public connection are planned. They are not implemented yet. Oracle Cloud is the first intended provider; OpenCode is the first agent adapter.

## Run the local proof

Requires Node 24, pnpm 11.25.0, Git, and macOS or Linux. No cloud account or model API key is needed.

```sh
pnpm install --frozen-lockfile
pnpm readiness
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
```

The probe starts a password-protected OpenCode 2.2.7 server on loopback and checks authenticated access and rejection without credentials. The round trip creates a fixture with unfinished Git changes, records a completed shell turn in a real session, stops the source, copies the workspace, and imports the session into fresh agent state. It compares file hashes, executable flags, Git HEAD/index/status, session ID, and settled messages.

Each run uses private temporary directories under ignored `.work/`, a generated password, and isolated HOME/XDG directories. It excludes inherited model/cloud credentials and removes its temporary state after stopping its own processes. The shell command is a fixed fixture; these checks perform no model inference. Docker is reported as an optional local tool; the scripts run native processes.

## Optional cloud inspection

These commands only read account metadata. Run them yourself with a dedicated cloud configuration. Do not paste keys into chat, commit them, or place them in a workspace that an agent can read.

```sh
pnpm inspect:oci --config /absolute/path/to/oci-config --profile DEFAULT
pnpm inspect:aws --region us-east-1
```

OCI requires an existing API-signing configuration and permission to list the tenancy's region subscriptions. AWS uses the SDK credential chain and reads STS identity plus the Free Tier account plan. The scripts print selected metadata, omit account identifiers, and always return `provisioningAllowed: false`. Live account calls have not been verified for this project. Connection discovery does not establish free allowance, available capacity, or zero cost.

## Boundaries and next steps

- Export/import preserves supported settled history. OpenCode's pending prompt inbox is separate and is not included in the transcript export. Migration must drain or explicitly preserve pending work before cutover.
- A workspace copy requires quiesced writers. The current receipt rejects symlinks and special files, excludes `.git`, and records file bytes and executable flags. Git checks are separate; this is not a production snapshot engine.
- Real model authentication/resumption, native CLI reconnection, production backups, and cloud migration remain untested.
- Next: inspect Oracle access and tenancy-wide usage, implement consistent snapshots with restore verification, then add a narrowly scoped OCI provisioner with explicit eligibility/cost checks and cleanup. Add a second eligible provider before testing cross-provider migration.

See [observed evidence](docs/evidence/00-readiness.md), the [first milestone brief](docs/plans/agent-router-first-milestone.md), [execution plan](docs/plans/agent-router-execution-plan.md), and [technical research](docs/research/agent-router-technical-build-blueprint.md). The earlier plans are design inputs; the evidence report is the current implementation status.

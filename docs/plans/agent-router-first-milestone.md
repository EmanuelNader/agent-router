**First milestone execution brief: readiness and compatibility**

**Implementation update (2026-11-12):** The first code slice uses `scripts/readiness.ts` and typed fixture tools instead of the draft `.mjs` names below. It verifies authenticated HTTP access and a fresh-state round trip of settled shell history without model credentials. Interactive CLI reconnection, model recall, and account discovery remain open. Oracle is the first intended cloud connection because the user has an Oracle account. See `docs/evidence/00-readiness.md` for observed results; unchecked items below remain requirements for the full milestone.

> For agentic workers: use superpowers:executing-plans and complete the checkboxes in order. Work in a dedicated product repository at execution time. This brief validates dependencies and supported interfaces; it does not authorize live resource creation or claim the product already works.

**Goal:** Produce enough observed evidence to start implementing a portable OpenCode workspace on an eligible AWS/OCI pair without inventing cloud, authentication or session behavior.

**Architecture:** A minimal compatibility harness validates the agent locally and inspects cloud access without creating infrastructure. Results become fixtures and explicit requirements for later adapters. No dashboard is needed for this milestone.

**Tech stack:** Node 24, pnpm, TypeScript, a pinned OpenCode package, official AWS/OCI clients; Docker for fresh Linux runtime checks when the daemon is available.

**Global constraints:** Never print secrets or export a personal home directory. Do not create cloud resources, upgrade account plans, join an organization or enable paid features in this milestone. Require explicit saved-state comparisons. Record observed limitations as failed checks rather than guessing.

**Task 1: create a reproducible evidence workspace.**

Create `package.json`, `pnpm-lock.yaml`, `.gitignore`, `docs/evidence/00-readiness.md` and `scripts/record-runtime.mjs` in the new product repository. The repository location is chosen at execution; do not initialize the existing research-output directory accidentally.

- [ ] Check the runtime:

```sh
node --version
pnpm --version
docker version --format '{{.Server.Version}}'
```

Expected now: Node/pnpm return versions; Docker currently fails to reach its daemon. Start an available Docker engine before Linux container tests; do not interpret a skipped container test as passing.

- [ ] Initialize the repository and ignore secrets/work products:

```gitignore
node_modules/
.env
.env.*
!.env.example
.credentials/
.work/
```

- [ ] Resolve exact package versions once and save the resulting lockfile. The initial resolution uses the package registry; all subsequent installs use the saved lockfile:

```sh
pnpm add --save-dev --save-exact typescript @types/node
pnpm add --save-dev --save-exact @opencode/cli
pnpm add --save-exact @aws-sdk/client-sts @aws-sdk/client-freetier oci-sdk
pnpm exec opencode --version
```

- [ ] Record the repository root for commands run from the fixture directory:

```sh
export ROUTER_REPO_ROOT="$(pwd)"
```

Run this only from the new product repository root. Commands below use its local binary so they do not depend on a globally installed CLI.

- [ ] Record the installed dependency graph:

```sh
pnpm list --depth 0 --json
```

- [ ] Save these outputs and the matching release/documentation URLs in the evidence report; commit only non-secret configuration and the lockfile.

**Task 2: prepare a deterministic workspace fixture.**

Create `fixtures/workspace/README.md`, `fixtures/workspace/src/message.txt`, `fixtures/workspace/scripts/check.sh`, and `scripts/hash-fixture.mjs`. Use `.work/source/` and `.work/target/` for mutable copies, not the fixture source.

The fixture's exact initial contents are:

```text
README.md: router migration fixture
src/message.txt: before migration
scripts/check.sh: #!/bin/sh followed by a newline and printf 'fixture-ok\n'
```

- [ ] In the mutable source copy, initialize Git and commit the initial files.
- [ ] Change `src/message.txt` to `unfinished work survives migration` without committing it.
- [ ] Create an untracked `notes.txt` containing `keep this untracked note` and a hidden `.workspace-note` containing `keep this hidden note`.
- [ ] Rename `README.md` to `PROJECT.md` without committing; ensure the shell script has executable permissions.
- [ ] Produce a deterministic content receipt using this script, saved as `scripts/hash-fixture.mjs`:

```javascript
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const rows = [];
async function visit(relative = '') {
  const names = (await readdir(path.join(root, relative))).sort();
  for (const name of names) {
    if (name === '.git') continue;
    const item = path.join(relative, name);
    const stat = await lstat(path.join(root, item));
    if (stat.isDirectory()) await visit(item);
    else if (stat.isFile()) rows.push({
      path: item.split(path.sep).join('/'),
      executable: (stat.mode & 0o111) !== 0,
      sha256: createHash('sha256')
        .update(await readFile(path.join(root, item))).digest('hex'),
    });
    else throw new Error(`Unsupported fixture entry: ${item}`);
  }
}
await visit();
process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
```

- [ ] Run it twice and compare the receipts:

```sh
node scripts/hash-fixture.mjs .work/source
```

Expected: stable hashes, hidden/untracked files included and executable bit recorded. This is a file-content receipt; it deliberately excludes `.git` and does not prove Git history or agent-session recovery. Test those separately.

**Task 3: verify the pinned agent's remote interface.**

Create `docs/evidence/opencode-compatibility.md`. Inputs are the selected package/release from task 1 and a dedicated model account/API key supplied through its supported authentication mechanism. A credential is required only for the real model task, not installation or help inspection.

- [ ] Record release-local command help:

```sh
pnpm exec opencode serve --help
pnpm exec opencode session --help
pnpm exec opencode auth --help
```

- [ ] Compare the release's supported options with its matching documentation. If names differ from the research examples, document the difference and use release-local help/source; do not combine v1 and v2 settings.
- [ ] Start a loopback-only server from the mutable source directory using the pinned binary and a temporary dedicated password provided via the supported environment variable. Disable shell tracing. Avoid saving a server-generated password in public logs.

The documented command shape to validate is:

```sh
"$ROUTER_REPO_ROOT/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 4096
```

- [ ] Connect a separate client with the same pinned release:

```sh
"$ROUTER_REPO_ROOT/node_modules/.bin/opencode" --server http://127.0.0.1:4096
```

- [ ] Authenticate through a supported provider method and ask the agent to read the fixture and remember the unique phrase `router-fixture-7a91`.
- [ ] Record the session ID and verify that a client reconnect returns to the same session. Never save a raw credential export in `docs/evidence/`.

Set `ROUTER_SESSION_ID` in the test shell to the actual ID shown by the fixture's client session. It is a test input, not a hard-coded sample ID. The next task must not proceed until that session exists.

**Exit check:** Remote serving, authenticated client connection and reconnect are observed. If model authentication is unavailable, record the model task as untested; help output alone is not a pass.

**Task 4: verify session export/import on a fresh target.**

Create `docs/evidence/session-roundtrip.md`; store sensitive exports only under ignored `.work/` with restricted local permissions.

- [ ] From the repository root, export the recorded session through the pinned release's supported command, after confirming its output format with release-local help:

```sh
umask 077
pnpm exec opencode session export "$ROUTER_SESSION_ID" > .work/session.json
```

If the selected release writes an export file instead of JSON to standard output, use its documented output option and record the observed command. It must not be assumed that exports contain all files or credentials.

- [ ] Stop the source agent before collecting a consistent state copy. Stage a target workspace containing the fixture files, separately from the agent session export.
- [ ] Import the session into the target at the same intended workspace path using the supported command shape:

```sh
pnpm exec opencode session import .work/session.json --directory .work/target
```

The target-directory import first tests the release's documented path-remapping behavior. The fresh Linux-worker restore in milestone 1 additionally uses the same fixed workspace path on each host. If the selected release rejects directory remapping, record the failure and run this check in isolated workers with an identical path rather than masking the incompatibility. This validates the actual release interface; it is not a guessed REST API call.

- [ ] Start a fresh target process, connect to the imported session and ask it to return the remembered phrase.
- [ ] Compare source/target file receipts and verify Git status/history separately.
- [ ] Document which configuration, credentials and state required additional transfer and whether the session ID changed.

**Exit check:** A fresh process recovers both the expected conversation and separately transferred files. If it requires an undocumented personal-home copy, stop and revise the adapter design.

**Task 5: inspect the cloud accounts without creating resources.**

Create `docs/evidence/aws-readiness.md` and `docs/evidence/oci-readiness.md`. Use account aliases in documents and keep actual account IDs/credential files outside Git.

- [ ] AWS: verify the delegated identity with STS, read the Free Tier account plan through the official client, and record the plan state, expiry, balance timestamp and permission failures in sanitized form.
- [ ] AWS: identify the precise additional permissions needed for later VM/network/disk discovery and creation; record whether the planned account connection could change its plan. Do not perform an upgrade.
- [ ] OCI: verify the selected delegated access method, home-region visibility, resource inventory visibility and required compute/network/storage permission scope using official SDK operations.
- [ ] OCI: document what entitlement/usage data can actually be read. Do not substitute a fabricated credit-balance API or infer unused allowance from the instance list alone.
- [ ] Identify one prospective compatible CPU architecture, memory/disk allocation, image and network arrangement for each provider; list every unresolved eligibility/cost assumption.
- [ ] Record the applicable account/offer/model-authentication restrictions and any required provider clarification.

**Exit check:** Each report distinguishes observed facts, API documentation and remaining unknowns. This task is an API discovery spike; provider adapter code is planned after these actual responses establish its contract. It does not claim capacity has been reserved or that a VM launch is already authorized.

**Task 6: review the evidence and decide the next implementation slice.**

- [ ] Consolidate the dependency baseline, agent session results and two account reports into `docs/evidence/00-readiness.md`.
- [ ] Mark each check PASS, FAIL or UNTESTED and include the reason and source/observed output.
- [ ] Confirm sensitive transcripts, passwords, account identifiers and signing keys are absent from staged files.
- [ ] If the gate passes, prepare the local snapshot/restore implementation task plan using the observed state layout and release-specific commands.
- [ ] If the gate fails, record the exact adapter/provider change required. Continue independent local work where useful; do not advertise the failed combination as supported.
- [ ] Commit the sanitized evidence and exact lockfile.

The milestone is complete when its evidence is sufficient to specify a real adapter and one safe prospective provider pair. It is not complete merely because the packages install, and it is not a production-readiness claim.

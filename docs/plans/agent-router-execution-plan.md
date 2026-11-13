**Free-compute agent router: execution plan**

> For agentic workers: use the superpowers:executing-plans skill to execute the current milestone task by task. This document is a delivery plan with explicit validation gates. The first milestone has a separate execution brief. Later milestones receive code-level task plans after their prerequisite evidence is available; unverified API behavior must not be replaced with invented implementation details.

**Goal:** A user connects a supported coding agent and eligible cloud accounts; the service creates suitable hosts, tracks benefits, and automatically moves saved work to the next eligible provider through one stable connection.

**Architecture:** A persistent controller maintains provider entitlements and resource inventory in PostgreSQL, coordinates recoverable operations, and manages independent workers. Agent-specific adapters save and restore state. An authenticated gateway routes a stable workspace address to its current worker; encrypted snapshots live outside the departing customer's account.

**Initial stack:** TypeScript; Node 24; Next.js dashboard; Fastify API; DBOS durable operations; PostgreSQL; official AWS and OCI SDKs; cloud-init/systemd; restic; frp/Caddy. Exact dependency and binary versions are selected and pinned during the first milestone's compatibility check.

**Status on November 13, 2026:** The readiness slice is in this repository and recorded in `docs/evidence/00-readiness.md`: local OpenCode portability, read-only Oracle quota inspection, and deployment previews. Later milestones — provisioning, durable workflows, migration, and the dashboard — have not been started. Live Oracle and AWS account calls remain unverified.

**Constraints that apply to every milestone:**

- Initial workload: one selected OpenCode release. Additional CLIs use separate adapters after this release passes acceptance tests.
- Initial providers: AWS and OCI, contingent on validated account eligibility, permissions, capacity and compatible architecture.
- Use legitimate customer-owned accounts. No duplicate-account creation, credit transfer between customers, automatic paid upgrades or hidden paid fallback.
- Customer completes identity verification and grants account/model permissions. The service automates server work after authorization.
- Free-only placement rejects unknown, stale or insufficient eligibility; covers required disks, networking, snapshots and migration overlap as well as compute.
- A stable address may reconnect during migration. Arbitrary live processes and exactly-once external actions are outside the promise.
- Planned moves preserve the validated saved workspace. Unplanned recovery is limited to the last verified off-host checkpoint.
- One active controller initially; no implicit high-availability claim. PostgreSQL and snapshots are independent of customer trial expiry.
- No second active agent until the source is stopped or otherwise demonstrably fenced.
- Cloud-management secrets stay outside the customer agent. Workflow inputs/results and logs contain secret references rather than plaintext credentials.
- No public onboarding until tenant isolation, cleanup, export and failure handling pass their gates.
- Production use and marketing remain contingent on applicable provider offer terms and supported model authentication.

**Repository boundaries are fixed before implementation.** Create a dedicated product repository at execution time, separate from the research deliverables. These are proposed repository-relative paths, not existing files.

| Path | Owns |
| --- | --- |
| `apps/web/` | Dashboard and onboarding |
| `apps/control/` | Fastify API, workflow registration, scheduling and operation reconciliation |
| `apps/worker/` | Restricted host commands, heartbeats and local operation receipts |
| `packages/domain/` | Eligibility rules, migration transitions and snapshot contracts |
| `packages/cloud-aws/` | AWS permissions, benefits, resource lifecycle and inventory |
| `packages/cloud-oci/` | OCI permissions, benefits, resource lifecycle and inventory |
| `packages/agent-opencode/` | Pinned release authentication, export/import, pause/resume and health |
| `packages/snapshots/` | Consistent capture, restic execution and restore verification |
| `packages/protocol/` | Versioned, authenticated controller/worker messages |
| `packages/testkit/` | Reproducible fixtures, provider fakes and fault controls |
| `infra/bootstrap/` | Account delegation, network bootstrap and host installation |
| `tests/scenarios/` | End-to-end migration and recovery checks |
| `docs/evidence/` | Sanitized compatibility results and gate decisions |

Provider adapters consume a customer-scoped credential reference and operation ID. They return entitlement observations, candidate/resource IDs, health/fencing receipts and cleanup results. Agent adapters consume a workspace identity, fixed filesystem layout and pinned agent version; they return lifecycle receipts, state exports and verification reports. Neither adapter chooses the customer's spending policy.

**Milestone 0: prove access and compatibility.** This is the first work to execute, detailed in the companion brief. It deliberately starts before a public dashboard.

- [ ] Create the product repository and record exact tools/dependencies, source references and runtime checks.
- [ ] Validate the selected OpenCode release's remote client, authentication and session export/import locally.
- [ ] Inspect two legitimate test cloud accounts using delegated, initially read-only access. Record real benefit/permission evidence without secrets.
- [ ] Identify one compatible AWS/OCI host pair and every required resource's cost/eligibility assumptions. Capacity is an observation, not a reservation.
- [ ] Record provider-policy and model-authentication restrictions relevant to offering this publicly.
- [ ] Produce a pass/fail decision in `docs/evidence/00-readiness.md`.

**Gate:** Remote agent access and a session round trip are observed; cloud access and entitlement visibility are sufficient to define a safe launch attempt. If OCI balance or home-region evidence cannot be obtained, that connector remains unverified and must not silently qualify as free. A failing gate changes the connector design or supported pair, not the product's promise.

**Milestone 1: prove local workspace recovery.** Depends on the selected runtime and session behavior from milestone 0.

Files: `packages/agent-opencode/src/adapter.ts`, `packages/snapshots/src/capture.ts`, `packages/snapshots/src/restore.ts`, `packages/domain/src/snapshot.ts`, `tests/scenarios/local-restore.test.ts`.

- [ ] Create a fixture with tracked/untracked/hidden files, a rename, executable permissions and conversation history.
- [ ] Define a versioned manifest with workspace ID, architecture, agent version, runtime digest, exact snapshot ID, file hashes and consistency method.
- [ ] Pause/flush the agent and make an encrypted checkpoint to an independent test repository.
- [ ] Restore into a fresh worker directory/process and verify files plus session behavior.
- [ ] Reject wrong-version, incomplete and corrupted checkpoints.
- [ ] Record the source/target hashes and observed restart behavior in `docs/evidence/01-local-restore.md`.

**Gate:** The restored fixture matches the expected saved state and the agent can continue the prior conversation. An upload receipt alone cannot pass this gate.

**Milestone 2: prove recoverable controller operations.** Can be developed alongside local recovery after milestone 0; no cloud writes are necessary for its initial tests.

Files: `apps/control/src/workflows/provision.ts`, `apps/control/src/workflows/migrate.ts`, `apps/control/src/workflows/reconcile.ts`, `packages/domain/src/operations.ts`, `packages/testkit/src/fake-provider.ts`, database migrations and restart integration tests.

- [ ] Create PostgreSQL records for customers, workspaces, accounts, operations, resources, entitlement observations, checkpoints and active generations.
- [ ] Wrap bounded operations in DBOS and record immutable operation IDs before external calls.
- [ ] Use a fake provider that can accept a create request while withholding its response.
- [ ] Kill/restart the controller at the response/checkpoint boundary and verify reconciliation prevents duplicate creation.
- [ ] Verify cooperative timeout handling, finite retries, credential failures and duplicate requests.
- [ ] Test process restart against a real PostgreSQL instance; record executor/version settings.

**Gate:** Restart recovery resumes the correct operation, repeats safe reads, and does not issue an uncorrelated second create request. Provider API idempotency remains mandatory in the real adapters.

**Milestone 3: prove cloud creation and complete cleanup.** Depends on milestone 0 and the operation model. Live provisioning starts only after reviewing an exact resource/eligibility plan for the test accounts.

Files: `packages/cloud-aws/src/adapter.ts`, `packages/cloud-oci/src/adapter.ts`, their contract tests, `infra/bootstrap/`, and `docs/evidence/03-cloud-lifecycle.md`.

- [ ] Implement scoped account access, account-level resource inspection and candidate selection.
- [ ] Persist AWS/OCI retry tokens and tag every owned resource with its operation/workspace identity.
- [ ] Provision one worker at a time with pinned bootstrap assets and a one-use registration token.
- [ ] Wait for both provider readiness and authenticated worker readiness.
- [ ] Exercise stop/fence and verify the observed stopped state.
- [ ] Delete owned resources; enumerate leftovers including disks, IPs, snapshots and shared-network references.
- [ ] Record latency, actual resource IDs, API errors, benefit observations and cost assumptions, with secrets removed.

**Gate:** Each provider can create, inspect, fence and clean up a worker with the intended restricted access. Unknown account-wide eligibility or an untracked resource blocks the gate. Provider no-charge plans and free-only estimation must be distinguished in evidence.

**Milestone 4: prove a real cross-cloud handoff.** Depends on local restore, operation recovery and both cloud lifecycle checks.

Files: `apps/worker/src/commands/`, `packages/protocol/src/messages.ts`, `apps/control/src/workflows/migrate.ts`, gateway authorization/routing files and `tests/scenarios/cross-cloud-move.test.ts`.

- [ ] Connect the user through a stable authenticated workspace address.
- [ ] Prepare the destination without activating a second agent.
- [ ] Pause the source and create the final verified off-host checkpoint.
- [ ] Confirm source fencing, restore the destination and check its agent state.
- [ ] Switch the route and reconnect the user without silently resubmitting a prompt.
- [ ] Clean up the recorded source resources.
- [ ] Repeat the handoff with a source/target fixture comparison and record interruption, transfer, overlap and cleanup results.

**Gate:** The actual agent continues through the same logical address with its expected conversation and unfinished files. Only one worker generation can act. A demo with an empty new session does not pass.

**Milestone 5: make allowance-triggered switching automatic.** Depends on a repeatable real handoff.

Files: `packages/domain/src/placement.ts`, `packages/domain/src/allowance.ts`, provider entitlement readers, controller schedules and `tests/scenarios/allowance-trigger.test.ts`.

- [ ] Normalize observed balances, expiries, monthly resets and timestamps without assuming identical APIs across clouds.
- [ ] Track estimated consumption and reconcile it with provider data and other account workloads.
- [ ] Calculate reserves for data lag, boot/transfer time, temporary overlap and cleanup.
- [ ] Reject incompatible CPU/memory/storage/architecture candidates and unknown benefits.
- [ ] Inject a clearly labeled simulated allowance threshold while using real hosts and real migration.
- [ ] Verify no-destination behavior: retain the source while safe, then pause and alert instead of selecting paid compute.

**Gate:** A policy event triggers the established handoff without a manual server command. Exhausted or uncertain benefits cannot produce a silent paid fallback. A simulated trigger proves routing behavior, not the accuracy of every provider's billing observations.

**Milestone 6: failure, isolation and recovery checks.** Depends on the automated prototype.

- [ ] Interrupt the controller before and after every durable migration phase.
- [ ] Partition the old worker from the controller while leaving its external internet access available.
- [ ] Test revoked cloud/model credentials, stale data, expired idempotency windows, corrupted backups and unavailable destinations.
- [ ] Verify stale routes/tokens and another customer's identity cannot access the workspace.
- [ ] Verify the coding agent cannot read cloud-management secrets, controller/gateway admin interfaces or other tenants' backups.
- [ ] Verify uncertain external actions produce a reconcile/review state rather than blind replay.
- [ ] Test restart during cleanup and later detection of billable remnants.
- [ ] Test a controller/agent version change while an operation is pending.

**Gate:** Every case has an expected result and evidence. Planned migration loses no acknowledged saved work in the fixture. Unplanned recovery reports the last verified checkpoint. Outstanding data-loss, duplicate-active-worker, isolation or uncontrolled-spending failures block public access.

**Milestone 7: small public pilot.** Depends on failure checks and applicable provider/model permissions.

Files: `apps/web/`, authentication and account-connection routes, workspace access/export/delete endpoints, operator recovery runbooks and `docs/evidence/07-pilot.md`.

- [ ] Provide guided account/model connections and an explicit preview of what will be created.
- [ ] Show concise running/moving/paused/reconnect-needed states and why no eligible host is available.
- [ ] Provide revocation, export, deletion and resource cleanup status.
- [ ] Run a small invitation-only pilot with supported combinations displayed clearly.
- [ ] Measure activation failures, recurring usage, migration success, interruption, support work, leftover costs and willingness to pay.

**Gate:** Real users can complete authorization and useful work, understand a demonstrated migration, and recover/export their data. Decide whether the current product is worth expanding from observed results rather than waitlist count alone.

**Expansion begins only after the shared migration contract is proven.** Add another CLI as an agent adapter, another provider as a cloud adapter, and qualify each supported pair. Codex CLI, Claude Code, OpenClaw and Hermes are candidates, subject to their official remote-authentication and resume interfaces. MausBot/OpenBot require their own runtime/dependency checks. The shared orchestration remains the same; claims of session portability are integration-specific.

**Acceptance evidence should be machine-readable where practical.** Each gate report records the repository commit, exact tool/runtime versions, test timestamp, account aliases without identifiers/secrets, fixture hash, test command, expected and observed result, created resource inventory, cleanup receipt and unresolved limitations. Evidence from fakes, local containers and live cloud accounts must be labeled separately.

The initial risk register is finite and actionable:

| Uncertainty | First proof | Decision if it fails |
| --- | --- | --- |
| Required free-account delegation works | Milestone 0 account inspection | Revise connection method or provider pairing before provisioning |
| Account benefits are observable sufficiently well | Milestone 0 entitlement report | Mark unknown and block automatic free-only selection |
| Selected agent state can round-trip | Milestones 0–1 | Change adapter/version or explicitly narrow supported state |
| Both destinations fit architecture/resources | Milestones 0 and 3 | Select a compatible pair; no undersized fallback |
| Old worker can be fenced after a partition | Milestones 3 and 6 | Pause recovery rather than activate a second agent |
| Controller can resume ambiguous operations | Milestones 2 and 6 | Repair idempotency/reconciliation before further automation |
| Benefits justify onboarding/support effort | Milestone 7 | Reassess this product before expanding the catalogue |

**Start with milestone 0.** Local compatibility work can proceed before cloud credentials exist. Cloud inspection requires two eligible accounts and supported model authentication; actual provisioning requires an exact approved/authorized resource plan. Those inputs cannot be manufactured by the implementation plan. No dates or $0 guarantees should be committed until the observed results support them.

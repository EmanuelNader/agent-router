**Technical build blueprint for the free-compute agent router**

> **Superseded in part on November 17, 2026:** See [2026-11-17-market-and-architecture-reassessment.md](./2026-11-17-market-and-architecture-reassessment.md) and [agent-router-execution-plan.md](../plans/agent-router-execution-plan.md). The hosted `Next.js` + `Fastify` + `PostgreSQL` + `DBOS` + `frp`/`Caddy` control plane proposed below was pruned in favor of a local-first BYOC CLI using an atomic local operation journal, `restic` snapshots, and Tailscale / OpenCode `OpenTunnel` (`opencode pair --remote`). Adapter isolation, idempotency tokens, fencing, and `restic` verification principles remain active.

Prepared November 12, 2026. This extends the earlier feasibility report and keeps the original product intact: users connect their own coding agents/bots and eligible cloud accounts; the service provisions suitable free compute and moves saved work between providers as benefits expire or run out. Research used Firecrawl repository/documentation retrieval and Context7 checks. Source inspection is distinguished below from proposed design. No dependencies were installed, application code written, cloud accounts connected, or migrations executed.

**Recommendation: begin with a TypeScript monorepo, PostgreSQL, DBOS durable workflows, official AWS/OCI SDKs, a small worker, restic, and a gateway built from existing proxy components.** The first workload should be one pinned OpenCode release; the first cloud pair to validate should be AWS and OCI. Cross-provider migration belongs in the initial prototype. The stack recommendation is engineering judgment based on the inspected interfaces, not a completed compatibility benchmark.

An all-TypeScript control service is practical because Oracle maintains a Node-compatible TypeScript SDK and AWS publishes modular JavaScript clients, including its Free Tier client. Oracle explicitly lists Node 24 among supported runtimes. Node 24 is therefore a reasonable initial compatibility target, subject to running the selected package versions together. This is more concrete than the earlier report's provisional suggestion of a Python controller. [OCI SDK](https://github.com/oracle/oci-typescript-sdk), [AWS Free Tier SDK client](https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-freetier).

| Component | Initial choice | Responsibility and boundary |
| --- | --- | --- |
| Dashboard | Next.js with TypeScript | Account connections, workspace status, policy choices, export/delete and activity history; a normal frontend choice rather than a migration dependency |
| API and controller | Fastify on Node 24, with DBOS in a persistent control service | Authenticated requests, provider adapters, durable provisioning/migration operations; keep API and workflow logic in one deployable service initially |
| Durable jobs | DBOS TypeScript SDK | Persist operation progress, retries and schedules in PostgreSQL; not a substitute for cloud-side idempotency |
| State | PostgreSQL | Customer ownership, resources, entitlement observations, snapshot manifests, operation IDs and workflow metadata |
| Authentication | Better Auth with its documented Fastify integration, or a managed identity service if preferred | User login/session handling; workspace authorization remains application code. [Integration](https://www.better-auth.com/docs/integrations/fastify) |
| Cloud access | Official AWS JavaScript v3 clients and OCI TypeScript SDK | Inspect benefits, launch compatible resources, wait for readiness, fence old hosts and clean up |
| Host initialization | cloud-init and systemd; versioned worker/runtime images | Make each new host reproducible; changing bootstrap data does not update an already-running installation |
| Host worker | Small TypeScript service at first | Heartbeats, restricted agent lifecycle commands, local operation receipts, snapshot coordination and signed command verification |
| Agent | Pinned OpenCode release and a dedicated adapter | Serve remotely, export/import sessions, authenticate, pause/resume and report health |
| Backups | restic to operator-controlled off-host object storage | Encrypted incremental backup/restore; agent adapter makes the data application-consistent first |
| Connectivity | frp tunnel plus Caddy reverse proxy and product authorization | Stable public connection, worker-initiated transport, streamed responses and routing to the active generation |
| Verification | A TypeScript test runner, Testcontainers PostgreSQL, Toxiproxy and real-cloud contract tests | Exercise actual persistence and failure boundaries; mocks alone cannot establish billing or account eligibility |

The controller must run on infrastructure we operate independently of a user's expiring trial. PostgreSQL and backup storage must also survive the departure of either customer cloud account. There are real product operating costs even when a customer's VM is covered by free benefits. A single persistent controller and managed PostgreSQL are sufficient for a prototype; that is not a claim of high availability.

**The open-source building blocks are real, but each has a specific role.** These license observations cover the inspected upstream projects, not every transitive dependency, container image, plugin or hosted service. Pin a release/commit, preserve required notices, and inventory the actual distributed artifacts before shipping.

| Project | Inspected license | Reuse recommendation |
| --- | --- | --- |
| [DBOS TypeScript](https://github.com/dbos-inc/dbos-transact-ts) | [MIT](https://github.com/dbos-inc/dbos-transact-ts/blob/main/LICENSE) | Use the SDK directly for durable operations; do not fork its engine |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) | [Apache-2.0](https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE) | Use modular clients for EC2, STS, Free Tier and object storage |
| [OCI TypeScript SDK](https://github.com/oracle/oci-typescript-sdk) | UPL-1.0 or Apache-2.0, documented as a choice | Use its service clients and examples; server-side only. [License statement](https://github.com/oracle/oci-typescript-sdk#license) |
| [OpenCode](https://github.com/anomalyco/opencode) | [MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE) | Run a pinned binary and build an adapter around its documented interfaces; retain its native UI where possible |
| [restic](https://github.com/restic/restic) | [BSD-2-Clause](https://github.com/restic/restic/blob/master/LICENSE) | Use the CLI for encrypted backups and restore verification |
| [frp](https://github.com/fatedier/frp) | [Apache-2.0](https://github.com/fatedier/frp/blob/dev/LICENSE) | Use as a transport component with explicit authentication, certificate verification and proxy-ownership enforcement |
| [Caddy](https://github.com/caddyserver/caddy) | [Apache-2.0](https://github.com/caddyserver/caddy/blob/master/LICENSE) | Use for HTTPS and reverse proxying; keep its management API private |
| [Better Auth](https://github.com/better-auth/better-auth) | [MIT](https://github.com/better-auth/better-auth/blob/main/LICENSE.md) | Use its documented framework integration; add explicit tenant/workspace authorization |
| [Testcontainers Node](https://github.com/testcontainers/testcontainers-node) | MIT in the inspected package metadata | Run real PostgreSQL and network-fault tooling in tests. [Toxiproxy module metadata](https://github.com/testcontainers/testcontainers-node/blob/c79a5a56bcc824e207ac243207bd83e5b0459dd3/packages/modules/toxiproxy/package.json) |

There is a concrete reason to inspect license files rather than trust badges. The README of [filippolmt/terraform-oci-free-tier](https://github.com/filippolmt/terraform-oci-free-tier) says MIT, but the retrieved [LICENSE file](https://raw.githubusercontent.com/filippolmt/terraform-oci-free-tier/main/LICENSE) contains GPLv3. A live retrieval confirmed the discrepancy. Keep it as a reference until its licensing is clarified or a suitable licensed revision is selected; this report does not recommend treating it as MIT code.

Its source also reveals implementation caveats. [checks.tf](https://github.com/filippolmt/terraform-oci-free-tier/blob/main/checks.tf) treats an unknown home region as a match and evaluates the module's configured quantities rather than the customer's total usage across all workloads. [compute.tf](https://github.com/filippolmt/terraform-oci-free-tier/blob/main/compute.tf) ignores later user-data changes. Our free-only policy must block unknown eligibility, inspect account-wide consumption, and manage worker upgrades separately. Those are design lessons from source inspection, not code to copy without resolving the license.

**DBOS is a useful first choice because it reduces the amount of workflow infrastructure we must operate.** Its library records progress in PostgreSQL and can resume interrupted work. The main reason to adopt it is that provisioning and migration span multiple external requests and can be interrupted between any two of them. [Project](https://github.com/dbos-inc/dbos-transact-ts).

A single-server deployment can recover pending operations when its process restarts. A distributed deployment needs executor IDs and explicit recovery management, or Conductor. We should begin with one active, supervised controller and test restart recovery, then deliberately design failover before adding replicas. [Production recovery](https://docs.dbos.dev/production/workflow-recovery).

DBOS can persist one recorded outcome while external steps still execute at least once. A cloud API call might succeed immediately before the checkpoint write fails. It is incorrect to interpret durable execution as a guarantee that only one server will be created. [Concurrent execution semantics](https://docs.dbos.dev/explanations/concurrent-executions).

Use a persisted operation ID, immutable launch parameters, and the provider's idempotency mechanism for every supported create call. AWS RunInstances accepts ClientToken; OCI LaunchInstance accepts opcRetryToken, with a documented finite validity period. Reconcile ambiguous outcomes against known resource IDs/tags before issuing a fresh operation. Token expiry, region/zone scope and resource-specific behavior are part of each adapter's contract. [AWS RunInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html), [OCI LaunchInstance request](https://docs.oracle.com/en-us/iaas/tools/typescript/latest/interfaces/_core_lib_request_launch_instance_request_.launchinstancerequest.html).

Step timeouts are cooperative in DBOS: a function that ignores the abort signal can keep running after a timeout. Propagate supported cancellation signals, and treat a timed-out creation as an unknown outcome to reconcile. Credential or configuration failures should not receive endless capacity retries. [Step retries and timeouts](https://docs.dbos.dev/typescript/tutorials/step-tutorial).

Workflow upgrades need planning. Pin workflow versions and keep old code running long enough to drain or recover its operations, or use documented compatible patches. Do not assume optional enterprise auto-upgrade features are part of the open-source plan. Keep long-lived workspace records in our own schema and use bounded workflows for provisioning, a migration, cleanup and reconciliation, rather than one never-ending workflow for each customer. [Workflow code upgrades](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows).

Temporal is a valid alternative if its ecosystem and operational model are preferable, especially for a team already familiar with it. It requires a Temporal service in addition to workers and persistence; it does not inherently require Cassandra plus Elasticsearch, since SQL persistence/visibility are supported. Its activities also need idempotency. DBOS is the initial recommendation for a small team, not a claim that Temporal is unsuitable. [Temporal persistence](https://docs.temporal.io/temporal-service/persistence), [activity idempotency](https://temporal.io/blog/idempotency-and-durable-execution).

**Use native provider SDKs first and keep infrastructure ownership explicit.** With two providers and a constrained resource model, the necessary operations can fit behind small adapters. The code must maintain a durable resource inventory and implement cleanup/reconciliation; SDKs do not provide those product guarantees for us.

An alternative is [Pulumi Automation API](https://www.pulumi.com/docs/iac/concepts/automation-api/), which can drive infrastructure programs from application code. It is relevant for SaaS provisioning and may become worthwhile with larger resource graphs. It still uses the Pulumi CLI under the hood and adds stack/state/backend management. Do not give Pulumi and a direct SDK adapter competing ownership of the same resources. The first prototype should choose one mechanism for the worker resource lifecycle.

Provider adapter responsibilities should be explicit: validate delegated access; inspect entitlements and current resources; enumerate compatible candidates; provision with an idempotency record; wait for worker readiness; stop or fence a worker; reconcile uncertain outcomes; and remove the recorded resource set. Separate per-account bootstrap resources, such as a reusable network, from per-workspace VM resources so deleting one workspace cannot destroy another's shared network.

Entitlement observations should carry provider/account ID, plan type, benefit kind, region and shape constraints, start/expiry/reset times, reported balance, report timestamp, estimated usage, data source and confidence. Distinguish verified, unknown and expired eligibility. A boolean named free is not enough.

AWS has a documented [GetAccountPlanState API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_freetier_GetAccountPlanState.html) and JavaScript client support for plan state. For OCI, the first spike must validate how to discover current account usage, home region and required permission scope. Do not invent an OCI equivalent credit-balance API or silently treat a missing field as an unused allowance.

Use scoped delegation and temporary credentials where supported. API inputs and workflow records should carry secret references, not plaintext signing keys or model credentials. Cloud management credentials belong in the controller, not inside the coding agent's environment. Worker bootstrap should exchange a short-lived one-use registration token for its own restricted identity; long-lived cloud account keys must not be embedded in cloud-init user data.

**The agent adapter should use one versioned protocol and a fixed workspace layout.** Start by running OpenCode as a supervised foreground service on the VM, listening on loopback. The tunnel exposes that service through our authenticated gateway. Its current documentation supports opencode serve and connecting with opencode --server. [Current remote-access documentation](https://opencode.ai/docs/cli/web/).

Version alignment matters: the current CLI web docs use OPENCODE_PASSWORD and describe a newer server layout, while older v1 server docs use different configuration names. Pin the binary, client and command reference together; do not assemble an adapter from examples belonging to different major versions. Initial export/import can use the selected release's CLI rather than assuming an old REST endpoint remains valid.

OpenCode separately documents session export/import and authentication migration. Build a fixture containing conversation history, tracked and untracked changes, a renamed file, executable permissions, selected configuration and an explicit model credential. Verify what each export contains and back up the remaining files separately. [Current CLI commands](https://opencode.ai/docs/cli/commands/).

A snapshot manifest should record the logical workspace ID, agent release, snapshot format, CPU architecture, runtime image digest, required files, exact restic snapshot ID, checksums, database-consistency method, credential references and completed verification checks. Keep the workspace at the same Linux path on both hosts. Rebuild architecture-specific dependencies rather than copying AMD64 binaries onto ARM64. Initially require compatible architectures unless the cross-architecture path has passed its own test.

Reusing the agent UI avoids rebuilding chat. Our dashboard should primarily show where the workspace runs, available benefits, migration status, account connection problems and export/delete controls. A small launcher can handle product authentication and reconnect behavior. Native clients and browser pairing must be tested through the gateway; keeping a domain name does not preserve an existing TCP connection.

**Backups must be recoverable, not just uploaded.** restic supplies encryption, incremental snapshots and a documented restore interface. Put its repository outside the departing customer's cloud account, isolate repositories/credentials by workspace, and restore the exact snapshot recorded in the migration operation. [restic](https://github.com/restic/restic), [restore documentation](https://restic.readthedocs.io/en/latest/050_restore.html).

Before taking a planned-migration checkpoint, pause the agent and flush/export its state. An encrypted copy of a changing database can still be inconsistent. After restore, verify the file manifest and reopen the agent database or import its session before allowing live tasks. Cache exclusions must be explicit; uncommitted, untracked or hidden working files should not disappear simply because Git does not track them.

Run repository integrity checks and periodic full restore drills. restic's default check verifies structure; reading all stored data is a separate check mode. Backup success is not evidence that an application will resume correctly. [Integrity checks](https://restic.readthedocs.io/en/latest/045_working_with_repos.html).

The coding agent should not receive authority to delete historical backups. Keep retention/pruning under controller ownership and validate the chosen storage permission model, including restic lock handling. Retention should use controller-verified snapshot receipts; do not trust arbitrary client-provided timestamps as proof that a checkpoint is good.

**Stable connectivity requires both transport and product authorization.** frp provides a worker-initiated reverse tunnel, while Caddy handles public HTTPS and supports WebSocket proxying and streaming. Neither replaces our customer/workspace authorization checks. [frp](https://github.com/fatedier/frp), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Force TLS and verify the server certificate. frp's inspected README explicitly notes that server-certificate verification depends on configuring trusted/system CAs; TLS enabled by itself is insufficient. Its server-plugin hooks can reject Login and NewProxy operations. Use them, or an equally enforced boundary, to bind each worker identity to its allowed workspace route and generation. Free-form metadata claiming a workspace ID is not proof of ownership. [Server plugin interface](https://github.com/fatedier/frp/blob/dev/doc/server_plugin.md).

Gateway routes should resolve a stable logical workspace to the current authorized worker generation. Switching generations must revoke old worker routing rights. A lease or database flag alone does not stop a disconnected process from making external API calls. A handoff must confirm source shutdown or enforce a real fence before the replacement can perform work; uncertain external actions after an unexpected crash require reconciliation.

**The migration should be an explicit durable state machine.** Proposed phases are: requested, destination-prepared, agent-quiesced, checkpoint-verified, source-fenced, destination-restored, destination-healthy, route-switched and cleanup-complete. The labels describe persisted progress, not commands the customer sees.

Prepare the destination without activating its agent. Pause the source, produce the final verified checkpoint, and then fence the source. Restore and validate the target before moving the route. If target preparation fails, keep the source running while its allowance permits. If a failure occurs after the source was fenced, recovery must either restart the safe source or complete the target, according to recorded state and available allowance. Never blindly restart both.

Serialize operations per workspace and persist operation IDs before cloud calls. Record cloud IDs as soon as they are known. Reconcile pending creations, leaked disks/IPs and incomplete cleanup on a schedule. Ensure operations remain safe when the controller dies immediately after any external response, a network request times out but later succeeds, or a cancellation arrives during a restore.

The policy module should be deterministic code. It evaluates workload CPU/memory/disk/architecture requirements, remaining verified benefits, billing-data freshness, migration reserve and the cost of every required resource. Unknown eligibility blocks free-only placement. A language model may explain a placement decision but should not authorize spending or rewrite the rules while provisioning.

**A practical repository layout keeps these responsibilities separate.** These paths describe a proposed new repository; they have not been created.

```text
apps/web/                 account and workspace dashboard
apps/control/             Fastify API and DBOS workflows
apps/worker/              restricted VM lifecycle service
packages/domain/          policy rules, state transitions and manifests
packages/cloud-aws/       AWS adapter and reconciliation
packages/cloud-oci/       OCI adapter and reconciliation
packages/agent-opencode/  pinned release adapter
packages/snapshots/       restic invocation and restore verification
packages/protocol/        versioned worker messages and validation
packages/testkit/         fixtures, fault controls and fake provider APIs
infra/bootstrap/          scoped delegation and host initialization
tests/scenarios/          migration and recovery acceptance tests
```

Begin with ordinary workspace tooling and a lockfile. Pin worker image digests, agent binaries, backup/tunnel binaries and bootstrap assets. Do not use an unaudited runtime curl-to-latest installer for every customer deployment. Bootstrap creates a host; authenticated, versioned worker operations manage its later lifecycle.

**Testing must prove behavior at the boundaries where money or data can be lost.** Testcontainers can run actual PostgreSQL in integration tests; Toxiproxy can introduce latency, connection loss and resets. Use provider fakes for deterministic policy/error cases and real cloud accounts for the behaviors fakes cannot establish. [PostgreSQL test module](https://node.testcontainers.org/modules/postgresql/), [Toxiproxy](https://github.com/Shopify/toxiproxy).

| Scenario | Required outcome |
| --- | --- |
| Kill controller after the cloud accepted create but before our DB checkpoint | Recovery finds/reuses the recorded request/resource rather than creating another VM |
| Kill controller at every migration phase | Operation resumes or rolls back according to its persisted phase; no two active agents |
| Worker loses contact with controller but can still reach the internet | A replacement is not activated until the old worker is fenced; a stale heartbeat alone is not proof of death |
| Agent has uncommitted and untracked files | Planned handoff preserves the fixture's exact expected files and conversation state |
| Source dies before final checkpoint | Restore the last verified off-host snapshot and disclose the measured recovery point |
| Snapshot upload succeeds but data is damaged | Verification fails and the source is not deleted based only on upload status |
| Cloud data is stale, home region unknown, or account allowance already consumed elsewhere | Free-only policy blocks placement or pauses safely |
| Destination lacks memory, architecture compatibility or capacity | No incompatible fallback and no silent paid resource |
| Model/cloud credentials are revoked | Show a reconnect-needed state without retry storms or leaking credentials |
| Retry begins after a provider idempotency token expires | Reconcile inventory first; do not assume the old token still deduplicates |
| Old gateway route or worker token is reused | Reject the stale generation and cross-tenant access |
| Stream drops during migration | Client reconnects to the logical workspace without silently replaying a prompt |
| VM is deleted but disks or IPs remain | Resource reconciliation identifies remaining charges and performs authorized cleanup |
| Workflow or agent release changes during an operation | Version policy allows compatible recovery or retains the appropriate old executor/runtime |

Planned migration should lose none of the acknowledged saved work in the test fixture. Measure interruption time, restore duration, checkpoint age, transfer volume, temporary overlap cost and leftover resources. Establish an unplanned-failure recovery-point target only after measuring checkpoint cost and successful restores on a specified reference workspace. These are proposed acceptance requirements, not achieved performance claims.

Run credential-isolation checks as part of the same test harness: the customer agent cannot read cloud-management credentials, gateway admin endpoints, another tenant's state, or unrestricted instance metadata credentials. Keep host management outside the agent container/user boundary; do not expose a Docker socket as a convenience feature. These boundaries are part of making a public coding-agent host work correctly.

**Build in an order that retires the largest uncertainties early.** First validate delegated access and exact SDK operations in legitimate AWS/OCI test accounts. Then run one supported OpenCode release on a local worker, make and restore a real snapshot, and verify remote client behavior through the proxy. Next provision two compatible cloud hosts and trigger a manual cross-cloud handoff. Add allowance-triggered automation only after that same handoff is repeatable. Finally run the failure matrix and expose a small public onboarding flow.

The first vertical slice should accept one repo and explicit supported model credentials, create a remote agent, save a conversation plus uncommitted files, and move them through the same public workspace connection. Induce the allowance threshold in test data rather than waiting months for a real trial to expire. Mark this clearly as a simulated threshold while the servers and migration are real.

The product-specific code we still need to write is substantial: entitlement normalization, safe placement, scoped account onboarding, provider resource reconciliation, an agent lifecycle adapter, consistent snapshot manifests, a fenced migration state machine, gateway ownership enforcement and client reconnect behavior. Existing open-source projects cover useful mechanisms; none of the inspected projects supplied this entire product as a ready-to-fork implementation.

Before promoting the prototype, resolve these open questions with measured evidence: whether both free account types support the chosen delegation model; which OCI usage/eligibility data is available with the minimum permissions; whether the selected OpenCode release round-trips the required session state; whether its native clients work through the authenticated gateway; whether the snapshot permission model supports safe locks and retention; and what interruption, egress and overlap costs the first real migrations incur.

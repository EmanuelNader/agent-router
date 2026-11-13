# Initial implementation evidence

Recorded 2026-11-12. This is a partial readiness milestone, not a production or free-hosting claim.

| Check | Observed result | Scope |
| --- | --- | --- |
| Node/pnpm | PASS: Node 24.18.1, pnpm 11.25.0 | Local macOS arm64 |
| Docker engine | AVAILABLE: 29.6.2 | Container migration not exercised |
| OpenCode | PASS: installed `@opencode/cli` 2.2.7 | Exact package and dependencies in lockfile |
| Isolated authenticated HTTP server | PASS | Loopback; random password; no inherited user/model/cloud configuration |
| Unauthorized request | PASS: HTTP 401 | Session listing endpoint |
| Ancestor project configuration | PASS: fixture marker excluded | Project and Claude discovery disabled; actual configuration endpoint checked |
| Fresh-state session import | PASS | Same session ID and settled shell-message history; asserted target-directory binding and successful completed shell output |
| Workspace copy | PASS | File hashes, hidden/untracked/modified/renamed files, executable flag, Git HEAD/index/status |
| Pending user input | LIMITATION | `resume: false` queues a prompt; it is absent from transcript export |
| Model inference and conversational recall | UNTESTED | No model credential supplied or accessed |
| Native CLI reconnect | UNTESTED | HTTP client exercised; interactive terminal client not exercised |
| Linux runtime | UNTESTED locally | Ubuntu CI configured; record actual CI result separately |
| OCI account discovery | UNTESTED | User has an Oracle account; no credentials read or requests made |
| AWS account discovery | UNTESTED | No AWS account connected |
| Cloud provisioning and free eligibility | NOT IMPLEMENTED | Read-only discovery cannot authorize launch |
| Automatic migration/stable ingress | NOT IMPLEMENTED | Later milestone |

## Reproduce

From the repository root, run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm readiness`, `pnpm agent:probe`, and `pnpm agent:roundtrip`. Scripts print bounded receipts without transcripts or passwords and return nonzero on a failed assertion. The round trip uses completed shell history so it can test a real nonempty session without making model calls. It does not prove model-generated conversation resumption.

`pnpm fixture:create` also creates a persistent disposable fixture at `.work/source`, refusing to overwrite an existing copy. `pnpm fixture:hash .work/source` prints its content receipt. These are local fixture tools, not a backup format.

## Release-specific findings

The checked release is [OpenCode v2.2.7](https://github.com/anomalyco/opencode/tree/v2.2.7), commit `fedc6f208aa2bd54c1019227214568083f6380ad`. Its [protocol](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/protocol/src/groups/session.ts) defines the v2 endpoints exercised by the adapter:

- `GET /api/session`: authenticated readiness check.
- `POST /api/session`: create at an explicit workspace directory.
- `POST /api/session/:id/shell`: execute a completed fixed fixture command without model inference.
- `GET /api/experimental/session/:id/export`: returns `{data: {info, messages}}`.
- `POST /api/experimental/session/import`: accepts `{info, messages, location}` and preserves the session ID on a fresh target.

`OPENCODE_PASSWORD` protects the server using HTTP Basic authentication with username `opencode`. Transfer routes are experimental and require a pinned-version compatibility test. The client does not send credentials over non-loopback HTTP, follow redirects, or include upstream error bodies in error messages.

A pending prompt is durably admitted to the inbox, but is not settled history. The first round-trip test deliberately failed when it expected a queued prompt in export. Changing the fixture to a completed shell turn established the supported saved-history boundary. Future migration must stop accepting input and drain or explicitly transfer pending inbox items; copying a transcript alone can lose queued work.

## Remaining gates

Code review found that isolated HOME/XDG paths alone did not prevent ancestor `opencode.json` discovery. A regression reproduced the leak before the fix and now verifies its exclusion via the real configuration endpoint. The harness sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_DISABLE_CLAUDE_CODE=1`, following the [pinned server startup](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/server-process.ts). Review also strengthened the shell-history check: the fixture now requires exited status, zero exit code, completion timestamp, exact captured output, and target-directory rebinding. TypeScript checks, 14 unit tests, the auth/config probe, and the strengthened native round trip pass locally.

1. Verify OCI delegated access, actual home region, compartment inventory, entitlement/tenancy-wide usage, architecture and image compatibility, and all related costs. Unknown data must block provisioning.
2. Build and failure-test quiescing, encrypted snapshots, restore verification, and pending-input handling.
3. Verify supported model authentication and real task resumption without copying a personal home directory.
4. Test idempotent OCI creation/reconciliation/deletion in a dedicated compartment; prove cleanup and budget controls.
5. Connect a second eligible provider and test interrupted migration, rollback, and stable ingress.

The complete first milestone remains open until the missing account and live-model evidence is available. No cloud resources have been created.

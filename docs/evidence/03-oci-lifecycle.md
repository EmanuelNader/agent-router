# Milestone 3 implementation evidence: guarded OCI lifecycle adapter and unified router CLI

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `oci-sdk 2.146.0`). This proves the local fail-closed OCI worker provisioner, crash reconciliation via operation tags, zero-remnant teardown checks, and unified `pnpm router` CLI against deterministic fault injection; live OCI `ComputeClient` / `BlockstorageClient` / `VirtualNetworkClient` mutations remain separate opt-in live checks scoped to a dedicated compartment.

| Check | Observed result | Scope |
| --- | --- | --- |
| Locked-down worker `#cloud-config` (`renderWorkerCloudInit`) | PASS | Non-root `agentrouter` user (`sudo: false`), root/password SSH disabled, `@opencode/cli@2.2.7` bound strictly to `127.0.0.1:4096`, zero cloud keys on host |
| Pre-flight fail-closed launch gates | PASS | Rejects `DEMO` or stale (>15m) evidence, enforces `GUARDED_QUOTA_FITS`, requires `VM.Standard.A1.Flex` (`bootVolumeVpusPerGB: 10`, `assignPublicIp: false`), and blocks subnets with inbound security rules (`ingressRuleCount > 0`) |
| Post-launch crash & >24h `opcRetryToken` expiry reconciliation | PASS | Simulated transport crash after instance creation marks `NEEDS_RECONCILE`, blocks duplicate `provision`, and adopts existing VM via `freeformTags['agent-router-operation-id']` (`launchCount: 1`) |
| `OutOfHostCapacity` fallback handling | PASS | Verifies zero cloud instance was created, clears unfenced `PENDING` journal lock, and returns `OUT_OF_CAPACITY` (`fallbackRecommended: true`) |
| Single-writer fencing & leak-free teardown | PASS | `fence` confirms `STOPPED`; `teardown` passes `preserveBootVolume: false` + `preserveDataVolumesCreatedAtLaunch: false` and fails closed (`LEAKED_RESOURCES_DETECTED`) when simulated orphaned boot volumes remain |
| Unified `pnpm router` CLI (`status`, `reconcile`, `checkpoint`, `restore`, `oci:*`) | PASS | Enforces `0600` key-file mode, records `OperationJournal` receipts, and scrubs OCIDs (`inst_<sha256_16hex>`) |
| Live OCI `ComputeClient` VM creation/teardown | UNTESTED LIVE | `createOciComputeSdkGateway` typechecked against `oci-sdk@2.146.0`; local tests and CI never create or modify cloud resources |

## Reproduce

```sh
pnpm check
pnpm router oci:simulate-lifecycle
```

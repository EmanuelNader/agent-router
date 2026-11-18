# Milestone 4 implementation evidence: allowance-aware cross-host migration and end-to-end daemon proof

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `@opencode/cli 2.2.7`, `OpenSSH_10.3p1`, `restic 0.19.1`). This proves allowance-triggered cross-host exit (`evaluateAwsFreePlanAllowance`), automatic destination fallback when OCI returns `OutOfHostCapacity` (`Hetzner CAX11 ARM64` + BYO SSH), corrupt-transfer protection, and the full `pnpm e2e` multi-daemon pipeline (`opencode serve`, `git`, `/usr/sbin/sshd`, `/usr/bin/ssh`, `/usr/bin/scp`, and `restic sftp://`).

| Check | Observed result | Scope |
| --- | --- | --- |
| AWS Free Plan allowance monitor (`evaluateAwsFreePlanAllowance`) | PASS | Triggers `MIGRATE_NOW` before credit floor (`<= $5`) or 6-month cutoff (`<= 7 days`); fails closed on stale (`> 15m`) or incomplete telemetry |
| Destination pre-flight & `OutOfHostCapacity` fallback (`migrateWorkspace`) | PASS | Skips capacity-exhausted OCI `VM.Standard.A1.Flex` target **before** fencing source, provisions fallback `Hetzner CAX11 ARM64` (`location`, IPv6-only default, zero-inbound firewall), and migrates cleanly |
| Corrupt transfer & zero-capacity abort safety | PASS | All-targets `OUT_OF_CAPACITY` leaves source running (`sourceIntact: true`); mid-flight ciphertext corruption records `NEEDS_RECONCILE` and refuses to tear down source compute |
| Real OpenSSH (`sshd`/`ssh`/`scp`) + `restic sftp://` multi-hop E2E (`pnpm e2e`) | PASS | Real non-root `sshd` transfers `AES-256-GCM` checkpoint (`aws-source → hetzner-cax11`) and `restic sftp://` snapshot (`hetzner-cax11 → laptop-final`) with `maxConcurrentAgents: 1`, verified multi-hop shell history, dirty Git state, and `0` cloud remnants |
| Live external cloud APIs (`OCI`, `AWS`, `Hetzner`) | UNTESTED LIVE | All cloud mutations run against deterministic fault-injecting gateways in tests/CI; live cloud usage remains opt-in with user-owned credentials |

## Reproduce

```sh
pnpm check
pnpm e2e
```

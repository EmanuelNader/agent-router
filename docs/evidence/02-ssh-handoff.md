# Milestone 2 implementation evidence: fenced cross-host handoff and operation journal

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `@opencode/cli 2.2.7`). This proves the local operation journal, hardened OpenSSH/SCP argument builders, and a fenced two-hop OpenCode workspace + session handoff (`laptop → simulated VPS → laptop`); live remote SSH network transport and Tailscale/`OpenTunnel` browser reconnect remain separate live-host checks.

| Check | Observed result | Scope |
| --- | --- | --- |
| Atomic operation journal (`OperationJournal`) | PASS | Mode `0700` dir, `0600` atomic receipt files, `retryToken` generation, and per-workspace `PENDING` / `NEEDS_RECONCILE` concurrency lock |
| Hardened OpenSSH / SCP argv builders & `SshCliTransport` | PASS | `BatchMode=yes`, `StrictHostKeyChecking=yes`, `ConnectTimeout=15`, `--` option termination, atomic `0600` remote `ln` spooling (`EEXIST` on duplicate), and remote `stderr` scrubbing |
| Remote `restic` backend builders (`buildResticRemoteConfig`) | PASS | Validated SFTP, OCI S3-compatible (`s3.bucket-lookup=path`), Cloudflare R2, and AWS S3 configs with owner-only `0600` `AWS_SHARED_CREDENTIALS_FILE` |
| Single-writer source fencing | PASS | `maxConcurrentAgents: 1` across `laptop → VPS → laptop`; target OpenCode starts only after source stops and restored workspace/Git hashes pass |
| Multi-hop OpenCode session + dirty Git continuity | PASS | Settled shell turns from both `laptop-a` and `remote-vps` plus uncommitted edits, renames, hidden files, and new remote untracked files survive return to `laptop-b` |
| Pre-fence vs. post-fence failure handling | PASS | Pre-fence failure leaves source untouched and clears `PENDING`; post-fence transfer failure records `NEEDS_RECONCILE` and blocks unsafe retries |
| Live local OpenSSH daemon (`/usr/sbin/sshd` + `ssh` + `scp` + `restic sftp://`) | PASS | Ephemeral non-root `OpenSSH_10.3p1` daemon proves real `SshCliTransport`, `[127.0.0.1]:port` `StrictHostKeyChecking=yes`, `EEXIST` duplicate protection, and `restic sftp://` `check --read-data` |
| External remote VPS & Tailscale/`OpenTunnel` | UNTESTED LIVE | Local real `sshd` exercised in automated tests; external WAN/tailnet host remains opt-in |

## Reproduce

```sh
pnpm check
pnpm handoff:roundtrip
```

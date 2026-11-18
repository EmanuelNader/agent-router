# v0.2.0 implementation evidence: polymorphic checkpoints, Tailscale & remote pairing, GCP/Codespaces guardrails, and live Ubuntu 24.04 ARM64 guest proof

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `Docker 29.x` `linux/aarch64` `ubuntu:24.04`, `@opencode/cli 2.2.7`, `codex-cli 0.169.0`, `Claude Code 2.1.326`, `OpenSSH_10.3p1`, `restic 0.19.1`).

| Check | Observed result | Scope |
| --- | --- | --- |
| Polymorphic `v2` checkpoints (`captureAgentCheckpoint` / `restoreAgentCheckpoint`) | PASS | Preserves `v1` OpenCode compatibility while supporting `none`, `opencode`, `codex-cli`, and `claude-code`; quiesces file-backed agents before reading `.jsonl` stores and rejects mismatched restore agent types |
| Remote pairing & Tailscale discovery (`pairing.ts`, `tailscale.ts`, `agent-router peers/pair/handoff`) | PASS | Non-interactive `opencode pair --remote --yes`, `codex remote-control start/pair --json`, and `claude remote-control`; scrubs Tailscale node keys/user IDs and runs live `handoff --agent claude-code` over real `sshd` |
| Google Cloud Always Free `e2-micro` guardrails (`gcp:guard`) | PASS | Allows only `STANDARD` `e2-micro` in `us-west1` / `us-central1` / `us-east1` with `pd-standard <= 30 GB`, `0` GPUs, `<= 0.85 GB` egress buffer, and `<= $5` budget alert; blocks paid `pd-balanced`/`pd-ssd` and China/Australia/Premium egress |
| GitHub Codespaces quota monitor (`codespaces:allowance`) | PASS | Tracks `120` core-hours (`2x..32x` machine multipliers) and `15` GB-month storage; signals `MIGRATE_NOW` before quota exhaustion |
| Air-gapped `ubuntu:24.04` `linux/aarch64` container check (`linux-container.test.ts`) | PASS (`Linux/aarch64`) | Validates `bootstrap.sh` under Ubuntu POSIX `dash` (`/bin/sh -n`), verifies `700:agentrouter:agentrouter` directories, executes non-root probe inside `Linux/aarch64`, and round-trips `darwin -> linux/aarch64 -> darwin` |

## Reproduce

```sh
pnpm build
node bin/agent-router.mjs --version
pnpm check
pnpm e2e
```

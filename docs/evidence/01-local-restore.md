# Milestone 1 implementation evidence: local encrypted checkpoint and restore

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `@opencode/cli 2.2.7`, `restic 0.19.1`). This verifies local encrypted workspace + OpenCode session capture and restoration; remote object-storage backends, SSH handoffs, and model-generated recall remain separate gates.

| Check | Observed result | Scope |
| --- | --- | --- |
| Checkpoint manifest validation | PASS | Schema v1, pinned OpenCode `2.2.7`, SHA-256 format, and path-traversal/backslash/NUL rejection |
| AES-256-GCM local store | PASS | Authenticated encryption at rest (`AR01` container), `checkpointId` AAD binding, overwrite refusal (`EEXIST`), wrong-key and ciphertext-tamper rejection |
| `restic` repository store | PASS | Isolated `RESTIC_PASSWORD_FILE` (`0600`), `restic init`, tagged backup, `restic check --read-data`, and snapshot restore |
| Quiesce ordering & unfinished-turn guard | PASS | Refuses capture when any session contains a non-exited shell turn; runs `quiesceSource` before reading workspace hashes or bytes |
| End-to-end OpenCode round trip (`AES_256_GCM`) | PASS | `pnpm checkpoint:roundtrip` preserves committed Git history, staged/unstaged/renamed/hidden/untracked files, executable bits, session ID, target-directory binding, and settled shell output |
| End-to-end OpenCode round trip (`RESTIC`) | PASS | `pnpm checkpoint:roundtrip --restic` passes full repository data read-back check (`check --read-data`) and restores workspace + OpenCode session into fresh isolated state |
| Tampered-workspace fail-closed restore | PASS | Hash or Git mismatch aborts before `importSession` and removes the partial target directory |
| Remote object-storage backends (S3/R2/OCI) | UNTESTED | Local `restic` repository exercised; remote bucket credentials not supplied |
| Pending prompt inbox items | LIMITATION | Queued prompts (`resume: false`) remain outside OpenCode's session export; checkpoints only preserve settled history |
| Model inference and conversational recall | UNTESTED | Fixed shell fixture used; no model API key or subscription credential accessed |

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm agent:probe
pnpm agent:roundtrip
pnpm checkpoint:roundtrip
# When restic is installed locally:
pnpm checkpoint:roundtrip --restic
```

All runs execute inside mode `0700` temporary directories under ignored `.work/`, generate ephemeral 256-bit keys/passwords in memory, isolate `HOME`/`XDG_*` state, verify restored `FileReceipt` and Git working-tree state *before* starting the target OpenCode server, and delete temporary state on exit.

# `agent-router move`

Recorded 2026-11-22 on Ubuntu Linux `x86_64` (Node 24, `pnpm 12.21.0`). The remote host is the repository's throwaway loopback `sshd`; the "remote" Agent Router is the same CLI run from source. No cloud calls and no model inference.

| Check | Result | Where |
| --- | --- | --- |
| Workspace restored on the remote side by the remote Agent Router over SSH | PASS | `packages/cli/test/move.test.ts` |
| Key delivered on stdin; no file on either side other than the key file contains it; absent from the remote command vector | PASS | `packages/cli/test/move.test.ts`, `packages/host-ssh/test/move.test.ts` |
| Uploaded checkpoint removed from the remote spool after success | PASS | `packages/cli/test/move.test.ts` |
| Claude Code history relocated and rewritten for the remote path | PASS | `packages/cli/test/move.test.ts` |
| Codex CLI 0.171.0 history: a settled shell turn recorded by the installed Codex is moved, then the installed Codex resumes the thread from the target `CODEX_HOME` with the remote path as `cwd` and the turn intact (added 2026-11-23) | PASS | `packages/cli/test/move.test.ts` |
| OpenCode 2.3.2 history: a settled shell turn is exported from a running source server and imported by the remote Agent Router into a second running server; messages are identical and the session directory is the remote path (added 2026-11-23) | PASS | `packages/cli/test/move.test.ts` |
| Missing remote Agent Router, version mismatch, or existing remote workspace refuses before capture; no blocking journal entry | PASS | both test files |
| Failure or unverifiable manifest after the remote restore starts records `NEEDS_RECONCILE`; source kept even with `--remove-source` | PASS | `packages/host-ssh/test/move.test.ts` |
| `--remove-source` removes the source after a verified remote restore | PASS | `packages/cli/test/move.test.ts` |
| Remote arguments containing shell syntax refused | PASS | `packages/host-ssh/test/move.test.ts` |

`pnpm check`: 837 passed, 2 skipped (832 when first recorded). The SSH tests skip when no local `sshd` binary exists; the Codex test also skips when no supported Codex CLI is installed, which is the case in CI.

## Not established

- A real second machine, a different architecture, or a remote install from `dist/`. Only loopback SSH was exercised.
- Codex and OpenCode history with model turns. The fixtures are shell turns, which need no credentials or inference. Both agent states were isolated and on the same machine.
- For OpenCode, the source server must be running during `move` and an OpenCode server must already be running on the remote host; `move` starts neither.
- Stopping the source agent. `move` does not fence a running agent process; the operator must stop it first.
- Running processes, sockets, and in-flight side effects are not moved. Text-only pending OpenCode inbox items are moved ([12-opencode-inbox.md](12-opencode-inbox.md)); any other inbox item blocks the move.

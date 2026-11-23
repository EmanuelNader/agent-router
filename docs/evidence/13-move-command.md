# `agent-router move`

Recorded 2026-11-22 on Ubuntu Linux `x86_64` (Node 24, `pnpm 12.21.0`). The remote host is the repository's throwaway loopback `sshd`; the "remote" Agent Router is the same CLI run from source. No cloud calls and no model inference.

| Check | Result | Where |
| --- | --- | --- |
| Workspace restored on the remote side by the remote Agent Router over SSH | PASS | `packages/cli/test/move.test.ts` |
| Key delivered on stdin; no file on either side other than the key file contains it; absent from the remote command vector | PASS | `packages/cli/test/move.test.ts`, `packages/host-ssh/test/move.test.ts` |
| Uploaded checkpoint removed from the remote spool after success | PASS | `packages/cli/test/move.test.ts` |
| Claude Code history relocated and rewritten for the remote path | PASS | `packages/cli/test/move.test.ts` |
| Missing remote Agent Router, version mismatch, or existing remote workspace refuses before capture; no blocking journal entry | PASS | both test files |
| Failure or unverifiable manifest after the remote restore starts records `NEEDS_RECONCILE`; source kept even with `--remove-source` | PASS | `packages/host-ssh/test/move.test.ts` |
| `--remove-source` removes the source after a verified remote restore | PASS | `packages/cli/test/move.test.ts` |
| Remote arguments containing shell syntax refused | PASS | `packages/host-ssh/test/move.test.ts` |

`pnpm check`: 832 passed, 2 skipped. The SSH tests skip when no local `sshd` binary exists.

## Not established

- A real second machine, a different architecture, or a remote install from `dist/`. Only loopback SSH was exercised.
- Codex CLI and OpenCode history through `move`. They use the same capture and restore paths as `handoff` and `restore`, but were not run through this command.
- Stopping the source agent. `move` does not fence a running agent process; the operator must stop it first.
- Pending OpenCode inbox items, running processes, sockets, and in-flight side effects are not moved.

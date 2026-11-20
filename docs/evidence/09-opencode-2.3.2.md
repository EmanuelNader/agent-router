# OpenCode 2.3.2 re-pin

Recorded 2026-11-20 on Ubuntu Linux `x86_64` (Node 24, `pnpm 11.25.0`). No model inference and no cloud calls.

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm check` | PASS | 811 passed, 7 skipped (Codex/Claude binaries, restic and the verification Docker image are absent on this host) |
| `pnpm agent:probe` | PASS | `packageVersion` 2.3.2; authenticated API, HTTP 401 without credentials, ancestor configuration excluded |
| `pnpm agent:roundtrip` | PASS | Session ID and settled shell history preserved into fresh agent state |
| `pnpm agent:acp-roundtrip` | `ACP_VERIFIED` | `agentVersion` 2.3.2; cold load replays imported settled history |
| 2.2.7 export imported by 2.3.2 | PASS | `AGENT_ROUTER_SOURCE_OPENCODE=<path to a 2.2.7 opencode binary> pnpm agent:roundtrip` |

The last row is why v1 checkpoint manifests written by 2.2.7 are still accepted (`RESTORABLE_OPENCODE_VERSIONS`). No other older release was tested.

Not re-run here: `pnpm benchmark`, the Docker and restic proofs, and the macOS results recorded in the earlier evidence files, which still describe 2.2.7.

# Codex CLI 0.171 re-check

Recorded 2026-11-20 on Ubuntu Linux `x86_64` (Node 24, `pnpm 11.25.0`) with `codex-cli 0.171.0` and Claude Code `2.1.329` installed from npm. No model inference and no cloud calls.

| Check | Result | Notes |
| --- | --- | --- |
| Live Codex app-server test (`packages/agent-codex/test/adapter.test.ts`) | PASS | Thread start, settled shell turn, rollout export, rebind and resume in a fresh `CODEX_HOME` |
| MCP loader proof (`packages/workspace/test/mcp-live.test.ts`) | `MCP_LOADERS_VERIFIED` | `codex mcp list --json` and `claude mcp get` load the translated config; the proof now reads the accepted Codex line from `SUPPORTED_CODEX_MAJOR_MINOR` |
| Live Claude Code project-store test (`packages/agent-claude-code`) | PASS | Against 2.1.329 |

Upstream notes read for 0.170 and 0.171: same-named MCP servers are kept separate per environment, rollout replay keeps retained assistant revisions, and rollout trace payloads moved to compressed shards. None of them changed the rollout JSONL fields the adapter rebinds (`cwd`, `runtime_workspace_roots`) as far as the live test exercises them.

Not tested: 0.170, model turns, and rollout traces.

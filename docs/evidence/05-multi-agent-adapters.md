# Multi-agent CLI adapter & v0.1.0 standalone binary evidence

Recorded 2026-11-17 on local macOS `arm64` (`Node 24.18.1`, `pnpm 11.25.0`, `@opencode/cli 2.2.7`, `codex-cli 0.169.0`, `Claude Code 2.1.326`). Each coding-agent adapter lives in its own isolated package, uses private state directories (`XDG_*`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`) without reading or copying `$HOME`, and has a real binary compatibility test.

| Component | Observed result | Scope & verified behavior |
| --- | --- | --- |
| Standalone `v0.1.0` CLI build (`pnpm build` + `bin/agent-router.mjs`) | PASS | Emits `dist/` via `tsconfig.build.json` and runs natively on Node 24 (`node bin/agent-router.mjs`) without `tsx`, exposing `status`, `reconcile`, `checkpoint`, `restore`, `aws:allowance`, `oci:*`, `hetzner:*`, and `migrate:simulate` |
| OpenCode adapter (`packages/agent-opencode`, `@opencode/cli@2.2.7`) | PASS | Password-protected loopback HTTP server, settled shell turn check, and fresh `XDG_*` session export/import |
| Codex CLI adapter (`packages/agent-codex`, `codex-cli 0.169.0`) | PASS | Spawns isolated `codex app-server --stdio` (`CODEX_HOME`, analytics off, loopback provider), records a settled `thread/shellCommand`, exports `sessions/YYYY/MM/DD/rollout-*.jsonl` (omitting SQLite files), remaps `cwd` + `runtime_workspace_roots`, and cold-resumes via `thread/resume` + `thread/read` in a fresh `CODEX_HOME` |
| Claude Code adapter (`packages/agent-claude-code`, `Claude Code 2.1.326`) | PASS | Isolates `CLAUDE_CONFIG_DIR`, encodes destination project slugs (`[^A-Za-z0-9] -> -`), remaps top-level `.jsonl` `cwd` fields without altering message prose, refuses overwrite (`EEXIST`), and proves live CLI discovery via `claude purge --dry-run <workspace>` |
| Live paid LLM inference turns | UNTESTED | All automated tests run offline with zero API keys or model billing |

## Reproduce

```sh
pnpm build
node bin/agent-router.mjs --version
pnpm check
pnpm e2e
```

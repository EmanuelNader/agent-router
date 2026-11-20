# ACP `session/resume`

Recorded 2026-11-20 on Ubuntu Linux `x86_64` (Node 24, `pnpm 11.25.0`, `@opencode/cli 2.2.7`). No model inference and no cloud calls.

`AcpClient.reconnectSession` calls `session/resume` when the agent advertises `agentCapabilities.sessionCapabilities.resume`, and otherwise falls back to `session/load`. Per the [ACP session setup spec](https://agentclientprotocol.com/protocol/session-setup), `session/resume` returns without replaying history, so it does not by itself show that saved history arrived. The proof therefore still uses `session/load` for that and exercises `session/resume` separately.

| Check | Result | Notes |
| --- | --- | --- |
| `pnpm agent:acp-roundtrip` | `ACP_VERIFIED`, `resumeWithoutReplay: true` | Real OpenCode 2.2.7 advertises `sessionCapabilities.resume`; after the load-based replay check, a fresh ACP process resumes the imported session and receives no replay of the saved user message |
| Fixture agents (`packages/agent-acp/test/client.test.ts`) | PASS | Resume is preferred when advertised; an agent that only advertises `loadSession` gets `session/load` and never receives `session/resume`; an agent that advertises neither is refused |

Not tested: prompting a resumed session (needs model inference), and agents other than OpenCode.

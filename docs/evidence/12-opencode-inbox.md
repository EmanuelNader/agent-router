# OpenCode 2.3.2 pending inbox

Recorded 2026-11-22 on Ubuntu Linux `x86_64` (Node 24, `pnpm 12.21.0`, OpenCode 2.3.2). No model inference and no cloud calls: every prompt was admitted with `resume: false`.

Checkpoints do **not** carry the inbox. Re-admission below is research only; the only part wired into capture is the guard described at the end.

| Observation (`pnpm agent:inbox-probe`) | Result |
| --- | --- |
| `GET /api/session/{id}/inbox` lists admitted, undelivered work in enqueue order | PASS |
| A completed shell turn leaves one `synthetic` item (`metadata.source: "shell"`) when the agent loop has not run | PASS |
| Queued and steered user prompts are absent from `/api/experimental/session/{id}/export` | PASS |
| The inbox survives a server restart on the same agent state | PASS |
| Importing the export into fresh agent state yields an empty inbox | PASS |
| Re-admitting each item through `/prompt` (`user`) or `/synthetic` (`synthetic`) with its original `id` keeps IDs, order, delivery mode and text | PASS |
| Re-admitting the same IDs a second time creates no duplicates | PASS |

## What this does and does not establish

- Text-only `user` and `synthetic` items can be listed on the source and re-admitted on the destination without waking the agent loop.
- `compaction` and `move` items have no admission endpoint in the 2.3.2 OpenAPI document, so they cannot be carried.
- Not tested: prompts with file, agent, or skill attachments (the list and admission schemas use different attachment types); delivery after re-admission, which needs model inference; any release other than 2.3.2.
- The inbox API is not marked stable upstream. Its lifecycle is still being designed ([opencode#35966](https://github.com/anomalyco/opencode/issues/35966)), and delivered items leaving stale entries is an open bug ([opencode#62618](https://github.com/anomalyco/opencode/issues/62618)).

## Capture guard

The `checkpoint`, `handoff`, `migrate` and `move` OpenCode capture paths export through `OpenCodeClient.exportSessionForCheckpoint`. It reads the inbox before and after the export and refuses with `OPENCODE_PENDING_INBOX` when any item is present, except a `synthetic` item with `metadata.source: "shell"`: that item records a shell turn whose result is already in the exported messages.

| Observation | Result |
| --- | --- |
| Export for a checkpoint succeeds with only the shell item in the inbox (`pnpm agent:inbox-probe`, OpenCode 2.3.2) | PASS |
| Export for a checkpoint is refused once a queued user prompt is admitted (`pnpm agent:inbox-probe`, OpenCode 2.3.2) | PASS |
| `user`, non-shell `synthetic` and `compaction` items are each refused (`packages/agent-opencode/test/client.test.ts`, fixture server) | PASS |

Limits: a prompt admitted after the second inbox read and before the server stops is not seen. If the upstream stale-entry bug ([opencode#62618](https://github.com/anomalyco/opencode/issues/62618)) leaves a delivered item listed, the guard refuses until that item is deleted. Pending items are still not carried in a checkpoint.

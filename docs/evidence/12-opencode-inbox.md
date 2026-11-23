# OpenCode 2.3.2 pending inbox

Recorded 2026-11-22 on Ubuntu Linux `x86_64` (Node 24, `pnpm 12.21.0`, OpenCode 2.3.2). No model inference and no cloud calls: every prompt was admitted with `resume: false`.

This is research. Checkpoints still do **not** carry the inbox; nothing below is wired into `checkpoint`, `restore`, `handoff`, or `migrate`.

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

## Gap in the current implementation

`README.md` says checkpointing must drain or reject pending work before cutover. Today nothing inspects the inbox: the OpenCode capture path only checks exported messages for unsettled shell turns, so pending prompts are dropped silently at cutover. `OpenCodeClient.listInbox` now makes a fail-closed check possible. A plain "refuse when the inbox is non-empty" rule would also refuse after any shell turn the agent loop has not consumed, because of the synthetic item above.

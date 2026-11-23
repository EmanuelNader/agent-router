# OpenCode 2.3.2 pending inbox

Recorded 2026-11-22 on Ubuntu Linux `x86_64` (Node 24, `pnpm 12.21.0`, OpenCode 2.3.2). No model inference and no cloud calls: every prompt was admitted with `resume: false`.

Checkpoints carry text-only `user` and `synthetic` inbox items and refuse everything else; see the last section.

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
- `compaction` and `move` items have no admission endpoint in the 2.3.2 OpenAPI document, so they cannot be carried and block capture.
- Not tested: prompts with file, agent, or skill attachments (the list and admission schemas use different attachment types); delivery after re-admission, which needs model inference; any release other than 2.3.2.
- The inbox API is not marked stable upstream. Its lifecycle is still being designed ([opencode#35966](https://github.com/anomalyco/opencode/issues/35966)). A report of delivered items leaving stale queued entries ([opencode#62618](https://github.com/anomalyco/opencode/issues/62618)) was closed as not planned on 2026-11-10: the maintainer could not reproduce it on 2.2.5, found the server inbox empty after delivery, and suspects a display problem in the terminal UI. That was not rerun here on 2.3.2.

## Capture and restore

The `checkpoint`, `handoff`, `migrate` and `move` OpenCode capture paths export through `OpenCodeClient.exportSessionForCheckpoint`. It reads the inbox before and after the export and stores the items as `pendingInbox` beside the exported session in the checkpoint's agent bundle. It refuses with `OPENCODE_PENDING_INBOX` when an item is not a text-only `user` or `synthetic` item, or when the two reads differ. `OpenCodeClient.importSession` imports the session, re-admits each carried item with its original `id` and `resume: false`, then lists the destination inbox and fails unless it equals what the checkpoint carried.

The `synthetic` item a finished shell turn leaves (`metadata.source: "shell"`) is carried like any other item, so the destination inbox equals the source inbox. `metadata` is carried only on `synthetic` items; a `user` item with any payload field other than `text` is refused.

| Observation | Result |
| --- | --- |
| `move` carries a shell `synthetic` item, a queued user prompt and a steered user prompt; the remote inbox has the same IDs, order, delivery modes and payloads (`packages/cli/test/move.test.ts`, OpenCode 2.3.2, loopback SSH) | PASS |
| A user prompt with a `files` attachment, a `compaction` item and a `move` item are each refused at capture (`packages/agent-opencode/test/client.test.ts`, fixture server) | PASS |
| An inbox that changes between the two reads is refused (same test) | PASS |
| Restore fails when the destination inbox differs from the checkpoint after re-admission, and rejects a carried item of another type (same file, fixture server) | PASS |

Limits:

- A prompt admitted after the second inbox read and before the server stops is not seen.
- Delivery of a re-admitted prompt needs model inference and is not tested. Only OpenCode 2.3.2 was run.
- A destination session that already holds other inbox items fails the post-admission comparison.
- An Agent Router build older than this change restores such a checkpoint without its pending items: OpenCode's import endpoint ignores the extra field.

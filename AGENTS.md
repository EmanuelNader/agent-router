# Agent Router development

Read README.md and docs/evidence/00-readiness.md before extending the adapters.

- Use Node 24 and the exact pnpm version in package.json. Install with the lockfile.
- Run pnpm check. Changes to the OpenCode integration also require pnpm agent:probe and pnpm agent:roundtrip.
- Keep personal configuration, credentials, transcripts, and raw cloud responses out of Git and logs. Use isolated agent state. Never copy an entire personal home directory.
- Cloud inspection is read-only. Missing or stale entitlement, usage, capacity, or cost evidence must block provisioning. Authentication alone does not establish free eligibility.
- Keep provider and agent adapters separate. Add an actual compatibility test before claiming support for another CLI or release.
- A migration restores a quiesced workspace and supported saved history. It does not preserve arbitrary processes, pending inputs, sockets, or in-flight side effects.
- Use provider retry tokens and reconciliation for future mutations. A durable workflow can repeat external calls.
- Do not create or modify cloud resources as part of local tests or CI. Keep live tests separately invoked and scoped to a dedicated project/compartment.
- Research/plans describe intended work; evidence describes implemented and observed behavior. Update both when they diverge.

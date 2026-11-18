# Agent Router `v0.3.0` Implementation Plan — Autonomous Watch Loop, Codespaces SSH Evacuation, GitHub 2026 Billing Parser, and Cloudflare R2 Guardrails

## Goal
Turn `agent-router` from one-shot manual commands into a fail-closed, end-to-end autonomous loop (`v0.3.0`) that monitors live free-tier quotas (AWS Free Plan, GitHub 2026 Consolidated Billing Usage API for Codespaces, Cloudflare R2 Standard storage/ops), automatically evacuates active workspaces + coding-agent state when allowances run low, safely bridges GitHub Codespaces over isolated OpenSSH configs, prunes old local checkpoints without touching journal-protected snapshots, and emits hardened rootless `systemd --user` / `launchd` units.

## Upstream Evidence Verified via Firecrawl (Nov 2026)
- **Cloudflare R2 Free Tier (`developers.cloudflare.com/r2/pricing/`):** `10 GB-month` Standard storage, `1,000,000` Class A operations/month, `10,000,000` Class B operations/month, `$0` egress, **no hard spend cap**, and **zero free tier on Infrequent Access (`IA`)** ($9/M Class A, $0.90/M Class B).
- **GitHub 2026 Consolidated Billing Usage API (`docs.github.com/en/rest/billing/usage`, `apiVersion=2026-03-10`):** Legacy `/settings/billing/*` endpoints were retired; `/users/{username}/settings/billing/usage` and `/usage/summary` return `usageItems[]` with `product: "codespaces"` and SKUs `codespaces_compute_d2` / `d4` / `d8` / `d16` / `d32`, `codespaces_storage`, and `codespaces_prebuild_storage`.
- **GitHub CLI Codespaces SSH (`cli.github.com/manual/gh_codespace_ssh`, `cli/cli#9817`):** `gh codespace ssh --config -c <name>` emits a `Host cs.<name>...` stanza using `ProxyCommand <gh> cs ssh -c <name> --stdio`; writing it to an isolated `0600` config passed via `ssh -F` / `scp -F` avoids mutating `~/.ssh/config` and allows sanitizing `StrictHostKeyChecking` / missing `codespaces.auto` identity paths.

## Tasks (Subagent-Driven Development)
1. **Task 1 (`packages/cloud-readiness`):** `r2-free-tier.ts` (`evaluateR2FreeTierGuardrails`) + `github-billing-api.ts` (`parseGitHubCodespacesBillingUsage`) + unit tests + `sdd-reviewer` gate.
2. **Task 2 (`packages/host-ssh` & `packages/snapshots`):** `SshConnectionOptions.configFile` (`-F`), `codespaces-ssh.ts` (`prepareIsolatedCodespaceSshConfig`), and `prune.ts` (`pruneLocalCheckpoints` with journal protection) + unit tests + `sdd-reviewer` gate.
3. **Task 3 (`packages/cli`):** `watch.ts` (`runAllowanceWatchLoop`), `service-units.ts` (`renderSystemdUserUnits`, `renderLaunchdPlist`), and `cli.ts` `v0.3.0` commands (`r2:guard`, `codespaces:parse-billing`, `prune`, `watch:simulate`, `service:emit`) + unit tests + `sdd-reviewer` gate.
4. **Task 4 (`scripts/e2e.ts` & `docs/evidence/`):** Live multi-tick `runAllowanceWatchLoop` integration in `scripts/e2e.ts`, `docs/evidence/07-v03-autonomous-watch-and-r2.md`, `README.md`, and Final Whole-Branch `sdd-reviewer` gate.

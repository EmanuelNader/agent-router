# Market and architecture reassessment: from credit-hopping SaaS to local-first BYOC CLI

Prepared November 17, 2026 using live Firecrawl web/developer searches and page scrapes. This reassesses the November 12 feasibility study ([free-compute-agent-router-research.md](./free-compute-agent-router-research.md)) and build blueprint ([agent-router-technical-build-blueprint.md](./agent-router-technical-build-blueprint.md)) against late-2026 cloud free-tier changes, agent-sandbox pricing, model-subscription terms, and upstream OpenCode v2 capabilities.

## Summary decision

- **Drop the commercial "$5–$9/month multi-cloud free-tier credit-hopping SaaS" model and its hosted control plane** (`Next.js` SaaS onboarding, multi-tenant `Fastify` + `PostgreSQL` + `DBOS` service, and custom `frp` + `Caddy` public tunnel gateway).
- **Refocus Agent Router as a local-first, serverless open-source BYOC CLI and TypeScript library ("DevPod for coding agents"):** provision or attach user-owned hosts (`OCI Always Free / PAYG-safe`, low-cost `Hetzner` / `SSH` VPSes, `AWS Free Account Plan`) with fail-closed cost/quota guardrails, capture quiesced encrypted checkpoints (`restic` + session export) to user-owned object storage, and move workspaces cleanly across `laptop ↔ VPS ↔ cloud`.

## 1. Cloud free-tier and unit-economics findings (November 2026)

| Option (2 vCPU / 4–12 GB class) | 730-hour monthly cost | Operational profile | Source |
| --- | --- | --- | --- |
| OCI Always Free (un-upgraded Free Tier) | $0.00 | Halved on June 12–15, 2026 from 3,000 OCPU-hours / 18,000 GB-hours (4 OCPUs / 24 GB) to **1,500 OCPU-hours / 9,000 GB-hours (2 OCPUs / 12 GB)**; 200 GB combined boot/block storage; 7-day idle reclamation (<20% CPU, network, and A1 memory). Severe anti-fraud signup rejections and persistent `Out of host capacity` errors on un-upgraded accounts (~1,500 failed CLI launch retries over two weeks in a mid-2026 Tokyo test). | [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [2026 OCI field report](https://draft-publish.com/articles/is-oracle-clouds-free-tier-still-worth-it-in-2026--0c75b5b7) |
| OCI Pay-As-You-Go within Always Free limits | $0.00 *(when guarded)* | Unlocks immediate `VM.Standard.A1.Flex` capacity, removes idle reclamation, and reportedly retains up to 4 OCPUs / 24 GB free—but exceeding Always Free compute or 200 GB storage bills immediately. Fail-closed quota checks, compartment quotas, and OCI budget alerts are the real safety requirement. | [OCI Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [2026 OCI field report](https://draft-publish.com/articles/is-oracle-clouds-free-tier-still-worth-it-in-2026--0c75b5b7) |
| AWS Free Account Plan | $0.00 *(up to $200 credit)* | Launched July 15, 2025: $100 signup credit + up to $100 earned credits; **account closes automatically at 6 months or credit exhaustion** unless upgraded to Paid. Useful 6-month runway, not a recurring pool. | [AWS Free Tier](https://aws.amazon.com/free/), [Rackspace 2026 analysis](https://spot.rackspace.com/blog/aws-free-tier) |
| Fly.io Sprites | ~$1.05 *(bursty example)* / $120.09 *(100% 730h)* | Hardware-isolated persistent Linux VMs for coding agents; auto-sleeps in seconds ($0 compute when warm/cold; ~$0.50/GB-month hot storage); 1-second Copy-on-Write disk checkpoints; HTTPS auto-wake and zero-key API Connectors. | [sprites.dev](https://sprites.dev), [Agent37 benchmarks](https://www.agent37.com/compare) |
| Agent37 Sandbox | $4.76 | Shared 2 vCPU / 4 GB RAM / 4 GB disk for 730 hours, no monthly plan fee, 176 ms median gVisor checkpoint resume. | [Agent37 benchmarks](https://www.agent37.com/compare) |
| Hetzner Cloud VM | ~$4.50–$6.49 | Dedicated Linux VM with bundled SSD and generous egress; no trial expiry or idle reclamation, user operates the host. | [Agent37 Hetzner comparison](https://www.agent37.com/compare), [sanand0 notes](https://github.com/sanand0/til/blob/main/til.md) |
| Upstash Box | $8.00 | Small always-on persistent container with built-in coding agents, browser tools, and Git workflows. | [Agent37 benchmarks](https://www.agent37.com/compare) |
| Nori Sessions | $99 Developer / $250 Team | Managed ephemeral agent machines triggered by cron, webhooks, or Slack/Discord using user-supplied harnesses and model subscriptions. | [Nori Oct 2026 sandbox report](https://noriagentic.com/newsletter/2026-07-03-remote-ephemeral-dev-sandboxes.html) |
| Daytona / E2B | $120.89 *(+$150 Pro on E2B)* | Fast programmatic sandbox APIs ($0.0504/vCPU-h + $0.0162/GiB-h); expensive for 24/7 personal workbenches. | [Daytona](https://www.daytona.io/), [Blaxel comparison](https://blaxel.ai/blog/blaxel-vs-e2b-vs-daytona) |

### Why credit-hopping SaaS unit economics fail

1. **Adverse selection against $5–$9/month:** Anyone willing to pay $5–$9/month already has turnkey single-card options (`Agent37` at $4.76/mo, `Hetzner` at ~$4.50–$6.49/mo, `Upstash Box` at $8.00/mo, or bursty `Fly.io Sprites` at ~$1–$5/mo) with zero multi-cloud KYC, CAPTCHAs, or forced migrations. Users enduring multi-cloud free-tier friction are optimizing strictly for $0.
2. **OCI Free-Tier capacity reality:** Un-upgraded OCI Free Tier accounts frequently cannot launch A1 instances at all, whereas OCI PAYG accounts launch immediately at $0/month *provided* strict pre-launch quota/storage checks and budget alerts prevent accidental overage. That turns our existing read-only OCI inspector and planner into a practical **"PAYG-safe guardrail"** rather than just a credit-hopping trigger.

## 2. Competitive opening in late-2026 BYOC tooling

Per [Nori's October 19, 2026 industry survey](https://noriagentic.com/newsletter/2026-07-03-remote-ephemeral-dev-sandboxes.html):

- **Daytona** archived its open-source repository and moved development private on June 11, 2026 ([github.com/daytonaio/daytona](https://github.com/daytonaio/daytona)).
- **Ona (formerly Gitpod)** was acquired by OpenAI on June 11, 2026 to join the Codex team and dropped public self-serve plans.
- **DevPod** (`loft-sh/devpod`, client-only MPL-2.0 workspace CLI) has not cut a release since `v0.6.15` in March 2025 and was built around human IDE devcontainers rather than autonomous coding agents.
- **Coder** removed `Coder Tasks` in `v2.37` (September 2026), requires operating a full server + PostgreSQL control plane, and gates headless API agents behind custom-quoted `AI Premium`.
- Solo developers and small teams are actively cobbling together shell scripts such as [VPSmaxxing](https://github.com/Kuberwastaken/VPSmaxxing) (`Tailscale + tmux + SSH`) to offload Claude Code, Codex, and OpenCode from laptops onto personal VPSes ([HN discussion](https://news.ycombinator.com/item?id=46517458)).

A lightweight, client-only BYOC CLI that provisions/attaches isolated remote agent hosts, enforces $0/budget safety checks, and checkpoints/migrates workspaces (`laptop ↔ VPS ↔ cloud`) fills an unoccupied open-source niche.

## 3. Model-subscription Terms of Service constraints

Anthropic's [Usage Policy (effective November 12, 2026)](https://www.anthropic.com/legal/aup) and [Claude Code Legal and Compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) prohibit third-party services from offering `claude.ai` login or routing requests through consumer Free, Pro, Max, or Ultra subscriptions on behalf of users ([CellCog Nov 2026 analysis](https://cellcog.ai/blog/opencode-claude-subscription/), [HN #46549823](https://news.ycombinator.com/item?id=46549823)). At the same time, end users are permitted to sign in to unmodified official CLIs (or use BYOK API keys) on machines they control.

Running Agent Router as a **local CLI that orchestrates the user's own hosts** avoids acting as a third-party hosted credential proxy and keeps model credentials strictly between the user, their own VM, and the model provider.

## 4. OpenCode v2 overlap vs. unsolved engineering gaps

Inspection of [OpenCode's Web docs](https://opencode.ai/docs/cli/web), [CLI reference](https://opencode.ai/docs/cli/commands), [OpenTunnel](https://github.com/anomalyco/opentunnel) (`v0.6.2`, November 4, 2026), and `anomalyco/opencode` issues shows:

- **Do not rebuild remote ingress:** OpenCode `2.2.x` ships `opencode pair --remote` backed by **OpenTunnel** (`<id>.opentunnel.xyz`), a Rust/Fly blind TLS relay where TLS terminates inside the user's OpenCode process, alongside QR-code browser/mobile pairing and `opencode --server`. Together with Tailscale, this eliminates the need for a custom `frp` + `Caddy` gateway.
- **Do not rebuild raw export primitives:** OpenCode `2.2.x` provides `opencode session export [--sanitize]`, `opencode session import --directory`, and `opencode auth export / import`.
- **Solve what OpenCode does NOT handle:**
  1. **Path/worktree migration fragility:** Moving or renaming directories/remotes breaks `opencode.db` `project.worktree` / `session_v2` scoping (`anomalyco/opencode` [#35240](https://github.com/anomalyco/opencode/issues/35240), [#59371](https://github.com/anomalyco/opencode/issues/59371), [#44216](https://github.com/anomalyco/opencode/issues/44216)), and queued inbox prompts are omitted from `session export` ([00-readiness.md](../evidence/00-readiness.md)).
  2. **Host isolation & credential separation:** OpenCode's `SECURITY.md` explicitly notes its permission prompts are **not** a sandbox ([F3Fundit Late 2026 Guide](https://f3fundit.com/ai-coding-agents-late-2026/)).
  3. **Application-consistent encrypted backups & exit mobility:** Quiescing the server, verifying an empty pending inbox, exporting settled sessions, snapshotting dirty/untracked Git working trees with `restic` to user-owned object storage (e.g., OCI's 20 GB Always Free Object Storage or Cloudflare R2), fencing the old process, and verifying full restoration on a new host or local machine.

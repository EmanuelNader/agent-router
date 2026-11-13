# PR #1 Post-Merge Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement post-merge follow-ups for merged PR #1: configurable per-request timeout in OCI SDK with mocked tests, refactor loose functions in `packages/cloud-readiness` into classes with static functions, fix whitespace in `reports.ts`, defer `OCI_API` source labeling until real API data is present in `emptyInspection()`, and open a PR with test proof.

**Architecture:** Encapsulate operations in `packages/cloud-readiness` within static classes (`OciSdkReader`, `OciInspector`, `OciPlanner`, `OciReport`, `OciConnection`, `AwsReports`) while preserving function exports for full backward compatibility. Implement per-request timeout via dynamic `signal` getter in client HTTP options. Update `emptyInspection()` and `inspectionSchema` to allow null `source` until real API responses are received.

**Tech Stack:** TypeScript 7, Node 24, pnpm 11, Vitest 5, Zod 4, OCI SDK 2.

## Global Constraints
- Author and committer: "Emanuel Nader <emanuelsnader@gmail.com>"
- No Co-authored-by trailers, no AI/agent attribution in commits or PR bodies
- Never merge any PR
- Free-only: mocked OCI SDK in tests, no live API calls, no cloud credentials
- Never touch OCI instance "discord-bot"
- No secrets in git
- Do not weaken tests or the local-portability CI check
- Prefer classes with static functions

---

### Task 1: Create Branch off origin/main

**Files:**
- Git branch: `build/readiness-followups`

- [ ] **Step 1: Check out new branch off origin/main**
- [ ] **Step 2: Verify git author and committer configuration**

---

### Task 2: Configurable Per-Request Timeout in oci-sdk.ts and Mocked Tests

**Files:**
- Modify: `packages/cloud-readiness/src/oci-sdk.ts`
- Create: `packages/cloud-readiness/test/oci-sdk.test.ts`

**Interfaces:**
- Consumes: `ConfigFileAuthenticationDetailsProvider`, `IdentityClient`, `LimitsClient` from `oci-sdk`
- Produces: `OciSdkReader` class with static `create(configPath: string, profileOrOptions?: string | OciSdkOptions, optionsOrTimeout?: { timeoutMs?: number } | number)` and `createOciSdkReader` export.

- [ ] **Step 1: Write tests in `test/oci-sdk.test.ts` mocking `oci-sdk`**
- [ ] **Step 2: Run test to verify it fails/passes**
- [ ] **Step 3: Implement configurable per-request timeout and `OciSdkReader` class in `oci-sdk.ts`**
- [ ] **Step 4: Run test to verify all pass**
- [ ] **Step 5: Commit**

---

### Task 3: Fix Whitespace Issue in reports.ts and Refactor into AwsReports Class

**Files:**
- Modify: `packages/cloud-readiness/src/reports.ts`
- Modify: `packages/cloud-readiness/test/reports.test.ts`

**Interfaces:**
- Produces: `AwsReports` class with static `readiness(plan: AwsPlan)` and `awsReadiness` export.

- [ ] **Step 1: Update `packages/cloud-readiness/src/reports.ts` removing extra whitespace on line 4 and wrapping in `AwsReports`**
- [ ] **Step 2: Add test in `test/reports.test.ts` for `AwsReports.readiness` static function**
- [ ] **Step 3: Run tests to verify they pass**
- [ ] **Step 4: Commit**

---

### Task 4: Fix emptyInspection() Source Labeling and Refactor oci-report.ts & oci-inspect.ts

**Files:**
- Modify: `packages/cloud-readiness/src/oci-report.ts`
- Modify: `packages/cloud-readiness/src/oci-inspect.ts`
- Modify: `packages/cloud-readiness/src/oci-plan.ts`
- Modify: `packages/cloud-readiness/test/oci-inspect.test.ts`
- Modify: `packages/cloud-readiness/test/oci-plan.test.ts`

**Interfaces:**
- Produces:
  - `OciReport` class with static `emptyInspection()`
  - `OciInspector` class with static `readMetric()` and `inspect()`
  - `OciPlanner` class with static `previewDeployment()`
  - Backward compatible function exports for all

- [ ] **Step 1: Write failing test in `test/oci-inspect.test.ts` verifying `emptyInspection().source` is null and only set to `OCI_API` once real data arrives**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Update `oci-report.ts`, `oci-inspect.ts`, and `oci-plan.ts` to allow null `source` until real API data is present**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Commit**

---

### Task 5: Refactor oci-connection.ts into OciConnection Class

**Files:**
- Modify: `packages/cloud-readiness/src/oci-connection.ts`
- Modify: `packages/cloud-readiness/test/oci-connection.test.ts`

**Interfaces:**
- Produces: `OciConnection` class with static `prepareKey()` and `writeConfig()`, preserving `prepareOciKey` and `writeOciConfig` exports.

- [ ] **Step 1: Wrap functions in `OciConnection` class with static methods in `oci-connection.ts`**
- [ ] **Step 2: Update/extend tests in `oci-connection.test.ts` to test both class methods and function exports**
- [ ] **Step 3: Run tests to verify all pass**
- [ ] **Step 4: Commit**

---

### Task 6: Full Verification and Local-Portability Run

**Files:**
- Run all checks:
  - `pnpm check` (`pnpm typecheck` && `pnpm test`)
  - `pnpm readiness`
  - `pnpm plan:oci --demo`
  - `pnpm plan:oci --demo --additional-instances 2`
  - `pnpm agent:probe`
  - `pnpm agent:roundtrip`

- [ ] **Step 1: Execute all verification commands and collect logs**
- [ ] **Step 2: Check git log, author, committer, and ensure no AI attribution or secrets**

---

### Task 7: Push Branch and Open PR into main

- [ ] **Step 1: Push branch `build/readiness-followups` to origin**
- [ ] **Step 2: Create PR into main using `gh pr create` with test logs as proof, authored by Emanuel Nader, without AI attribution**

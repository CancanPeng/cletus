# Subagent Permission Inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subagents inherit a static snapshot of the parent policy's grants (allowWrite, yolo, session grants, readOnlyRoots) at spawn, with no confirmation forwarding.

**Architecture:** `PermissionPolicy` gains a `snapshot()` export and an `inherit?: PermissionSnapshot` constructor option. `createSubagentRunner` passes `deps.policy.snapshot()` when building the child policy. Non-interactive denial messages become actionable. No TUI/task-tool/print-mode changes.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-17-subagent-permission-inheritance-design.md`

## Global Constraints

- Snapshot semantics: copied at spawn; parent grants approved later do NOT reach a running child; nothing flows back from child to parent.
- `interactive` and `confirm` are NEVER taken from the snapshot — child policies stay non-interactive (spec's B-plan floor).
- Denial copy (exact, replaces every "Non-interactive mode requires --yolo for X" string in policy.ts): `Denied: not covered by inherited grants or permissions rules (approve it in the main session, add a rule via /permissions add, or use --yolo)`
- Snapshot covers: allowWrite, yolo, readOnlyRoots, sessionPaths, sessionCommands, sessionMcpTools, sessionSearches, sessionCurls, sessionExtraTools. NOT extraTools registration (child registers its own via refreshTools path — verify in Task 2; if child policies never learn extension tool names, include extraTools in the snapshot and ledger the ruling).
- Work in place on `main` (user consent given for the previous plan; same session, same arrangement). Untracked docs/cletus-intro.* stay untouched. Commit only listed files.
- Existing tests must pass untouched, including "denies write tools without yolo even inside a subagent" (its parent policy has no grants, so semantics are unchanged).

## Review Focus

- Snapshot mutation isolation: parent approving a grant AFTER child spawn must not affect the child (copy, not reference) → Task 1 test.
- Inherit must not make a child interactive: snapshot from an interactive parent still denies un-granted writes in the child → Task 1 test.
- Child granted-path writes work with yolo:false (the whole point of B) → Task 2 test.
- sessionCommands snapshot: exact-command match semantics carry over (parent approved `pnpm test`, child runs `pnpm test` → allow; `pnpm build` → deny) → Task 2 test.
- Denial message change must not break callers/tests that match the old string → grep for "Non-interactive mode requires" across repo in Task 1; update only policy.ts and any test that asserts the old copy (ledger if found outside).

---

### Task 1: Policy snapshot + inherit

**Files:**
- Modify: `packages/coding-agent/src/permissions/policy.ts`
- Test: `packages/coding-agent/test/permissions.test.ts` (add cases; keep existing untouched)

**Interfaces:**
- Produces:
  ```ts
  export type PermissionSnapshot = {
    allowWrite: string[];
    yolo: boolean;
    readOnlyRoots: string[];
    sessionPaths: string[];
    sessionCommands: string[];
    sessionMcpTools: string[];
    sessionSearches: string[];
    sessionCurls: string[];
    sessionExtraTools: string[];
  };
  // on PermissionPolicy:
  snapshot(): PermissionSnapshot;
  // constructor opts gains: inherit?: PermissionSnapshot
  ```
  Task 2 consumes `deps.policy.snapshot()` and passes it as `inherit`.

- [ ] **Step 1: Write failing tests** (follow existing permissions.test.ts construction patterns; use its tmpdir helpers if present):
  - `"snapshot round-trips grants into a new policy"`: parent (yolo:false, interactive:false) with allowWrite `["src/**"]`; seed grants via `check()` calls that exercise session sets is awkward non-interactively — instead construct parent interactive:true with a confirm stub returning "allow", approve one write path, one bash command, one web_search query, one curl URL, one mcp tool, one extra tool (setExtraTools first). Build child with `inherit: parent.snapshot(), interactive:false, yolo:false`. Assert child `check()` allows all six without confirm, and allows a write under `src/**`.
  - `"snapshot is a copy, not a live reference"`: after child creation, parent approves a NEW bash command; child `check()` on that command → deny.
  - `"inherit never makes a child interactive"`: parent interactive:true w/ confirm stub; child inherit + interactive:false, NO confirm; un-granted write → `{allow:false}` with the new denial copy (exact string from Global Constraints).
  - `"deny copy is actionable"`: non-interactive policy without inherit; bash check → reason contains `/permissions add` and `--yolo`.
- [ ] **Step 2: Run to verify failure**

  Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/permissions.test.ts`
  Expected: new tests FAIL (snapshot not a function / inherit ignored), existing PASS.

- [ ] **Step 3: Implement**

  Add `PermissionSnapshot` type + `snapshot()` (Array.from each Set, spread arrays, read `this.sandbox.readOnlyRoots`). Constructor: when `opts.inherit` present, initialize sets/allowWrite/yoloMode/readOnlyRoots from it (explicit opts.yolo still wins if provided — decide: inherit fills, explicit overrides; ledger nothing, this is the obvious reading). Replace the six denial strings with the exact Global Constraints copy. Grep repo for the old string; if asserted in other tests, update those assertions and ledger a ruling.

- [ ] **Step 4: Run to verify pass**

  Run: same command. Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add packages/coding-agent/src/permissions/policy.ts packages/coding-agent/test/permissions.test.ts
  git commit -m "feat(permissions): snapshot and inherit policy grants for non-interactive children"
  ```

### Task 2: Subagent inherits parent snapshot

**Files:**
- Modify: `packages/coding-agent/src/subagent.ts` (policy construction, ~line 16)
- Test: `packages/coding-agent/test/subagent.test.ts` (add cases; keep existing 7 untouched)

**Interfaces:**
- Consumes: `PermissionSnapshot`, `snapshot()`, `inherit` from Task 1.
- Produces: no signature changes. Child policy = `new PermissionPolicy({ cwd: deps.cwd, readOnlyRoots: [], allowWrite: [], yolo: deps.policy.yolo, interactive: false, inherit: deps.policy.snapshot() })`.

- [ ] **Step 1: Write failing tests** (reuse fake streamFn/echoTool patterns already in subagent.test.ts):
  - `"inherits parent-approved commands without yolo"`: parent policy interactive:true, confirm stub "allow"; pre-approve bash command `pnpm test` via `parent.check("bash", {command:"pnpm test"})`. Child stream emits bash toolCall `{command:"pnpm test"}` then final text; createTools returns a bash-named echo tool recording execution. Assert tool executed (yolo:false throughout).
  - `"denies commands outside the snapshot with actionable copy"`: same setup, child runs `pnpm build` (never approved). Assert tool NOT executed; progress/result surfaces the new denial copy (check via onProgress texts containing `/permissions add`).
  - `"inherits persistent allowWrite for child writes"`: parent yolo:false interactive:false allowWrite `["**"]` (tmpdir cwd); child stream emits write toolCall to a file in cwd; createTools returns write echo tool. Assert executed.
- [ ] **Step 2: Run to verify failure**

  Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/subagent.test.ts`
  Expected: 3 new FAIL (grants not inherited), existing 7 PASS.

- [ ] **Step 3: Implement**

  One-line change per Interfaces. Check whether child policies ever get `setExtraTools` called (grep session.ts refreshTools path): if not, extension tools would be "Unknown tool" in children even with snapshot — include `extraTools` in snapshot/inherit (type + constructor + snapshot()) and ledger the ruling; add assertion to the round-trip test in Task 1's file if extended.

- [ ] **Step 4: Run to verify pass**

  Run: same command. Expected: 10 PASS.

- [ ] **Step 5: Full verification**

  Run: `pnpm typecheck && pnpm test`
  Expected: clean; whole suite green.

- [ ] **Step 6: Commit**

  ```bash
  git add packages/coding-agent/src/subagent.ts packages/coding-agent/test/subagent.test.ts docs/superpowers/specs/2026-11-17-subagent-permission-inheritance-design.md docs/superpowers/plans/2026-11-17-subagent-permission-inheritance.md
  git commit -m "feat(agent): subagents inherit a snapshot of parent permission grants"
  ```

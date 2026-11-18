# Subagent Progress Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a subagent's live activity (status line + tool log) in the parent's `task` tool card while it runs.

**Architecture:** A pure formatter module turns the child agent's `AgentEvent`s into progress text (first line = current activity, rest = capped log). The subagent runner calls it from its existing event subscription and forwards text via a new per-request `onProgress` callback; `createTaskTool` wires that to `ctx.onUpdate`, reusing the existing `tool_execution_update` → TUI card pipeline. No TUI changes.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-17-subagent-progress-design.md`

## Global Constraints

- Subagent hard cap stays `maxTurns: 30`, `maxAutoContinues: 0` — unchanged.
- Log cap: keep the most recent **100** lines; when dropping, prefix `[earlier activity dropped]`. Whole text then tail-sliced to **16384** chars (16KB).
- Args summary: `JSON.stringify(args)` (compact, single line), clipped to **80** chars with trailing `…`.
- Status line: `▸ turn ${turn}/30 · ${activity}`; idle activity is `thinking …`.
- Log line: `✓ ${name} ${argsSummary} · ${duration}` or `✗ ${name} ${argsSummary} · ${duration} — ${firstNonEmptyResultLine clipped to 80}`.
- Duration: `<1000ms → "${Math.round(ms)}ms"`, else `"${(ms/1000).toFixed(1)}s"` (no minutes branch needed at 30-turn scale).
- Final `tool_execution_end` of the parent task still replaces card output with the report — do not touch `cli.ts` or TUI.
- `-p`/`--json` print mode: no changes (it ignores update events already).
- Queue message `"Waiting for subagent slot..."` unchanged.
- Work happens on `main` in the current checkout; the dirty `packages/tui/*` files are unrelated — **commit only the files listed per task**, never `git add -A`.

## Review Focus

- Concurrent tasks sharing one runner must not mix progress streams → per-request formatter; tested in Task 2.
- `onProgress` absent (e.g. existing callers/tests) → zero behavior change; existing subagent tests must pass untouched.
- Child tool error or permission-blocked call → `✗` line with reason, run continues; tested in Task 1 (formatter) and Task 2 (blocked write).
- Enormous args or tool output → clipped args, capped log, no unbounded partials; tested in Task 1.
- Abort mid-run → no further `onProgress` calls after abort, no throw; tested in Task 2.

---

### Task 1: Progress formatter module

**Files:**
- Create: `packages/coding-agent/src/subagent-progress.ts`
- Test: `packages/coding-agent/test/subagent-progress.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` from `@cletus/agent` (variants `turn_start {turn}`, `tool_execution_start {toolCallId, toolName, args}`, `tool_execution_end {toolCallId, toolName, result}`).
- Produces:
  ```ts
  export function createSubagentProgress(maxTurns: number): {
    /** Returns the full progress text when the display should change, else undefined. */
    handle(event: AgentEvent): string | undefined;
  };
  ```
  Task 2 calls `createSubagentProgress(30)` once per subagent run.

- [ ] **Step 1: Write failing tests** in `subagent-progress.test.ts` (vitest, import from `../src/subagent-progress.js`; build plain `AgentEvent` object literals — no Agent needed):
  - `"renders a status line plus a log of finished tools"`: feed `turn_start {turn:1}`, `tool_execution_start {toolCallId:"a", toolName:"read", args:{path:"src/app.ts"}}`, then `tool_execution_end` with success result. Assert: start snapshot's first line is `▸ turn 1/30 · read {"path":"src/app.ts"}`; end snapshot's first line is `▸ turn 1/30 · thinking …` and it contains a line matching `/^✓ read \{"path":"src\/app\.ts"\} · \d+m?s?/`.
  - `"marks failed tools with ✗ and the first result line"`: end event with `{isError:true, content:[{type:"text",text:"\nexit 1\nmore"}]}` → log line contains `✗` and ends `— exit 1`.
  - `"clips args to 80 chars"`: start with a 500-char string arg → activity's args portion length ≤ 81 (80 + `…`).
  - `"keeps only the last 100 log lines"`: 105 start/end pairs → text contains `[earlier activity dropped]`, contains tool #105's line, not tool #1's; total length ≤ 16384.
  - `"returns undefined for unrelated events"`: `handle({type:"agent_start"})` → `undefined`.

- [ ] **Step 2: Run to verify failure**

  Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/subagent-progress.test.ts`
  Expected: FAIL — cannot resolve `../src/subagent-progress.js`.

- [ ] **Step 3: Implement `subagent-progress.ts`**

  Signature above. Internal state: `turn = 0`, `activity = "thinking …"`, `lines: string[]`, `starts = new Map<string, {name, args, at}>()`, `dropped = false`. On `turn_start`: set turn, activity `thinking …`, return text. On `tool_execution_start`: record start, set activity `${name} ${clip(argsSummary)}`, return text. On `tool_execution_end`: push log line (icon from `result.isError`; error detail = first non-empty line of concatenated text content, clipped 80), delete start entry, activity `thinking …`, enforce 100-line cap (set `dropped`), return text. Other events: `undefined`. Text assembly: status line, optional `[earlier activity dropped]`, lines joined with `\n`, tail-slice 16384. Use `Date.now()` for durations.

- [ ] **Step 4: Run to verify pass**

  Run: same command as Step 2. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

  ```bash
  git add packages/coding-agent/src/subagent-progress.ts packages/coding-agent/test/subagent-progress.test.ts
  git commit -m "feat(agent): format subagent activity as status line plus capped log"
  ```

### Task 2: Wire progress through runner and task tool

**Files:**
- Modify: `packages/coding-agent/src/tools/task.ts` (SubagentRequest type + execute)
- Modify: `packages/coding-agent/src/subagent.ts` (subscription handler)
- Test: `packages/coding-agent/test/subagent.test.ts` (add cases; keep existing 2 untouched)

**Interfaces:**
- Consumes: `createSubagentProgress(maxTurns)` from Task 1.
- Produces: `SubagentRequest` gains `onProgress?: (text: string) => void`. `createTaskTool` passes `onProgress: (text) => ctx.onUpdate({ content: [{ type: "text", text }] })` in its `spawnSubagent` call. No other signature changes.

- [ ] **Step 1: Write failing tests** (reuse the fake `streamFn`/`AssistantEventStream` pattern already in `subagent.test.ts`):
  - `"streams tool activity through onProgress"`: child stream emits one `ls` tool call then a final text message; `createTools` returns a trivial `ls` tool. Collect `onProgress` texts. Assert: some text's first line matches `/^▸ turn \d+\/30 · ls/`; last text contains `✓ ls`; final `ToolResult` text is still just the child's summary (progress never leaks into the report).
  - `"reports blocked writes as failed activity"`: reuse the denied-write scenario (yolo:false); assert some progress text contains `✗ write` and `blocked` (reason from policy), and result summary unchanged.
  - `"task tool forwards progress to ctx.onUpdate"`: `createTaskTool({spawnSubagent: async (req) => { req.onProgress?.("▸ turn 1/30 · thinking …"); return {content:[{type:"text",text:"done"}]}; }})`; execute with a stub `ToolExecutionContext` capturing `onUpdate`. Assert captured partials contain that text and final result is `done`.
  - `"concurrent tasks keep separate progress streams"`: one shared runner; two fake streams keyed by prompt, each calling a distinctly named tool (`ls_a` / `ls_b` via `createTools`); run both requests concurrently with separate collectors. Assert collector A never contains `ls_b` and vice versa.
  - `"stops progress after abort"`: child stream would emit a tool call every turn (never a final text); pass an `AbortController` signal and call `abort()` from inside the child tool's `execute`. Assert `run` resolves without throwing, some progress contains `✗` (the aborted tool), and no progress text contains `turn 2` (the loop stopped before another turn).

- [ ] **Step 2: Run to verify failure**

  Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/subagent.test.ts`
  Expected: new tests FAIL (no `onProgress` on type / no calls), existing 2 PASS.

- [ ] **Step 3: Implement**

  - `task.ts`: add `onProgress?: (text: string) => void` to `SubagentRequest`; in `execute`, pass it through to `deps.spawnSubagent` as specified in Interfaces.
  - `subagent.ts`: inside the returned per-request closure, `const progress = createSubagentProgress(30);`. First line of the existing `agent.subscribe` handler: `const text = progress.handle(event); if (text !== undefined) req.onProgress?.(text);` — keep the existing usage/text accumulation below it untouched.

- [ ] **Step 4: Run to verify pass**

  Run: same command as Step 2. Expected: PASS (7 tests).

- [ ] **Step 5: Full verification**

  Run: `pnpm typecheck && pnpm test`
  Expected: typecheck clean; whole suite green (TUI's uncommitted changes included — if a TUI test fails, confirm it fails on the pre-existing dirty files and report, don't fix here).

- [ ] **Step 6: Commit**

  ```bash
  git add packages/coding-agent/src/tools/task.ts packages/coding-agent/src/subagent.ts packages/coding-agent/test/subagent.test.ts docs/superpowers/specs/2026-11-17-subagent-progress-design.md docs/superpowers/plans/2026-11-17-subagent-progress.md
  git commit -m "feat(agent): surface subagent activity in the task tool card"
  ```

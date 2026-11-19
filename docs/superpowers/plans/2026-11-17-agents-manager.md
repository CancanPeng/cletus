# /agents Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/agents` slash command: view agent definitions in the manageTabs popup, space-toggle on/off (persisted), Enter/new-file editing via $EDITOR with TUI suspend/resume.

**Architecture:** config gains `agentOverrides` (filter applied in session.toolsFor next to the model-ref filter). TUI's ManagedListTab gains optional `onOpen` (Enter fires it and closes the popup); TuiApp gains `editFile(path, editorCommand)` (suspend → spawn stdio:inherit → finally resume). cli.ts wires the `/agents` command: list tab + New prompt tab, template generation as a pure exported function.

**Tech Stack:** TypeScript ESM, vitest, @opentui/core (CliRenderer.suspend/resume verified at renderer.d.ts:651-652), node:child_process spawn.

**Spec:** `docs/superpowers/specs/2026-11-17-agents-manager-design.md`

## Global Constraints

- config key: `agentOverrides: Record<string, "on" | "off">`, default `{}`, merged like skillOverrides (config.ts:144 pattern).
- Filter point: session.toolsFor agents list — drop `agentOverrides[def.name] === "off"` BEFORE the model-ref filter. ResourceLoader untouched (list tab must still show off entries).
- ManagedListTab: `onOpen?: (item: ManagedItem) => void`. Enter: if onOpen present → closeManager() then onOpen(item); else current behavior (close). No other manager behavior changes.
- `TuiApp.editFile(path: string, editorCommand: string): Promise<void>` — spawn(editorCommand, [path], {stdio:"inherit", shell:true}) after `await renderer.suspend()`; `await renderer.resume()` in finally; non-zero editor exit → notify warn but resolve (still reload). TUI does NOT read env; cli resolves the editor chain: `$EDITOR` → `$VISUAL` → first existing of nvim/vim/vi/nano (via `which`); none → notify path, no editFile call.
- New/override files always written to `join(home, "agents")`; project-source agents edit their original `def.path`.
- Template (exact shape): `---\nname: <name>\ndescription: TODO: describe when to delegate to this agent\n---\nYou are the <name> agent. TODO: define this role.\n` — builtin override additionally pre-fills `tools: [<orig tools>]` and `model: <orig model>` lines when present, and uses the builtin's description/prompt instead of TODO placeholders.
- Name validation for New: `/^[a-zA-Z0-9_-]+$/`; existing name → notify "already exists — edit it from the list" and do NOT overwrite.
- `/agents` refuses while streaming (same copy pattern as /skills: "Cannot manage agents while running").
- Popup closes BEFORE suspend (spec: no popup state across editor session).
- After editFile resolves (or editor missing): `opts.resources.reload(); await opts.resources.load(); session.refreshTools();` then notify "Agents reloaded".
- Work in place on main; commit only listed files; untracked user files (docs/cletus-intro.*, EDR*, scratch/) untouched.

## Review Focus

- Editor crash / non-zero exit must still resume the TUI (finally) and reload → Task 2 test with failing editor command.
- Enter without onOpen must keep closing the popup (skills regression) → Task 2 test + existing skills-tabs suite.
- off filter must remove the agent from BOTH the task description list and the runner's agents (single filter point feeds both) → Task 1 test.
- New-name collision / path traversal (`../evil`) must never write outside home/agents → Task 3 tests.
- Builtin override template must carry orig tools/model so the override doesn't silently widen tools → Task 3 test.

---

### Task 1: agentOverrides config + session filter

**Files:**
- Modify: `packages/coding-agent/src/config.ts` (type, default, merge)
- Modify: `packages/coding-agent/src/session/session.ts` (toolsFor filter)
- Test: `packages/coding-agent/test/config.test.ts`, `packages/coding-agent/test/session.test.ts` (add cases)

**Interfaces:**
- Produces: `CletusConfig.agentOverrides: Record<string, "on" | "off">`. Session filter reads `this.options.config.agentOverrides`. Task 3 writes it via `writeJsonAtomic(configPath(opts.home), opts.config)` (existing pattern).

- [ ] **Step 1: Write failing tests**:
  - config: `"agentOverrides defaults and merges"` — createDefaultConfig().agentOverrides = {}; loadConfig of a file with `{"agentOverrides":{"explore":"off"}}` preserves it (follow existing config.test.ts file-fixture pattern).
  - session: `"off agents are excluded from delegation"` — follow existing session.test.ts construction; set config.agentOverrides `{explore:"off"}`; resources with builtin agents; after create, find task tool in session.agent.state.tools; assert description lacks `- explore:` and contains `- general-purpose:`.
- [ ] **Step 2: Verify RED** — run both files; new fail, existing pass.
- [ ] **Step 3: Implement** — three config.ts lines (type/default/merge) + one filter line in toolsFor before the model-ref filter: `.filter((def) => this.options.config.agentOverrides[def.name] !== "off")`.
- [ ] **Step 4: Verify GREEN** — same run.
- [ ] **Step 5: Commit** — `git add packages/coding-agent/src/config.ts packages/coding-agent/src/session/session.ts packages/coding-agent/test/config.test.ts packages/coding-agent/test/session.test.ts && git commit -m "feat(config): agentOverrides to disable subagent types"`

### Task 2: TUI onOpen + editFile

**Files:**
- Modify: `packages/tui/src/app.ts` (ManagedListTab.onOpen, Enter branch, editFile method)
- Test: `packages/tui/test/agents-manager.test.ts` (new; mirror skills-tabs.test.ts harness)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ManagedListTab.onOpen?: (item: ManagedItem) => void`; `TuiApp.editFile(path: string, editorCommand: string): Promise<void>`. Task 3 uses both.

- [ ] **Step 1: Write failing tests** (createTestRenderer harness from skills-tabs.test.ts):
  - `"Enter opens the item when onOpen is set"`: list tab with onOpen collector; type filter to pick item, pressEnter → onOpen called with that item, popup closed (frame no longer shows tab header).
  - `"Enter without onOpen still closes the popup"`: same harness, no onOpen → manageTabs promise resolves, no throw.
  - `"editFile suspends and resumes around the editor"`: app.editFile("/tmp/x.md", "true") resolves; afterwards app still renders (appendBlock + flush shows text). Use a marker script via `sh -c` wrapper if needed to record invocation: editorCommand `sh -c 'echo ran >> /tmp/marker' --` is fragile with the [path] arg — instead use editorCommand "true" for lifecycle and a separate temp script file (writeFileSync chmod 755) that appends its argv to a marker file, asserting the path argument arrives.
  - `"editFile resumes even when the editor fails"`: editorCommand "false" (exit 1) → promise resolves (warn notified), renderer usable afterwards.
- [ ] **Step 2: Verify RED** — `NODE_OPTIONS=--experimental-ffi npx vitest run packages/tui/test/agents-manager.test.ts`; new fail (onOpen ignored / editFile missing).
- [ ] **Step 3: Implement** — onOpen in type + Enter branch per Global Constraints; editFile: guard renderer exists; `await this.renderer.suspend()`; spawn with shell:true (editorCommand may be "code -w"); await close event; finally `await this.renderer.resume()`; non-zero code → this.notify(...,"warn"). Note: test renderer may not implement suspend/resume identically — if createTestRenderer's renderer lacks them, stub via (renderer as any) in tests ONLY if the real CliRenderer has them (verified); ledger any harness accommodation.
- [ ] **Step 4: Verify GREEN** — same run + full tui suite: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/tui`.
- [ ] **Step 5: Commit** — `git add packages/tui/src/app.ts packages/tui/test/agents-manager.test.ts && git commit -m "feat(tui): manager list onOpen action and external editor handoff"`

### Task 3: /agents command wiring + templates

**Files:**
- Create: `packages/coding-agent/src/agents-manager.ts` (pure helpers: validateAgentName, agentTemplate, resolveEditorCommand)
- Modify: `packages/coding-agent/src/cli.ts` (/agents command after /skills)
- Test: `packages/coding-agent/test/agents-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 `config.agentOverrides`; Task 2 `onOpen` + `editFile`; existing `promptInput`, `manageTabs`, `writeJsonAtomic`, `configPath`, resources reload pattern.
- Produces:
  ```ts
  export function validateAgentName(name: string): boolean; // /^[a-zA-Z0-9_-]+$/
  export function agentTemplate(def: { name: string; description?: string; tools?: string[]; model?: string; prompt?: string }): string; // Global Constraints shape; builtin override passes orig fields
  export function resolveEditorCommand(env: NodeJS.ProcessEnv, which: (cmd: string) => boolean): string | undefined; // $EDITOR → $VISUAL → nvim/vim/vi/nano
  ```

- [ ] **Step 1: Write failing tests** (pure functions, no TUI):
  - validateAgentName: "reviewer" true; "../evil" false; "a b" false; "" false.
  - agentTemplate: plain name → exact TODO template; builtin override (description/tools/model/prompt given) → frontmatter contains `tools: [read, grep]` style list + model line + orig description, body = orig prompt.
  - resolveEditorCommand: {EDITOR:"nvim"} → "nvim"; {VISUAL:"code -w"} → "code -w"; {} with which("vim")=true → "vim"; {} all false → undefined.
- [ ] **Step 2: Verify RED** — module missing.
- [ ] **Step 3: Implement helpers + wire /agents in cli.ts**:
  - Command refuses while streaming; loads resources; list items: id=name, label=`${name} · ${source}${model ? " · " + model : ""}${tools ? " · " + tools.length + " tools" : ""} — ${description}`, state from agentOverrides (default "on"), states ["on","off"].
  - onCycle: write config.agentOverrides + writeJsonAtomic; resources untouched (filter is session-side); session.refreshTools().
  - onOpen: find def by id; builtin → write override template to home/agents/<name>.md (never overwrite existing file — if exists, edit it); file-source → edit def.path. Then editor chain; editFile; reload+refreshTools+notify per Global Constraints.
  - New prompt tab: validateAgentName; collision check against loaded agents → notify and return; write template; same editor handoff.
  - After manageTabs resolves: reload + load + refreshTools (same as /skills tail).
- [ ] **Step 4: Verify GREEN** — helpers tests pass; `pnpm typecheck`.
- [ ] **Step 5: Full verification** — `pnpm test` whole suite green.
- [ ] **Step 6: Commit** — `git add packages/coding-agent/src/agents-manager.ts packages/coding-agent/src/cli.ts packages/coding-agent/test/agents-manager.test.ts docs/superpowers/specs/2026-11-17-agents-manager-design.md docs/superpowers/plans/2026-11-17-agents-manager.md && git commit -m "feat(cli): /agents manager popup with editor handoff"`

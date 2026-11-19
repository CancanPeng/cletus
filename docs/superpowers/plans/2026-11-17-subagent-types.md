# Subagent Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delegate subagents by type — markdown agent definitions (name/description/tools/model + prompt body), built-in explore/general-purpose roles, per-agent model resolution.

**Architecture:** New `resources/agents.ts` loader (skills.ts pattern: frontmatter, realpath dedup, trustProject gating) merged into ResourceLoader. `PermissionPolicy` gains a `readOnly` constructor flag (not in snapshots). `createSubagentRunner` takes the agent list + a model resolver and builds per-type tools/prompt/model/policy. `task` tool gains optional `subagent_type` and a dynamic description listing available agents.

**Tech Stack:** TypeScript ESM (`.js` suffixes), vitest, yaml (already a dep via skills.ts).

**Spec:** `docs/superpowers/specs/2026-11-17-subagent-types-design.md`

## Global Constraints

- Definition dirs: `join(home, "agents")` (personal) + `join(cwd, ".cletus", "agents")` (project, ONLY when trustProject). No ancestor walk (spec lists two dirs only). Flat `*.md` files, no recursion.
- Frontmatter: `name` (default: filename without .md), `description` (required non-empty string, else skip file), `tools` (optional string[] whitelist of core names: read write edit bash grep find ls curl web_search; unknown names dropped with a warning; `task` always excluded), `model` (optional ref string).
- Precedence: project > personal > builtin, by name. Builtins: `explore` (tools: read grep find ls web_search curl; no contextFiles/skills in prompt) and `general-purpose` (all core; contextFiles+skills loaded — current behavior).
- Builtin explore prompt body (exact): `You are a read-only exploration agent. Search and analyze the codebase, then report findings concisely. Never modify files or run commands.`
- Builtin general-purpose prompt body (exact): `You are a general-purpose coding agent. Complete the delegated task independently, exploring and modifying code as needed.`
- Invalid model ref: agent excluded from the list + warning via onNotice; task tool itself must not break.
- Unknown subagent_type: isError ToolResult listing available type names (model self-corrects).
- Omitted subagent_type = general-purpose. Existing task calls and all existing tests unchanged.
- readOnly policy flag: check() denies write/edit/bash with reason `Denied: agent is read-only` BEFORE grant/yolo checks. NOT part of PermissionSnapshot.
- Progress status line gains the type label: `▸ ${label} turn N/30 · …` when label non-empty; existing format unchanged when empty.
- Custom agent prompt: body is appended as an `<agent_role>` block after the base prompt (instruction precedence overrides the default persona; threading a persona param through buildSystemPrompt is unnecessary churn). Tools/rules sections stay; contextFiles+skills loaded by default. The `<subagent>` suffix block stays for all types.
- Work in place on main; commit only listed files; untracked docs/cletus-intro.* untouched.

## Review Focus

- Untrusted project definitions must not load without trustProject (prompt-injection surface, same as skills) → Task 1 test.
- explore double-lock: tool list has no write/edit/bash AND policy denies them even if a write tool were somehow present → Task 3 tests (both layers separately).
- Model routing: child LLM requests must carry the definition's model (not parent's) incl. provider-specific streamFn dispatch and getApiKey → Task 3 test with two-model fake config.
- Malformed definitions (missing description, bad YAML, unknown tools, invalid model ref) degrade gracefully — skip/warn, never throw into the task path → Task 1 + Task 3 tests.
- Concurrent different-type tasks: per-request model/policy/tools must not leak across requests sharing one runner → Task 3 test.

---

### Task 1: Agent definition loader + resource integration

**Files:**
- Create: `packages/coding-agent/src/resources/agents.ts`
- Modify: `packages/coding-agent/src/resources/skills.ts` (export parseFrontmatter)
- Modify: `packages/coding-agent/src/resources/index.ts` (LoadedResources.agents, load in parallel)
- Test: `packages/coding-agent/test/agents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentDefinition = {
    name: string;
    description: string;
    tools?: string[];        // undefined = all core
    model?: string;          // ref for resolveModel
    prompt: string;          // frontmatter body, trimmed
    source: "builtin" | "personal" | "project";
    path?: string;           // undefined for builtins
    readOnly?: boolean;      // true for builtin explore
    omitContext?: boolean;   // true for builtin explore (no contextFiles/skills)
  };
  export const CORE_TOOL_NAMES: string[]; // the 9 whitelist names
  export function builtinAgents(): AgentDefinition[];
  export async function loadAgents(cwd: string, home: string, trustProject?: boolean): Promise<{ agents: AgentDefinition[]; warnings: string[] }>;
  ```
  `LoadedResources` gains `agents: AgentDefinition[]` and `agentWarnings: string[]`. Task 2/3 consume `AgentDefinition` and the loaded list.
- Consumes: `parseFrontmatter` from skills.ts (export it; keep signature `{ meta: Record<string, unknown>; body: string }`).

- [ ] **Step 1: Write failing tests** in agents.test.ts (tmpdir pattern from permissions.test.ts):
  - `"loads personal and project definitions with frontmatter"`: write home/agents/reviewer.md (name/description/tools/model + body) and cwd/.cletus/agents/helper.md; loadAgents(cwd, home, true) → both present with parsed fields, source correct, prompt = trimmed body.
  - `"project definitions require trust"`: same setup, trustProject false → project agent absent, personal present.
  - `"name defaults to filename and description is required"`: file without name → name = basename; file without description → skipped.
  - `"project overrides personal overrides builtin by name"`: define `explore` in both dirs → project wins (source "project"); personal `general-purpose` overrides builtin.
  - `"unknown tool names are dropped with a warning"`: tools: [read, frobnicate] → tools = [read], warnings mention frobnicate.
  - `"builtins are always present with correct shape"`: empty dirs → exactly explore + general-purpose; explore.readOnly true, explore.omitContext true, explore.tools excludes write/edit/bash/task; general-purpose.tools undefined.
  - `"bad YAML frontmatter is skipped without throwing"`: file with invalid YAML meta → falls back to {} → no description → skipped.
- [ ] **Step 2: Run to verify failure**

  Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/agents.test.ts`
  Expected: FAIL — cannot resolve agents.js.

- [ ] **Step 3: Implement**

  agents.ts per Interfaces. Read dirs with readdir (flat *.md only, skip non-files), realpath-dedupe files, parse via exported parseFrontmatter, validate per Global Constraints, merge by name with precedence project > personal > builtin (Map keyed by name, insert builtins first then personal then project). Warnings collected, never thrown. Export parseFrontmatter from skills.ts (delete local copy, import instead — no behavior change). Wire ResourceLoader.load(): add loadAgents to the Promise.all, expose agents + agentWarnings on LoadedResources.
- [ ] **Step 4: Run to verify pass** — same command, all PASS. Also run resources.test.ts (loader integration must not regress): `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/agents.test.ts packages/coding-agent/test/resources.test.ts`
- [ ] **Step 5: Commit**

  ```bash
  git add packages/coding-agent/src/resources/agents.ts packages/coding-agent/src/resources/skills.ts packages/coding-agent/src/resources/index.ts packages/coding-agent/test/agents.test.ts
  git commit -m "feat(resources): load subagent definitions from agents directories"
  ```

### Task 2: readOnly policy flag + progress label

**Files:**
- Modify: `packages/coding-agent/src/permissions/policy.ts` (readOnly ctor opt + check guards)
- Modify: `packages/coding-agent/src/subagent-progress.ts` (label param)
- Test: `packages/coding-agent/test/permissions.test.ts`, `packages/coding-agent/test/subagent-progress.test.ts` (add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PermissionPolicy` ctor opt `readOnly?: boolean` (default false); denial reason exact `Denied: agent is read-only` for write/edit/bash, checked before allowlist/yolo/session grants. `createSubagentProgress(maxTurns: number, label?: string)` — status line `▸ ${label} turn N/M · …` when label non-empty (label + single space), unchanged otherwise. Task 3 passes both.

- [ ] **Step 1: Write failing tests**:
  - permissions: `"readOnly denies writes even with yolo and grants"` — readOnly:true + yolo:true + allowWrite:["**"] → write/edit/bash all denied with exact reason; read still allowed; snapshot() of a readOnly policy inherited into a normal child does NOT make the child readOnly.
  - progress: `"prefixes the status line with the agent label"` — createSubagentProgress(30, "explore") → first line starts `▸ explore turn 1/30 · `; without label unchanged (existing tests already pin this).
- [ ] **Step 2: Verify RED** — run both test files; new cases fail, existing pass.
- [ ] **Step 3: Implement** — readOnly private field; in check(), before the write/edit branch's grant logic and in bash branch head: `if (this.readOnly) return { allow: false, reason: "Denied: agent is read-only" };` (write/edit share one guard at branch top after resolveWrite so .git error still wins for .git paths — decide: guard BEFORE resolveWrite is simpler and equally safe; pick before, ledger nothing). Do NOT add readOnly to PermissionSnapshot. Progress: second optional param, template per Interfaces.
- [ ] **Step 4: Verify GREEN** — same run, all pass.
- [ ] **Step 5: Commit**

  ```bash
  git add packages/coding-agent/src/permissions/policy.ts packages/coding-agent/src/subagent-progress.ts packages/coding-agent/test/permissions.test.ts packages/coding-agent/test/subagent-progress.test.ts
  git commit -m "feat(permissions): read-only policy flag and labeled subagent progress"
  ```

### Task 3: Type routing in runner + task tool + session wiring

**Files:**
- Modify: `packages/coding-agent/src/tools/task.ts` (SubagentRequest.subagentType, dynamic description, type param schema)
- Modify: `packages/coding-agent/src/subagent.ts` (agents deps, per-type model/tools/prompt/policy)
- Modify: `packages/coding-agent/src/session/session.ts` (pass agents + resolver into runner, tool list refresh already covered by refreshTools)
- Test: `packages/coding-agent/test/subagent.test.ts` (add cases; existing 10 untouched)

**Interfaces:**
- Consumes: `AgentDefinition`/`CORE_TOOL_NAMES` (Task 1), `readOnly` ctor opt + `createSubagentProgress(maxTurns, label)` (Task 2).
- Produces:
  ```ts
  // task.ts
  export type SubagentRequest = { description: string; prompt: string; signal?: AbortSignal; onProgress?: (text: string) => void; subagentType?: string };
  createTaskTool(deps: { spawnSubagent: ...; maxConcurrent?: number; agents?: AgentDefinition[] })
  // description: base line + "\nAvailable subagent types:\n" + agents.map(a => `- ${a.name}: ${a.description}`).join("\n") (omit section when agents empty/undefined)
  // parameters.subagentType: { type: "string", description: "Optional agent type; omit for general-purpose" } — property name subagent_type in schema, mapped to req.subagentType
  // subagent.ts deps gains:
  agents: AgentDefinition[];
  resolveModel: (ref: string) => Model;   // throws on unknown ref
  buildSystemPrompt: (tools: AgentTool[], def: AgentDefinition) => string;  // session decides contextFiles/skills per def.omitContext
  ```
  Runner behavior: resolve def = agents.find(name === (req.subagentType ?? "general-purpose")); unknown → `{ isError: true, content: [text listing available names] }` without spawning. Model: def.model ? deps.resolveModel(def.model) : deps.model (resolver throw → isError result with the ref in message). Tools: createTools(...excludeTask:true) then filter by def.tools when defined. Policy: inherit snapshot + `readOnly: def.readOnly === true`. Progress label = def.name. Prompt = deps.buildSystemPrompt(tools, def) + existing `<subagent>` block. details gains `model: model.ref ?? model.id` and `subagentType: def.name`.

- [ ] **Step 1: Write failing tests** (existing fake-stream patterns; two-model config helper: model A openai/fake, model B anthropic/fake-b with distinct ids; streamFn records model.id per call):
  - `"routes subagent_type to the definition's model and tools"`: agents [explore builtin]; streamFn records models + contexts; request subagentType "explore" with def.model "fake-b" → recorded model id fake-b; context tools exclude write/edit/bash.
  - `"unknown type errors with the available list"`: subagentType "nope" → isError, text contains "explore" and "general-purpose"; streamFn never called.
  - `"omitted type keeps parent model and full tools"`: no subagentType → parent model id recorded; tools include write.
  - `"explore policy denies writes even if a write tool slips through"`: agents [{...explore, tools: undefined}] (deliberately no whitelist) + createTools returns write echo tool; child stream calls write → not executed; result/progress contains `agent is read-only`.
  - `"invalid model ref becomes an isError result naming the ref"`: def.model "ghost" with resolver that throws → isError, message contains "ghost"; other types still work after.
  - `"concurrent different types keep separate models"`: two defs with different models, two concurrent requests keyed by prompt → each stream's model matches its type.
  - `"task tool description lists agents and schema accepts subagent_type"`: createTaskTool with agents → description contains `- explore:`; execute with params {subagent_type: "explore"} → spawnSubagent receives subagentType "explore".
- [ ] **Step 2: Verify RED** — `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/subagent.test.ts`; new fail, existing 10 pass.
- [ ] **Step 3: Implement** — per Interfaces. session.ts toolsFor: pass `agents: this.resources.agents`, `resolveModel: (ref) => resolveModel(this.options.config, this.options.auth, ref)`, buildSystemPrompt(tools, def) => buildSystemPrompt({ cwd, tools, contextFiles: def.omitContext ? [] : this.resources.contextFiles, skills: def.omitContext ? [] : this.resources.skills }) with def.prompt appended as persona replacement — implement persona replacement inside subagent.ts: base prompt from buildSystemPrompt keeps its default persona line; append `\n\n<agent_role>\n${def.prompt}\n</agent_role>` after it (simpler than threading persona through buildSystemPrompt; the role block overrides persona by instruction precedence — ledger this as the reading of "body replaces persona" if reviewer objects). Invalid-model filtering happens at list build time in session (filter agents whose model ref fails resolveModel, onNotice warning) AND defensively in runner (isError). createTaskTool receives the same filtered list.
- [ ] **Step 4: Verify GREEN** — same run, all pass (17).
- [ ] **Step 5: Full verification** — `pnpm typecheck && pnpm test`; whole suite green.
- [ ] **Step 6: Commit**

  ```bash
  git add packages/coding-agent/src/tools/task.ts packages/coding-agent/src/subagent.ts packages/coding-agent/src/session/session.ts packages/coding-agent/test/subagent.test.ts docs/superpowers/specs/2026-11-17-subagent-types-design.md docs/superpowers/plans/2026-11-17-subagent-types.md
  git commit -m "feat(agent): delegate subagents by type with per-agent models and tools"
  ```

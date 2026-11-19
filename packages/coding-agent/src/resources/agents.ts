import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./skills.js";

export type AgentDefinition = {
  name: string;
  description: string;
  /** Whitelist of core tool names; undefined = all core tools. */
  tools?: string[];
  /** Model ref resolved via resolveModel; undefined = parent's model. */
  model?: string;
  /** Frontmatter body: the agent's role instructions. */
  prompt: string;
  source: "builtin" | "personal" | "project";
  path?: string;
  /** Read-only agents deny write/edit/bash at the policy layer too. */
  readOnly?: boolean;
  /** Skip contextFiles/skills in the system prompt (fast research). */
  omitContext?: boolean;
};

export const CORE_TOOL_NAMES: string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "curl",
  "web_search",
];

export function builtinAgents(): AgentDefinition[] {
  return [
    {
      name: "explore",
      description:
        "Read-only codebase exploration: file discovery, code search, and analysis. Use for research that should not modify anything.",
      tools: ["read", "grep", "find", "ls", "web_search", "curl"],
      prompt:
        "You are a read-only exploration agent. Search and analyze the codebase, then report findings concisely. Never modify files or run commands.",
      source: "builtin",
      readOnly: true,
      omitContext: true,
    },
    {
      name: "general-purpose",
      description:
        "Capable agent for complex multi-step tasks requiring both exploration and code modification.",
      prompt:
        "You are a general-purpose coding agent. Complete the delegated task independently, exploring and modifying code as needed.",
      source: "builtin",
    },
  ];
}

/**
 * Loads agent definitions: builtins, then personal (~/.cletus/agents), then
 * project (.cletus/agents, trust-gated like skills — definitions inject
 * prompts). Later sources override earlier ones by name. Malformed files are
 * skipped with warnings, never thrown.
 */
export async function loadAgents(
  cwd: string,
  home: string,
  trustProject = false,
): Promise<{ agents: AgentDefinition[]; warnings: string[] }> {
  const warnings: string[] = [];
  const byName = new Map<string, AgentDefinition>();
  for (const def of builtinAgents()) byName.set(def.name, def);

  const dirs: Array<{ dir: string; source: "personal" | "project" }> = [
    { dir: join(home, "agents"), source: "personal" },
  ];
  if (trustProject) dirs.push({ dir: join(cwd, ".cletus", "agents"), source: "project" });

  const seenFiles = new Set<string>();
  for (const { dir, source } of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      let real: string;
      let text: string;
      try {
        real = await realpath(path);
        if (seenFiles.has(real)) continue;
        seenFiles.add(real);
        text = await readFile(real, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const name =
        typeof meta["name"] === "string" && meta["name"].trim()
          ? meta["name"].trim()
          : basename(entry.name, ".md");
      const description =
        typeof meta["description"] === "string" ? meta["description"].trim() : "";
      if (!name || !description) {
        warnings.push(`Agent definition skipped (missing description): ${path}`);
        continue;
      }
      const def: AgentDefinition = { name, description, prompt: body.trim(), source, path: real };
      if (Array.isArray(meta["tools"])) {
        const tools: string[] = [];
        for (const raw of meta["tools"]) {
          const tool = String(raw);
          if (tool === "task") continue; // recursion guard, always excluded
          if (CORE_TOOL_NAMES.includes(tool)) tools.push(tool);
          else warnings.push(`Agent ${name}: unknown tool "${tool}" ignored`);
        }
        def.tools = tools;
      }
      if (typeof meta["model"] === "string" && meta["model"].trim()) {
        def.model = meta["model"].trim();
      }
      byName.set(name, def);
    }
  }
  return { agents: [...byName.values()], warnings };
}

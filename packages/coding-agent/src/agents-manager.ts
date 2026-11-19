import { stringify as stringifyYaml } from "yaml";

/** Pure helpers for the /agents manager popup (cli.ts wires the TUI). */

export function validateAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Template for a new agent file, or an override of a builtin (pass the
 * builtin's fields to pre-fill them so the override keeps its tool scope).
 */
export function agentTemplate(def: {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  prompt?: string;
}): string {
  // YAML-serialize the meta: descriptions contain ": " (TODO placeholder,
  // builtin explore), which is invalid as a plain scalar and would make the
  // loader silently skip the file.
  const meta: Record<string, unknown> = {
    name: def.name,
    description: def.description ?? "TODO: describe when to delegate to this agent",
  };
  if (def.tools) meta["tools"] = def.tools;
  if (def.model) meta["model"] = def.model;
  const header = stringifyYaml(meta).trimEnd();
  const body = def.prompt ?? `You are the ${def.name} agent. TODO: define this role.`;
  return `---\n${header}\n---\n${body}\n`;
}

/** $EDITOR → $VISUAL → first installed of nvim/vim/vi/nano; undefined = none. */
export function resolveEditorCommand(
  env: NodeJS.ProcessEnv,
  which: (cmd: string) => boolean,
): string | undefined {
  const editor = env["EDITOR"]?.trim();
  if (editor) return editor;
  const visual = env["VISUAL"]?.trim();
  if (visual) return visual;
  for (const cmd of ["nvim", "vim", "vi", "nano"]) {
    if (which(cmd)) return cmd;
  }
  return undefined;
}

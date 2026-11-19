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
  const lines = [
    "---",
    `name: ${def.name}`,
    `description: ${def.description ?? "TODO: describe when to delegate to this agent"}`,
  ];
  if (def.tools) lines.push(`tools: [${def.tools.join(", ")}]`);
  if (def.model) lines.push(`model: ${def.model}`);
  lines.push("---");
  const body = def.prompt ?? `You are the ${def.name} agent. TODO: define this role.`;
  return `${lines.join("\n")}\n${body}\n`;
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

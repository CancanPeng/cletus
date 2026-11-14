import { homedir } from "node:os";
import type { Model } from "@cletus/ai";
import type { Theme } from "@cletus/tui";

export function headerFor(
  cwd: string,
  model: Pick<Model, "provider" | "id" | "ref">,
  branch: string | undefined,
  theme: Theme,
): string {
  const home = homedir();
  const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = [
    `${theme.symbol("model")} ${model.ref ?? `${model.provider}/${model.id}`}`,
    `${theme.symbol("cwd")} ${shortCwd}`,
  ];
  if (branch) parts.push(`${theme.symbol("branch")} ${branch}`);
  return parts.join(" · ");
}

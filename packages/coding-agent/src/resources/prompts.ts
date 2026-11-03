import { glob, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type PromptTemplate = {
  name: string;
  description: string;
  path: string;
  template: string;
};

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const headerEnd = text.indexOf("\n", end + 1);
  const raw = text.slice(3, end).trim();
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { meta, body: headerEnd >= 0 ? text.slice(headerEnd + 1) : "" };
}

export async function loadPrompts(
  cwd: string,
  home: string,
): Promise<PromptTemplate[]> {
  const dirs = [join(home, "prompts"), join(cwd, ".cletus", "prompts")];
  const prompts: PromptTemplate[] = [];
  const names = new Set<string>();
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      for await (const file of glob("*.md", { cwd: dir })) files.push(join(dir, file));
    } catch {
      continue;
    }
    for (const path of files.sort()) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (!text) continue;
      const { meta, body } = parseFrontmatter(text);
      const name = basename(path, ".md");
      if (names.has(name)) continue;
      names.add(name);
      const description =
        typeof meta["description"] === "string"
          ? meta["description"]
          : body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? name;
      prompts.push({ name, description, path, template: body });
    }
  }
  return prompts;
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

export function expandTemplate(template: string, argsString: string): string {
  const args = splitArgs(argsString);
  let result = template;
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, startRaw: string, lenRaw?: string) => {
    const start = Math.max(0, Number(startRaw) - 1);
    const selected = lenRaw
      ? args.slice(start, start + Number(lenRaw))
      : args.slice(start);
    return selected.join(" ");
  });
  result = result.replace(/\$\{(\d+):-([^}]*)\}/g, (_match, indexRaw: string, fallback: string) => {
    const value = args[Number(indexRaw) - 1];
    return value ? value : fallback;
  });
  result = result.replace(/\$\{@:-([^}]*)\}/g, (_match, fallback: string) =>
    args.length > 0 ? args.join(" ") : fallback,
  );
  result = result.replace(/\$@|\$ARGUMENTS/g, args.join(" "));
  result = result.replace(/\$([1-9])/g, (_match, indexRaw: string) => args[Number(indexRaw) - 1] ?? "");
  return result;
}
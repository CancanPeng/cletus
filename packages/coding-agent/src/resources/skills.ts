import { glob, readFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { findRepoRoot } from "./context-files.js";

export type Skill = {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
};

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const raw = text.slice(3, end).trim();
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function skillsIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  try {
    for await (const file of glob("**/SKILL.md", {
      cwd: dir,
      exclude: ["**/node_modules/**", "**/.git/**"],
    })) {
      found.push(join(dir, file));
    }
  } catch {
    // missing directory
  }
  return found;
}

export async function loadSkills(
  cwd: string,
  home: string,
): Promise<{ skills: Skill[]; roots: string[] }> {
  const root = await findRepoRoot(cwd);
  const dirs: string[] = [
    join(home, "skills"),
    join(cwd, ".cletus", "skills"),
    join(cwd, ".agents", "skills"),
  ];
  let current = cwd;
  for (;;) {
    dirs.push(join(current, ".agents", "skills"));
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const seenPaths = new Set<string>();
  const skills: Skill[] = [];
  const names = new Set<string>();
  const roots = new Set<string>();

  for (const dir of dirs) {
    for (const file of await skillsIn(dir)) {
      let real = file;
      try {
        real = await realpath(file);
      } catch {
        continue;
      }
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);
      let text: string;
      try {
        text = await readFile(real, "utf8");
      } catch {
        continue;
      }
      const meta = parseFrontmatter(text);
      const name = typeof meta["name"] === "string" ? meta["name"] : "";
      const description = typeof meta["description"] === "string" ? meta["description"] : "";
      if (!name || !description) continue;
      if (names.has(name)) {
        process.stderr.write(`Warning: duplicate skill ${name}; keeping first\n`);
        continue;
      }
      names.add(name);
      roots.add(dirname(real));
      skills.push({
        name,
        description,
        path: real,
        disableModelInvocation: meta["disable-model-invocation"] === true,
      });
    }
  }
  return { skills, roots: [...roots] };
}
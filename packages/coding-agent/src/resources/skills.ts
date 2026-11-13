import { chmod, glob, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { SkillVisibility } from "../config.js";
import { findRepoRoot } from "./context-files.js";

export type SkillState = SkillVisibility | "model-only";
export type SkillSource = "personal" | "project" | "ancestor";

export type Skill = {
  name: string;
  description: string;
  path: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  visibility: SkillState;
  override?: SkillVisibility;
  whenToUse?: string;
  source: SkillSource;
};

function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(3, end).trim();
  const headerEnd = text.indexOf("\n", end + 1);
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { meta, body: headerEnd >= 0 ? text.slice(headerEnd + 1) : "" };
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

function firstLine(body: string): string {
  return body.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

export async function loadSkills(
  cwd: string,
  home: string,
  overrides: Record<string, SkillVisibility> = {},
): Promise<{ skills: Skill[]; roots: string[] }> {
  const root = await findRepoRoot(cwd);
  const dirs: Array<{ dir: string; source: SkillSource }> = [
    { dir: join(home, "skills"), source: "personal" },
    { dir: join(cwd, ".cletus", "skills"), source: "project" },
    { dir: join(cwd, ".agents", "skills"), source: "project" },
  ];
  let current = cwd;
  for (;;) {
    dirs.push({ dir: join(current, ".agents", "skills"), source: "ancestor" });
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const seenPaths = new Set<string>();
  const seenDirs = new Set<string>();
  const skills: Skill[] = [];
  const names = new Set<string>();
  const roots = new Set<string>();

  for (const { dir, source } of dirs) {
    let realDir = dir;
    try {
      realDir = await realpath(dir);
    } catch {
      continue;
    }
    if (seenDirs.has(realDir)) continue;
    seenDirs.add(realDir);
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
      const { meta, body } = parseFrontmatter(text);
      const name =
        typeof meta["name"] === "string" && meta["name"].trim()
          ? meta["name"].trim()
          : basename(dirname(real));
      const description =
        typeof meta["description"] === "string" && meta["description"].trim()
          ? meta["description"].trim()
          : firstLine(body);
      if (!name || !description) continue;
      if (names.has(name)) {
        process.stderr.write(`Warning: duplicate skill ${name}; keeping first\n`);
        continue;
      }
      names.add(name);
      roots.add(dirname(real));

      const override = overrides[name];
      const frontmatterDisable = meta["disable-model-invocation"] === true;
      const frontmatterUser = meta["user-invocable"] !== false;
      const modelVisible = override
        ? override === "on" || override === "name-only"
        : !frontmatterDisable;
      const userInvocable = override
        ? override !== "off"
        : frontmatterUser;
      const visibility: SkillState =
        override ??
        (!modelVisible
          ? userInvocable
            ? "user-invocable-only"
            : "off"
          : userInvocable
            ? "on"
            : "model-only");
      const skill: Skill = {
        name,
        description,
        path: real,
        disableModelInvocation: !modelVisible,
        userInvocable,
        visibility,
        source,
      };
      if (override) skill.override = override;
      if (typeof meta["when_to_use"] === "string") {
        skill.whenToUse = meta["when_to_use"];
      }
      skills.push(skill);
    }
  }
  return { skills, roots: [...roots] };
}

export async function setSkillModelInvocation(
  path: string,
  disabled: boolean,
): Promise<void> {
  const text = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`Skill has no frontmatter: ${path}`);
  let meta: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid skill frontmatter: ${path}`);
  }
  if (disabled) meta["disable-model-invocation"] = true;
  else delete meta["disable-model-invocation"];
  const header = stringifyYaml(meta).trimEnd();
  const body = text.slice(match[0].length);
  const updated = `---\n${header}\n---\n${body}`;
  const info = await stat(path);
  const temp = join(dirname(path), `.${Date.now()}.${process.pid}.skill.tmp`);
  await writeFile(temp, updated, "utf8");
  await chmod(temp, info.mode);
  await rename(temp, path);
}

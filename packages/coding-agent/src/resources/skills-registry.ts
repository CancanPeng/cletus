import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type RegistrySkill = {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
};

async function json(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "cletus",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${url}`);
  return (await response.json()) as Record<string, unknown>;
}

export async function searchSkillRegistry(
  query: string,
  signal?: AbortSignal,
): Promise<RegistrySkill[]> {
  const response = await fetch(
    `https://skills.sh/api/search?q=${encodeURIComponent(query)}`,
    {
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(`skills.sh returned ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const skills = Array.isArray(body["skills"]) ? body["skills"] : [];
  const results: RegistrySkill[] = [];
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") continue;
    if (
      !("source" in raw) ||
      typeof raw.source !== "string" ||
      !("skillId" in raw) ||
      typeof raw.skillId !== "string"
    ) {
      continue;
    }
    results.push({
      id: "id" in raw && typeof raw.id === "string" ? raw.id : `${raw.source}/${raw.skillId}`,
      source: raw.source,
      skillId: raw.skillId,
      name: "name" in raw && typeof raw.name === "string" ? raw.name : raw.skillId,
      installs: "installs" in raw && typeof raw.installs === "number" ? raw.installs : 0,
    });
  }
  return results;
}

type TreeEntry = { path: string; type: string };

export async function installRegistrySkill(
  skill: RegistrySkill,
  signal?: AbortSignal,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(skill.skillId)) {
    throw new Error(`Invalid skill id: ${skill.skillId}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.source)) {
    throw new Error(`Invalid repository: ${skill.source}`);
  }
  const tree = await json(
    `https://api.github.com/repos/${skill.source}/git/trees/HEAD?recursive=1`,
    signal,
  );
  const sha = typeof tree["sha"] === "string" ? tree["sha"] : "HEAD";
  const entries = Array.isArray(tree["tree"]) ? tree["tree"] : [];
  const files = entries.filter(
    (entry): entry is TreeEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      "path" in entry &&
      typeof entry.path === "string" &&
      "type" in entry &&
      entry.type === "blob",
  );
  const candidates = files.filter(
    (entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"),
  );
  const chosen =
    candidates
      .filter((entry) => {
        const dir = dirname(entry.path);
        return dir.split("/").pop() === skill.skillId;
      })
      .sort((a, b) => a.path.length - b.path.length)[0] ??
    candidates
      .filter((entry) => entry.path.includes(`/skills/${skill.skillId}/`))
      .sort((a, b) => a.path.length - b.path.length)[0] ??
    candidates.sort((a, b) => a.path.length - b.path.length)[0];
  if (!chosen) throw new Error(`SKILL.md not found in ${skill.source}`);

  const prefix = chosen.path.slice(0, -"SKILL.md".length);
  const directory = join(homedir(), ".claude", "skills", skill.skillId);
  const installed = files.filter((entry) => entry.path.startsWith(prefix));
  await mkdir(directory, { recursive: true });
  for (const entry of installed) {
    const relative = entry.path.slice(prefix.length);
    if (!relative || relative.includes("..")) continue;
    const response = await fetch(
      `https://raw.githubusercontent.com/${skill.source}/${sha}/${entry.path}`,
      {
        headers: { "user-agent": "cletus" },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to download ${entry.path}: ${response.status}`);
    }
    const target = join(directory, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }
  await readFile(join(directory, "SKILL.md"), "utf8");
  return directory;
}

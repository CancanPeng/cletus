import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinAgents, loadAgents } from "../src/resources/agents.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-agents-"));
  dirs.push(dir);
  return dir;
}

async function writeAgent(dir: string, file: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text, "utf8");
}

const REVIEWER = `---
name: reviewer
description: Reviews code for bugs
tools: [read, grep]
model: anthropic/claude
---
You review code carefully.
`;

describe("agent definitions", () => {
  it("loads personal and project definitions with frontmatter", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(join(home, "agents"), "reviewer.md", REVIEWER);
    await writeAgent(
      join(cwd, ".cletus", "agents"),
      "helper.md",
      `---\ndescription: Project helper\n---\nHelp with this project.\n`,
    );
    const { agents } = await loadAgents(cwd, home, true);
    const reviewer = agents.find((a) => a.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe("Reviews code for bugs");
    expect(reviewer?.tools).toEqual(["read", "grep"]);
    expect(reviewer?.model).toBe("anthropic/claude");
    expect(reviewer?.prompt).toBe("You review code carefully.");
    expect(reviewer?.source).toBe("personal");
    const helper = agents.find((a) => a.name === "helper");
    expect(helper?.source).toBe("project");
    expect(helper?.prompt).toBe("Help with this project.");
  });

  it("project definitions require trust", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(join(home, "agents"), "reviewer.md", REVIEWER);
    await writeAgent(
      join(cwd, ".cletus", "agents"),
      "helper.md",
      `---\ndescription: Project helper\n---\nHelp.\n`,
    );
    const { agents } = await loadAgents(cwd, home, false);
    expect(agents.find((a) => a.name === "helper")).toBeUndefined();
    expect(agents.find((a) => a.name === "reviewer")).toBeDefined();
  });

  it("name defaults to filename and description is required", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(join(home, "agents"), "no-name.md", `---\ndescription: Has desc\n---\nBody.\n`);
    await writeAgent(join(home, "agents"), "no-desc.md", `---\nname: nodesc\n---\nBody.\n`);
    const { agents } = await loadAgents(cwd, home, false);
    expect(agents.find((a) => a.name === "no-name")).toBeDefined();
    expect(agents.find((a) => a.name === "nodesc")).toBeUndefined();
    expect(agents.find((a) => a.name === "no-desc")).toBeUndefined();
  });

  it("project overrides personal overrides builtin by name", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(
      join(home, "agents"),
      "explore.md",
      `---\ndescription: Personal explore\n---\nPersonal.\n`,
    );
    await writeAgent(
      join(cwd, ".cletus", "agents"),
      "explore.md",
      `---\ndescription: Project explore\n---\nProject.\n`,
    );
    await writeAgent(
      join(home, "agents"),
      "general-purpose.md",
      `---\ndescription: Personal gp\n---\nPersonal gp.\n`,
    );
    const { agents } = await loadAgents(cwd, home, true);
    const explore = agents.filter((a) => a.name === "explore");
    expect(explore).toHaveLength(1);
    expect(explore[0]?.source).toBe("project");
    const gp = agents.filter((a) => a.name === "general-purpose");
    expect(gp).toHaveLength(1);
    expect(gp[0]?.source).toBe("personal");
  });

  it("unknown tool names are dropped with a warning", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(
      join(home, "agents"),
      "odd.md",
      `---\ndescription: Odd tools\ntools: [read, frobnicate]\n---\nBody.\n`,
    );
    const { agents, warnings } = await loadAgents(cwd, home, false);
    expect(agents.find((a) => a.name === "odd")?.tools).toEqual(["read"]);
    expect(warnings.some((w) => w.includes("frobnicate"))).toBe(true);
  });

  it("builtins are always present with correct shape", async () => {
    const cwd = await temp();
    const home = await temp();
    const { agents } = await loadAgents(cwd, home, false);
    expect(agents.map((a) => a.name).sort()).toEqual(["explore", "general-purpose"]);
    const explore = agents.find((a) => a.name === "explore");
    expect(explore?.readOnly).toBe(true);
    expect(explore?.omitContext).toBe(true);
    for (const banned of ["write", "edit", "bash", "task"]) {
      expect(explore?.tools).not.toContain(banned);
    }
    const gp = agents.find((a) => a.name === "general-purpose");
    expect(gp?.tools).toBeUndefined();
    expect(builtinAgents().map((a) => a.name).sort()).toEqual(["explore", "general-purpose"]);
  });

  it("bad YAML frontmatter is skipped without throwing", async () => {
    const cwd = await temp();
    const home = await temp();
    await writeAgent(join(home, "agents"), "bad.md", `---\n: [unclosed\n---\nBody.\n`);
    const { agents } = await loadAgents(cwd, home, false);
    expect(agents.find((a) => a.name === "bad")).toBeUndefined();
  });
});

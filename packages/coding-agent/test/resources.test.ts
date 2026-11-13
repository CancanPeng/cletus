import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceLoader } from "../src/resources/index.js";
import { buildSystemPrompt } from "../src/prompt/system.js";
import { expandTemplate } from "../src/resources/prompts.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-res-"));
  dirs.push(dir);
  return dir;
}

describe("resources", () => {
  it("discovers skills, prompts, and AGENTS.md", async () => {
    const home = await temp();
    const cwd = await temp();
    await mkdir(join(home, "skills", "pdf"), { recursive: true });
    await writeFile(
      join(home, "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: Extract PDF text\n---\nBody\n",
    );
    await mkdir(join(home, "prompts"), { recursive: true });
    await writeFile(
      join(home, "prompts", "review.md"),
      "---\ndescription: Review code\n---\nReview $1 and $@\n",
    );
    await writeFile(join(cwd, "AGENTS.md"), "Use two spaces.\n");
    const loader = new ResourceLoader(cwd, home);
    const loaded = await loader.load();
    expect(loaded.skills.map((skill) => skill.name)).toContain("pdf");
    expect(loaded.prompts.map((prompt) => prompt.name)).toContain("review");
    expect(loaded.contextFiles[0]?.content).toContain("two spaces");
    expect(loaded.readOnlyRoots.some((root) => root.endsWith("/skills/pdf"))).toBe(true);
  });

  it("applies visibility overrides and name-only listings", async () => {
    const home = await temp();
    const cwd = await temp();
    await mkdir(join(home, "skills", "review"), { recursive: true });
    const path = join(home, "skills", "review", "SKILL.md");
    await writeFile(path, "---\nname: review\ndescription: Review code\n---\nBody\n");
    const loader = new ResourceLoader(cwd, home, {
      review: "name-only",
    });
    const loaded = await loader.load();
    const skill = loaded.skills.find((candidate) => candidate.name === "review");
    expect(skill?.visibility).toBe("name-only");
    expect(skill?.disableModelInvocation).toBe(false);
    const prompt = buildSystemPrompt({
      cwd,
      tools: [],
      contextFiles: [],
      skills: loaded.skills,
    });
    expect(prompt).toContain("- review (path:");
    expect(prompt).not.toContain("Review code");
    loader.setSkillOverrides({ review: "off" });
    const off = (await loader.load()).skills.find((candidate) => candidate.name === "review");
    expect(off?.visibility).toBe("off");
    expect(off?.disableModelInvocation).toBe(true);
    expect(off?.userInvocable).toBe(false);
  });

  it("uses directory and body fallbacks for skill metadata", async () => {
    const home = await temp();
    const cwd = await temp();
    await mkdir(join(home, "skills", "unnamed"), { recursive: true });
    await writeFile(join(home, "skills", "unnamed", "SKILL.md"), "First line description\n");
    const loader = new ResourceLoader(cwd, home);
    const skill = (await loader.load()).skills.find((candidate) => candidate.name === "unnamed");
    expect(skill?.description).toBe("First line description");
  });

  it("toggles model invocation by editing skill frontmatter", async () => {
    const home = await temp();
    const cwd = await temp();
    await mkdir(join(home, "skills", "pdf"), { recursive: true });
    const path = join(home, "skills", "pdf", "SKILL.md");
    await writeFile(
      path,
      "---\nname: pdf\ndescription: Extract PDF text\n---\nOriginal body\n",
    );
    const loader = new ResourceLoader(cwd, home);
    await loader.load();
    await loader.setSkillDisabled("pdf", true);
    let text = await readFile(path, "utf8");
    expect(text).toContain("disable-model-invocation: true");
    expect(text).toContain("Original body");
    let loaded = await loader.load();
    expect(loaded.skills.find((skill) => skill.name === "pdf")?.disableModelInvocation).toBe(true);
    await loader.setSkillDisabled("pdf", false);
    text = await readFile(path, "utf8");
    expect(text).not.toContain("disable-model-invocation");
    loaded = await loader.load();
    expect(loaded.skills.find((skill) => skill.name === "pdf")?.disableModelInvocation).toBe(false);
  });

  it("expands positional and sliced arguments", () => {
    expect(expandTemplate("A $1 B $@", '"one two" three')).toBe(
      "A one two B one two three",
    );
    expect(expandTemplate("${@:2:2}", "a b c d")).toBe("b c");
    expect(expandTemplate("${1:-fallback}", "")).toBe("fallback");
  });
});
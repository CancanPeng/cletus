import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceLoader } from "../src/resources/index.js";
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

  it("expands positional and sliced arguments", () => {
    expect(expandTemplate("A $1 B $@", '"one two" three')).toBe(
      "A one two B one two three",
    );
    expect(expandTemplate("${@:2:2}", "a b c d")).toBe("b c");
    expect(expandTemplate("${1:-fallback}", "")).toBe("fallback");
  });
});
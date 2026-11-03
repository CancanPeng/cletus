import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createEditTool } from "../src/tools/edit.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-edit-"));
  dirs.push(dir);
  return dir;
}

function context(cwd: string) {
  return {
    cwd,
    toolCallId: "t1",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
  };
}

describe("edit tool", () => {
  it("applies multiple edits atomically and preserves CRLF", async () => {
    const cwd = await temp();
    const path = join(cwd, "file.txt");
    await writeFile(path, "a\r\nb\r\nc\r\n", "utf8");
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const tool = createEditTool({ policy });
    const result = await tool.execute(
      {
        path: "file.txt",
        edits: [
          { oldText: "a\nb", newText: "x\ny" },
          { oldText: "c", newText: "z" },
        ],
      },
      context(cwd),
    );
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    expect(await readFile(path, "utf8")).toBe("x\r\ny\r\nz\r\n");
  });

  it("rejects duplicate and missing matches", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "file.txt"), "same same\n", "utf8");
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const tool = createEditTool({ policy });
    const duplicate = await tool.execute(
      { path: "file.txt", edits: [{ oldText: "same", newText: "other" }] },
      context(cwd),
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0]?.text).toContain("matched 2 times");
    const missing = await tool.execute(
      { path: "file.txt", edits: [{ oldText: "absent", newText: "other" }] },
      context(cwd),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("not found");
  });
});
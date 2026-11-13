import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createBashTool } from "../src/tools/bash.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bash tool", () => {
  it("streams partial output before completion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cletus-bash-"));
    dirs.push(cwd);
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const tool = createBashTool({
      policy,
      cwd,
      home: cwd,
      model: "fake",
      sessionId: "test",
    });
    const updates: string[] = [];
    const result = await tool.execute(
      { command: "printf one; sleep 0.25; printf two" },
      {
        cwd,
        toolCallId: "call",
        signal: new AbortController().signal,
        onUpdate: (partial) => {
          updates.push(partial.content.map((block) => block.text).join(""));
        },
      },
    );
    expect(updates.some((text) => text.includes("one"))).toBe(true);
    expect(result.content[0]?.text).toContain("onetwo");
  });
});

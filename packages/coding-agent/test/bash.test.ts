import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("preserves multibyte characters split across output chunks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cletus-bash-"));
    dirs.push(cwd);
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const tool = createBashTool({ policy, cwd, home: cwd, model: "fake", sessionId: "test" });
    const result = await tool.execute(
      { command: "printf '\\344\\275'; sleep 0.05; printf '\\240\\345\\245\\275'" },
      {
        cwd,
        toolCallId: "call-utf8",
        signal: new AbortController().signal,
        onUpdate: () => {},
      },
    );
    expect(result.content[0]?.text).toContain("你好");
  });

  it("writes the full output log before returning a truncated result", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cletus-bash-"));
    dirs.push(cwd);
    const policy = new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const tool = createBashTool({ policy, cwd, home: cwd, model: "fake", sessionId: "test" });
    const result = await tool.execute(
      { command: "for i in $(seq 1 3000); do echo \"line $i\"; done" },
      {
        cwd,
        toolCallId: "call-log",
        signal: new AbortController().signal,
        onUpdate: () => {},
      },
    );
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("truncated");
    const logPath = join(cwd, "tmp", "bash-call-log.log");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("line 1\n");
    expect(log).toContain("line 3000");
  });
});

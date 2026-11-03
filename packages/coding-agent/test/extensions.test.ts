import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionHost } from "../src/extensions/host.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ExtensionHost", () => {
  it("loads tools and blocks before_tool_call", async () => {
    const home = await mkdtemp(join(tmpdir(), "cletus-ext-"));
    dirs.push(home);
    await mkdir(join(home, "extensions"), { recursive: true });
    await writeFile(
      join(home, "extensions", "hello.ts"),
      `export default function (api) {
  api.registerTool({
    name: "hello",
    description: "Say hello",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "hello from ext" }] }),
  });
  api.on("before_tool_call", (event) =>
    event.type === "before_tool_call" && event.toolName === "bash"
      ? { block: true, reason: "no bash" }
      : undefined,
  );
}
`,
    );
    const host = new ExtensionHost({
      cwd: home,
      home,
      trustProject: false,
      builtinToolNames: ["bash", "read"],
      builtinCommands: ["help"],
    });
    await host.load();
    const tool = host.getTools().find((candidate) => candidate.name === "hello");
    expect(tool).toBeTruthy();
    const result = await tool!.execute(
      {},
      {
        cwd: home,
        toolCallId: "1",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    expect(result.content[0]?.text).toBe("hello from ext");
    expect(await host.beforeToolCall("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "no bash",
    });
    expect(await host.beforeToolCall("read", { path: "a" })).toBeUndefined();
    await host.dispose();
  });
});
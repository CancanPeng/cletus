import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp/manager.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("McpManager", () => {
  it("discovers and calls a stdio tool", async () => {
    const home = await mkdtemp(join(tmpdir(), "cletus-mcp-"));
    dirs.push(home);
    const fixture = resolve(import.meta.dirname, "fixtures/mcp-echo-server.mjs");
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [fixture], timeout: 10 },
        },
      }),
    );
    const manager = await McpManager.create(home, home, { trustProject: false });
    await manager.start();
    const status = manager.getStatus();
    expect(status[0]).toMatchObject({ name: "echo", connected: true, toolCount: 1 });
    const tool = manager.getTools().find((candidate) => candidate.name === "mcp__echo__echo");
    expect(tool).toBeTruthy();
    const result = await tool!.execute(
      { text: "hi" },
      {
        cwd: home,
        toolCallId: "1",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    expect(result.content[0]?.text).toBe("echo: hi");
    await manager.dispose();
  });
});
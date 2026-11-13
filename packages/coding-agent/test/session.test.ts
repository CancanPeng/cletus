import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@cletus/agent";
import { SessionManager, encodeCwd } from "../src/session/manager.js";
import { buildProjection } from "../src/session/context.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-session-"));
  dirs.push(dir);
  return dir;
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

describe("SessionManager", () => {
  it("reopens the same branch and skips corrupt lines", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("hello"));
    await manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "openai",
      model: "fake",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 2,
    });
    const file = manager.filePath;
    expect(file).toBeTruthy();
    await appendFile(file!, "{broken\n", "utf8");
    const opened = await SessionManager.open(file!);
    expect(opened.getBranch()).toHaveLength(2);
    expect(opened.getLeafId()).toBeTruthy();
  });

  it("forks a branch into a new file", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("one"));
    await manager.appendMessage(user("two"));
    const fork = await manager.fork();
    expect(fork.sessionId).not.toBe(manager.sessionId);
    expect(fork.getBranch()).toHaveLength(2);
    const header = JSON.parse((await readFile(fork.filePath!, "utf8")).split("\n")[0] ?? "{}");
    expect(header.parentSession).toBe(manager.filePath);
  });

  it("lists sessions newest first", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("find me"));
    const infos = await SessionManager.list(cwd, { home });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.firstUserText).toBe("find me");
  });

  it("encodes cwds injectively and isolates their sessions", async () => {
    expect(encodeCwd("/a/b")).not.toBe(encodeCwd("/a-b"));
    const home = await temp();
    const first = await SessionManager.create("/a/b", { home });
    await first.appendMessage(user("project one"));
    const second = await SessionManager.create("/a-b", { home });
    await second.appendMessage(user("project two"));
    const infos = await SessionManager.list("/a/b", { home });
    expect(infos).toHaveLength(1);
    expect(infos[0]?.firstUserText).toBe("project one");
  });

  it("keeps the recent tail when forking a compacted session", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("old goal"));
    const kept = await manager.appendMessage(user("recent question"));
    await manager.appendCompaction("summary of old goal", kept.id, 100);
    const fork = await manager.fork();
    const projection = buildProjection(fork);
    const texts = projection.messages.map((message) =>
      message.role === "user" ? message.content : "",
    );
    expect(texts.some((text) => text.includes("summary of old goal"))).toBe(true);
    expect(texts).toContain("recent question");
  });
});
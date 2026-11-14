import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@cletus/agent";
import { SessionManager } from "../src/session/manager.js";
import { buildProjection } from "../src/session/context.js";
import { forkChoices, runFork } from "../src/session/fork.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-fork-"));
  dirs.push(dir);
  return dir;
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

describe("forkChoices", () => {
  it("offers the current position plus user messages newest first", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("first question"));
    await manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provider: "openai",
      model: "fake",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 2,
    });
    const second = await manager.appendMessage(user("second question"));

    const choices = forkChoices(manager);
    expect(choices.map((choice) => choice.label)).toEqual([
      "Now · keep the whole conversation",
      "second question",
      "first question",
    ]);
    expect(choices[0]?.value).toBe("");
    expect(choices[1]?.value).toBe(second.id);
  });

  it("collapses whitespace and truncates long messages", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user(`${"word ".repeat(40)}\n\nend`));

    const label = forkChoices(manager)[1]?.label ?? "";
    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(73);
  });
});

describe("runFork", () => {
  it("refuses to fork while the agent is streaming", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    let asked = false;

    const outcome = await runFork({
      manager,
      isStreaming: true,
      select: async () => {
        asked = true;
        return undefined;
      },
    });
    expect(outcome).toEqual({ status: "busy" });
    expect(asked).toBe(false);
  });

  it("forks at the chosen entry and treats dismissal as a cancel", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const first = await manager.appendMessage(user("first question"));
    await manager.appendMessage(user("second question"));

    await expect(
      runFork({ manager, isStreaming: false, select: async () => undefined }),
    ).resolves.toEqual({ status: "cancelled" });

    const outcome = await runFork({
      manager,
      isStreaming: false,
      select: async () => first.id,
    });
    expect(outcome.status).toBe("forked");
    if (outcome.status !== "forked") throw new Error("expected forked");
    expect(outcome.manager.sessionId).not.toBe(manager.sessionId);
    expect(buildProjection(outcome.manager).messages).toHaveLength(1);
  });

  it("forks at the leaf when the current position is chosen", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    await manager.appendMessage(user("one"));
    await manager.appendMessage(user("two"));

    const outcome = await runFork({
      manager,
      isStreaming: false,
      select: async () => "",
    });
    if (outcome.status !== "forked") throw new Error("expected forked");
    expect(buildProjection(outcome.manager).messages).toHaveLength(2);
  });
});

describe("forking at a chosen message", () => {
  it("drops later entries and leaves the original session intact", async () => {
    const home = await temp();
    const cwd = await temp();
    const manager = await SessionManager.create(cwd, { home });
    const first = await manager.appendMessage(user("first question"));
    await manager.appendMessage(user("second question"));
    await manager.appendMessage(user("third question"));

    const forked = await manager.fork(first.id);
    expect(forked.getBranch()).toHaveLength(1);
    expect(buildProjection(forked).messages).toEqual([
      expect.objectContaining({ role: "user", content: "first question" }),
    ]);

    await forked.appendMessage(user("new direction"));
    expect(forked.getBranch()).toHaveLength(2);
    expect(manager.getBranch()).toHaveLength(3);
    expect(manager.filePath).not.toBe(forked.filePath);
  });
});
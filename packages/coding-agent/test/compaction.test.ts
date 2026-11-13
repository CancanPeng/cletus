import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type AssistantMessage,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import type { AgentMessage } from "@cletus/agent";
import { SessionManager } from "../src/session/manager.js";
import { buildProjection } from "../src/session/context.js";
import { compact, selectCut } from "../src/session/compaction.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 1000,
  maxOutputTokens: 8192,
};

describe("compaction", () => {
  it("selects a user/assistant boundary outside the recent window", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    for (let index = 0; index < 40; index += 1) {
      await manager.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        ...(index % 2 === 0
          ? { content: `user ${index} ${"x".repeat(100)}` }
          : {
              content: [{ type: "text" as const, text: `assistant ${index} ${"y".repeat(100)}` }],
              provider: "openai",
              model: "fake",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
              stopReason: "stop" as const,
            }),
        timestamp: index,
      } as AgentMessage);
    }
    const branch = manager.getBranch();
    const cut = selectCut(branch, 100);
    expect(cut).toBeGreaterThan(0);
    const entry = branch[cut];
    expect(entry?.type).toBe("message");
    if (entry?.type === "message") {
      expect(["user", "assistant"]).toContain(entry.message.role);
    }
  });

  it("appends a compaction entry and projects the summary", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    for (let index = 0; index < 10; index += 1) {
      await manager.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        ...(index % 2 === 0
          ? { content: `user ${index} ${"x".repeat(100)}` }
          : {
              content: [{ type: "text" as const, text: `assistant ${index}` }],
              provider: "openai",
              model: "fake",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
              stopReason: "stop" as const,
            }),
        timestamp: index,
      } as AgentMessage);
    }
    const streamFn: StreamFn = (): AssistantEventStream => {
      const stream = new AssistantEventStream();
      const message: AssistantMessage = assistantMessage(
        model,
        [{ type: "text", text: "## Goal\nsummarized" }],
        "stop",
      );
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", delta: "## Goal\nsummarized" });
      stream.end(message);
      return stream;
    };
    const result = await compact(manager, model, streamFn, {
      keepRecentTokens: 20,
      force: true,
    });
    expect("skipped" in result).toBe(false);
    const projection = buildProjection(manager);
    expect(projection.compaction).toBeTruthy();
    expect(projection.messages[0]?.role).toBe("user");
    expect(
      projection.messages[0]?.role === "user" ? projection.messages[0].content : "",
    ).toContain("summarized");
  });

  it("never keeps an assistant tool call without its tool results", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    await manager.appendMessage({ role: "user", content: `goal ${"x".repeat(200)}`, timestamp: 0 });
    await manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "toolCall", id: "call_a", name: "bash", arguments: { command: "ls" } },
      ],
      provider: "openai",
      model: "fake",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "toolUse",
      timestamp: 1,
    });
    await manager.appendMessage({
      role: "toolResult",
      toolCallId: "call_a",
      toolName: "bash",
      content: [{ type: "text", text: `output ${"y".repeat(200)}` }],
      isError: false,
      timestamp: 2,
    });
    await manager.appendMessage({ role: "user", content: `next ${"z".repeat(200)}`, timestamp: 3 });
    const branch = manager.getBranch();
    const cut = selectCut(branch, 50);
    expect(cut).toBeGreaterThan(0);
    const kept = branch.slice(cut);
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const entry of kept) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant") {
        for (const block of entry.message.content) {
          if (block.type === "toolCall") callIds.add(block.id);
        }
      } else if (entry.message.role === "toolResult") {
        resultIds.add(entry.message.toolCallId);
      }
    }
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
  });
});
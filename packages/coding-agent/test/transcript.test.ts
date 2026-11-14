import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@cletus/agent";
import { projectionBlocks } from "../src/session/transcript.js";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };

describe("projectionBlocks", () => {
  it("replays user and assistant text in order with idle-friendly ids", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        provider: "openai",
        model: "fake",
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    ];

    expect(projectionBlocks(messages)).toEqual([
      { id: "h0", kind: "user", text: "hello" },
      { id: "h1", kind: "assistant", text: "hi there", thinking: "", done: true },
    ]);
  });

  it("pairs tool calls with their results", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls" } },
        ],
        provider: "openai",
        model: "fake",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const blocks = projectionBlocks(messages);
    expect(blocks[1]).toMatchObject({
      kind: "tool",
      name: "read",
      output: "file body",
      isError: false,
      status: "success",
      argsSummary: JSON.stringify({ path: "a.ts" }, null, 2),
    });
    // call-2 never returned: a fork can cut a turn in half.
    expect(blocks[2]).toMatchObject({ kind: "tool", name: "bash", status: "error" });
  });

  it("marks failed tool results as errors", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
        provider: "openai",
        model: "fake",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "c",
        toolName: "bash",
        content: [{ type: "text", text: "boom" }],
        isError: true,
        timestamp: 2,
      },
    ];

    expect(projectionBlocks(messages)[0]).toMatchObject({
      kind: "tool",
      output: "boom",
      isError: true,
      status: "error",
    });
  });

  it("renders custom messages as user text and keeps thinking", () => {
    const messages: AgentMessage[] = [
      { role: "custom", customType: "note", content: "remember this", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "pondering" }],
        provider: "openai",
        model: "fake",
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    ];

    expect(projectionBlocks(messages)).toEqual([
      { id: "h0", kind: "user", text: "[note]\nremember this" },
      { id: "h1", kind: "assistant", text: "", thinking: "pondering", done: true },
    ]);
  });

  it("renders tool result images as a placeholder line", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.png" } }],
        provider: "openai",
        model: "fake",
        usage,
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [
          { type: "text", text: "a.png — image/png" },
          { type: "image", mediaType: "image/png", path: "/tmp/a.png" },
        ],
        isError: false,
        timestamp: 2,
      },
    ];
    const blocks = projectionBlocks(messages);
    const tool = blocks.find((block) => block.kind === "tool");
    expect(tool).toMatchObject({ output: "a.png — image/png\n[图片: a.png  image/png]" });
  });
});

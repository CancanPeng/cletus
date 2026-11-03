import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type AssistantMessage,
  type AssistantStreamEvent,
  type LlmContext,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { runAgentLoop } from "../src/loop.js";
import type { AgentEvent, AgentTool } from "../src/types.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 1000,
  maxOutputTokens: 100,
};

function final(text: string): AssistantMessage {
  return assistantMessage(model, [{ type: "text", text }], "stop");
}

function fakeStream(message: AssistantMessage): AssistantEventStream {
  const stream = new AssistantEventStream();
  const partial = assistantMessage(model, [], message.stopReason);
  stream.push({ type: "start", partial });
  for (const block of message.content) {
    if (block.type === "text") stream.push({ type: "text_delta", delta: block.text });
    if (block.type === "toolCall") {
      const index = 0;
      stream.push({ type: "toolcall_start", index, id: block.id, name: block.name });
      stream.push({ type: "toolcall_delta", index, delta: JSON.stringify(block.arguments) });
      stream.push({ type: "toolcall_end", index, toolCall: block });
    }
  }
  stream.end(message);
  return stream;
}

describe("runAgentLoop", () => {
  it("runs tools serially and emits the expected event order", async () => {
    const events: AgentEvent[] = [];
    let call = 0;
    const streamFn: StreamFn = (_model: Model, _context: LlmContext): AssistantEventStream => {
      call += 1;
      if (call === 1) {
        return fakeStream(
          assistantMessage(
            model,
            [
              {
                type: "toolCall",
                id: "call_1",
                name: "write",
                arguments: { path: "a.txt", content: "x" },
              },
            ],
            "toolUse",
          ),
        );
      }
      return fakeStream(final("done"));
    };
    const tool: AgentTool = {
      name: "write",
      description: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: async (params) => ({
        content: [{ type: "text", text: `wrote ${String(params["path"])}` }],
      }),
    };
    await runAgentLoop(
      ["go"],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );

    const types = events.map((event) => event.type);
    expect(types.slice(0, 4)).toEqual([
      "agent_start",
      "message_start",
      "message_end",
      "turn_start",
    ]);
    expect(types).toContain("tool_execution_start");
    expect(types).toContain("tool_execution_end");
    expect(types.filter((type) => type === "turn_end")).toHaveLength(2);
    expect(types[types.length - 1]).toBe("agent_end");
    const toolResultIndex = types.indexOf("tool_execution_end");
    expect(types.indexOf("turn_end")).toBeGreaterThan(toolResultIndex);
    const secondTurn = types.lastIndexOf("turn_start");
    expect(secondTurn).toBeGreaterThan(types.indexOf("turn_end"));
    expect(types.indexOf("tool_execution_start")).toBeLessThan(
      types.indexOf("tool_execution_end"),
    );
    const end = events.find((event) => event.type === "agent_end");
    if (end?.type === "agent_end") {
      expect(end.messages.some((message) => message.role === "toolResult")).toBe(true);
      expect(end.messages.some((message) => message.role === "user")).toBe(true);
    }
  });
});
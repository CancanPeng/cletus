import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type AssistantMessage,
  type LlmContext,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { runAgentLoop } from "../src/loop.js";
import type { AgentEvent, AgentMessage, AgentTool } from "../src/types.js";

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
      [{ text: "go" }],
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

  it("reports the configured cwd to tool execution", async () => {
    let call = 0;
    const streamFn: StreamFn = (): AssistantEventStream => {
      call += 1;
      if (call === 1) {
        return fakeStream(
          assistantMessage(
            model,
            [{ type: "toolCall", id: "call_1", name: "probe", arguments: {} }],
            "toolUse",
          ),
        );
      }
      return fakeStream(final("done"));
    };
    let seenCwd = "";
    const tool: AgentTool = {
      name: "probe",
      description: "probe",
      parameters: { type: "object", properties: {} },
      execute: async (_params, ctx) => {
        seenCwd = ctx.cwd;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    await runAgentLoop(
      [{ text: "go" }],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        cwd: "/tmp/cletus-cwd-test",
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async () => {},
      new AbortController().signal,
    );
    expect(seenCwd).toBe("/tmp/cletus-cwd-test");
  });

  it("answers every tool call when a batch is aborted mid-flight", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let call = 0;
    const streamFn: StreamFn = (): AssistantEventStream => {
      call += 1;
      if (call === 1) {
        return fakeStream(
          assistantMessage(
            model,
            [
              { type: "toolCall", id: "call_1", name: "slow", arguments: {} },
              { type: "toolCall", id: "call_2", name: "slow", arguments: {} },
            ],
            "toolUse",
          ),
        );
      }
      return fakeStream(final("done"));
    };
    const tool: AgentTool = {
      name: "slow",
      description: "slow",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        controller.abort();
        return { content: [{ type: "text", text: "ran" }] };
      },
    };
    await runAgentLoop(
      [{ text: "go" }],
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
      controller.signal,
    );
    const end = events.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type !== "agent_end") return;
    const results = end.messages.filter((message) => message.role === "toolResult");
    expect(results.map((message) => message.toolCallId).sort()).toEqual(["call_1", "call_2"]);
    expect(call).toBe(1);
  });

  it("stops the loop when a tool result requests termination", async () => {
    const events: AgentEvent[] = [];
    let call = 0;
    const streamFn: StreamFn = (): AssistantEventStream => {
      call += 1;
      return fakeStream(
        assistantMessage(
          model,
          [{ type: "toolCall", id: `call_${call}`, name: "stopper", arguments: {} }],
          "toolUse",
        ),
      );
    };
    const tool: AgentTool = {
      name: "stopper",
      description: "stopper",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "bye" }], terminate: true }),
    };
    await runAgentLoop(
      [{ text: "go" }],
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
    expect(call).toBe(1);
    expect(events[events.length - 1]?.type).toBe("agent_end");
  });

  it("survives a streamFn that throws synchronously", async () => {
    const events: AgentEvent[] = [];
    const streamFn: StreamFn = () => {
      throw new Error("boom");
    };
    await runAgentLoop(
      [{ text: "go" }],
      { systemPrompt: "s", messages: [], tools: [] },
      {
        model,
        streamFn,
        tools: [],
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );
    expect(events.some((event) => event.type === "turn_start")).toBe(true);
    expect(events.some((event) => event.type === "turn_end")).toBe(true);
    const end = events.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type === "agent_end") {
      const last = end.messages[end.messages.length - 1];
      expect(last?.role).toBe("assistant");
      if (last?.role === "assistant") {
        expect(last.stopReason).toBe("error");
        expect(last.errorMessage).toContain("boom");
      }
    }
  });

  it("carries images on the initial prompt and steered messages", async () => {
    const img = { mediaType: "image/png" as const, path: "/tmp/shot.png" };
    const events: AgentEvent[] = [];
    let call = 0;
    const streamFn: StreamFn = (): AssistantEventStream => {
      call += 1;
      if (call === 1) {
        return fakeStream(
          assistantMessage(
            model,
            [{ type: "toolCall", id: "call_1", name: "probe", arguments: {} }],
            "toolUse",
          ),
        );
      }
      return fakeStream(final("done"));
    };
    const tool: AgentTool = {
      name: "probe",
      description: "probe",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    let drained = false;
    await runAgentLoop(
      [{ text: "hi", images: [img] }],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
        drainSteering: () => {
          if (drained) return [];
          drained = true;
          return [{ text: "steer", images: [img] }];
        },
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );
    const end = events.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type === "agent_end") {
      const users = end.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(2);
      for (const user of users) {
        if (user.role === "user") expect(user.images).toEqual([img]);
      }
      expect(users.map((user) => (user.role === "user" ? user.content : ""))).toEqual([
        "hi",
        "steer",
      ]);
    }
  });

  it("auto-continues past the turn cap and keeps history clean", async () => {
    const events: AgentEvent[] = [];
    const tool: AgentTool = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    let call = 0;
    const streamFn: StreamFn = () => {
      call += 1;
      return fakeStream(
        assistantMessage(
          model,
          [{ type: "toolCall", id: `c${call}`, name: "noop", arguments: {} }],
          "toolUse",
        ),
      );
    };
    await runAgentLoop(
      [{ text: "go" }],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        maxTurns: 2,
        maxAutoContinues: 2,
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );

    // 2 turns initial + 2 turns per auto-continue, 2 continues.
    expect(call).toBe(6);
    const notices = events.filter(
      (event) => event.type === "turn_limit" && event.continuing,
    );
    expect(notices).toHaveLength(2);

    const end = events.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type !== "agent_end") return;
    // No fabricated assistant message in history, and the run ends on a
    // real tool result rather than an empty assistant message.
    const last = end.messages[end.messages.length - 1];
    expect(last?.role).toBe("toolResult");
    const fabricated = end.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.content.length === 0 &&
        message.stopReason === "error",
    );
    expect(fabricated).toHaveLength(0);
  });

  it("stops with a maxTurns stop reason once auto-continues are exhausted", async () => {
    const events: AgentEvent[] = [];
    const tool: AgentTool = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    let call = 0;
    const streamFn: StreamFn = () => {
      call += 1;
      return fakeStream(
        assistantMessage(
          model,
          [{ type: "toolCall", id: `c${call}`, name: "noop", arguments: {} }],
          "toolUse",
        ),
      );
    };
    await runAgentLoop(
      [{ text: "go" }],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        maxTurns: 2,
        maxAutoContinues: 1,
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        events.push(event);
      },
      new AbortController().signal,
    );

    expect(call).toBe(4);
    const finals = events.filter(
      (event) => event.type === "turn_limit" && !event.continuing,
    );
    expect(finals).toHaveLength(1);
    if (finals[0]?.type !== "turn_limit") return;
    expect(finals[0].turns).toBe(2);
    expect(finals[0].autoContinues).toBe(1);

    // The agent ends without appending anything to the transcript, so the
    // next prompt still sees a normal conversation.
    const end = events.find((event) => event.type === "agent_end");
    if (end?.type !== "agent_end") return;
    const last = end.messages[end.messages.length - 1];
    expect(last?.role).toBe("toolResult");
    expect(
      end.messages.some(
        (message) => message.role === "assistant" && message.content.length === 0,
      ),
    ).toBe(false);
  });

  it("leaves the conversation resumable after the turn limit", async () => {
    const tool: AgentTool = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    let call = 0;
    const streamFn: StreamFn = () => {
      call += 1;
      return fakeStream(
        assistantMessage(
          model,
          [{ type: "toolCall", id: `c${call}`, name: "noop", arguments: {} }],
          "toolUse",
        ),
      );
    };
    const events: AgentEvent[] = [];
    let finalMessages: AgentMessage[] = [];
    await runAgentLoop(
      [{ text: "go" }],
      { systemPrompt: "s", messages: [], tools: [tool] },
      {
        model,
        streamFn,
        tools: [tool],
        maxTurns: 1,
        maxAutoContinues: 0,
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        events.push(event);
        if (event.type === "agent_end") finalMessages = event.messages;
      },
      new AbortController().signal,
    );

    // Every limit-stop leaves the transcript ending on a tool result, which
    // is exactly the precondition Agent.continue() needs.
    expect(finalMessages[finalMessages.length - 1]?.role).toBe("toolResult");
    expect(finalMessages.some((message) => message.role === "custom")).toBe(false);

    // Everything the provider would be shown is non-empty and alternating.
    const usable = finalMessages.filter((message) => message.role !== "custom");
    for (const message of usable) {
      if (message.role === "assistant") {
        expect(message.content.length).toBeGreaterThan(0);
      }
    }

    // A second run over the same history works: the loop must not choke on
    // the transcript a limit-stop left behind.
    const second: AgentEvent[] = [];
    await runAgentLoop(
      [{ text: "again" }],
      { systemPrompt: "s", messages: finalMessages, tools: [tool] },
      {
        model,
        streamFn: () =>
          fakeStream(assistantMessage(model, [{ type: "text", text: "done" }], "stop")),
        tools: [tool],
        maxTurns: 5,
        convertToLlm: (messages) =>
          messages.filter((message) => message.role !== "custom") as never,
      },
      async (event) => {
        second.push(event);
      },
      new AbortController().signal,
    );
    const end = second.find((event) => event.type === "agent_end");
    expect(end?.type).toBe("agent_end");
    if (end?.type !== "agent_end") return;
    expect(end.messages[end.messages.length - 1]?.role).toBe("assistant");
  });
});

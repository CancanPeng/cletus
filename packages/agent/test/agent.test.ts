import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { Agent } from "../src/agent.js";
import type { AgentTool } from "../src/types.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 1000,
  maxOutputTokens: 100,
};

const okStream: StreamFn = () => {
  const stream = new AssistantEventStream();
  const message = assistantMessage(model, [{ type: "text", text: "ok" }], "stop");
  stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
  stream.end(message);
  return stream;
};

describe("Agent", () => {
  it("honors abort() issued before the first prompt", async () => {
    const agent = new Agent({ model, streamFn: okStream });
    agent.abort();
    await agent.prompt("hello");
    const last = agent.state.messages[agent.state.messages.length - 1];
    expect(last?.role).toBe("assistant");
    if (last?.role === "assistant") expect(last.stopReason).toBe("aborted");
  });

  it("keeps queued steering when a run fails before draining", async () => {
    const failing: StreamFn = () => {
      throw new Error("boom");
    };
    const agent = new Agent({ model, streamFn: failing });
    agent.steer("queued steering");
    await expect(agent.prompt("hello")).resolves.toBeUndefined();
    expect(agent.queuedMessageCount).toBe(1);

    agent.setModel(model);
    const healthy = new Agent({ model, streamFn: okStream });
    healthy.steer("queued steering");
    await healthy.prompt("hello");
    expect(healthy.queuedMessageCount).toBe(0);
    expect(
      healthy.state.messages.some(
        (message) => message.role === "user" && message.content === "queued steering",
      ),
    ).toBe(true);
  });

  it("runs the permission gate even for malformed arguments", async () => {
    let calls = 0;
    const gated: StreamFn = () => {
      calls += 1;
      const stream = new AssistantEventStream();
      const message =
        calls === 1
          ? assistantMessage(
              model,
              [{ type: "toolCall", id: "call_1", name: "write", arguments: { path: 42 } }],
              "toolUse",
            )
          : assistantMessage(model, [{ type: "text", text: "done" }], "stop");
      stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
      stream.end(message);
      return stream;
    };
    let gateCalls = 0;
    let executed = false;
    const tool: AgentTool = {
      name: "write",
      description: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async () => {
        executed = true;
        return { content: [{ type: "text", text: "wrote" }] };
      },
    };
    const agent = new Agent({
      model,
      streamFn: gated,
      initialState: { tools: [tool] },
      beforeToolCall: async () => {
        gateCalls += 1;
        return { block: true, reason: "denied" };
      },
    });
    await agent.prompt("go");
    expect(gateCalls).toBe(1);
    expect(executed).toBe(false);
    const results = agent.state.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]?.content[0]?.text).toContain("denied");
  });

  it("does not expose internal arrays through state", async () => {
    const agent = new Agent({ model, streamFn: okStream });
    await agent.prompt("hello");
    const snapshot = agent.state.messages;
    snapshot.length = 0;
    expect(agent.state.messages.length).toBeGreaterThan(0);
  });
});

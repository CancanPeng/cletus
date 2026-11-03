import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  type LlmContext,
  type Model,
} from "@cletus/ai";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createSubagentRunner } from "../src/subagent.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 1000,
  maxOutputTokens: 100,
};

describe("subagent", () => {
  it("runs with an isolated message list and returns a summary", async () => {
    const contexts: LlmContext[] = [];
    const streamFn = (_model: Model, context: LlmContext): AssistantEventStream => {
      contexts.push(context);
      const stream = new AssistantEventStream();
      const message = assistantMessage(model, [{ type: "text", text: "child result" }], "stop");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_delta", delta: "child result" });
      stream.end(message);
      return stream;
    };
    const policy = new PermissionPolicy({
      cwd: process.cwd(),
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn,
      policy,
      createTools: () => [],
      buildSystemPrompt: () => "parent prompt",
    });
    const result = await run({ description: "test", prompt: "child task" });
    expect(result.content[0]?.text).toBe("child result");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.messages).toHaveLength(1);
    expect(contexts[0]?.messages[0]?.role).toBe("user");
    expect(contexts[0]?.systemPrompt).toContain("You are a subagent");
    expect(JSON.stringify(contexts[0]?.messages)).not.toContain("parent secret");
  });
});
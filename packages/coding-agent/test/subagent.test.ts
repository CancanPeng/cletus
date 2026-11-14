import { describe, expect, it } from "vitest";
import {
  AssistantEventStream,
  assistantMessage,
  toolContentText,
  type LlmContext,
  type Model,
} from "@cletus/ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(toolContentText(result.content)).toBe("child result");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.messages).toHaveLength(1);
    expect(contexts[0]?.messages[0]?.role).toBe("user");
    expect(contexts[0]?.systemPrompt).toContain("You are a subagent");
    expect(JSON.stringify(contexts[0]?.messages)).not.toContain("parent secret");
  });

  it("denies write tools without yolo even inside a subagent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cletus-subagent-"));
    try {
      let calls = 0;
      const streamFn = (): AssistantEventStream => {
        calls += 1;
        const stream = new AssistantEventStream();
        const message =
          calls === 1
            ? assistantMessage(
                model,
                [
                  {
                    type: "toolCall",
                    id: "call_1",
                    name: "write",
                    arguments: { path: "escape.txt", content: "x" },
                  },
                ],
                "toolUse",
              )
            : assistantMessage(model, [{ type: "text", text: "done" }], "stop");
        stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
        stream.end(message);
        return stream;
      };
      const policy = new PermissionPolicy({
        cwd,
        readOnlyRoots: [],
        allowWrite: [],
        yolo: false,
        interactive: false,
      });
      let executed = false;
      const run = createSubagentRunner({
        cwd,
        model,
        streamFn,
        policy,
        createTools: () => [
          {
            name: "write",
            description: "write",
            parameters: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
            },
            execute: async () => {
              executed = true;
              return { content: [{ type: "text", text: "wrote" }] };
            },
          },
        ],
        buildSystemPrompt: () => "parent prompt",
      });
      await run({ description: "test", prompt: "child task" });
      expect(executed).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
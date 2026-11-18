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
import type { AgentTool, ToolExecutionContext, ToolResult } from "@cletus/agent";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createSubagentRunner } from "../src/subagent.js";
import { createTaskTool } from "../src/tools/task.js";

const echoTool = (name: string, execute?: () => void): AgentTool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  execute: async (): Promise<ToolResult> => {
    execute?.();
    return { content: [{ type: "text", text: "ok" }] };
  },
});


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

  it("streams tool activity through onProgress", async () => {
    let calls = 0;
    const streamFn = (): AssistantEventStream => {
      calls += 1;
      const stream = new AssistantEventStream();
      const message =
        calls === 1
          ? assistantMessage(
              model,
              [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }],
              "toolUse",
            )
          : assistantMessage(model, [{ type: "text", text: "child summary" }], "stop");
      stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
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
      createTools: () => [echoTool("ls")],
      buildSystemPrompt: () => "parent prompt",
    });
    const texts: string[] = [];
    const result = await run({
      description: "test",
      prompt: "child task",
      onProgress: (text) => texts.push(text),
    });
    expect(texts.some((t) => /^▸ turn \d+\/30 · ls/.test(t.split("\n")[0] ?? ""))).toBe(true);
    expect(texts[texts.length - 1]).toContain("✓ ls");
    expect(toolContentText(result.content)).toBe("child summary");
  });

  it("reports blocked writes as failed activity", async () => {
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
                    id: "c1",
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
      const run = createSubagentRunner({
        cwd,
        model,
        streamFn,
        policy,
        createTools: () => [echoTool("write")],
        buildSystemPrompt: () => "parent prompt",
      });
      const texts: string[] = [];
      const result = await run({
        description: "test",
        prompt: "child task",
        onProgress: (text) => texts.push(text),
      });
      expect(texts.some((t) => t.includes("✗ write") && t.includes("blocked"))).toBe(true);
      expect(toolContentText(result.content)).toBe("done");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("task tool forwards progress to ctx.onUpdate", async () => {
    const tool = createTaskTool({
      spawnSubagent: async (req) => {
        req.onProgress?.("▸ turn 1/30 · thinking …");
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const partials: ToolResult[] = [];
    const ctx: ToolExecutionContext = {
      cwd: process.cwd(),
      toolCallId: "t1",
      signal: new AbortController().signal,
      onUpdate: (partial) => partials.push(partial),
    };
    const result = await tool.execute({ description: "d", prompt: "p" }, ctx);
    expect(partials.some((p) => toolContentText(p.content) === "▸ turn 1/30 · thinking …")).toBe(
      true,
    );
    expect(toolContentText(result.content)).toBe("done");
  });

  it("concurrent tasks keep separate progress streams", async () => {
    const streamFn = (_model: Model, context: LlmContext): AssistantEventStream => {
      const last = context.messages[context.messages.length - 1];
      const promptText = last?.role === "user" ? last.content : "";
      const stream = new AssistantEventStream();
      const message = promptText.includes("task-a")
        ? context.messages.length === 1
          ? assistantMessage(
              model,
              [{ type: "toolCall", id: "a1", name: "ls_a", arguments: {} }],
              "toolUse",
            )
          : assistantMessage(model, [{ type: "text", text: "a done" }], "stop")
        : context.messages.length === 1
          ? assistantMessage(
              model,
              [{ type: "toolCall", id: "b1", name: "ls_b", arguments: {} }],
              "toolUse",
            )
          : assistantMessage(model, [{ type: "text", text: "b done" }], "stop");
      stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
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
      createTools: () => [echoTool("ls_a"), echoTool("ls_b")],
      buildSystemPrompt: () => "parent prompt",
    });
    const textsA: string[] = [];
    const textsB: string[] = [];
    await Promise.all([
      run({ description: "a", prompt: "task-a", onProgress: (t) => textsA.push(t) }),
      run({ description: "b", prompt: "task-b", onProgress: (t) => textsB.push(t) }),
    ]);
    expect(textsA.length).toBeGreaterThan(0);
    expect(textsB.length).toBeGreaterThan(0);
    expect(textsA.some((t) => t.includes("ls_a"))).toBe(true);
    expect(textsB.some((t) => t.includes("ls_b"))).toBe(true);
    expect(textsA.some((t) => t.includes("ls_b"))).toBe(false);
    expect(textsB.some((t) => t.includes("ls_a"))).toBe(false);
  });

  it("stops progress after abort", async () => {
    const controller = new AbortController();
    const streamFn = (): AssistantEventStream => {
      const stream = new AssistantEventStream();
      stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
      stream.end(
        assistantMessage(
          model,
          [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }],
          "toolUse",
        ),
      );
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
      createTools: () => [
        echoTool("ls", () => {
          controller.abort();
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }),
      ],
      buildSystemPrompt: () => "parent prompt",
    });
    const texts: string[] = [];
    await run({
      description: "test",
      prompt: "child task",
      signal: controller.signal,
      onProgress: (text) => texts.push(text),
    });
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => t.includes("✗ ls") && t.includes("aborted"))).toBe(true);
    expect(texts.some((t) => t.includes("turn 2"))).toBe(false);
  });
});
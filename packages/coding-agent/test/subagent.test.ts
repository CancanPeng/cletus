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
import { builtinAgents, type AgentDefinition } from "../src/resources/agents.js";
import { createSubagentRunner } from "../src/subagent.js";
import { createTaskTool } from "../src/tools/task.js";

const echoTool = (
  name: string,
  execute?: () => void,
  properties: Record<string, unknown> = {},
): AgentTool => ({
  name,
  description: name,
  parameters: { type: "object", properties },
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
    // Default type is general-purpose, so the status line carries its label.
    expect(
      texts.some((t) => /^▸ general-purpose turn \d+\/30 · ls/.test(t.split("\n")[0] ?? "")),
    ).toBe(true);
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

  const toolCallThenDone = (
    name: string,
    args: Record<string, unknown>,
  ): (() => AssistantEventStream) => {
    let calls = 0;
    return () => {
      calls += 1;
        const stream = new AssistantEventStream();
        const message =
          calls === 1
            ? assistantMessage(
                model,
                [{ type: "toolCall", id: "c1", name, arguments: args }],
                "toolUse",
              )
            : assistantMessage(model, [{ type: "text", text: "done" }], "stop");
      stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
      stream.end(message);
      return stream;
    };
  };

  it("inherits parent-approved commands without yolo", async () => {
    const parent = new PermissionPolicy({
      cwd: process.cwd(),
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: true,
      confirm: async () => "allow",
    });
    expect((await parent.check("bash", { command: "pnpm test" })).allow).toBe(true);
    let executed = false;
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: toolCallThenDone("bash", { command: "pnpm test" }),
      policy: parent,
      createTools: () => [
        echoTool("bash", () => (executed = true), { command: { type: "string" } }),
      ],
      buildSystemPrompt: () => "parent prompt",
    });
    await run({ description: "test", prompt: "child task" });
    expect(executed).toBe(true);
  });

  it("denies commands outside the snapshot with actionable copy", async () => {
    const parent = new PermissionPolicy({
      cwd: process.cwd(),
      readOnlyRoots: [],
      allowWrite: [],
      yolo: false,
      interactive: true,
      confirm: async () => "allow",
    });
    expect((await parent.check("bash", { command: "pnpm test" })).allow).toBe(true);
    let executed = false;
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: toolCallThenDone("bash", { command: "pnpm build" }),
      policy: parent,
      createTools: () => [
        echoTool("bash", () => (executed = true), { command: { type: "string" } }),
      ],
      buildSystemPrompt: () => "parent prompt",
    });
    const texts: string[] = [];
    await run({ description: "test", prompt: "child task", onProgress: (t) => texts.push(t) });
    expect(executed).toBe(false);
    // The progress line clips at 80 chars; assert the actionable head.
    expect(
      texts.some((t) => t.includes("Denied: bash not covered by inherited grants")),
    ).toBe(true);
  });

  it("inherits persistent allowWrite for child writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cletus-subagent-"));
    try {
      const parent = new PermissionPolicy({
        cwd,
        readOnlyRoots: [],
        allowWrite: ["**"],
        yolo: false,
        interactive: false,
      });
      let executed = false;
      const run = createSubagentRunner({
        cwd,
        model,
        streamFn: toolCallThenDone("write", { path: "out.txt", content: "x" }),
        policy: parent,
        createTools: () => [
          echoTool("write", () => (executed = true), {
            path: { type: "string" },
            content: { type: "string" },
          }),
        ],
        buildSystemPrompt: () => "parent prompt",
      });
      await run({ description: "test", prompt: "child task" });
      expect(executed).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  const modelB: Model = {
    provider: "anthropic",
    id: "fake-b",
    baseUrl: "http://localhost",
    contextWindow: 1000,
    maxOutputTokens: 100,
  };

  const typingPolicy = (): PermissionPolicy =>
    new PermissionPolicy({
      cwd: process.cwd(),
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    });

  const recordingStream =
    (record: { models: string[]; contexts: LlmContext[] }) =>
    (_model: Model, context: LlmContext): AssistantEventStream => {
      record.models.push(_model.id);
      record.contexts.push(context);
      const stream = new AssistantEventStream();
      stream.push({ type: "start", partial: assistantMessage(_model, [], "stop") });
      stream.end(assistantMessage(_model, [{ type: "text", text: "done" }], "stop"));
      return stream;
    };

  const allTools = (): AgentTool[] => [
    echoTool("read"),
    echoTool("write", undefined, { path: { type: "string" }, content: { type: "string" } }),
    echoTool("edit"),
    echoTool("bash", undefined, { command: { type: "string" } }),
    echoTool("grep"),
    echoTool("ls"),
  ];

  it("routes subagent_type to the definition's model and tools", async () => {
    const record = { models: [] as string[], contexts: [] as LlmContext[] };
    const explore: AgentDefinition = { ...builtinAgents()[0]!, model: "fake-b" };
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: recordingStream(record),
      policy: typingPolicy(),
      createTools: allTools,
      buildSystemPrompt: () => "parent prompt",
      agents: [explore, ...builtinAgents().slice(1)],
      resolveModel: (ref) => {
        if (ref === "fake-b") return modelB;
        throw new Error(`Unknown model: ${ref}`);
      },
    });
    await run({ description: "t", prompt: "p", subagentType: "explore" });
    expect(record.models).toEqual(["fake-b"]);
    const toolNames = record.contexts[0]?.tools.map((t) => t.name) ?? [];
    for (const banned of ["write", "edit", "bash"]) {
      expect(toolNames).not.toContain(banned);
    }
    expect(toolNames).toContain("read");
  });

  it("unknown type errors with the available list", async () => {
    const record = { models: [] as string[], contexts: [] as LlmContext[] };
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: recordingStream(record),
      policy: typingPolicy(),
      createTools: allTools,
      buildSystemPrompt: () => "parent prompt",
      agents: builtinAgents(),
      resolveModel: () => modelB,
    });
    const result = await run({ description: "t", prompt: "p", subagentType: "nope" });
    expect(result.isError).toBe(true);
    const text = toolContentText(result.content);
    expect(text).toContain("explore");
    expect(text).toContain("general-purpose");
    expect(record.models).toHaveLength(0);
  });

  it("omitted type keeps parent model and full tools", async () => {
    const record = { models: [] as string[], contexts: [] as LlmContext[] };
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: recordingStream(record),
      policy: typingPolicy(),
      createTools: allTools,
      buildSystemPrompt: () => "parent prompt",
      agents: builtinAgents(),
      resolveModel: () => modelB,
    });
    await run({ description: "t", prompt: "p" });
    expect(record.models).toEqual(["fake"]);
    expect(record.contexts[0]?.tools.map((t) => t.name)).toContain("write");
  });

  it("explore policy denies writes even if a write tool slips through", async () => {
    const { tools: _whitelist, ...exploreRest } = builtinAgents()[0]!;
    const noWhitelist: AgentDefinition = exploreRest;
    let executed = false;
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: toolCallThenDone("write", { path: "a.txt", content: "x" }),
      policy: typingPolicy(),
      createTools: () => [
        echoTool("write", () => (executed = true), {
          path: { type: "string" },
          content: { type: "string" },
        }),
      ],
      buildSystemPrompt: () => "parent prompt",
      agents: [noWhitelist],
      resolveModel: () => modelB,
    });
    const texts: string[] = [];
    await run({ description: "t", prompt: "p", subagentType: "explore", onProgress: (t) => texts.push(t) });
    expect(executed).toBe(false);
    expect(texts.some((t) => t.includes("agent is read-only"))).toBe(true);
  });

  it("invalid model ref becomes an isError result naming the ref", async () => {
    const record = { models: [] as string[], contexts: [] as LlmContext[] };
    const ghost: AgentDefinition = {
      name: "ghosty",
      description: "uses a ghost model",
      prompt: "p",
      source: "personal",
      model: "ghost",
    };
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn: recordingStream(record),
      policy: typingPolicy(),
      createTools: allTools,
      buildSystemPrompt: () => "parent prompt",
      agents: [ghost, ...builtinAgents()],
      resolveModel: (ref) => {
        throw new Error(`Unknown model: ${ref}`);
      },
    });
    const bad = await run({ description: "t", prompt: "p", subagentType: "ghosty" });
    expect(bad.isError).toBe(true);
    expect(toolContentText(bad.content)).toContain("ghost");
    const ok = await run({ description: "t", prompt: "p" });
    expect(ok.isError).not.toBe(true);
    expect(record.models).toEqual(["fake"]);
  });

  it("concurrent different types keep separate models", async () => {
    const seen: Array<{ prompt: string; modelId: string }> = [];
    const streamFn = (_model: Model, context: LlmContext): AssistantEventStream => {
      const last = context.messages[context.messages.length - 1];
      const promptText = last?.role === "user" ? last.content : "";
      seen.push({ prompt: promptText, modelId: _model.id });
      const stream = new AssistantEventStream();
      stream.push({ type: "start", partial: assistantMessage(_model, [], "stop") });
      stream.end(assistantMessage(_model, [{ type: "text", text: "done" }], "stop"));
      return stream;
    };
    const defA: AgentDefinition = {
      name: "type-a",
      description: "a",
      prompt: "a",
      source: "personal",
      model: "fake-b",
    };
    const defB: AgentDefinition = { name: "type-b", description: "b", prompt: "b", source: "personal" };
    const run = createSubagentRunner({
      cwd: process.cwd(),
      model,
      streamFn,
      policy: typingPolicy(),
      createTools: allTools,
      buildSystemPrompt: () => "parent prompt",
      agents: [defA, defB, ...builtinAgents()],
      resolveModel: (ref) => {
        if (ref === "fake-b") return modelB;
        throw new Error(`Unknown model: ${ref}`);
      },
    });
    await Promise.all([
      run({ description: "a", prompt: "task-a", subagentType: "type-a" }),
      run({ description: "b", prompt: "task-b", subagentType: "type-b" }),
    ]);
    expect(seen.find((s) => s.prompt === "task-a")?.modelId).toBe("fake-b");
    expect(seen.find((s) => s.prompt === "task-b")?.modelId).toBe("fake");
  });

  it("task tool description lists agents and schema accepts subagent_type", async () => {
    let received: string | undefined;
    const tool = createTaskTool({
      spawnSubagent: async (req) => {
        received = req.subagentType;
        return { content: [{ type: "text", text: "done" }] };
      },
      agents: builtinAgents(),
    });
    expect(tool.description).toContain("- explore:");
    const ctx: ToolExecutionContext = {
      cwd: process.cwd(),
      toolCallId: "t1",
      signal: new AbortController().signal,
      onUpdate: () => undefined,
    };
    await tool.execute({ description: "d", prompt: "p", subagent_type: "explore" }, ctx);
    expect(received).toBe("explore");
  });
});
import { Agent, type AgentEvent, type AgentTool, type ToolResult } from "@cletus/agent";
import type { Model, StreamFn, AssistantMessage, Usage } from "@cletus/ai";
import { PermissionPolicy } from "./permissions/policy.js";
import { createSubagentProgress } from "./subagent-progress.js";
import type { SubagentRequest } from "./tools/task.js";

export function createSubagentRunner(deps: {
  cwd: string;
  model: Model;
  streamFn: StreamFn;
  policy: PermissionPolicy;
  createTools: (cwd: string, extra: { excludeTask: boolean; policy: PermissionPolicy }) => AgentTool[];
  buildSystemPrompt: (tools: AgentTool[]) => string;
  getApiKey?: (model: Model) => string | undefined;
}): (req: SubagentRequest) => Promise<ToolResult> {
  return async (req: SubagentRequest): Promise<ToolResult> => {
    const policy = new PermissionPolicy({
      cwd: deps.cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: deps.policy.yolo,
      interactive: false,
    });
    const tools = deps.createTools(deps.cwd, { excludeTask: true, policy });
    const systemPrompt = `${deps.buildSystemPrompt(tools)}\n\n<subagent>\nYou are a subagent. Work independently, do not ask questions, and finish with a concise report of findings and changes.\n</subagent>`;
    const agent = new Agent({
      model: deps.model,
      streamFn: deps.streamFn,
      cwd: deps.cwd,
      initialState: { systemPrompt, tools, messages: [] },
      // A subagent is non-interactive: it cannot ask to continue, so it gets
      // a hard cap with no auto-continue batches.
      maxTurns: 30,
      maxAutoContinues: 0,
      // Subagents are non-interactive: enforce the same permission model
      // (writes/commands denied unless yolo or allowlisted).
      beforeToolCall: async (call, args) => {
        const record =
          args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const permission = await policy.check(call.name, record);
        if (!permission.allow) {
          return permission.reason !== undefined
            ? { block: true, reason: permission.reason }
            : { block: true };
        }
        return undefined;
      },
      ...(deps.getApiKey ? { getApiKey: deps.getApiKey } : {}),
    });

    const texts: string[] = [];
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    let turns = 0;
    // Per-request state: concurrent tasks share this runner but must not
    // mix progress streams.
    const progress = createSubagentProgress(30);
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      const progressText = progress.handle(event);
      if (progressText !== undefined) req.onProgress?.(progressText);
      if (event.type === "turn_end") {
        turns += 1;
        const message = event.message;
        usage.input += message.usage.input;
        usage.output += message.usage.output;
        usage.cacheRead += message.usage.cacheRead;
        usage.cacheWrite += message.usage.cacheWrite;
        usage.totalTokens += message.usage.totalTokens;
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const assistant = event.message as AssistantMessage;
        const text = assistant.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        if (text.trim()) texts.push(text);
      }
    });

    const onAbort = (): void => agent.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(req.prompt);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    let output = texts.join("\n").trim();
    if (!output) output = "Subagent produced no output";
    if (output.length > 8000) output = `${output.slice(0, 8000)}\n[truncated]`;
    return {
      content: [{ type: "text", text: output }],
      details: { turns, usage },
    };
  };
}
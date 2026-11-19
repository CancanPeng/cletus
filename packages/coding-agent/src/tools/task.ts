import type { AgentTool, ToolResult } from "@cletus/agent";
import type { AgentDefinition } from "../resources/agents.js";

export type SubagentRequest = {
  description: string;
  prompt: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  subagentType?: string;
};

export function createTaskTool(deps: {
  spawnSubagent: (req: SubagentRequest) => Promise<ToolResult>;
  maxConcurrent?: number;
  agents?: AgentDefinition[];
}): AgentTool {
  const maxConcurrent = deps.maxConcurrent ?? 4;
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (onUpdate: (partial: ToolResult) => void): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    onUpdate({ content: [{ type: "text", text: "Waiting for subagent slot..." }] });
    const slot = Promise.withResolvers<void>();
    waiters.push(slot.resolve);
    // The slot is transferred by release(); active already counts it.
    await slot.promise;
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };

  const agents = deps.agents ?? [];
  const description =
    agents.length > 0
      ? `Delegate an independent read/write coding task to a subagent.\nAvailable subagent types:\n${agents
          .map((a) => `- ${a.name}: ${a.description}`)
          .join("\n")}`
      : "Delegate an independent read/write coding task to a subagent.";

  return {
    name: "task",
    snippet: "Run a subagent for an independent subtask",
    description,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        subagent_type: {
          type: "string",
          description: "Optional agent type; omit for general-purpose",
        },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    async execute(params, ctx): Promise<ToolResult> {
      await acquire(ctx.onUpdate);
      try {
        const type = params["subagent_type"];
        return await deps.spawnSubagent({
          description: String(params["description"] ?? ""),
          prompt: String(params["prompt"] ?? ""),
          signal: ctx.signal,
          onProgress: (text) => ctx.onUpdate({ content: [{ type: "text", text }] }),
          ...(typeof type === "string" && type ? { subagentType: type } : {}),
        });
      } finally {
        release();
      }
    },
  };
}
import type { AgentTool, ToolResult } from "@cletus/agent";

export type SubagentRequest = {
  description: string;
  prompt: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
};

export function createTaskTool(deps: {
  spawnSubagent: (req: SubagentRequest) => Promise<ToolResult>;
  maxConcurrent?: number;
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

  return {
    name: "task",
    snippet: "Run a subagent for an independent subtask",
    description: "Delegate an independent read/write coding task to a subagent.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    async execute(params, ctx): Promise<ToolResult> {
      await acquire(ctx.onUpdate);
      try {
        return await deps.spawnSubagent({
          description: String(params["description"] ?? ""),
          prompt: String(params["prompt"] ?? ""),
          signal: ctx.signal,
          onProgress: (text) => ctx.onUpdate({ content: [{ type: "text", text }] }),
        });
      } finally {
        release();
      }
    },
  };
}
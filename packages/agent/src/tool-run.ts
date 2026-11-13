import type { ToolCallContent } from "@cletus/ai";
import type { AgentTool, ToolExecutionContext, ToolHooks, ToolResult } from "./types.js";
import { validateArgs } from "./validate.js";

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export async function runToolCall(
  call: ToolCallContent,
  tools: AgentTool[],
  ctx: ToolExecutionContext,
  hooks?: ToolHooks,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return errorResult(`Unknown tool: ${call.name}`);

  if (hooks?.beforeToolCall) {
    try {
      const decision = await hooks.beforeToolCall(call, call.arguments, ctx.signal);
      if (decision?.block) {
        return errorResult(`Tool call blocked: ${decision.reason ?? "blocked"}`);
      }
    } catch (error) {
      return errorResult(
        `Tool call blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Validate only after the permission hook: blocked calls must be denied
  // and audited even when the model sends malformed arguments.
  const validation = validateArgs(tool.parameters, call.arguments, call.name);
  if (!validation.ok) return errorResult(validation.message);

  let result: ToolResult;
  try {
    result = await tool.execute(call.arguments, ctx);
  } catch (error) {
    const aborted = ctx.signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    return errorResult(
      aborted
        ? `Tool ${call.name} aborted`
        : `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (hooks?.afterToolCall) {
    try {
      const patch = await hooks.afterToolCall(call, result);
      if (patch) result = { ...result, ...patch };
    } catch {
      // Hooks cannot fail the underlying tool result.
    }
  }
  return result;
}
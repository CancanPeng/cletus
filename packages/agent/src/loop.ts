import {
  assistantMessage,
  emptyUsage,
  type AssistantContent,
  type AssistantMessage,
  type AssistantStreamEvent,
  type LlmContext,
  type Message,
  type Model,
  type ToolCallContent,
} from "@cletus/ai";
import { runToolCall } from "./tool-run.js";
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  PromptInput,
} from "./types.js";

export type Emit = (event: AgentEvent) => Promise<void>;

function userMessage(input: PromptInput): AgentMessage {
  return {
    role: "user",
    content: input.text,
    timestamp: Date.now(),
    ...(input.images?.length ? { images: input.images } : {}),
  };
}

async function emitMessage(emit: Emit, message: AgentMessage): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

function errorAssistant(model: Model, text: string): AssistantMessage {
  return assistantMessage(model, [], "error", emptyUsage(), text);
}

function contentFor(text: string, thinking: string): AssistantContent[] {
  const content: AssistantContent[] = [];
  if (text) content.push({ type: "text", text });
  if (thinking) content.push({ type: "thinking", thinking });
  return content;
}

async function consumeStream(
  stream: AsyncIterable<AssistantStreamEvent>,
  model: Model,
  emit: Emit,
): Promise<AssistantMessage> {
  let text = "";
  let thinking = "";
  const toolCalls = new Map<number, ToolCallContent>();
  const partial: AssistantMessage = assistantMessage(model, [], "stop");
  const rebuild = (): void => {
    partial.content = [
      ...contentFor(text, thinking),
      ...[...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    ];
  };
  let final: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === "start") {
      await emit({ type: "message_start", message: partial });
    } else if (event.type === "text_delta") {
      text += event.delta;
      rebuild();
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "text", text: event.delta },
      });
    } else if (event.type === "thinking_delta") {
      thinking += event.delta;
      rebuild();
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "thinking", text: event.delta },
      });
    } else if (event.type === "toolcall_start") {
      toolCalls.set(event.index, {
        type: "toolCall",
        id: event.id,
        name: event.name,
        arguments: {},
      });
      rebuild();
      await emit({ type: "message_update", message: partial });
    } else if (event.type === "toolcall_delta") {
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "toolcall", index: event.index, delta: event.delta },
      });
    } else if (event.type === "toolcall_end") {
      toolCalls.set(event.index, event.toolCall);
      rebuild();
      await emit({ type: "message_update", message: partial });
    } else if (event.type === "done" || event.type === "error") {
      final = event.message;
    }
  }

  const result = final ?? assistantMessage(model, contentFor(text, thinking), "stop");
  await emit({ type: "message_end", message: result });
  return result;
}

export async function runAgentLoop(
  prompts: PromptInput[],
  context: { systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  let messages = [...context.messages];
  let systemPrompt = context.systemPrompt;
  let tools = context.tools;
  let model = config.model;
  const maxTurns = config.maxTurns ?? 100;
  let turn = 0;

  const appendQueued = async (inputs: PromptInput[]): Promise<void> => {
    for (const input of inputs) {
      const message = userMessage(input);
      messages.push(message);
      await emitMessage(emit, message);
    }
  };

  await emit({ type: "agent_start" });

  await appendQueued(prompts);

  if (prompts.length === 0 && messages.length === 0) {
    await emit({ type: "agent_end", messages });
    return;
  }

  for (;;) {
    if (signal.aborted) {
      const aborted = errorAssistant(model, "Aborted");
      aborted.stopReason = "aborted";
      messages.push(aborted);
      await emitMessage(emit, aborted);
      await emit({ type: "turn_end", message: aborted, toolResults: [] });
      break;
    }
    if (turn >= maxTurns) {
      const limited = errorAssistant(model, `Max turns exceeded (${maxTurns})`);
      messages.push(limited);
      await emitMessage(emit, limited);
      await emit({ type: "turn_end", message: limited, toolResults: [] });
      break;
    }

    turn += 1;
    await emit({ type: "turn_start", turn });

    if (config.prepareRequest) {
      try {
        const prepared = await config.prepareRequest({ systemPrompt, messages, tools, model });
        if (prepared?.systemPrompt !== undefined) systemPrompt = prepared.systemPrompt;
        if (prepared?.messages) messages = prepared.messages;
        if (prepared?.model) model = prepared.model;
      } catch (error) {
        const failed = errorAssistant(
          model,
          error instanceof Error ? error.message : String(error),
        );
        messages.push(failed);
        await emitMessage(emit, failed);
        await emit({ type: "turn_end", message: failed, toolResults: [] });
        break;
      }
    }

    let assistant: AssistantMessage;
    try {
      const llmContext: LlmContext = {
        systemPrompt,
        messages: config.convertToLlm(messages),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      };
      const apiKey = config.getApiKey?.(model);
      const stream = config.streamFn(model, llmContext, {
        signal,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      assistant = await consumeStream(stream, model, emit);
    } catch (error) {
      assistant = errorAssistant(
        model,
        error instanceof Error ? error.message : String(error),
      );
    }

    messages.push(assistant);

    const calls = assistant.content.filter(
      (block): block is ToolCallContent => block.type === "toolCall",
    );
    const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
    const toolResults: Message[] = [];
    const recordResult = async (call: ToolCallContent, text: string): Promise<void> => {
      const message: Message = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        isError: true,
        timestamp: Date.now(),
      };
      messages.push(message);
      toolResults.push(message);
      await emitMessage(emit, message);
    };

    let terminated = false;
    if (!failed) {
      for (const [index, call] of calls.entries()) {
        if (signal.aborted || terminated) {
          // Every tool call must be answered, or providers reject the next
          // request (tool_use without tool_result).
          for (const pending of calls.slice(index)) {
            await recordResult(pending, "Tool call cancelled");
          }
          break;
        }
        await emit({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        });
        const result = await runToolCall(
          call,
          tools,
          {
            cwd: config.cwd ?? process.cwd(),
            toolCallId: call.id,
            signal,
            onUpdate: (partial) => {
              // Fire-and-forget progress; Agent.emit isolates listener errors.
              void emit({
                type: "tool_execution_update",
                toolCallId: call.id,
                partial,
              }).catch(() => undefined);
            },
          },
          {
            ...(config.beforeToolCall
              ? {
                  beforeToolCall: async (toolCall, args) =>
                    config.beforeToolCall?.(toolCall, args),
                }
              : {}),
            ...(config.afterToolCall
              ? {
                  afterToolCall: async (toolCall, toolResult) =>
                    config.afterToolCall?.(toolCall, toolResult),
                }
              : {}),
          },
        );
        await emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result,
        });
        const message: Message = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: result.isError ?? false,
          timestamp: Date.now(),
        };
        messages.push(message);
        toolResults.push(message);
        await emitMessage(emit, message);
        terminated = result.terminate === true;
      }
    } else {
      for (const call of calls) {
        await recordResult(call, "Tool call cancelled");
      }
    }

    await emit({ type: "turn_end", message: assistant, toolResults });

    if (failed || terminated) break;

    const steering = config.drainSteering?.() ?? [];
    await appendQueued(steering);
    const followUp = config.drainFollowUp?.() ?? [];
    await appendQueued(followUp);
    if (calls.length === 0 && steering.length === 0 && followUp.length === 0) break;
  }

  await emit({ type: "agent_end", messages });
}

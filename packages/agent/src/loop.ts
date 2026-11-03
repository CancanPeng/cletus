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
  ToolResult,
} from "./types.js";

export type Emit = (event: AgentEvent) => Promise<void>;

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
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
  const partial: AssistantMessage = assistantMessage(model, [], "stop");
  let final: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === "start") {
      await emit({ type: "message_start", message: partial });
    } else if (event.type === "text_delta") {
      text += event.delta;
      partial.content = contentFor(text, thinking);
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "text", text: event.delta },
      });
    } else if (event.type === "thinking_delta") {
      thinking += event.delta;
      partial.content = contentFor(text, thinking);
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "thinking", text: event.delta },
      });
    } else if (event.type === "toolcall_delta") {
      await emit({
        type: "message_update",
        message: partial,
        delta: { type: "toolcall", index: event.index, delta: event.delta },
      });
    } else if (event.type === "done" || event.type === "error") {
      final = event.message;
    }
  }

  const result = final ?? assistantMessage(model, contentFor(text, thinking), "stop");
  if (!final) result.content = contentFor(text, thinking);
  await emit({ type: "message_end", message: result });
  return result;
}

export async function runAgentLoop(
  prompts: string[],
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

  await emit({ type: "agent_start" });

  for (const prompt of prompts) {
    const message = userMessage(prompt);
    messages.push(message);
    await emitMessage(emit, message);
  }

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
      break;
    }
    if (turn >= maxTurns) {
      const limited = errorAssistant(model, `Max turns exceeded (${maxTurns})`);
      messages.push(limited);
      await emitMessage(emit, limited);
      break;
    }

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

    turn += 1;
    await emit({ type: "turn_start", turn });

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
    let assistant: AssistantMessage;
    try {
      assistant = await consumeStream(stream, model, emit);
    } catch (error) {
      assistant = errorAssistant(
        model,
        error instanceof Error ? error.message : String(error),
      );
      messages.push(assistant);
      await emitMessage(emit, assistant);
      await emit({ type: "turn_end", message: assistant, toolResults: [] });
      break;
    }

    messages.push(assistant);

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      await emit({ type: "turn_end", message: assistant, toolResults: [] });
      break;
    }

    const calls = assistant.content.filter(
      (block): block is ToolCallContent => block.type === "toolCall",
    );
    const toolResults: Message[] = [];
    if (calls.length > 0) {
      for (const call of calls) {
        if (signal.aborted) break;
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
            cwd: process.cwd(),
            toolCallId: call.id,
            signal,
            onUpdate: (partial) => {
              void emit({
                type: "tool_execution_update",
                toolCallId: call.id,
                partial,
              });
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
        if (result.terminate) break;
      }
    }

    await emit({ type: "turn_end", message: assistant, toolResults });

    if (calls.length > 0) {
      let steering = config.drainSteering?.() ?? [];
      if (steering.length > 0) {
        for (const text of steering) {
          const message = userMessage(text);
          messages.push(message);
          await emitMessage(emit, message);
        }
        continue;
      }
      const followUp = config.drainFollowUp?.() ?? [];
      if (followUp.length > 0) {
        for (const text of followUp.slice(0, 1)) {
          const message = userMessage(text);
          messages.push(message);
          await emitMessage(emit, message);
        }
        continue;
      }
      continue;
    }

    const steering = config.drainSteering?.() ?? [];
    if (steering.length > 0) {
      for (const text of steering) {
        const message = userMessage(text);
        messages.push(message);
        await emitMessage(emit, message);
      }
      continue;
    }
    const followUp = config.drainFollowUp?.() ?? [];
    if (followUp.length > 0) {
      for (const text of followUp.slice(0, 1)) {
        const message = userMessage(text);
        messages.push(message);
        await emitMessage(emit, message);
      }
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages });
}
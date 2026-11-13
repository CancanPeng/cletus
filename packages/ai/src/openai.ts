import { AssistantEventStream } from "./event-stream.js";
import { parseSse } from "./sse.js";
import { parseRetryAfter, sleep } from "./retry.js";
import {
  assistantMessage,
  emptyUsage,
  type AssistantContent,
  type AssistantMessage,
  type LlmContext,
  type Message,
  type Model,
  type StreamOptions,
  type StopReason,
  type ToolCallContent,
  type Usage,
} from "./types.js";

type OpenAIToolCall = {
  id?: string;
  name: string;
  args: string;
  started: boolean;
  /** Argument text received before toolcall_start; flushed when it starts. */
  pending: string;
};

function apiKeyFor(model: Model, options?: StreamOptions): string {
  return options?.apiKey ?? (model.apiKeyEnv ? process.env[model.apiKeyEnv] : "") ?? "";
}

function toOpenAIMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "assistant") {
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const toolCalls = message.content
      .filter((b): b is ToolCallContent => b.type === "toolCall")
      .map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));
    return {
      role: "assistant",
      // null content is only valid alongside tool_calls.
      content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (message.role === "system") {
    return { role: "system", content: message.content };
  }
  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.content.map((b) => b.text).join(""),
  };
}

function mergeUsage(target: Usage, raw: Record<string, unknown>): void {
  const input = Number(raw["prompt_tokens"] ?? target.input);
  const output = Number(raw["completion_tokens"] ?? target.output);
  const total = Number(raw["total_tokens"] ?? input + output);
  const details = raw["prompt_tokens_details"];
  const cached =
    details && typeof details === "object"
      ? Number((details as Record<string, unknown>)["cached_tokens"] ?? 0)
      : 0;
  target.input = Number.isFinite(input) ? input : target.input;
  target.output = Number.isFinite(output) ? output : target.output;
  target.cacheRead = Number.isFinite(cached) ? cached : target.cacheRead;
  target.totalTokens = Number.isFinite(total) ? total : target.totalTokens;
}

export function streamOpenAI(
  model: Model,
  context: LlmContext,
  options?: StreamOptions,
): AssistantEventStream {
  const stream = new AssistantEventStream();
  const key = apiKeyFor(model, options);
  if (!key) {
    const message = assistantMessage(model, [], "error", emptyUsage(),
      `Missing API key for ${model.provider}/${model.id}; set ${model.apiKeyEnv ?? "an API key env"} or run cletus import-pi`);
    stream.fail(message, message.errorMessage ?? "Missing API key");
    return stream;
  }

  const body = {
    model: model.id,
    messages: [
      { role: "system", content: context.systemPrompt },
      ...context.messages.map(toOpenAIMessage),
    ],
    tools: context.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options?.maxTokens ?? model.maxOutputTokens,
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  };

  void (async () => {
    const partial: AssistantMessage = assistantMessage(model, [], "stop");
    stream.push({ type: "start", partial });
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const calls = new Map<number, OpenAIToolCall>();
    const usage = emptyUsage();
    let finishReason: string | undefined;

    try {
      let response: Response | undefined;
      let lastError = "";
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (response.ok) break;
        const bodyText = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${bodyText.slice(0, 500)}`;
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 2) {
          throw new Error(lastError);
        }
        await sleep(parseRetryAfter(response.headers.get("retry-after")), options?.signal);
      }
      if (!response?.ok || !response.body) throw new Error(lastError || "Empty response body");

      for await (const event of parseSse(response.body)) {
        if (event.data === "[DONE]") break;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const streamError = json["error"];
        if (streamError && typeof streamError === "object") {
          const message = (streamError as Record<string, unknown>)["message"];
          throw new Error(
            `Provider stream error: ${typeof message === "string" ? message : JSON.stringify(streamError)}`,
          );
        }
        const rawUsage = json["usage"];
        if (rawUsage && typeof rawUsage === "object") {
          mergeUsage(usage, rawUsage as Record<string, unknown>);
        }
        const choices = json["choices"];
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const choice = choices[0] as Record<string, unknown>;
        const delta = choice["delta"];
        if (delta && typeof delta === "object") {
          const d = delta as Record<string, unknown>;
          const content = d["content"];
          if (typeof content === "string" && content.length > 0) {
            textParts.push(content);
            stream.push({ type: "text_delta", delta: content });
          }
          const reasoning = d["reasoning_content"] ?? d["reasoning"];
          if (typeof reasoning === "string" && reasoning.length > 0) {
            thinkingParts.push(reasoning);
            stream.push({ type: "thinking_delta", delta: reasoning });
          }
          const toolCalls = d["tool_calls"];
          if (Array.isArray(toolCalls)) {
            for (const rawCall of toolCalls) {
              if (!rawCall || typeof rawCall !== "object") continue;
              const call = rawCall as Record<string, unknown>;
              const index = Number(call["index"] ?? 0);
              let entry = calls.get(index);
              if (!entry) {
                entry = { name: "", args: "", started: false, pending: "" };
                calls.set(index, entry);
              }
              const id = call["id"];
              if (typeof id === "string" && id.length > 0) entry.id = id;
              const fn = call["function"];
              if (fn && typeof fn === "object") {
                const f = fn as Record<string, unknown>;
                if (typeof f["name"] === "string" && f["name"].length > 0) entry.name = f["name"];
                if (typeof f["arguments"] === "string") {
                  entry.args += f["arguments"];
                  if (entry.started) {
                    stream.push({ type: "toolcall_delta", index, delta: f["arguments"] });
                  } else {
                    entry.pending += f["arguments"];
                  }
                }
              }
              if (!entry.started && entry.id && entry.name) {
                entry.started = true;
                stream.push({
                  type: "toolcall_start",
                  index,
                  id: entry.id,
                  name: entry.name,
                });
                if (entry.pending) {
                  stream.push({ type: "toolcall_delta", index, delta: entry.pending });
                  entry.pending = "";
                }
              }
            }
          }
        }
        if (typeof choice["finish_reason"] === "string") {
          finishReason = choice["finish_reason"];
        }
      }

      const content: AssistantContent[] = [];
      if (textParts.length > 0) content.push({ type: "text", text: textParts.join("") });
      if (thinkingParts.length > 0) {
        content.push({ type: "thinking", thinking: thinkingParts.join("") });
      }
      const toolCalls: ToolCallContent[] = [];
      for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.args || "{}");
          args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          args = { __raw: call.args };
        }
        const toolCall: ToolCallContent = {
          type: "toolCall",
          id: call.id ?? `call_${index}`,
          name: call.name || "unknown",
          arguments: args,
        };
        toolCalls.push(toolCall);
        if (!call.started) {
          stream.push({ type: "toolcall_start", index, id: toolCall.id, name: toolCall.name });
        }
        stream.push({ type: "toolcall_end", index, toolCall });
        content.push(toolCall);
      }

      if (finishReason === undefined) {
        throw new Error("Provider stream ended without a finish reason");
      }
      const stopReason: StopReason =
        finishReason === "length"
          ? "length"
          : finishReason === "tool_calls" || toolCalls.length > 0
            ? "toolUse"
            : "stop";
      const final = assistantMessage(model, content, stopReason, usage);
      stream.end(final);
    } catch (error) {
      const aborted =
        options?.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError");
      const text = aborted
        ? "Aborted"
        : error instanceof Error
          ? error.message
          : String(error);
      const content: AssistantContent[] = [];
      const joined = textParts.join("");
      if (joined.length > 0) content.push({ type: "text", text: joined });
      const final = assistantMessage(
        model,
        content,
        aborted ? "aborted" : "error",
        usage,
        text,
      );
      stream.fail(final, text);
    }
  })();

  return stream;
}
import { AssistantEventStream } from "./event-stream.js";
import { parseSse } from "./sse.js";
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
  type WebSearchResultItem,
} from "./types.js";

type Block =
  | { kind: "text"; index: number; text: string }
  | { kind: "thinking"; index: number; thinking: string; signature: string }
  | {
      kind: "toolCall";
      index: number;
      id: string;
      name: string;
      args: string;
      toolCall?: ToolCallContent;
    }
  | {
      kind: "serverToolUse";
      index: number;
      id: string;
      name: string;
      args: string;
      input?: Record<string, unknown>;
    }
  | {
      kind: "webSearchResult";
      index: number;
      toolUseId: string;
      results: WebSearchResultItem[];
      errorCode?: string;
    };

function toAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  const append = (role: "user" | "assistant", block: Record<string, unknown>): void => {
    const last = result[result.length - 1];
    if (last && last["role"] === role && Array.isArray(last["content"])) {
      (last["content"] as unknown[]).push(block);
    } else {
      result.push({ role, content: [block] });
    }
  };

  for (const message of messages) {
    if (message.role === "user") {
      append("user", { type: "text", text: message.content });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") {
          append("assistant", { type: "text", text: block.text });
        } else if (block.type === "thinking" && block.signature) {
          append("assistant", {
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          });
        } else if (block.type === "toolCall") {
          append("assistant", {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
        } else if (block.type === "serverToolUse") {
          append("assistant", {
            type: "server_tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === "webSearchResult") {
          const content = block.results.length > 0
            ? block.results.map((item) => {
                const result: Record<string, unknown> = {
                  type: "web_search_result",
                };
                if (item.title !== undefined) result["title"] = item.title;
                if (item.url !== undefined) result["url"] = item.url;
                if (item.pageAge !== undefined) result["page_age"] = item.pageAge;
                if (item.encryptedContent !== undefined) {
                  result["encrypted_content"] = item.encryptedContent;
                }
                return result;
              })
            : {
                type: "web_search_tool_result_error",
                error_code: block.errorCode ?? "unavailable",
              };
          append("assistant", {
            type: "web_search_tool_result",
            tool_use_id: block.toolUseId,
            content,
          });
        }
      }
    } else if (message.role === "toolResult") {
      append("user", {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content.map((block) => ({ type: "text", text: block.text })),
        is_error: message.isError,
      });
    }
  }
  return result;
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  return 1000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

export function streamAnthropic(
  model: Model,
  context: LlmContext,
  options?: StreamOptions,
): AssistantEventStream {
  const stream = new AssistantEventStream();
  const key = options?.apiKey ?? (model.apiKeyEnv ? process.env[model.apiKeyEnv] : "") ?? "";
  if (!key) {
    const message = assistantMessage(model, [], "error", emptyUsage(),
      `Missing API key for ${model.provider}/${model.id}; set ${model.apiKeyEnv ?? "an API key env"} or run cletus import-pi`);
    stream.fail(message, message.errorMessage ?? "Missing API key");
    return stream;
  }

  let maxTokens = options?.maxTokens ?? model.maxOutputTokens;
  let thinkingBudget = 0;
  const level = options?.thinkingLevel ?? model.thinkingLevel ?? "off";
  if (level !== "off" && model.supportsThinking) {
    const base = level === "low" ? 1024 : level === "medium" ? 4096 : 8192;
    thinkingBudget = Math.min(base, maxTokens - 1024);
    if (thinkingBudget < 1024) thinkingBudget = 0;
    else maxTokens = Math.max(maxTokens, thinkingBudget + 1024);
  }

  const tools: Array<Record<string, unknown>> = context.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
  if (model.webSearch) {
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: model.webSearchMaxUses ?? 5,
    });
  }

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxTokens,
    system: context.systemPrompt,
    messages: toAnthropicMessages(context.messages),
    tools,
    stream: true,
  };
  if (thinkingBudget > 0) {
    body["thinking"] = { type: "enabled", budget_tokens: thinkingBudget };
  }

  void (async () => {
    const partial = assistantMessage(model, [], "stop");
    stream.push({ type: "start", partial });
    const blocks: Block[] = [];
    const usage = emptyUsage();
    let stopReason: StopReason = "stop";
    let sawMessageStop = false;

    try {
      let response: Response | undefined;
      let lastError = "";
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (response.ok) break;
        const text = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 2) throw new Error(lastError);
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
        const type = json["type"];
        if (type === "message_start") {
          const message = json["message"];
          if (message && typeof message === "object") {
            const msgUsage = (message as Record<string, unknown>)["usage"];
            if (msgUsage && typeof msgUsage === "object") {
              const u = msgUsage as Record<string, unknown>;
              usage.input = Number(u["input_tokens"] ?? 0);
              usage.cacheRead = Number(u["cache_read_input_tokens"] ?? 0);
              usage.cacheWrite = Number(u["cache_creation_input_tokens"] ?? 0);
            }
          }
        } else if (type === "content_block_start") {
          const index = Number(json["index"] ?? 0);
          const block = json["content_block"];
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const blockType = b["type"];
          if (blockType === "text") {
            blocks.push({ kind: "text", index, text: String(b["text"] ?? "") });
          } else if (blockType === "thinking") {
            blocks.push({
              kind: "thinking",
              index,
              thinking: String(b["thinking"] ?? ""),
              signature: "",
            });
          } else if (blockType === "tool_use") {
            const id = String(b["id"] ?? `tool_${index}`);
            const name = String(b["name"] ?? "unknown");
            blocks.push({ kind: "toolCall", index, id, name, args: "" });
            stream.push({ type: "toolcall_start", index, id, name });
          } else if (blockType === "server_tool_use") {
            const input = b["input"];
            blocks.push({
              kind: "serverToolUse",
              index,
              id: String(b["id"] ?? `server_${index}`),
              name: String(b["name"] ?? "web_search"),
              args:
                input && typeof input === "object" ? JSON.stringify(input) : "",
            });
          } else if (blockType === "web_search_tool_result") {
            const results: WebSearchResultItem[] = [];
            let errorCode: string | undefined;
            const content = b["content"];
            if (Array.isArray(content)) {
              for (const item of content) {
                if (!item || typeof item !== "object") continue;
                if (!("type" in item) || item.type !== "web_search_result") continue;
                const result: WebSearchResultItem = {};
                if ("title" in item && typeof item.title === "string") result.title = item.title;
                if ("url" in item && typeof item.url === "string") result.url = item.url;
                if ("page_age" in item) {
                  result.pageAge =
                    typeof item.page_age === "string" || item.page_age === null
                      ? item.page_age
                      : null;
                }
                if ("encrypted_content" in item && typeof item.encrypted_content === "string") {
                  result.encryptedContent = item.encrypted_content;
                }
                results.push(result);
              }
            } else if (content && typeof content === "object" && "type" in content) {
              if (content.type === "web_search_tool_result_error" && "error_code" in content) {
                errorCode = typeof content.error_code === "string" ? content.error_code : "unavailable";
              }
            }
            blocks.push({
              kind: "webSearchResult",
              index,
              toolUseId: String(b["tool_use_id"] ?? ""),
              results,
              ...(errorCode ? { errorCode } : {}),
            });
          }
        } else if (type === "content_block_delta") {
          const index = Number(json["index"] ?? 0);
          const delta = json["delta"];
          if (!delta || typeof delta !== "object") continue;
          const d = delta as Record<string, unknown>;
          const deltaType = d["type"];
          const block = blocks.find((b) => b.index === index);
          if (deltaType === "text_delta") {
            const text = String(d["text"] ?? "");
            if (block?.kind === "text") block.text += text;
            if (text) stream.push({ type: "text_delta", delta: text });
          } else if (deltaType === "thinking_delta") {
            const text = String(d["thinking"] ?? "");
            if (block?.kind === "thinking") block.thinking += text;
            if (text) stream.push({ type: "thinking_delta", delta: text });
          } else if (deltaType === "signature_delta") {
            const signature = String(d["signature"] ?? "");
            if (block?.kind === "thinking") block.signature += signature;
          } else if (deltaType === "input_json_delta") {
            const partialJson = String(d["partial_json"] ?? "");
            if (block?.kind === "toolCall" || block?.kind === "serverToolUse") {
              block.args += partialJson;
            }
            if (partialJson && block?.kind === "toolCall") {
              stream.push({ type: "toolcall_delta", index, delta: partialJson });
            }
          }
        } else if (type === "content_block_stop") {
          const index = Number(json["index"] ?? 0);
          const block = blocks.find((b) => b.index === index);
          if (block?.kind === "toolCall") {
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(block.args || "{}");
              args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
            } catch {
              args = { __raw: block.args };
            }
            block.toolCall = {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: args,
            };
            stream.push({ type: "toolcall_end", index, toolCall: block.toolCall });
          } else if (block?.kind === "serverToolUse") {
            let input: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(block.args || "{}");
              input = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
            } catch {
              input = { __raw: block.args };
            }
            block.input = input;
          }
        } else if (type === "message_delta") {
          const delta = json["delta"];
          if (delta && typeof delta === "object") {
            const reason = (delta as Record<string, unknown>)["stop_reason"];
            if (reason === "end_turn") stopReason = "stop";
            else if (reason === "max_tokens") stopReason = "length";
            else if (reason === "tool_use") stopReason = "toolUse";
            else if (reason === "refusal") stopReason = "stop";
          }
          const rawUsage = json["usage"];
          if (rawUsage && typeof rawUsage === "object") {
            const u = rawUsage as Record<string, unknown>;
            usage.output = Number(u["output_tokens"] ?? usage.output);
            usage.cacheRead = Number(u["cache_read_input_tokens"] ?? usage.cacheRead);
            usage.cacheWrite = Number(
              u["cache_creation_input_tokens"] ?? usage.cacheWrite,
            );
          }
          usage.totalTokens =
            usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        } else if (type === "message_stop") {
          sawMessageStop = true;
        }
      }

      const content: AssistantContent[] = [];
      for (const block of blocks) {
        if (block.kind === "text") {
          if (block.text) content.push({ type: "text", text: block.text });
        } else if (block.kind === "thinking") {
          if (block.thinking) {
            const thinking: AssistantContent = {
              type: "thinking",
              thinking: block.thinking,
            };
            if (block.signature) thinking.signature = block.signature;
            content.push(thinking);
          }
        } else if (block.kind === "toolCall" && block.toolCall) {
          content.push(block.toolCall);
        } else if (block.kind === "serverToolUse") {
          content.push({
            type: "serverToolUse",
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
        } else if (block.kind === "webSearchResult") {
          const result = {
            type: "webSearchResult" as const,
            toolUseId: block.toolUseId,
            results: block.results,
          };
          content.push(
            block.errorCode ? { ...result, errorCode: block.errorCode } : result,
          );
        }
      }
      if (!sawMessageStop && stopReason === "stop" && content.some((c) => c.type === "toolCall")) {
        stopReason = "toolUse";
      }
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
      for (const block of blocks) {
        if (block.kind === "text" && block.text) content.push({ type: "text", text: block.text });
        if (block.kind === "toolCall" && block.toolCall) content.push(block.toolCall);
        if (block.kind === "serverToolUse") {
          content.push({
            type: "serverToolUse",
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
        }
        if (block.kind === "webSearchResult") {
          content.push({
            type: "webSearchResult",
            toolUseId: block.toolUseId,
            results: block.results,
            ...(block.errorCode ? { errorCode: block.errorCode } : {}),
          });
        }
      }
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
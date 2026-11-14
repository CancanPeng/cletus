import { readFile } from "node:fs/promises";
import { AssistantEventStream } from "./event-stream.js";
import { parseSse } from "./sse.js";
import { parseRetryAfter, sleep } from "./retry.js";
import { toolContentText } from "./tokens.js";
import {
  assistantMessage,
  emptyUsage,
  type AssistantContent,
  type LlmContext,
  type Message,
  type Model,
  type StreamOptions,
  type StopReason,
  type ToolCallContent,
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
    };

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function toAnthropicMessages(messages: Message[]): Promise<Array<Record<string, unknown>>> {
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
    if (message.role === "user" || message.role === "system") {
      if (message.role === "user" && message.images?.length) {
        for (const image of message.images) {
          try {
            const data = (await readFile(image.path)).toString("base64");
            append("user", {
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data },
            });
          } catch {
            append("user", { type: "text", text: `[图片不可用: ${image.path}]` });
          }
        }
      }
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
        }
      }
    } else if (message.role === "toolResult") {
      append("user", {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: [{ type: "text", text: toolContentText(message.content) }],
        is_error: message.isError,
      });
    }
  }
  return result;
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

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: maxTokens,
    system: context.systemPrompt,
    messages: [],
    tools: context.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    stream: true,
  };
  if (thinkingBudget > 0) {
    body["thinking"] = { type: "enabled", budget_tokens: thinkingBudget };
  }
  // Anthropic requires temperature=1 while thinking is enabled.
  if (options?.temperature !== undefined && thinkingBudget === 0) {
    body["temperature"] = options.temperature;
  }

  void (async () => {
    const partial = assistantMessage(model, [], "stop");
    stream.push({ type: "start", partial });
    const blocks: Block[] = [];
    const usage = emptyUsage();
    let stopReason: StopReason = "stop";
    let sawMessageStop = false;

    try {
      body["messages"] = await toAnthropicMessages(context.messages);
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
              usage.input = finite(u["input_tokens"], 0);
              usage.cacheRead = finite(u["cache_read_input_tokens"], 0);
              usage.cacheWrite = finite(u["cache_creation_input_tokens"], 0);
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
            if (block?.kind === "toolCall") block.args += partialJson;
            if (partialJson) stream.push({ type: "toolcall_delta", index, delta: partialJson });
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
            usage.output = finite(u["output_tokens"], usage.output);
            usage.cacheRead = finite(u["cache_read_input_tokens"], usage.cacheRead);
            usage.cacheWrite = finite(u["cache_creation_input_tokens"], usage.cacheWrite);
          }
          usage.totalTokens =
            usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        } else if (type === "message_stop") {
          sawMessageStop = true;
        } else if (type === "error") {
          const err = json["error"];
          const message =
            err && typeof err === "object"
              ? (err as Record<string, unknown>)["message"]
              : undefined;
          throw new Error(
            `Provider stream error: ${typeof message === "string" ? message : JSON.stringify(err ?? json)}`,
          );
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
        } else if (block.toolCall) {
          content.push(block.toolCall);
        }
      }
      if (!sawMessageStop) {
        throw new Error("Provider stream ended without message_stop");
      }
      usage.totalTokens =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
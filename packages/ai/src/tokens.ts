import { basename } from "node:path";
import type { LlmContext, Message, ToolContent } from "./types.js";

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 128) ascii += 1;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // Surrogate pair: one non-ASCII code point.
      nonAscii += 1;
      index += 1;
    } else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export function estimateMessageTokens(message: Message): number {
  let total = 4;
  if (message.role === "user") {
    total += estimateTokens(message.content) + (message.images?.length ?? 0) * 1600;
  } else if (message.role === "system") {
    total += estimateTokens(message.content);
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "thinking") total += estimateTokens(block.thinking);
      else total += estimateTokens(block.name + JSON.stringify(block.arguments));
    }
  } else {
    for (const block of message.content) {
      total += block.type === "text" ? estimateTokens(block.text) : 1600;
    }
  }
  return total;
}

/** Flattens tool result content to text, rendering images as a placeholder line. */
export function toolContentText(content: ToolContent[]): string {
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[图片: ${basename(block.path)}  ${block.mediaType}]`,
    )
    .join("\n");
}

export function estimateContextTokens(context: LlmContext): number {
  let total = estimateTokens(context.systemPrompt);
  for (const message of context.messages) total += estimateMessageTokens(message);
  total += Math.ceil(JSON.stringify(context.tools).length / 4);
  return total;
}
import type { LlmContext, Message } from "./types.js";

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
  if (message.role === "user" || message.role === "system") {
    total += estimateTokens(message.content);
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "thinking") total += estimateTokens(block.thinking);
      else total += estimateTokens(block.name + JSON.stringify(block.arguments));
    }
  } else {
    for (const block of message.content) total += estimateTokens(block.text);
  }
  return total;
}

export function estimateContextTokens(context: LlmContext): number {
  let total = estimateTokens(context.systemPrompt);
  for (const message of context.messages) total += estimateMessageTokens(message);
  total += Math.ceil(JSON.stringify(context.tools).length / 4);
  return total;
}
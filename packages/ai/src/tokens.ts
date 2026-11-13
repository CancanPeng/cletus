import type { LlmContext, Message } from "./types.js";

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (/[\x00-\x7F]/.test(ch)) ascii += 1;
    else nonAscii += 1;
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
      else if (block.type === "toolCall") {
        total += estimateTokens(block.name + JSON.stringify(block.arguments));
      } else if (block.type === "serverToolUse") {
        total += estimateTokens(block.name + JSON.stringify(block.input));
      } else {
        total += estimateTokens(JSON.stringify(block.results));
      }
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
import type { AgentMessage } from "@cletus/agent";
import { toolContentText } from "@cletus/ai";
import type { TranscriptBlock } from "@cletus/tui";

function textOf(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function thinkingOf(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .map((block) => (block.type === "thinking" ? block.thinking : ""))
    .join("");
}

/**
 * Turns a projected conversation into transcript blocks. A fork starts from
 * history rather than from events, so the TUI has to replay what it missed.
 */
export function projectionBlocks(
  messages: AgentMessage[],
  idPrefix = "h",
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let counter = 0;
  const nextId = (): string => `${idPrefix}${counter++}`;

  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    results.set(message.toolCallId, {
      text: toolContentText(message.content),
      isError: message.isError,
    });
  }

  for (const message of messages) {
    if (message.role === "user") {
      blocks.push({ id: nextId(), kind: "user", text: message.content });
    } else if (message.role === "custom") {
      blocks.push({
        id: nextId(),
        kind: "user",
        text: `[${message.customType}]\n${message.content}`,
      });
    } else if (message.role === "assistant") {
      const text = textOf(message);
      const thinking = thinkingOf(message);
      if (text || thinking) {
        blocks.push({ id: nextId(), kind: "assistant", text, thinking, done: true });
      }
      for (const content of message.content) {
        if (content.type !== "toolCall") continue;
        const result = results.get(content.id);
        blocks.push({
          id: nextId(),
          kind: "tool",
          name: content.name,
          argsSummary: JSON.stringify(content.arguments, null, 2) ?? "{}",
          output: result?.text ?? "",
          isError: result?.isError ?? false,
          expanded: false,
          // No result means the call never finished (aborted run, or a fork cut
          // mid-turn); report it the way a failure is shown rather than as a
          // success with empty output.
          status: result && !result.isError ? "success" : "error",
        });
      }
    }
  }
  return blocks;
}
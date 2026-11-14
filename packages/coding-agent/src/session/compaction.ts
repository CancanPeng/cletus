import { basename } from "node:path";
import {
  estimateMessageTokens,
  toolContentText,
  type AssistantContent,
  type AssistantMessage,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import type { SessionManager } from "./manager.js";
import type { SessionEntry } from "./types.js";

export type CompactionConfig = { reserveTokens: number; keepRecentTokens: number };
export type CompactionResult = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};

export const COMPACTION_SYSTEM_PROMPT = `You are summarizing a coding-agent conversation so work can continue with limited context.
Preserve: the user's goals and constraints, decisions made, files created or modified (with paths), commands run and their results, unresolved errors, and next steps.
Omit chit-chat and redundant detail. Output Markdown under these headings:
## Goal
## Decisions
## Files
## Commands
## Errors
## Next steps`;

export function shouldCompact(
  tokens: number,
  model: Model,
  cfg: CompactionConfig,
): boolean {
  const reserve =
    model.contextWindow < 32768
      ? Math.min(cfg.reserveTokens, Math.floor(model.contextWindow / 4))
      : cfg.reserveTokens;
  return tokens > model.contextWindow - reserve;
}

export function selectCut(branch: SessionEntry[], keepRecentTokens: number): number {
  if (branch.length === 0) return -1;
  const last = branch[branch.length - 1];
  let upper = branch.length;
  if (last?.type === "message" && last.message.role === "user") upper -= 1;
  if (upper <= 0) return -1;

  let tokens = 0;
  for (let index = upper - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message.role !== "custom") {
      tokens += estimateMessageTokens(entry.message);
    }
    if (tokens >= keepRecentTokens) {
      let cut = index;
      while (cut > 0) {
        const entry = branch[cut];
        if (
          entry?.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant")
        ) {
          // Never keep an assistant message without all of its tool results:
          // providers reject a tool_use that has no matching tool_result.
          if (entry.message.role === "assistant") {
            const callIds = new Set(
              entry.message.content
                .filter((block) => block.type === "toolCall")
                .map((block) => block.id),
            );
            if (callIds.size > 0) {
              const answered = new Set<string>();
              for (let scan = cut + 1; scan < branch.length; scan += 1) {
                const next = branch[scan];
                if (next?.type === "message" && next.message.role === "toolResult") {
                  answered.add(next.message.toolCallId);
                }
              }
              if (![...callIds].every((id) => answered.has(id))) {
                cut -= 1;
                continue;
              }
            }
          }
          return cut;
        }
        cut -= 1;
      }
      return -1;
    }
  }
  return -1;
}

function serializeMessage(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message;
  if (message.role === "user") {
    const images = message.images
      ?.map((image) => `[attached image: ${basename(image.path)}]`)
      .join("\n");
    return `## User\n${message.content}${images ? `\n${images}` : ""}\n`;
  }
  if (message.role === "assistant") {
    const text = message.content
      .map((block: AssistantContent) =>
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? `[thinking] ${block.thinking}`
            : `[tool ${block.name}] ${JSON.stringify(block.arguments)}`,
      )
      .join("\n");
    return `## Assistant\n${text}\n`;
  }
  if (message.role === "toolResult") {
    return `## Tool result (${message.toolName})\n${toolContentText(message.content)}\n`;
  }
  return "";
}

function tokensOf(branch: SessionEntry[]): number {
  let total = 0;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role !== "custom") {
      total += estimateMessageTokens(entry.message);
    }
  }
  return total;
}

export async function compact(
  manager: SessionManager,
  model: Model,
  streamFn: StreamFn,
  opts: {
    keepRecentTokens: number;
    reserveTokens?: number;
    instructions?: string;
    signal?: AbortSignal;
    force?: boolean;
    apiKey?: string;
  },
): Promise<CompactionResult | { skipped: true }> {
  const branch = manager.getBranch();
  const tokensBefore = tokensOf(branch);
  if (!opts.force) {
    const cfg: CompactionConfig = {
      reserveTokens: opts.reserveTokens ?? 16384,
      keepRecentTokens: opts.keepRecentTokens,
    };
    if (!shouldCompact(tokensBefore, model, cfg)) return { skipped: true };
  }

  const cut = selectCut(branch, opts.keepRecentTokens);
  if (cut <= 0) return { skipped: true };

  let previousCompaction: SessionEntry | undefined;
  for (let index = 0; index < cut; index += 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") previousCompaction = entry;
  }

  let start = 0;
  if (previousCompaction && previousCompaction.type === "compaction") {
    const keptIndex = branch.findIndex(
      (entry) => entry.id === previousCompaction.firstKeptEntryId,
    );
    start = keptIndex >= 0 ? keptIndex : branch.indexOf(previousCompaction) + 1;
  }

  let input = "";
  if (previousCompaction && previousCompaction.type === "compaction") {
    input += `Previous summary:\n${previousCompaction.summary}\n\n`;
  }
  for (let index = start; index < cut; index += 1) {
    input += serializeMessage(branch[index] as SessionEntry);
  }
  if (opts.instructions) input += `Focus:\n${opts.instructions}\n`;
  if (!input.trim()) return { skipped: true };

  const stream = streamFn(
    model,
    {
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input, timestamp: Date.now() }],
      tools: [],
    },
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      maxTokens: Math.min(4096, model.maxOutputTokens),
    },
  );

  let summary = "";
  for await (const event of stream) {
    if (event.type === "text_delta") summary += event.delta;
    else if (event.type === "done") {
      const message: AssistantMessage = event.message;
      const text = message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      if (text) summary = text;
    } else if (event.type === "error") {
      throw new Error(event.error);
    }
  }
  summary = summary.trim();
  if (!summary) throw new Error("Compaction failed: empty summary");

  await manager.appendCompaction(summary, (branch[cut] as SessionEntry).id, tokensBefore);
  return {
    summary,
    firstKeptEntryId: (branch[cut] as SessionEntry).id,
    tokensBefore,
  };
}
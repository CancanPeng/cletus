import type { AssistantMessage, Message } from "@cletus/ai";
import type { AgentMessage, JsonValue } from "@cletus/agent";

export type SessionEntryBase = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type SessionEntry =
  | {
      type: "session";
      version: 1;
      id: string;
      timestamp: string;
      cwd: string;
      parentSession?: string;
    }
  | (SessionEntryBase & { type: "message"; message: AgentMessage })
  | (SessionEntryBase & { type: "model_change"; ref: string })
  | (SessionEntryBase & {
      type: "compaction";
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    })
  | (SessionEntryBase & { type: "custom"; customType: string; data: JsonValue });

export type SessionInfo = {
  id: string;
  filePath: string;
  cwd: string;
  timestamp: string;
  messageCount: number;
  firstUserText: string;
};

export type MessageEntry = SessionEntryBase & { type: "message"; message: AgentMessage };
export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};
export type ModelChangeEntry = SessionEntryBase & { type: "model_change"; ref: string };
export type CustomEntry = SessionEntryBase & {
  type: "custom";
  customType: string;
  data: JsonValue;
};

export function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === "message";
}
export function isCompactionEntry(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === "compaction";
}
export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}
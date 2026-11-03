import type { AgentMessage } from "@cletus/agent";
import type { SessionEntry } from "./types.js";
import type { SessionManager } from "./manager.js";

export function buildProjection(
  manager: SessionManager,
  leafId?: string | null,
): { messages: AgentMessage[]; compaction: SessionEntry | null } {
  const branch = manager.getBranch(leafId);
  let lastCompaction: SessionEntry | null = null;
  let compactionIndex = -1;
  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      lastCompaction = entry;
      compactionIndex = index;
    }
  }

  const messages: AgentMessage[] = [];
  const project = (entry: SessionEntry): void => {
    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "custom") {
      let content = "";
      if (
        entry.data &&
        typeof entry.data === "object" &&
        !Array.isArray(entry.data) &&
        "message" in entry.data &&
        typeof entry.data.message === "string"
      ) {
        content = entry.data.message;
      }
      messages.push({
        role: "custom",
        customType: entry.customType,
        content,
        display: true,
        timestamp: Date.parse(entry.timestamp) || Date.now(),
      });
    }
  };

  if (lastCompaction && lastCompaction.type === "compaction") {
    messages.push({
      role: "user",
      content: `Previous conversation summary:\n${lastCompaction.summary}`,
      timestamp: Date.now(),
    });
    const keptIndex = branch.findIndex(
      (entry) => entry.id === lastCompaction.firstKeptEntryId,
    );
    const start = keptIndex >= 0 ? keptIndex : compactionIndex + 1;
    for (let index = start; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry && entry.id !== lastCompaction.id) project(entry);
    }
  } else {
    for (const entry of branch) project(entry);
  }

  return { messages, compaction: lastCompaction };
}
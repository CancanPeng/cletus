import type { AgentEvent, ToolResult } from "@cletus/agent";

const MAX_LINES = 100;
const MAX_TEXT = 16_384;
const MAX_DETAIL = 80;

function clip(text: string, max = MAX_DETAIL): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function firstLine(result: ToolResult): string {
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Turns a subagent's events into progress text for the parent's task card:
 * the first line is the current activity, the rest is a capped tool log.
 * One instance per subagent run — concurrent tasks must not share state.
 */
export function createSubagentProgress(maxTurns: number): {
  /** Returns the full progress text when the display should change, else undefined. */
  handle(event: AgentEvent): string | undefined;
} {
  let turn = 0;
  let activity = "thinking …";
  let dropped = false;
  const lines: string[] = [];
  const starts = new Map<string, { name: string; args: string; at: number }>();

  const MARKER = "[earlier activity dropped]";

  const render = (): string => {
    const status = `▸ turn ${turn}/${maxTurns} · ${activity}`;
    // Spend the char budget on whole log lines from the newest backwards:
    // a blind tail-slice would eat the status line, the feature's whole point.
    // Reserve room for the marker up front so flipping `dropped` mid-render
    // can never push the total past MAX_TEXT.
    const kept: string[] = [];
    let used = status.length + 1 + MARKER.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (used + 1 + line.length > MAX_TEXT) {
        dropped = true;
        break;
      }
      used += 1 + line.length;
      kept.unshift(line);
    }
    const parts = [status];
    if (dropped) parts.push(MARKER);
    parts.push(...kept);
    return parts.join("\n");
  };

  return {
    handle(event: AgentEvent): string | undefined {
      if (event.type === "turn_start") {
        turn = event.turn;
        activity = "thinking …";
        return render();
      }
      if (event.type === "tool_execution_start") {
        const args = clip(JSON.stringify(event.args ?? {}));
        starts.set(event.toolCallId, { name: event.toolName, args, at: Date.now() });
        activity = `${event.toolName} ${args}`;
        return render();
      }
      if (event.type === "tool_execution_end") {
        const started = starts.get(event.toolCallId);
        starts.delete(event.toolCallId);
        const name = started?.name ?? event.toolName;
        const args = started?.args ?? "";
        const duration = formatDuration(Date.now() - (started?.at ?? Date.now()));
        const failed = event.result.isError === true;
        let line = `${failed ? "✗" : "✓"} ${name} ${args} · ${duration}`;
        if (failed) {
          const detail = clip(firstLine(event.result));
          if (detail) line += ` — ${detail}`;
        }
        lines.push(line);
        if (lines.length > MAX_LINES) {
          lines.splice(0, lines.length - MAX_LINES);
          dropped = true;
        }
        activity = "thinking …";
        return render();
      }
      return undefined;
    },
  };
}

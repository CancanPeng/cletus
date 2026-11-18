import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@cletus/agent";
import { createSubagentProgress } from "../src/subagent-progress.js";

const start = (id: string, name: string, args: unknown): AgentEvent => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  args,
});

const end = (
  id: string,
  name: string,
  text: string,
  isError = false,
): AgentEvent => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: name,
  result: { isError, content: [{ type: "text", text }] },
});

describe("subagent progress formatter", () => {
  it("renders a status line plus a log of finished tools", () => {
    const progress = createSubagentProgress(30);
    progress.handle({ type: "turn_start", turn: 1 });
    const running = progress.handle(start("a", "read", { path: "src/app.ts" }));
    expect(running?.split("\n")[0]).toBe('▸ turn 1/30 · read {"path":"src/app.ts"}');
    const done = progress.handle(end("a", "read", "file contents"));
    expect(done?.split("\n")[0]).toBe("▸ turn 1/30 · thinking …");
    expect(done).toMatch(/^✓ read \{"path":"src\/app\.ts"\} · \d+m?s?/m);
  });

  it("marks failed tools with ✗ and the first result line", () => {
    const progress = createSubagentProgress(30);
    progress.handle({ type: "turn_start", turn: 1 });
    progress.handle(start("a", "bash", { command: "pnpm test" }));
    const done = progress.handle(end("a", "bash", "\nexit 1\nmore", true));
    const logLine = done?.split("\n").find((line) => line.includes("✗"));
    expect(logLine).toBeDefined();
    expect(logLine?.endsWith("— exit 1")).toBe(true);
  });

  it("clips args to 80 chars", () => {
    const progress = createSubagentProgress(30);
    progress.handle({ type: "turn_start", turn: 1 });
    const running = progress.handle(start("a", "write", { content: "x".repeat(500) }));
    const firstLine = running?.split("\n")[0] ?? "";
    const argsPart = firstLine.slice(firstLine.indexOf("write ") + "write ".length);
    expect(argsPart.length).toBeLessThanOrEqual(81);
    expect(argsPart.endsWith("…")).toBe(true);
  });

  it("keeps only the last 100 log lines", () => {
    const progress = createSubagentProgress(30);
    progress.handle({ type: "turn_start", turn: 1 });
    let text = "";
    for (let i = 1; i <= 105; i += 1) {
      progress.handle(start(`t${i}`, `tool_${i}`, {}));
      text = progress.handle(end(`t${i}`, `tool_${i}`, "ok")) ?? "";
    }
    expect(text).toContain("[earlier activity dropped]");
    expect(text).toContain("✓ tool_105");
    expect(text).not.toContain("✓ tool_1 ");
    expect(text.length).toBeLessThanOrEqual(16384);
  });

  it("keeps the status line when long log lines exceed the char budget", () => {
    const progress = createSubagentProgress(30);
    progress.handle({ type: "turn_start", turn: 1 });
    const longArgs = { command: "c".repeat(200) };
    const longError = `FAIL ${"x".repeat(170)}`;
    let text = "";
    for (let i = 1; i <= 100; i += 1) {
      progress.handle(start(`t${i}`, "bash", longArgs));
      text = progress.handle(end(`t${i}`, "bash", longError, true)) ?? "";
    }
    expect(text.startsWith("▸ turn 1/30 · thinking …")).toBe(true);
    expect(text).toContain("[earlier activity dropped]");
    expect(text).toContain("✗ bash");
    expect(text.length).toBeLessThanOrEqual(16384);
  });

  it("returns undefined for unrelated events", () => {
    const progress = createSubagentProgress(30);
    expect(progress.handle({ type: "agent_start" })).toBeUndefined();
  });
});

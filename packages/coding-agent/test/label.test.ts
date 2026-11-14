import { describe, expect, it } from "vitest";
import { sessionLabel } from "../src/session/label.js";

const info = (overrides: Partial<Parameters<typeof sessionLabel>[0]> = {}) => ({
  id: "abc",
  filePath: "/tmp/s.jsonl",
  cwd: "/tmp",
  timestamp: "2026-01-02T03:04:05.000Z",
  messageCount: 4,
  firstUserText: "refactor the parser",
  ...overrides,
});

describe("sessionLabel", () => {
  it("includes time, message count, and preview", () => {
    const label = sessionLabel(info());
    expect(label).toContain("4 msg");
    expect(label).toContain("refactor the parser");
  });

  it("marks the session already open", () => {
    expect(sessionLabel(info(), true)).toContain("current");
    expect(sessionLabel(info(), false)).not.toContain("current");
    // The separator belongs to join(), not to the segment.
    expect(sessionLabel(info(), true)).not.toContain("· · ");
  });

  it("collapses whitespace and truncates the preview", () => {
    const label = sessionLabel(info({ firstUserText: `${"word ".repeat(20)}\nend` }));
    expect(label).not.toContain("\n");
    expect(label).toContain("…");
  });

  it("names empty sessions instead of leaving a gap", () => {
    const label = sessionLabel(info({ firstUserText: "" }));
    expect(label).toContain("(empty session)");
  });
});
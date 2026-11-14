import { describe, expect, it } from "vitest";
import { headerFor } from "../src/session/header.js";
import { getTheme } from "@cletus/tui";

describe("headerFor", () => {
  const model = { provider: "anthropic", id: "claude-test", ref: "anthropic/claude-test" } as const;

  it("shows model, cwd, and branch without app name or session id", () => {
    const header = headerFor("/tmp/proj", model, "main", getTheme("dark", { preset: "unicode" }));
    expect(header).toContain("◈ anthropic/claude-test");
    expect(header).toContain("⌂ /tmp/proj");
    expect(header).toContain("⎇ main");
    expect(header).not.toContain("cletus");
    expect(header).not.toContain("▣");
  });

  it("falls back to provider/id and omits branch when absent", () => {
    const header = headerFor(
      "/tmp/proj",
      { provider: "openai", id: "gpt" },
      undefined,
      getTheme("dark", { preset: "unicode" }),
    );
    expect(header).toContain("◈ openai/gpt");
    expect(header).not.toContain("⎇");
  });
});

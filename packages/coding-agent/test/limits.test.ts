import { describe, expect, it } from "vitest";
import { createDefaultConfig, loadConfig } from "../src/config.js";

describe("turn limits", () => {
  it("defaults to 500/3 and survives a round trip", async () => {
    const defaults = createDefaultConfig();
    expect(defaults.maxTurns).toBe(500);
    expect(defaults.maxAutoContinues).toBe(3);
  });

  it("an existing config file without the keys gets the defaults", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "cletus-cfg-"));
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { openai: { baseUrl: "https://x" }, anthropic: { baseUrl: "https://y" } },
      models: [], compaction: { reserveTokens: 1, keepRecentTokens: 1 },
      webSearch: { enabled: false, order: [], timeoutSeconds: 1 },
      skillOverrides: {}, permissions: { allowWrite: [] },
      tui: { showThinking: false, theme: "dark", keybindings: {}, symbols: { preset: "nerd", overrides: {} } },
    }), "utf8");
    const cfg = await loadConfig(home);
    expect(cfg.maxTurns).toBe(500);
    expect(cfg.maxAutoContinues).toBe(3);
  });
});

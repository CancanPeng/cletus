import { describe, expect, it } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";

async function setup() {
  const test = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const app = new TuiApp({
    header: "h",
    theme: getTheme("dark", { preset: "unicode" }),
    keybindings: new KeybindingsManager({}),
    submit: async () => undefined,
    abort: () => undefined,
    commands: [],
    history: [],
    renderer: test.renderer,
  });
  await app.start();
  return { ...test, app };
}

describe("status line ordering", () => {
  it("idle: duration comes before context usage", async () => {
    const ctx = await setup();
    ctx.app.setStatus({
      busy: false,
      model: "m",
      tokens: "",
      queue: 0,
      context: "12.4k/128k 10%",
      duration: "1.2s",
    });
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    const durationAt = frame.indexOf("◷ 1.2s");
    const usageAt = frame.indexOf("▤ 12.4k/128k 10%");
    expect(durationAt).toBeGreaterThanOrEqual(0);
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(durationAt).toBeLessThan(usageAt);
    ctx.app.stop();
    await ctx.dispose();
  });

  it("busy: elapsed comes before context usage", async () => {
    const ctx = await setup();
    ctx.app.setStatus({
      busy: true,
      model: "m",
      tokens: "",
      queue: 0,
      activity: "thinking",
      context: "12.4k/128k 10%",
      startedAt: Date.now() - 5000,
    });
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    const durationAt = frame.indexOf("◷ ");
    const usageAt = frame.indexOf("▤ 12.4k/128k 10%");
    expect(durationAt).toBeGreaterThanOrEqual(0);
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(durationAt).toBeLessThan(usageAt);
    ctx.app.stop();
    await ctx.dispose();
  });
});

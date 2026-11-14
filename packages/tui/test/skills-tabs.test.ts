import { describe, expect, it } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import type { ManagedItem } from "../src/app.js";
import { TuiApp } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";

// Mirrors the /skills tab wiring in packages/coding-agent/src/cli.ts.
describe("skills tabs", () => {
  it("filters, searches, and installs from one popup", async () => {
    const test = await createTestRenderer({ width: 110, height: 32, exitOnCtrlC: false });
    const app = new TuiApp({
      header: "cletus", theme: getTheme("dark", { preset: "unicode" }),
      keybindings: new KeybindingsManager({}), submit: async () => undefined,
      abort: () => undefined, commands: [], history: [], renderer: test.renderer,
    });
    await app.start();
    const skills: ManagedItem[] = [
      { id: "brainstorming", label: "brainstorming · personal — plan", state: "on", states: ["on", "name-only", "user-only", "off"] },
      { id: "blogwatcher", label: "blogwatcher · personal — rss", state: "on", states: ["on", "name-only", "user-only", "off"] },
      { id: "pdf", label: "pdf · personal — docs", state: "off", states: ["on", "name-only", "user-only", "off"] },
    ];
    const installed: string[] = [];
    const cycled: Array<[string, string]> = [];
    const done = app.manageTabs("Skills", [
      { kind: "list", id: "skills", title: "Skills", items: skills,
        refresh: async () => skills,
        onCycle: (id, state) => { cycled.push([id, state]); } },
      { kind: "search", id: "search", title: "Search", placeholder: "pdf, testing, design…",
        search: async (query) => [{ id: "x/y/" + query, label: `${query} · x/y · 42 installs` }],
        onAccept: (r) => { installed.push(r.id); } },
      { kind: "prompt", id: "install", title: "Install", placeholder: "owner/repo#skill",
        onSubmit: (v) => { installed.push(v); } },
    ]);
    await test.flush();

    // Skills tab: filter by letter, cycle visibility.
    await test.mockInput.typeText("pdf");
    await test.flush();
    let frame = test.captureCharFrame();
    expect(frame).toContain("1/3");
    expect(frame).toContain("[off] pdf");
    expect(frame).not.toContain("brainstorming");
    await test.mockInput.typeText(" ");
    await test.flush();
    expect(cycled).toEqual([["pdf", "on"]]);
    expect(test.captureCharFrame()).toContain("[on] pdf");

    // Tab -> Search, live search, Enter installs.
    test.mockInput.pressTab();
    await test.flush();
    expect(test.captureCharFrame()).toContain("[Search]");
    await test.mockInput.typeText("design");
    await test.flush();
    await new Promise((r) => setTimeout(r, 350));
    await test.flush();
    frame = test.captureCharFrame();
    expect(frame).toContain("design · x/y · 42 installs");
    test.mockInput.pressEnter();
    await test.flush();
    expect(installed).toEqual(["x/y/design"]);

    // Tab -> Install, prompt submit.
    test.mockInput.pressTab();
    await test.flush();
    expect(test.captureCharFrame()).toContain("[Install]");
    await test.mockInput.typeText("owner/repo#skill");
    await test.flush();
    test.mockInput.pressEnter();
    await test.flush();
    expect(installed.at(-1)).toBe("owner/repo#skill");

    // Esc goes back to Skills, keeping the filter that was set there.
    await new Promise((r) => setTimeout(r, 60));
    test.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await test.flush();
    frame = test.captureCharFrame();
    expect(frame).toContain("[Skills]");
    expect(frame).toContain("/pdf");
    // Next Esc clears the filter, and only then does Esc close.
    test.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await test.flush();
    expect(test.captureCharFrame()).not.toContain("/pdf");
    expect(test.captureCharFrame()).toContain("[Skills]");
    test.mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await test.flush();
    await expect(done).resolves.toBeUndefined();
    app.stop();
    await test.dispose();
  }, 20000);
});

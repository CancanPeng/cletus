import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { ManagedItem } from "../src/app.js";
import { TuiApp } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";

// The test renderer has no real terminal setup, so CliRenderer.suspend()
// throws there. Stub the two transition methods to record the handoff; the
// real suspend/resume path is exercised by the production CliRenderer.
async function makeApp() {
  const test = await createTestRenderer({ width: 110, height: 32, exitOnCtrlC: false });
  const transitions: string[] = [];
  const renderer = test.renderer as unknown as {
    suspend: () => Promise<void>;
    resume: () => Promise<void>;
  };
  renderer.suspend = async () => {
    transitions.push("suspend");
  };
  renderer.resume = async () => {
    transitions.push("resume");
  };
  const app = new TuiApp({
    header: "cletus",
    theme: getTheme("dark", { preset: "unicode" }),
    keybindings: new KeybindingsManager({}),
    submit: async () => undefined,
    abort: () => undefined,
    commands: [],
    history: [],
    renderer: test.renderer,
  });
  await app.start();
  return { test, app, transitions };
}

const items: ManagedItem[] = [
  { id: "explore", label: "explore · builtin — research", state: "on", states: ["on", "off"] },
  { id: "reviewer", label: "reviewer · personal — review", state: "on", states: ["on", "off"] },
];

describe("agents manager", () => {
  it("Enter opens the item when onOpen is set", async () => {
    const { test, app } = await makeApp();
    const opened: string[] = [];
    const done = app.manageTabs("Agents", [
      {
        kind: "list",
        id: "agents",
        title: "Agents",
        items: items.map((i) => ({ ...i })),
        onCycle: () => undefined,
        onOpen: (item) => {
          opened.push(item.id);
        },
      },
    ]);
    await test.flush();
    await test.mockInput.typeText("reviewer");
    await test.flush();
    test.mockInput.pressEnter();
    await test.flush();
    await done;
    expect(opened).toEqual(["reviewer"]);
    expect(test.captureCharFrame()).not.toContain("[Agents]");
    app.stop();
  });

  it("Enter without onOpen still closes the popup", async () => {
    const { test, app } = await makeApp();
    const done = app.manageTabs("Agents", [
      {
        kind: "list",
        id: "agents",
        title: "Agents",
        items: items.map((i) => ({ ...i })),
        onCycle: () => undefined,
      },
    ]);
    await test.flush();
    test.mockInput.pressEnter();
    await test.flush();
    await done;
    expect(test.captureCharFrame()).not.toContain("[Agents]");
    app.stop();
  });

  it("editFile suspends and resumes around the editor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cletus-edit-"));
    try {
      const marker = join(dir, "marker.txt");
      const script = join(dir, "editor.sh");
      await writeFile(script, `#!/bin/sh\necho "$1" > "${marker}"\n`, "utf8");
      await chmod(script, 0o755);
      const target = join(dir, "x.md");
      const { test, app, transitions } = await makeApp();
      await app.editFile(target, script);
      expect((await readFile(marker, "utf8")).trim()).toBe(target);
      expect(transitions).toEqual(["suspend", "resume"]);
      // The TUI must still render after the editor handoff.
      app.appendBlock({ id: "post-edit", kind: "notice", text: "still alive", level: "info" });
      await test.flush();
      expect(test.captureCharFrame()).toContain("still alive");
      app.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("editFile resumes even when the editor fails", async () => {
    const { test, app, transitions } = await makeApp();
    await app.editFile("/tmp/does-not-matter.md", "false");
    expect(transitions).toEqual(["suspend", "resume"]);
    app.appendBlock({ id: "post-fail", kind: "notice", text: "resumed after failure", level: "info" });
    await test.flush();
    expect(test.captureCharFrame()).toContain("resumed after failure");
    app.stop();
  });
});

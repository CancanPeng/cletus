import { describe, expect, it } from "vitest";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp, type SlashCommand } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";

async function setupApp(overrides: Record<string, string | string[]> = {}) {
  const test = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const submissions: string[] = [];
  const commands: SlashCommand[] = [
    { name: "test", description: "test command", run: () => undefined },
  ];
  const app = new TuiApp({
    header: "cletus test",
    theme: getTheme("dark"),
    keybindings: new KeybindingsManager(overrides),
    submit: async (text) => {
      submissions.push(text);
    },
    abort: () => undefined,
    commands,
    history: [],
    renderer: test.renderer,
  });
  await app.start();
  return { ...test, app, submissions };
}

describe("TuiApp", () => {
  it("submits editor input on Enter", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("hello");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions).toEqual(["hello"]);
    ctx.app.stop();
    await ctx.dispose();
  });

  it("resolves the permission modal with y", async () => {
    const ctx = await setupApp();
    const decision = ctx.app.confirm("Permission", "Write a.txt");
    ctx.mockInput.pressKey("y");
    await ctx.flush();
    await expect(decision).resolves.toBe("allow");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("notifies unknown slash commands", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("/nope");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("Unknown command: /nope");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("honors a keybinding override", async () => {
    const test = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
    let aborts = 0;
    const app = new TuiApp({
      header: "cletus test",
      theme: getTheme("dark"),
      keybindings: new KeybindingsManager({ abort: "ctrl+x" }),
      submit: async () => undefined,
      abort: () => {
        aborts += 1;
      },
      commands: [],
      history: [],
      renderer: test.renderer,
    });
    await app.start();
    app.setStatus({ busy: true, model: "m", tokens: "", queue: 0 });
    test.mockInput.pressCtrlC();
    await test.flush();
    expect(aborts).toBe(0);
    test.mockInput.pressKey("x", { ctrl: true });
    await test.flush();
    expect(aborts).toBe(1);
    app.stop();
    await test.dispose();
  });

  it("switches theme and reports keybinding conflicts", async () => {
    const ctx = await setupApp();
    ctx.app.setTheme(getTheme("light"));
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("cletus test");
    expect(() => new KeybindingsManager({ abort: "enter" })).toThrow(
      "Keybinding conflict: enter is bound to submit and abort",
    );
    ctx.app.stop();
    await ctx.dispose();
  });

  it("shows help for slash commands", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("/help");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("/test");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("renders activity and key hints in the status line", async () => {
    const ctx = await setupApp();
    ctx.app.setStatus({
      busy: true,
      model: "openai/fake",
      tokens: "9",
      queue: 1,
      activity: "running read",
    });
    await ctx.flush();
    let frame = ctx.captureCharFrame();
    expect(frame).toContain("running read");
    expect(frame).toContain("9 tok");
    expect(frame).toContain("1 queued");
    ctx.app.setStatus({
      busy: false,
      model: "openai/fake",
      tokens: "",
      queue: 0,
      context: "12.4k/128k 10%",
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("ctx 12.4k/128k 10%");
    const decision = ctx.app.confirm("Permission", "Write a.txt");
    await ctx.flush();
    frame = ctx.captureCharFrame();
    expect(frame).toContain("waiting for permission");
    expect(frame).toContain("y allow");
    ctx.mockInput.pressKey("n");
    await ctx.flush();
    await expect(decision).resolves.toBe("deny");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("does not show a message title on the input box", async () => {
    const ctx = await setupApp();
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("message");
    ctx.app.setTheme(getTheme("light"));
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("message");
    expect(getTheme("light").colors.inputBg).not.toBe(getTheme("dark").colors.inputBg);
    ctx.app.stop();
    await ctx.dispose();
  });

  it("renders select options", async () => {
    const ctx = await setupApp();
    const selection = ctx.app.select("Skills", [
      { label: "[on] demo — Demo skill", value: "demo" },
    ]);
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    expect(frame).toContain("Skills");
    expect(frame).toContain("demo");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    await expect(selection).resolves.toBe("demo");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("marks yolo mode in the status line", async () => {
    const ctx = await setupApp();
    ctx.app.setYolo(true);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("YOLO");
    ctx.app.setYolo(false);
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("YOLO");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("shows the slash command palette", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("/");
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    expect(frame).toContain("/test");
    expect(frame).toContain("test command");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("keeps the cursor at the end after accepting a command", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("/te");
    await ctx.flush();
    ctx.mockInput.pressTab();
    await ctx.flush();
    ctx.mockInput.typeText("x");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("/test x");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("manages list states in a popup", async () => {
    const ctx = await setupApp();
    const changes: Array<[string, string]> = [];
    const done = ctx.app.manageItems(
      "Skills",
      [{ id: "review", label: "review · personal", state: "on", states: ["on", "off"] }],
      (id, state) => {
        changes.push([id, state]);
      },
    );
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[on] review");
    ctx.mockInput.typeText(" ");
    await ctx.flush();
    expect(changes).toEqual([["review", "off"]]);
    expect(ctx.captureCharFrame()).toContain("[off] review");
    ctx.mockInput.pressEscape();
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("renders assistant markdown and tool cards", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "assistant-1",
      kind: "assistant",
      text: "# Title\n\n- one\n- two",
    });
    ctx.app.appendBlock({
      id: "tool-1",
      kind: "tool",
      name: "read",
      argsSummary: "a.txt",
      output: "file contents",
      isError: false,
      expanded: true,
    });
    await ctx.flush();
    await ctx.flush();
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    expect(frame).toContain("Title");
    expect(frame).toContain("one");
    expect(frame).toContain("read");
    expect(frame).toContain("file contents");
    ctx.app.stop();
    await ctx.dispose();
  });
});
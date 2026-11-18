import { describe, expect, it } from "vitest";
import { KeyCodes, createTestRenderer } from "@opentui/core/testing";
import type { ClipboardService } from "@opentui/core";
import type { ImageAttachment } from "@cletus/ai";
import { TuiApp, type SlashCommand } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";

function fakeClipboard(mimeType: string, bytes: Uint8Array): ClipboardService {
  return {
    read: async () => ({ status: "read", representation: { mimeType, bytes } }),
    writeText: async () => ({
      host: { status: "not-attempted" },
      terminal: { status: "not-attempted" },
    }),
    clear: async () => ({
      host: { status: "not-attempted" },
      terminal: { status: "not-attempted" },
    }),
    dispose: async () => undefined,
  } as unknown as ClipboardService;
}

async function setupImageApp(opts: {
  mimeType: string;
  bytes: Uint8Array;
  attach?: (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg") => Promise<ImageAttachment | undefined>;
}) {
  const test = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const submissions: Array<{ text: string; images?: ImageAttachment[] }> = [];
  const attachCalls: Array<{ size: number; mediaType: string }> = [];
  const app = new TuiApp({
    header: "cletus test",
    theme: getTheme("dark", { preset: "unicode" }),
    keybindings: new KeybindingsManager({}),
    submit: async (text, images) => {
      submissions.push({ text, ...(images ? { images } : {}) });
    },
    abort: () => undefined,
    commands: [],
    history: [],
    renderer: test.renderer,
    clipboard: fakeClipboard(opts.mimeType, opts.bytes),
    attachImage: async (bytes, mediaType) => {
      attachCalls.push({ size: bytes.length, mediaType });
      return opts.attach ? opts.attach(bytes, mediaType) : { mediaType, path: "/tmp/shot.png" };
    },
  });
  await app.start();
  return { ...test, app, submissions, attachCalls };
}

async function setupApp(overrides: Record<string, string | string[]> = {}) {
  const test = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const submissions: string[] = [];
  const commands: SlashCommand[] = [
    { name: "test", description: "test command", run: () => undefined },
  ];
  const app = new TuiApp({
    header: "cletus test",
    theme: getTheme("dark", { preset: "unicode" }),
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

  it("submits an absolute file path as a message instead of a command", async () => {
    const ctx = await setupApp();
    const path = "/var/folders/cv/tmp/orca-paste-123.png";
    ctx.mockInput.typeText(path);
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions).toEqual([path]);
    expect(ctx.captureCharFrame()).not.toContain("Unknown command");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("honors a keybinding override", async () => {
    const test = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
    let aborts = 0;
    const app = new TuiApp({
      header: "cletus test",
      theme: getTheme("dark", { preset: "unicode" }),
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

  it("matches clipboard keybindings without collapsing modifiers", () => {
    const bindings = new KeybindingsManager();
    expect(bindings.matches({ name: "c", super: true }, "copy")).toBe(true);
    expect(bindings.matches({ name: "v", super: true }, "paste")).toBe(true);
    expect(bindings.matches({ name: "v", ctrl: true, shift: true }, "paste")).toBe(true);
    // Ctrl+Shift+C is copy, not the Ctrl+C abort binding.
    expect(bindings.matches({ name: "c", ctrl: true, shift: true }, "copy")).toBe(true);
    expect(bindings.matches({ name: "c", ctrl: true, shift: true }, "abort")).toBe(false);
    // Capital letters still answer modals.
    expect(bindings.matches({ name: "y", shift: true }, "modalAllow")).toBe(true);
    // Modifier order in overrides is canonicalized.
    const reordered = new KeybindingsManager({ copy: "shift+ctrl+x" });
    expect(reordered.matches({ name: "x", ctrl: true, shift: true }, "copy")).toBe(true);
  });

  it("falls back safely for prototype-key theme names", () => {
    const theme = getTheme("toString");
    expect(theme.name).toBe("dark");
    expect(theme.colors.inputBorder).toBeTruthy();
    const symbols = getTheme("dark", { preset: "constructor" as never, overrides: { toString: "x" } });
    expect(symbols.symbol("model")).toBe("\uf2db");
  });

  it("keeps the copy toast out of the transcript and hides it after 2s", async () => {
    const ctx = await setupApp();
    ctx.app.toast("Copied 9 chars");
    await ctx.flush();
    const lines = ctx.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Copied 9 chars"));
    expect(row).toBeGreaterThan(lines.length / 2);
    // Bottom-right float: the box hugs the frame's right edge.
    expect(lines[row]!.trimEnd().endsWith("│")).toBe(true);
    expect(lines[row]!.indexOf("╭")).toBe(-1);
    expect(lines[row]!.indexOf("│ Copied")).toBeGreaterThan(60);
    // It is a toast, not a transcript notice.
    expect(ctx.captureCharFrame()).not.toContain("! Copied 9 chars");
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("Copied 9 chars");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("keeps the editor focused when transcript text is selected with the mouse", async () => {
    const test = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false, useMouse: true });
    const written: string[] = [];
    const clipboard = {
      read: async () => ({ status: "empty" }),
      writeText: async (text: string) => {
        written.push(text);
        return { host: { status: "written" }, terminal: { status: "not-attempted" } };
      },
      clear: async () => ({ host: { status: "written" }, terminal: { status: "not-attempted" } }),
      dispose: async () => undefined,
    } as unknown as ClipboardService;
    const app = new TuiApp({
      header: "cletus test",
      theme: getTheme("dark", { preset: "unicode" }),
      keybindings: new KeybindingsManager({}),
      submit: async () => undefined,
      abort: () => undefined,
      commands: [],
      history: [],
      renderer: test.renderer,
      clipboard,
    });
    await app.start();
    app.appendBlock({ id: "u1", kind: "user", text: "hello selection world" });
    await test.flush();
    await test.mockMouse.pressDown(3, 0, 0);
    await test.flush();
    await test.mockMouse.moveTo(20, 0);
    await test.flush();
    await test.mockMouse.release(20, 0, 0);
    await test.flush();
    expect(written).toEqual(["hello selection wo"]);
    // Selecting must not leave focus on the transcript box, or typing is lost.
    expect(test.renderer.currentFocusedRenderable?.id).toBe("editor");
    test.mockInput.typeText("zz");
    await test.flush();
    expect(test.captureCharFrame()).toContain("zz");
    app.stop();
    await test.dispose();
  });

  it("switches symbol presets", async () => {
    const ctx = await setupApp();
    const ascii = getTheme("dark", {
      preset: "ascii",
      overrides: { ready: "OK" },
    });
    expect(getTheme("dark").symbol("model")).toBe("\uf2db");
    expect(ascii.symbol("model")).toBe("M");
    expect(ascii.symbol("ready")).toBe("OK");
    ctx.app.setTheme(ascii);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("OK");
    ctx.app.stop();
    await ctx.dispose();
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
    expect(ctx.captureCharFrame()).toContain("▤ 12.4k/128k 10%");
    ctx.app.setStatus({
      busy: false,
      model: "openai/fake",
      tokens: "",
      queue: 0,
      context: "12.4k/128k 10%",
      duration: "1.2s",
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("1.2s");
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

  it("filters managed items by typed letters and still cycles state", async () => {
    const ctx = await setupApp();
    const changes: Array<[string, string]> = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [
          { id: "review", label: "review · personal", state: "on", states: ["on", "off"] },
          { id: "pdf", label: "pdf · personal", state: "on", states: ["on", "off"] },
          { id: "PDFKit", label: "PDFKit · personal", state: "on", states: ["on", "off"] },
        ],
        onCycle: (id, state) => {
          changes.push([id, state]);
        },
      },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[on] review");

    ctx.mockInput.typeText("PDF");
    await ctx.flush();
    const filtered = ctx.captureCharFrame();
    expect(filtered).toContain("/PDF");
    expect(filtered).toContain("[on] PDFKit");
    expect(filtered).not.toContain("review");

    ctx.mockInput.pressBackspace();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("/PD");

    ctx.mockInput.typeText("F");
    await ctx.flush();
    ctx.mockInput.pressArrow("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("› [on] PDFKit");

    ctx.mockInput.typeText(" ");
    await ctx.flush();
    expect(changes).toEqual([["PDFKit", "off"]]);

    ctx.mockInput.typeText("zzz");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("no matches");
    expect(ctx.captureCharFrame()).toContain("0/3");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    const cleared = ctx.captureCharFrame();
    expect(cleared).toContain("3/3");
    expect(cleared).not.toContain("/zzz");
    expect(cleared).toContain("[on] review");
    expect(cleared).toContain("[off] PDFKit");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("collects input from the prompt modal", async () => {
    const ctx = await setupApp();
    const input = ctx.app.promptInput("Search skills", "query");
    await ctx.flush();
    ctx.mockInput.typeText("pdf");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    await expect(input).resolves.toBe("pdf");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("closes the manager with Escape", async () => {
    const ctx = await setupApp();
    const manager = ctx.app.manageTabs("Skills", [
      { kind: "list", id: "skills", title: "Skills", items: [], onCycle: () => undefined },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");
    ctx.mockInput.pressEscape();
    await ctx.flush();
    await expect(manager).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("shows a live spinner and elapsed time for running tools", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "tool-running",
      kind: "tool",
      name: "bash",
      argsSummary: "sleep 2",
      output: "",
      isError: false,
      expanded: false,
      status: "running",
      startedAt: Date.now() - 1200,
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("1.2s");
    ctx.app.updateBlock("tool-running", {
      kind: "tool",
      status: "success",
      output: "done",
      duration: "1.3s",
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("1.3s");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("animates a progress bar while a progress block is running and settles on done", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "compact-1",
      kind: "progress",
      label: "Compacting context",
      status: "running",
      startedAt: Date.now(),
    });
    await ctx.flush();
    const first = ctx.captureCharFrame();
    expect(first).toContain("Compacting context");
    // Indeterminate bar: 24 cells, 6 filled, bouncing.
    expect(first).toContain("█".repeat(6));
    expect(first).toContain("░".repeat(18));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ctx.flush();
    const moved = ctx.captureCharFrame();
    expect(moved).toContain("█".repeat(6));
    // The bar must actually move, not render a static strip.
    const barOf = (frame: string): string =>
      frame.split("\n").find((line) => line.includes("█")) ?? "";
    expect(barOf(moved)).not.toBe(barOf(first));
    ctx.app.updateBlock("compact-1", { kind: "progress", status: "done", detail: "38k → 24k" });
    await ctx.flush();
    const done = ctx.captureCharFrame();
    expect(done).toContain("Compacting context");
    expect(done).toContain("38k → 24k");
    expect(done).not.toContain("░");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("renders a failed progress block as an error without a bar", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "compact-err",
      kind: "progress",
      label: "Compacting context",
      status: "running",
    });
    await ctx.flush();
    ctx.app.updateBlock("compact-err", {
      kind: "progress",
      status: "error",
      detail: "Compaction failed: empty summary",
    });
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    expect(frame).toContain("Compaction failed: empty summary");
    expect(frame).not.toContain("░");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("previews collapsed tool output and expands on toggle", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "tool-preview",
      kind: "tool",
      name: "bash",
      argsSummary: "npm test",
      output: "line one\nline two",
      isError: false,
      expanded: false,
    });
    await ctx.flush();
    let frame = ctx.captureCharFrame();
    expect(frame).toContain("✓ bash");
    expect(frame).toContain("→ line one");
    expect(frame).not.toContain("line two");
    ctx.app.updateBlock("tool-preview", { expanded: true });
    await ctx.flush();
    frame = ctx.captureCharFrame();
    expect(frame).toContain("line two");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("expands tool output in verbose mode", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "verbose-tool",
      kind: "tool",
      name: "bash",
      argsSummary: "npm test",
      output: "line one\nline two",
      isError: false,
      expanded: false,
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("line two");
    ctx.app.setVerbose(true);
    await ctx.flush();
    let frame = ctx.captureCharFrame();
    expect(frame).toContain("line two");
    expect(frame).toContain("verbose");
    ctx.app.setVerbose(false);
    await ctx.flush();
    frame = ctx.captureCharFrame();
    expect(frame).not.toContain("line two");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("shows and hides thinking content", async () => {
    const ctx = await setupApp();
    ctx.app.appendBlock({
      id: "thinking-1",
      kind: "assistant",
      text: "Answer",
      thinking: "Reasoning about the answer",
    });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("Reasoning about the answer");
    ctx.app.setShowThinking(false);
    await ctx.flush();
    expect(ctx.captureCharFrame()).not.toContain("Reasoning about the answer");
    ctx.app.setShowThinking(true);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("Reasoning about the answer");
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

  it("navigates input history with Up and Down and restores the draft", async () => {
    const ctx = await setupApp();
    ctx.mockInput.typeText("first prompt");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    ctx.mockInput.typeText("second prompt");
    ctx.mockInput.pressEnter();
    await ctx.flush();

    ctx.mockInput.typeText("draft");
    ctx.mockInput.pressKey("up");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("second prompt");
    ctx.mockInput.pressKey("up");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("first prompt");
    ctx.mockInput.pressKey("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("second prompt");
    ctx.mockInput.pressKey("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("draft");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("attaches pasted image, inserts placeholder, and sends images with submit", async () => {
    const att: ImageAttachment = { mediaType: "image/png", path: "/tmp/a.png" };
    const ctx = await setupImageApp({
      mimeType: "image/png",
      bytes: new Uint8Array([0x89, 0x50]),
      attach: async () => att,
    });
    ctx.mockInput.pressKey("v", { ctrl: true });
    await ctx.flush();
    expect(ctx.attachCalls).toHaveLength(1);
    expect(ctx.captureCharFrame()).toContain("[图片 #1]");
    ctx.mockInput.typeText(" analyze");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions).toEqual([{ text: "[图片 #1] analyze", images: [att] }]);
    ctx.mockInput.typeText("next");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions[1]).toEqual({ text: "next" });
    ctx.app.stop();
    await ctx.dispose();
  });

  it("rejects oversize images with a warning and no placeholder", async () => {
    const ctx = await setupImageApp({
      mimeType: "image/png",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
    });
    ctx.mockInput.pressKey("v", { ctrl: true });
    await ctx.flush();
    expect(ctx.attachCalls).toHaveLength(0);
    expect(ctx.captureCharFrame()).toContain("5MB");
    expect(ctx.captureCharFrame()).not.toContain("[图片 #1]");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("clears pending images when input is cleared with ctrl+c", async () => {
    const ctx = await setupImageApp({ mimeType: "image/png", bytes: new Uint8Array([1]) });
    ctx.mockInput.pressKey("v", { ctrl: true });
    await ctx.flush();
    expect(ctx.attachCalls).toHaveLength(1);
    ctx.mockInput.pressCtrlC();
    await ctx.flush();
    ctx.mockInput.typeText("y");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions).toEqual([{ text: "y" }]);
    ctx.app.stop();
    await ctx.dispose();
  });

  it("clears pending images when input is cancelled", async () => {
    const ctx = await setupImageApp({ mimeType: "image/png", bytes: new Uint8Array([1]) });
    ctx.mockInput.pressKey("v", { ctrl: true });
    await ctx.flush();
    expect(ctx.attachCalls).toHaveLength(1);
    ctx.mockInput.pressEscape();
    // The stdin parser holds a lone ESC for ~20ms to disambiguate sequences.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await ctx.flush();
    ctx.mockInput.typeText("x");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.submissions).toEqual([{ text: "x" }]);
    ctx.app.stop();
    await ctx.dispose();
  });

  it("keeps plain-text paste behavior", async () => {
    const ctx = await setupImageApp({
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("pasted text"),
    });
    ctx.mockInput.pressKey("v", { ctrl: true });
    await ctx.flush();
    expect(ctx.attachCalls).toHaveLength(0);
    expect(ctx.captureCharFrame()).toContain("pasted text");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("switches manager tabs with Tab and exits Escape layer by layer", async () => {
    const ctx = await setupApp();
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [{ id: "review", label: "review · personal", state: "on", states: ["on", "off"] }],
        onCycle: () => undefined,
      },
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf, testing",
        search: async () => [],
        onAccept: () => undefined,
      },
      {
        kind: "prompt",
        id: "install",
        title: "Install",
        placeholder: "owner/repo#skill",
        onSubmit: () => undefined,
      },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");

    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Search]");

    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Install]");

    ctx.mockInput.pressKey(KeyCodes.TAB, { shift: true });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");
    expect(ctx.captureCharFrame()).not.toContain("[Search]");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("searches as you type and installs the selected result", async () => {
    const ctx = await setupApp();
    const queries: string[] = [];
    const accepted: string[] = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf, testing",
        search: async (query) => {
          queries.push(query);
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (query.toLowerCase() === "pdf") {
            return [
              { id: "a/skills/pdf", label: "pdf · a/skills · 120 installs" },
              { id: "b/skills/pdfpro", label: "pdfpro · b/skills · 30 installs" },
            ];
          }
          return [];
        },
        onAccept: (result) => {
          accepted.push(result.id);
        },
      },
    ]);
    await ctx.flush();

    ctx.mockInput.typeText("pdf");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ctx.flush();
    expect(queries.at(-1)).toBe("pdf");
    expect(ctx.captureCharFrame()).toContain("pdf · a/skills");

    ctx.mockInput.pressArrow("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("› pdfpro · b/skills");

    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(accepted).toEqual(["b/skills/pdfpro"]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("keeps the search tab open when the registry errors", async () => {
    const ctx = await setupApp();
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf",
        search: async () => {
          throw new Error("skills.sh returned 500");
        },
        onAccept: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.typeText("pdf");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("skills.sh returned 500");
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("ignores results from aborted searches", async () => {
    const ctx = await setupApp();
    const settled: string[] = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf",
        search: async (query, signal) => {
          await new Promise((resolve) => setTimeout(resolve, query === "p" ? 120 : 5));
          if (signal.aborted) {
            settled.push(`aborted:${query}`);
            return [{ id: "stale", label: "stale result" }];
          }
          settled.push(`fresh:${query}`);
          return [{ id: "fresh", label: "fresh result" }];
        },
        onAccept: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.typeText("p");
    await new Promise((resolve) => setTimeout(resolve, 300));
    ctx.mockInput.typeText("d");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.flush();
    expect(settled).toContain("aborted:p");
    expect(ctx.captureCharFrame()).toContain("fresh result");
    expect(ctx.captureCharFrame()).not.toContain("stale result");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("answers a confirm opened from a manager tab", async () => {
    const ctx = await setupApp();
    let decision: string | undefined;
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "query",
        search: async () => [{ id: "a/b/c", label: "c · a/b" }],
        onAccept: async () => {
          decision = await ctx.app.confirm("Install skill", "a/b · c\n\nInstall globally?");
        },
      },
    ]);
    await ctx.flush();
    await ctx.mockInput.typeText("c");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await ctx.flush();
    ctx.resize(120, 58);
    await ctx.flush();
    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[y] allow once");

    ctx.mockInput.pressKey("y");
    await ctx.flush();
    expect(decision).toBe("allow");
    expect(ctx.captureCharFrame()).not.toContain("[y] allow once");
    // The popup survives the confirm and is still usable.
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("denies a confirm opened from a manager tab without losing the popup", async () => {
    const ctx = await setupApp();
    let decision: string | undefined;
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "query",
        search: async () => [{ id: "a/b/c", label: "c · a/b" }],
        onAccept: async () => {
          decision = await ctx.app.confirm("Install skill", "a/b · c");
        },
      },
    ]);
    await ctx.flush();
    ctx.mockInput.typeText("c");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await ctx.flush();
    ctx.mockInput.pressEnter();
    await ctx.flush();
    ctx.mockInput.pressKey("n");
    await ctx.flush();
    expect(decision).toBe("deny");
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("refreshes the list tab when returning to it", async () => {
    const ctx = await setupApp();
    let refreshes = 0;
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [{ id: "review", label: "review · personal", state: "on", states: ["on", "off"] }],
        refresh: async () => {
          refreshes += 1;
          return [
            { id: "review", label: "review · personal", state: "on", states: ["on", "off"] },
            { id: "fresh", label: "fresh · personal", state: "on", states: ["on", "off"] },
          ];
        },
        onCycle: () => undefined,
      },
      {
        kind: "prompt",
        id: "install",
        title: "Install",
        placeholder: "owner/repo#skill",
        onSubmit: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.pressTab();
    await ctx.flush();
    ctx.mockInput.pressTab();
    await ctx.flush();
    const refreshed = ctx.waitFor(() => ctx.captureCharFrame().includes("fresh · personal"));
    await refreshed;
    expect(refreshes).toBe(1);
    expect(ctx.captureCharFrame()).toContain("2/2");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("refreshes the list when Escape returns to it", async () => {
    const ctx = await setupApp();
    let refreshes = 0;
    const base = [{ id: "review", label: "review · personal", state: "on", states: ["on", "off"] }];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: base,
        refresh: async () => {
          refreshes += 1;
          return [...base, { id: "fresh", label: "fresh · personal", state: "on", states: ["on", "off"] }];
        },
        onCycle: () => undefined,
      },
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "query",
        search: async () => [],
        onAccept: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.waitFor(() => ctx.captureCharFrame().includes("fresh · personal"));
    expect(refreshes).toBe(1);
    expect(ctx.captureCharFrame()).toContain("[Skills]");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });

  it("keeps the list filter across a tab round trip", async () => {
    const ctx = await setupApp();
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [
          { id: "review", label: "review · personal", state: "on", states: ["on", "off"] },
          { id: "pdf", label: "pdf · personal", state: "on", states: ["on", "off"] },
        ],
        onCycle: () => undefined,
      },
      {
        kind: "prompt",
        id: "install",
        title: "Install",
        placeholder: "owner/repo#skill",
        onSubmit: () => undefined,
      },
    ]);
    await ctx.flush();
    await ctx.mockInput.typeText("pdf");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("/pdf");
    expect(ctx.captureCharFrame()).toContain("1/2");

    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Install]");

    ctx.mockInput.pressTab();
    await ctx.flush();
    const frame = ctx.captureCharFrame();
    expect(frame).toContain("[Skills]");
    expect(frame).toContain("/pdf");
    expect(frame).toContain("1/2");
    expect(frame).not.toContain("review");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    // First Esc clears the filter, second closes.
    const cleared = ctx.captureCharFrame();
    expect(cleared).toContain("2/2");
    expect(cleared).not.toContain("/pdf");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
});

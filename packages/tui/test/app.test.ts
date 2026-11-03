import { describe, expect, it } from "vitest";
import { TuiApp, type SlashCommand } from "../src/app.js";
import { KeybindingsManager } from "../src/keybindings.js";
import { getTheme } from "../src/theme.js";
import type { Terminal } from "../src/terminal.js";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  width = 100;
  height = 30;
  isTTY = true;
  private input: ((data: string) => void) | undefined;
  write(data: string): void {
    this.writes.push(data);
  }
  onInput(listener: (data: string) => void): () => void {
    this.input = listener;
    return () => {
      this.input = undefined;
    };
  }
  onResize(): () => void {
    return () => undefined;
  }
  start(): void {}
  stop(): void {}
  feed(data: string): void {
    this.input?.(data);
  }
}

function makeApp(terminal: FakeTerminal, overrides: Record<string, string | string[]> = {}) {
  const submissions: string[] = [];
  const commands: SlashCommand[] = [
    { name: "test", description: "test command", run: () => undefined },
  ];
  const app = new TuiApp(terminal, {
    header: "cletus test",
    theme: getTheme("dark"),
    keybindings: new KeybindingsManager(overrides),
    submit: async (text) => {
      submissions.push(text);
    },
    abort: () => undefined,
    confirm: async () => "deny",
    commands,
    history: [],
  });
  return { app, submissions };
}

describe("TuiApp", () => {
  it("submits editor input on Enter", () => {
    const terminal = new FakeTerminal();
    const { app, submissions } = makeApp(terminal);
    app.start();
    terminal.feed("hello");
    terminal.feed("\r");
    expect(submissions).toEqual(["hello"]);
    app.stop();
  });

  it("resolves the permission modal with y", async () => {
    const terminal = new FakeTerminal();
    const { app } = makeApp(terminal);
    app.start();
    const decision = app.confirm("Permission", "Write a.txt");
    terminal.feed("y");
    await expect(decision).resolves.toBe("allow");
    app.stop();
  });

  it("notifies unknown slash commands", () => {
    const terminal = new FakeTerminal();
    const { app } = makeApp(terminal);
    app.start();
    terminal.feed("/nope");
    terminal.feed("\r");
    expect(terminal.writes.join("")).toContain("Unknown command: /nope");
    app.stop();
  });

  it("honors a keybinding override", () => {
    const terminal = new FakeTerminal();
    let aborts = 0;
    const keys = new KeybindingsManager({ abort: "ctrl+x" });
    const app = new TuiApp(terminal, {
      header: "cletus test",
      theme: getTheme("dark"),
      keybindings: keys,
      submit: async () => undefined,
      abort: () => {
        aborts += 1;
      },
      confirm: async () => "deny",
      commands: [],
      history: [],
    });
    app.setStatus({ busy: true, model: "m", tokens: "", queue: 0 });
    app.start();
    terminal.feed("\x03");
    expect(aborts).toBe(0);
    terminal.feed("\x18");
    expect(aborts).toBe(1);
    app.stop();
  });

  it("switches theme and reports keybinding conflicts", () => {
    const terminal = new FakeTerminal();
    const { app } = makeApp(terminal);
    app.start();
    terminal.writes = [];
    app.setTheme(getTheme("light"));
    expect(terminal.writes.join("")).toContain("\x1b[38;5;245m");
    expect(() => new KeybindingsManager({ abort: "enter" })).toThrow(
      "Keybinding conflict: enter is bound to submit and abort",
    );
    app.stop();
  });

  it("shows help for slash commands", () => {
    const terminal = new FakeTerminal();
    const { app } = makeApp(terminal);
    app.start();
    terminal.feed("/help");
    terminal.feed("\r");
    expect(terminal.writes.join("")).toContain("/test");
    app.stop();
  });
});
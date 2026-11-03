import type { Key } from "./keys.js";
import { InputParser } from "./keys.js";
import type { KeybindingsManager } from "./keybindings.js";
import type { Theme, ThemeToken } from "./theme.js";
import type { Terminal } from "./terminal.js";
import { Editor } from "./editor.js";
import { renderMarkdown } from "./markdown.js";
import { FrameRenderer } from "./renderer.js";

export type SlashCommand = {
  name: string;
  description: string;
  run: (args: string) => void | Promise<void>;
};

export type TuiAppOptions = {
  header: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  submit: (text: string) => Promise<void>;
  followUp?: (text: string) => void;
  abort: () => void;
  confirm: (title: string, message: string) => Promise<"allow" | "session" | "deny">;
  commands: SlashCommand[];
  history: string[];
  onExit?: () => void;
};

export type TranscriptBlock =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; thinking?: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      argsSummary: string;
      output: string;
      isError: boolean;
      expanded: boolean;
    }
  | { id: string; kind: "notice"; text: string; level: "info" | "warn" | "error" };

type SelectState = {
  title: string;
  items: Array<{ label: string; value: string }>;
  index: number;
  resolve: (value: string | undefined) => void;
};

type ModalState = {
  title: string;
  message: string;
  resolve: (value: "allow" | "session" | "deny") => void;
};

export class TuiApp {
  private readonly terminal: Terminal;
  private readonly options: TuiAppOptions;
  private readonly editor = new Editor();
  private readonly parser = new InputParser();
  private readonly renderer: FrameRenderer;
  private blocks: TranscriptBlock[] = [];
  private header: string;
  private theme: Theme;
  private status = { busy: false, model: "", tokens: "", queue: 0 };
  private scrollOffset = 0;
  private expandedAll = false;
  private historyIndex = 0;
  private completionIndex = 0;
  private modal: ModalState | undefined;
  private selectState: SelectState | undefined;
  private spinner = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private readonly unsubscribeInput: () => void;
  private readonly unsubscribeResize: () => void;
  private nextId = 0;

  constructor(terminal: Terminal, options: TuiAppOptions) {
    this.terminal = terminal;
    this.options = options;
    this.header = options.header;
    this.theme = options.theme;
    this.renderer = new FrameRenderer(terminal);
    this.unsubscribeInput = terminal.onInput((data) => this.handleData(data));
    this.unsubscribeResize = terminal.onResize(() => this.render());
  }

  private stopped = false;

  start(): void {
    this.terminal.start();
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.modal?.resolve("deny");
    this.modal = undefined;
    this.selectState?.resolve(undefined);
    this.selectState = undefined;
    this.unsubscribeInput();
    this.unsubscribeResize();
    this.terminal.stop();
    this.options.onExit?.();
  }

  appendBlock(block: TranscriptBlock): void {
    this.blocks.push(block);
    this.scrollOffset = 0;
    this.render();
  }

  updateBlock(id: string, patch: Partial<TranscriptBlock>): void {
    this.blocks = this.blocks.map((block) =>
      block.id === id ? ({ ...block, ...patch } as TranscriptBlock) : block,
    );
    this.render();
  }

  setStatus(status: { busy: boolean; model: string; tokens: string; queue: number }): void {
    this.status = status;
    if (status.busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinner = (this.spinner + 1) % 4;
        this.render();
      }, 200);
    } else if (!status.busy && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.render();
  }

  setHeader(header: string): void {
    this.header = header;
    this.render();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.render();
  }

  clearTranscript(): void {
    this.blocks = [];
    this.scrollOffset = 0;
    this.render();
  }

  notify(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.appendBlock({ id: `n${this.nextId++}`, kind: "notice", text, level });
  }

  getKeybindings(): KeybindingsManager {
    return this.options.keybindings;
  }

  confirm(title: string, message: string): Promise<"allow" | "session" | "deny"> {
    const state = Promise.withResolvers<"allow" | "session" | "deny">();
    this.modal = { title, message, resolve: state.resolve };
    this.render();
    return state.promise;
  }

  select(
    title: string,
    items: Array<{ label: string; value: string }>,
  ): Promise<string | undefined> {
    if (items.length === 0) {
      this.notify("Nothing to select", "warn");
      return Promise.resolve(undefined);
    }
    const state = Promise.withResolvers<string | undefined>();
    this.selectState = { title, items, index: 0, resolve: state.resolve };
    this.render();
    return state.promise;
  }

  private handleData(data: string): void {
    for (const key of this.parser.feed(data)) this.handleKey(key);
  }

  private handleKey(key: Key): void {
    if (this.modal) {
      if (this.options.keybindings.matches(key, "modalAllow")) this.finishModal("allow");
      else if (this.options.keybindings.matches(key, "modalSession")) this.finishModal("session");
      else if (
        this.options.keybindings.matches(key, "modalDeny") ||
        this.options.keybindings.matches(key, "cancel")
      ) {
        this.finishModal("deny");
      }
      return;
    }
    if (this.selectState) {
      const state = this.selectState;
      if (key.name === "up") state.index = Math.max(0, state.index - 1);
      else if (key.name === "down") state.index = Math.min(state.items.length - 1, state.index + 1);
      else if (key.name === "enter") {
        this.selectState = undefined;
        state.resolve(state.items[state.index]?.value);
      } else if (key.name === "esc") {
        this.selectState = undefined;
        state.resolve(undefined);
      }
      this.render();
      return;
    }

    const bindings = this.options.keybindings;
    if (bindings.matches(key, "abort")) {
      if (this.status.busy) this.options.abort();
      else if (this.editor.value.length === 0) this.stop();
      else this.editor.setValue("");
      this.render();
      return;
    }
    if (bindings.matches(key, "exit")) {
      if (this.editor.value.length === 0) this.stop();
      return;
    }
    if (bindings.matches(key, "cancel")) {
      if (this.status.busy) this.options.abort();
      else this.editor.setValue("");
      this.render();
      return;
    }
    if (bindings.matches(key, "followUp")) {
      const text = this.editor.value.trim();
      if (text && this.status.busy) {
        this.options.followUp?.(text);
        this.editor.setValue("");
        this.render();
        return;
      }
    }
    if (bindings.matches(key, "scrollUp")) {
      this.scrollOffset += 10;
      this.render();
      return;
    }
    if (bindings.matches(key, "scrollDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.render();
      return;
    }
    if (bindings.matches(key, "scrollBottom")) {
      this.scrollOffset = 0;
      this.render();
      return;
    }
    if (bindings.matches(key, "toggleToolOutput")) {
      this.expandedAll = !this.expandedAll;
      this.blocks = this.blocks.map((block) =>
        block.kind === "tool" ? { ...block, expanded: this.expandedAll } : block,
      );
      this.render();
      return;
    }
    if (bindings.matches(key, "complete")) {
      this.completeCommand();
      return;
    }
    if (bindings.matches(key, "historyPrev")) {
      if (this.editor.value.length === 0 && this.options.history.length > 0) {
        this.historyIndex = Math.min(
          this.options.history.length - 1,
          this.historyIndex + 1,
        );
        this.editor.setValue(
          this.options.history[this.options.history.length - 1 - this.historyIndex] ?? "",
        );
        this.render();
        return;
      }
    }
    if (bindings.matches(key, "historyNext")) {
      if (this.editor.value.length === 0 && this.historyIndex > 0) {
        this.historyIndex -= 1;
        this.editor.setValue(
          this.options.history[this.options.history.length - 1 - this.historyIndex] ?? "",
        );
        this.render();
        return;
      }
    }

    const result = this.editor.handle(key, bindings);
    if (result === "submit") {
      this.submitEditor();
    } else if (result === "changed") {
      this.render();
    }
  }

  private submitEditor(): void {
    const text = this.editor.value.trim();
    if (!text) return;
    this.editor.setValue("");
    this.historyIndex = 0;
    if (text.startsWith("/")) {
      this.runCommand(text);
      return;
    }
    this.options.history.push(text);
    this.appendBlock({ id: `u${this.nextId++}`, kind: "user", text });
    void this.options.submit(text).catch((error: unknown) => {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    });
  }

  private completeCommand(): void {
    if (!this.editor.value.startsWith("/") || this.editor.value.includes(" ")) return;
    const query = this.editor.value.slice(1);
    const matches = this.options.commands
      .filter((command) => command.name.startsWith(query))
      .map((command) => command.name);
    if (matches.length === 0) return;
    const name = matches[this.completionIndex % matches.length] ?? matches[0];
    this.completionIndex += 1;
    if (name) this.editor.setValue(`/${name} `);
    this.render();
  }

  private runCommand(text: string): void {
    const body = text.slice(1);
    const space = body.indexOf(" ");
    const name = space < 0 ? body : body.slice(0, space);
    const args = space < 0 ? "" : body.slice(space + 1).trim();
    if (name === "help") {
      const lines = this.options.commands
        .map((command) => `/${command.name}  ${command.description}`)
        .join("\n");
      this.notify(lines || "No commands", "info");
      this.render();
      return;
    }
    const command = this.options.commands.find((candidate) => candidate.name === name);
    if (!command) {
      this.notify(`Unknown command: /${name}`, "warn");
      this.render();
      return;
    }
    void Promise.resolve(command.run(args)).catch((error: unknown) => {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    });
  }

  private finishModal(decision: "allow" | "session" | "deny"): void {
    const modal = this.modal;
    this.modal = undefined;
    modal?.resolve(decision);
    this.render();
  }

  private render(): void {
    const width = this.terminal.width;
    const height = this.terminal.height;
    if (width < 40 || height < 12) {
      this.renderer.render([`Terminal too small: ${width}x${height}`]);
      return;
    }
    const lines: string[] = [this.header];
    const transcriptRows = height - 5;
    const transcript = this.renderTranscript(width);
    const start = Math.max(0, transcript.length - transcriptRows - this.scrollOffset);
    for (const line of transcript.slice(start, start + transcriptRows)) lines.push(line);
    while (lines.length < 1 + transcriptRows) lines.push("");

    const editor = this.editor.render(width - 2, 3);
    for (const line of editor.lines) lines.push(line);

    const footer = this.footer(width);
    lines.push(footer);

    let cursor: { row: number; col: number } | undefined = {
      row: 1 + transcriptRows + editor.row,
      col: 2 + editor.col,
    };

    if (this.modal) {
      const overlay = this.renderModal(width);
      const startRow = height - overlay.length;
      for (let index = 0; index < overlay.length; index += 1) {
        lines[startRow + index] = overlay[index] ?? "";
      }
      cursor = undefined;
    } else if (this.selectState) {
      const overlay = this.renderSelect(width);
      const startRow = height - overlay.length;
      for (let index = 0; index < overlay.length; index += 1) {
        lines[startRow + index] = overlay[index] ?? "";
      }
      cursor = undefined;
    }

    this.renderer.render(lines.slice(0, height), cursor);
  }

  private renderTranscript(width: number): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      if (block.kind === "user") {
        const wrapped = block.text.split("\n").flatMap((line) =>
          line.match(/.{1,80}/gu) ?? [line],
        );
        const prefix = this.theme.style("user", "› ");
        wrapped.forEach((line, index) => {
          lines.push(`${index === 0 ? prefix : "  "}${this.theme.style("user", line)}`);
        });
      } else if (block.kind === "assistant") {
        lines.push(...renderMarkdown(block.text, width - 2, this.theme));
      } else if (block.kind === "tool") {
        const color: ThemeToken = block.isError ? "error" : "tool";
        lines.push(this.theme.style(color, `[${block.name}] ${block.argsSummary}`));
        if (block.expanded) {
          const output = block.output.split("\n").slice(0, 20);
          for (const line of output) lines.push(this.theme.style("muted", `  ${line}`));
        }
      } else {
        const color: ThemeToken =
          block.level === "error" ? "error" : block.level === "warn" ? "warning" : "muted";
        lines.push(this.theme.style(color, `! ${block.text}`));
      }
    }
    return lines;
  }

  private footer(width: number): string {
    const bindings = this.options.keybindings;
    const parts = [
      `${bindings.get("submit")[0]} send`,
      `${bindings.get("newline")[0]} newline`,
      `${bindings.get("abort")[0]} abort`,
      "/help",
    ];
    if (this.status.busy) {
      parts.unshift(`${["⠋", "⠙", "⠹", "⠸"][this.spinner] ?? "⠋"} working`);
      parts.push(`${bindings.get("cancel")[0]} to abort`);
    }
    if (this.status.queue > 0) parts.push(`${this.status.queue} queued`);
    const text = parts.join(" · ");
    return this.theme.style("muted", text.slice(0, width));
  }

  private renderModal(width: number): string[] {
    const modal = this.modal;
    if (!modal) return [];
    const bindings = this.options.keybindings;
    const lines = [
      this.theme.style("warning", modal.title),
      ...modal.message.slice(0, 300).split("\n"),
      this.theme.style(
        "muted",
        `[${bindings.get("modalAllow")[0]}] allow once  [${bindings.get("modalSession")[0]}] allow for session  [${bindings.get("modalDeny")[0]}] deny`,
      ),
    ];
    return lines.map((line) => line.slice(0, width));
  }

  private renderSelect(width: number): string[] {
    const state = this.selectState;
    if (!state) return [];
    const lines = [this.theme.style("accent", state.title)];
    const start = Math.max(0, Math.min(state.index - 3, state.items.length - 6));
    for (let index = start; index < Math.min(state.items.length, start + 6); index += 1) {
      const item = state.items[index];
      if (!item) continue;
      const marker = index === state.index ? "› " : "  ";
      lines.push(
        index === state.index
          ? this.theme.style("accent", `${marker}${item.label}`)
          : `${marker}${item.label}`,
      );
    }
    lines.push(this.theme.style("muted", "Enter select · Esc cancel"));
    return lines.map((line) => line.slice(0, width));
  }
}
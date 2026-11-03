import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { KeybindingsManager } from "./keybindings.js";
import type { Theme, ThemeToken } from "./theme.js";

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
  commands: SlashCommand[];
  history: string[];
  onExit?: () => void;
  /** Test seam: use a pre-created renderer instead of taking over the terminal. */
  renderer?: CliRenderer;
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

type BlockView =
  | { kind: "user"; box: BoxRenderable; text: TextRenderable }
  | { kind: "assistant"; box: BoxRenderable; markdown: MarkdownRenderable }
  | {
      kind: "tool";
      box: BoxRenderable;
      title: TextRenderable;
      args: TextRenderable;
      output: TextRenderable;
    }
  | { kind: "notice"; box: BoxRenderable; text: TextRenderable };

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

const SPINNER = ["⠋", "⠙", "⠹", "⠸"];

export class TuiApp {
  private readonly options: TuiAppOptions;
  private readonly history: string[];
  private renderer: CliRenderer | undefined;
  private ownsRenderer = true;
  private root: BoxRenderable | undefined;
  private headerText: TextRenderable | undefined;
  private headerBox: BoxRenderable | undefined;
  private scrollbox: ScrollBoxRenderable | undefined;
  private editorBox: BoxRenderable | undefined;
  private textarea: TextareaRenderable | undefined;
  private footerText: TextRenderable | undefined;
  private modalBox: BoxRenderable | undefined;
  private selectBox: BoxRenderable | undefined;
  private syntaxStyle: SyntaxStyle | undefined;
  private theme: Theme;
  private header: string;
  private status = { busy: false, model: "", tokens: "", queue: 0 };
  private spinner = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private readonly blocks = new Map<string, TranscriptBlock>();
  private readonly order: string[] = [];
  private readonly views = new Map<string, BlockView>();
  private modal: ModalState | undefined;
  private selectState: SelectState | undefined;
  private historyIndex = 0;
  private completionIndex = 0;
  private expandedAll = false;
  private started = false;
  private stopped = false;

  constructor(options: TuiAppOptions) {
    this.options = options;
    this.theme = options.theme;
    this.header = options.header;
    this.history = options.history;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.renderer =
      this.options.renderer ??
      (await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        backgroundColor: this.theme.background,
        clearOnShutdown: true,
      }));
    this.ownsRenderer = !this.options.renderer;
    this.renderer.setBackgroundColor(this.theme.background);
    this.syntaxStyle = this.createSyntaxStyle();

    this.root = new BoxRenderable(this.renderer, {
      id: "cletus-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: this.theme.background,
    });
    this.renderer.root.add(this.root);

    const headerBox = new BoxRenderable(this.renderer, {
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: this.theme.background,
    });
    this.headerText = new TextRenderable(this.renderer, {
      content: this.header,
      fg: this.theme.colors.accent,
      wrapMode: "none",
      truncate: true,
      height: 1,
    });
    this.headerBox = headerBox;
    headerBox.add(this.headerText);
    this.root.add(headerBox);

    this.scrollbox = new ScrollBoxRenderable(this.renderer, {
      id: "transcript",
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 0,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 1,
      paddingRight: 1,
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: this.theme.colors.border,
          backgroundColor: this.theme.background,
        },
      },
    });
    this.root.add(this.scrollbox);

    this.editorBox = new BoxRenderable(this.renderer, {
      height: 5,
      flexShrink: 0,
      marginX: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: this.theme.colors.border,
      title: " message ",
      titleColor: this.theme.colors.muted,
      paddingX: 1,
      backgroundColor: this.theme.background,
    });
    this.textarea = new TextareaRenderable(this.renderer, {
      id: "editor",
      width: "100%",
      height: 3,
      placeholder: "Ask cletus to change code, run tests, or explain the repo…",
      placeholderColor: this.theme.colors.muted,
      backgroundColor: this.theme.background,
      textColor: this.theme.colors.fg,
      focusedBackgroundColor: this.theme.background,
      focusedTextColor: this.theme.colors.fg,
      cursorColor: this.theme.colors.accent,
      keyBindings: [{ name: "return", shift: true, action: "newline" }],
      onSubmit: () => this.onTextareaSubmit(),
    });
    this.editorBox.add(this.textarea);
    this.root.add(this.editorBox);

    this.footerText = new TextRenderable(this.renderer, {
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      fg: this.theme.colors.muted,
      wrapMode: "none",
      truncate: true,
      content: this.footerContent(),
    });
    this.root.add(this.footerText);

    this.renderer.keyInput.on("keypress", this.handleKey);
    this.textarea.focus();
    this.rebuildBlocks();
    this.renderer.requestRender();
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
    this.renderer?.keyInput.off("keypress", this.handleKey);
    if (this.ownsRenderer) this.renderer?.destroy();
    this.options.onExit?.();
  }

  appendBlock(block: TranscriptBlock): void {
    this.blocks.set(block.id, block);
    this.order.push(block.id);
    this.addView(block);
  }

  updateBlock(id: string, patch: Partial<TranscriptBlock>): void {
    const current = this.blocks.get(id);
    if (!current) return;
    const next = { ...current, ...patch } as TranscriptBlock;
    this.blocks.set(id, next);
    this.updateView(next);
  }

  setStatus(status: { busy: boolean; model: string; tokens: string; queue: number }): void {
    this.status = status;
    if (status.busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinner = (this.spinner + 1) % SPINNER.length;
        this.updateFooter();
      }, 200);
    } else if (!status.busy) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.updateFooter();
  }

  setHeader(header: string): void {
    this.header = header;
    if (this.headerText) this.headerText.content = header;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    if (!this.renderer) return;
    this.renderer.setBackgroundColor(theme.background);
    if (this.root) this.root.backgroundColor = theme.background;
    if (this.headerText) this.headerText.fg = theme.colors.accent;
    if (this.headerBox) this.headerBox.backgroundColor = theme.background;
    if (this.footerText) this.footerText.fg = theme.colors.muted;
    if (this.editorBox) {
      this.editorBox.backgroundColor = theme.background;
      this.editorBox.borderColor = theme.colors.border;
      this.editorBox.titleColor = theme.colors.muted;
    }
    if (this.textarea) {
      this.textarea.backgroundColor = theme.background;
      this.textarea.textColor = theme.colors.fg;
      this.textarea.focusedBackgroundColor = theme.background;
      this.textarea.focusedTextColor = theme.colors.fg;
      this.textarea.cursorColor = theme.colors.accent;
      this.textarea.placeholderColor = theme.colors.muted;
    }
    this.syntaxStyle = this.createSyntaxStyle();
    if (this.scrollbox) {
      for (const view of this.views.values()) view.box.destroyRecursively();
      this.views.clear();
      this.rebuildBlocks();
    }
    if (this.modal) this.renderModal();
    if (this.selectState) this.renderSelect();
    this.renderer.requestRender();
  }

  clearTranscript(): void {
    for (const view of this.views.values()) view.box.destroyRecursively();
    this.views.clear();
    this.blocks.clear();
    this.order.length = 0;
    this.scrollbox?.scrollTo(0);
  }

  getKeybindings(): KeybindingsManager {
    return this.options.keybindings;
  }

  notify(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.appendBlock({ id: `notice-${Date.now()}-${this.order.length}`, kind: "notice", text, level });
  }

  confirm(title: string, message: string): Promise<"allow" | "session" | "deny"> {
    this.modal?.resolve("deny");
    const state = Promise.withResolvers<"allow" | "session" | "deny">();
    this.modal = { title, message, resolve: state.resolve };
    this.renderModal();
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
    this.selectState?.resolve(undefined);
    const state = Promise.withResolvers<string | undefined>();
    this.selectState = { title, items, index: 0, resolve: state.resolve };
    this.renderSelect();
    return state.promise;
  }

  private createSyntaxStyle(): SyntaxStyle {
    const c = this.theme.colors;
    return SyntaxStyle.fromStyles(
      {
        default: { fg: c.fg },
        "markup.heading": { fg: c.accent, bold: true },
        "markup.heading.1": { fg: c.accent, bold: true },
        "markup.heading.2": { fg: c.accent, bold: true },
        "markup.heading.3": { fg: c.accent, bold: true },
        "markup.raw": { fg: c.code },
        "markup.list": { fg: c.user },
        "markup.link": { fg: c.accent, underline: true },
        string: { fg: c.success },
        keyword: { fg: c.tool },
        comment: { fg: c.muted, italic: true },
        number: { fg: c.warning },
        function: { fg: c.accent },
        type: { fg: c.user },
        operator: { fg: c.fg },
        punctuation: { fg: c.muted },
      },
      this.renderer!.nativeScene,
    );
  }

  private color(token: ThemeToken): string {
    return this.theme.colors[token];
  }

  private baseBox(id: string): BoxRenderable {
    return new BoxRenderable(this.renderer!, {
      id,
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      marginBottom: 1,
    });
  }

  private addView(block: TranscriptBlock): void {
    if (!this.renderer || !this.scrollbox) return;
    const view = this.createView(block);
    this.views.set(block.id, view);
    this.scrollbox.add(view.box);
    this.scrollbox.scrollTo(Infinity);
  }

  private createView(block: TranscriptBlock): BlockView {
    const box = this.baseBox(`block-${block.id}`);
    if (block.kind === "user") {
      const text = new TextRenderable(this.renderer!, {
        content: `› ${block.text}`,
        fg: this.color("user"),
        wrapMode: "word",
        width: "100%",
      });
      box.add(text);
      return { kind: "user", box, text };
    }
    if (block.kind === "assistant") {
      const markdown = new MarkdownRenderable(this.renderer!, {
        content: block.text,
        syntaxStyle: this.syntaxStyle!,
        fg: this.color("assistant"),
        width: "100%",
        conceal: true,
        streaming: true,
      });
      box.add(markdown);
      return { kind: "assistant", box, markdown };
    }
    if (block.kind === "tool") {
      box.border = ["left"];
      box.borderColor = block.isError ? this.color("error") : this.color("tool");
      box.paddingLeft = 1;
      const title = new TextRenderable(this.renderer!, {
        content: `${block.expanded ? "▾" : "▸"} ${block.name}`,
        fg: block.isError ? this.color("error") : this.color("tool"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      const args = new TextRenderable(this.renderer!, {
        content: block.argsSummary,
        fg: this.color("muted"),
        wrapMode: "word",
        width: "100%",
      });
      const output = new TextRenderable(this.renderer!, {
        content: block.output,
        fg: this.color("muted"),
        wrapMode: "word",
        width: "100%",
        visible: block.expanded,
      });
      box.add(title);
      box.add(args);
      box.add(output);
      return { kind: "tool", box, title, args, output };
    }
    const text = new TextRenderable(this.renderer!, {
      content: `! ${block.text}`,
      fg:
        block.level === "error"
          ? this.color("error")
          : block.level === "warn"
            ? this.color("warning")
            : this.color("muted"),
      wrapMode: "word",
      width: "100%",
    });
    box.add(text);
    return { kind: "notice", box, text };
  }

  private updateView(block: TranscriptBlock): void {
    const view = this.views.get(block.id);
    if (!view) return;
    if (view.kind === "user" && block.kind === "user") {
      view.text.content = `› ${block.text}`;
    } else if (view.kind === "assistant" && block.kind === "assistant") {
      view.markdown.content = block.text;
    } else if (view.kind === "tool" && block.kind === "tool") {
      view.title.content = `${block.expanded ? "▾" : "▸"} ${block.name}`;
      view.title.fg = block.isError ? this.color("error") : this.color("tool");
      view.box.borderColor = block.isError ? this.color("error") : this.color("tool");
      view.args.content = block.argsSummary;
      view.output.content = block.output;
      view.output.visible = block.expanded;
    } else if (view.kind === "notice" && block.kind === "notice") {
      view.text.content = `! ${block.text}`;
    }
    this.scrollbox?.scrollTo(Infinity);
  }

  private rebuildBlocks(): void {
    if (!this.scrollbox) return;
    for (const id of this.order) {
      const block = this.blocks.get(id);
      if (!block) continue;
      const view = this.createView(block);
      this.views.set(id, view);
      this.scrollbox.add(view.box);
    }
    this.scrollbox.scrollTo(Infinity);
  }

  private handleKey = (key: KeyEvent): void => {
    if (this.modal) {
      this.handleModalKey(key);
      return;
    }
    if (this.selectState) {
      this.handleSelectKey(key);
      return;
    }
    const bindings = this.options.keybindings;
    if (bindings.matches(key, "abort")) {
      this.intercept(key);
      if (this.status.busy) this.options.abort();
      else if (!this.textarea?.plainText) this.stop();
      else this.textarea.setText("");
      return;
    }
    if (bindings.matches(key, "exit")) {
      if (!this.textarea?.plainText) {
        this.intercept(key);
        this.stop();
      }
      return;
    }
    if (bindings.matches(key, "cancel")) {
      this.intercept(key);
      if (this.status.busy) this.options.abort();
      else this.textarea?.setText("");
      return;
    }
    if (bindings.matches(key, "scrollUp")) {
      this.intercept(key);
      this.scrollbox?.scrollBy(-10);
      return;
    }
    if (bindings.matches(key, "scrollDown")) {
      this.intercept(key);
      this.scrollbox?.scrollBy(10);
      return;
    }
    if (bindings.matches(key, "scrollBottom")) {
      this.intercept(key);
      this.scrollbox?.scrollTo(Infinity);
      return;
    }
    if (bindings.matches(key, "toggleToolOutput")) {
      this.intercept(key);
      this.toggleToolOutput();
      return;
    }
    if (bindings.matches(key, "complete")) {
      if (this.completeCommand()) this.intercept(key);
      return;
    }
    if (bindings.matches(key, "historyPrev")) {
      if (!this.textarea?.plainText && this.history.length > 0) {
        this.intercept(key);
        this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
        this.textarea?.setText(this.history[this.history.length - 1 - this.historyIndex] ?? "");
        return;
      }
    }
    if (bindings.matches(key, "historyNext")) {
      if (!this.textarea?.plainText && this.historyIndex > 0) {
        this.intercept(key);
        this.historyIndex -= 1;
        this.textarea?.setText(this.history[this.history.length - 1 - this.historyIndex] ?? "");
        return;
      }
    }
    if (key.name === "return" && !key.shift && !key.ctrl && !key.meta && !key.option) {
      this.intercept(key);
      this.submitEditor();
    }
  };

  private intercept(key: KeyEvent): void {
    key.preventDefault();
    key.stopPropagation();
  }

  private onTextareaSubmit(): void {
    const text = this.textarea?.plainText.trim() ?? "";
    if (!text) return;
    if (this.status.busy && this.options.followUp) {
      this.options.followUp(text);
      this.textarea?.setText("");
      return;
    }
    this.submitEditor();
  }

  private submitEditor(): void {
    const text = this.textarea?.plainText.trim() ?? "";
    if (!text) return;
    this.textarea?.setText("");
    this.historyIndex = 0;
    if (text.startsWith("/")) {
      this.runCommand(text);
      return;
    }
    this.history.push(text);
    this.appendBlock({
      id: `user-${Date.now()}-${this.order.length}`,
      kind: "user",
      text,
    });
    void this.options.submit(text).catch((error: unknown) => {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    });
  }

  private completeCommand(): boolean {
    const value = this.textarea?.plainText ?? "";
    if (!value.startsWith("/") || value.includes(" ")) return false;
    const query = value.slice(1);
    const matches = this.options.commands
      .filter((command) => command.name.startsWith(query))
      .map((command) => command.name);
    const name = matches[this.completionIndex % Math.max(1, matches.length)];
    this.completionIndex += 1;
    if (!name) return false;
    this.textarea?.setText(`/${name} `);
    return true;
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
      this.notify(lines || "No commands");
      return;
    }
    const command = this.options.commands.find((candidate) => candidate.name === name);
    if (!command) {
      this.notify(`Unknown command: /${name}`, "warn");
      return;
    }
    void Promise.resolve(command.run(args)).catch((error: unknown) => {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    });
  }

  private toggleToolOutput(): void {
    this.expandedAll = !this.expandedAll;
    for (const [id, block] of this.blocks) {
      if (block.kind !== "tool") continue;
      const next = { ...block, expanded: this.expandedAll };
      this.blocks.set(id, next);
      this.updateView(next);
    }
  }

  private footerContent(): string {
    const bindings = this.options.keybindings;
    const parts = [
      `${bindings.get("submit")[0]} send`,
      `${bindings.get("newline")[0]} newline`,
      `${bindings.get("abort")[0]} abort`,
      "/help",
    ];
    if (this.status.busy) {
      parts.unshift(`${SPINNER[this.spinner] ?? "⠋"} working`);
      parts.push(`${bindings.get("cancel")[0]} to abort`);
    }
    if (this.status.queue > 0) parts.push(`${this.status.queue} queued`);
    const prefix = this.status.model
      ? `${this.status.model}${this.status.tokens ? ` · ${this.status.tokens} tokens` : ""} · `
      : "";
    return `${prefix}${parts.join(" · ")}`;
  }

  private updateFooter(): void {
    if (this.footerText) this.footerText.content = this.footerContent();
  }

  private handleModalKey(key: KeyEvent): void {
    this.intercept(key);
    const bindings = this.options.keybindings;
    if (bindings.matches(key, "modalAllow")) this.finishModal("allow");
    else if (bindings.matches(key, "modalSession")) this.finishModal("session");
    else if (bindings.matches(key, "modalDeny") || bindings.matches(key, "cancel")) {
      this.finishModal("deny");
    }
  }

  private finishModal(decision: "allow" | "session" | "deny"): void {
    const modal = this.modal;
    this.modal = undefined;
    this.modalBox?.destroyRecursively();
    this.modalBox = undefined;
    modal?.resolve(decision);
    this.textarea?.focus();
  }

  private renderModal(): void {
    if (!this.renderer || !this.root || !this.modal) return;
    this.modalBox?.destroyRecursively();
    this.textarea?.blur();
    const box = new BoxRenderable(this.renderer, {
      id: "permission-modal",
      position: "absolute",
      top: "28%",
      left: "10%",
      width: "80%",
      height: 10,
      border: true,
      borderStyle: "rounded",
      borderColor: this.color("warning"),
      backgroundColor: this.theme.background,
      padding: 1,
      flexDirection: "column",
      zIndex: 100,
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: this.modal.title,
        fg: this.color("warning"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      }),
    );
    box.add(
      new TextRenderable(this.renderer, {
        content: this.modal.message,
        fg: this.color("fg"),
        wrapMode: "word",
        width: "100%",
        marginTop: 1,
      }),
    );
    const bindings = this.options.keybindings;
    box.add(
      new TextRenderable(this.renderer, {
        content: `[${bindings.get("modalAllow")[0]}] allow once   [${bindings.get("modalSession")[0]}] allow for session   [${bindings.get("modalDeny")[0]}] deny`,
        fg: this.color("muted"),
        wrapMode: "word",
        width: "100%",
        marginTop: 1,
      }),
    );
    this.root.add(box);
    this.modalBox = box;
    this.renderer.requestRender();
  }

  private handleSelectKey(key: KeyEvent): void {
    this.intercept(key);
    const state = this.selectState;
    if (!state) return;
    if (key.name === "up") state.index = Math.max(0, state.index - 1);
    else if (key.name === "down") state.index = Math.min(state.items.length - 1, state.index + 1);
    else if (key.name === "return") {
      this.selectState = undefined;
      this.selectBox?.destroyRecursively();
      this.selectBox = undefined;
      state.resolve(state.items[state.index]?.value);
      this.textarea?.focus();
      return;
    } else if (key.name === "escape") {
      this.selectState = undefined;
      this.selectBox?.destroyRecursively();
      this.selectBox = undefined;
      state.resolve(undefined);
      this.textarea?.focus();
      return;
    }
    this.renderSelect();
    this.renderer?.requestRender();
  }

  private renderSelect(): void {
    if (!this.renderer || !this.root || !this.selectState) return;
    this.selectBox?.destroyRecursively();
    this.textarea?.blur();
    const state = this.selectState;
    const visible = Math.min(6, state.items.length);
    const box = new BoxRenderable(this.renderer, {
      id: "select-modal",
      position: "absolute",
      top: "22%",
      left: "12%",
      width: "76%",
      height: visible + 5,
      border: true,
      borderStyle: "rounded",
      borderColor: this.color("accent"),
      backgroundColor: this.theme.background,
      padding: 1,
      flexDirection: "column",
      zIndex: 100,
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: state.title,
        fg: this.color("accent"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      }),
    );
    const start = Math.max(0, Math.min(state.index - 3, state.items.length - visible));
    for (let index = start; index < start + visible; index += 1) {
      const item = state.items[index];
      if (!item) continue;
      box.add(
        new TextRenderable(this.renderer, {
          content: `${index === state.index ? "› " : "  "}${item.label}`,
          fg: index === state.index ? this.color("accent") : this.color("fg"),
          wrapMode: "none",
          truncate: true,
          width: "100%",
        }),
      );
    }
    box.add(
      new TextRenderable(this.renderer, {
        content: "Enter select · Esc cancel",
        fg: this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
        marginTop: 1,
      }),
    );
    this.root.add(box);
    this.selectBox = box;
  }
}
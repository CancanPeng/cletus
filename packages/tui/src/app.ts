import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
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
import type { SymbolKey, Theme, ThemeToken } from "./theme.js";

export type ManagedItem = {
  id: string;
  label: string;
  state: string;
  states: string[];
};

export type ManagedAction = {
  key: string;
  label: string;
  run: () => void;
};

export type SlashCommand = {
  name: string;
  description: string;
  run: (args: string) => void | Promise<void>;
};

export type TuiAppOptions = {
  header: string;
  theme: Theme;
  keybindings: KeybindingsManager;
  showThinking?: boolean;
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
      status?: "running" | "success" | "error";
      duration?: string;
      startedAt?: number;
    }
  | { id: string; kind: "notice"; text: string; level: "info" | "warn" | "error" };

type BlockView =
  | { kind: "user"; box: BoxRenderable; text: TextRenderable }
  | {
      kind: "assistant";
      box: BoxRenderable;
      thinking: TextRenderable;
      markdown: MarkdownRenderable;
    }
  | {
      kind: "tool";
      box: BoxRenderable;
      title: TextRenderable;
      args: TextRenderable;
      preview: TextRenderable;
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

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function toolPreview(output: string, isError: boolean, arrow: string): string {
  const line = output.split("\n").map((item) => item.trim()).find((item) => item.length > 0);
  if (!line) return isError ? `${arrow} error` : `${arrow} …`;
  const clipped = line.length > 118 ? `${line.slice(0, 118)}…` : line;
  return `${arrow} ${clipped}`;
}

export class TuiApp {
  private readonly options: TuiAppOptions;
  private readonly history: string[];
  private showThinking: boolean;
  private renderer: CliRenderer | undefined;
  private ownsRenderer = true;
  private root: BoxRenderable | undefined;
  private footerInfo: TextRenderable | undefined;
  private scrollbox: ScrollBoxRenderable | undefined;
  private editorBox: BoxRenderable | undefined;
  private textarea: TextareaRenderable | undefined;
  private footerBox: BoxRenderable | undefined;
  private footerRow: BoxRenderable | undefined;
  private footerLeft: TextRenderable | undefined;
  private footerRight: TextRenderable | undefined;
  private modalBox: BoxRenderable | undefined;
  private selectBox: BoxRenderable | undefined;
  private completionBox: BoxRenderable | undefined;
  private completionRows: TextRenderable[] = [];
  private completionItems: SlashCommand[] = [];
  private completionIndex = 0;
  private manager:
    | {
        title: string;
        items: ManagedItem[];
        index: number;
        resolve: () => void;
        onCycle: (id: string, state: string) => Promise<void> | void;
        actions: ManagedAction[];
      }
    | undefined;
  private inputModal:
    | {
        title: string;
        box: BoxRenderable;
        input: InputRenderable;
        resolve: (value: string | undefined) => void;
      }
    | undefined;
  private managerBox: BoxRenderable | undefined;
  private managerRows: TextRenderable[] = [];
  private syntaxStyle: SyntaxStyle | undefined;
  private theme: Theme;
  private header: string;
  private status: {
    busy: boolean;
    model: string;
    tokens: string;
    queue: number;
    activity?: string;
    context?: string;
    duration?: string;
    startedAt?: number | undefined;
  } = { busy: false, model: "", tokens: "", queue: 0 };
  private spinner = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private toolSpinner = 0;
  private toolTicker: NodeJS.Timeout | undefined;
  private readonly blocks = new Map<string, TranscriptBlock>();
  private readonly order: string[] = [];
  private readonly views = new Map<string, BlockView>();
  private modal: ModalState | undefined;
  private selectState: SelectState | undefined;
  private historyIndex = 0;
  private verbose = false;
  private yolo = false;
  private started = false;
  private stopped = false;

  constructor(options: TuiAppOptions) {
    this.options = options;
    this.theme = options.theme;
    this.header = options.header;
    this.history = options.history;
    this.showThinking = options.showThinking ?? true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.renderer =
      this.options.renderer ??
      (await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        useMouse: true,
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
      borderColor: this.theme.colors.inputBorder,
      paddingX: 1,
      backgroundColor: this.theme.colors.inputBg,
    });
    this.textarea = new TextareaRenderable(this.renderer, {
      id: "editor",
      width: "100%",
      height: 3,
      placeholder: "Ask cletus to change code, run tests, or explain the repo…",
      placeholderColor: this.theme.colors.inputPlaceholder,
      backgroundColor: this.theme.colors.inputBg,
      textColor: this.theme.colors.inputText,
      focusedBackgroundColor: this.theme.colors.inputBg,
      focusedTextColor: this.theme.colors.inputText,
      cursorColor: this.theme.colors.inputFocus,
      keyBindings: [{ name: "return", shift: true, action: "newline" }],
      onSubmit: () => this.onTextareaSubmit(),
      onContentChange: () => this.updateCompletion(),
    });
    this.editorBox.add(this.textarea);
    this.root.add(this.editorBox);

    this.footerBox = new BoxRenderable(this.renderer, {
      height: 2,
      flexShrink: 0,
      flexDirection: "column",
      paddingX: 1,
      backgroundColor: this.theme.background,
    });
    this.footerInfo = new TextRenderable(this.renderer, {
      content: this.header,
      height: 1,
      fg: this.theme.colors.accent,
      wrapMode: "none",
      truncate: true,
    });
    this.footerRow = new BoxRenderable(this.renderer, {
      height: 1,
      flexDirection: "row",
    });
    this.footerLeft = new TextRenderable(this.renderer, {
      content: "",
      flexGrow: 1,
      height: 1,
      fg: this.theme.colors.success,
      wrapMode: "none",
      truncate: true,
    });
    this.footerRight = new TextRenderable(this.renderer, {
      content: "",
      flexShrink: 0,
      height: 1,
      fg: this.theme.colors.muted,
      wrapMode: "none",
      truncate: true,
    });
    this.footerRow.add(this.footerLeft);
    this.footerRow.add(this.footerRight);
    this.footerBox.add(this.footerInfo);
    this.footerBox.add(this.footerRow);
    this.root.add(this.footerBox);
    this.updateFooter();

    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, (current: unknown) => {
      if (this.editorBox) {
        this.editorBox.borderColor =
          current === this.textarea ? this.color("inputFocus") : this.color("inputBorder");
      }
    });
    this.renderer.keyInput.on("keypress", this.handleKey);
    this.textarea.focus();
    this.rebuildBlocks();
    this.renderer.requestRender();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hideCompletion();
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    clearInterval(this.toolTicker);
    this.toolTicker = undefined;
    this.modal?.resolve("deny");
    this.modal = undefined;
    this.manager?.resolve();
    this.manager = undefined;
    this.inputModal?.resolve(undefined);
    this.inputModal = undefined;
    this.selectState?.resolve(undefined);
    this.selectState = undefined;
    this.renderer?.keyInput.off("keypress", this.handleKey);
    if (this.ownsRenderer) this.renderer?.destroy();
    this.options.onExit?.();
  }

  appendBlock(block: TranscriptBlock): void {
    let stored = block;
    if (stored.kind === "tool") {
      if (this.verbose) stored = { ...stored, expanded: true };
      if (stored.status === "running" && stored.startedAt === undefined) {
        stored = { ...stored, startedAt: Date.now() };
      }
    }
    this.blocks.set(stored.id, stored);
    this.order.push(stored.id);
    const follow = stored.kind === "user" || this.isAtBottom();
    this.addView(stored, follow);
    this.updateToolTickerState();
  }

  updateBlock(id: string, patch: Partial<TranscriptBlock>): void {
    const current = this.blocks.get(id);
    if (!current) return;
    const next = { ...current, ...patch } as TranscriptBlock;
    if (next.kind === "tool" && this.verbose) next.expanded = true;
    this.blocks.set(id, next);
    this.updateView(next);
    this.updateToolTickerState();
  }

  setStatus(status: {
    busy: boolean;
    model: string;
    tokens: string;
    queue: number;
    activity?: string;
    context?: string;
    duration?: string;
    startedAt?: number | undefined;
  }): void {
    this.status = {
      ...status,
      startedAt: status.busy
        ? status.startedAt ?? this.status.startedAt
        : undefined,
    };
    if (status.busy && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinner = (this.spinner + 1) % this.theme.spinner.length;
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
    if (this.footerInfo) this.footerInfo.content = header;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    if (!this.renderer) return;
    this.renderer.setBackgroundColor(theme.background);
    if (this.root) this.root.backgroundColor = theme.background;
    if (this.footerInfo) this.footerInfo.fg = theme.colors.accent;
    if (this.footerInfo) this.footerInfo.bg = theme.background;
    if (this.footerRow) this.footerRow.backgroundColor = theme.background;
    if (this.footerLeft) this.footerLeft.fg = theme.colors.success;
    if (this.footerRight) this.footerRight.fg = theme.colors.muted;
    if (this.footerBox) this.footerBox.backgroundColor = theme.background;
    if (this.completionBox) {
      this.completionBox.backgroundColor = theme.background;
      this.completionBox.borderColor = theme.colors.border;
    }
    if (this.managerBox) {
      this.managerBox.backgroundColor = theme.background;
      this.managerBox.borderColor = theme.colors.accent;
    }
    if (this.inputModal) {
      this.inputModal.box.backgroundColor = theme.background;
      this.inputModal.box.borderColor = theme.colors.accent;
    }
    if (this.completionItems.length > 0) this.renderCompletion();
    if (this.editorBox) {
      this.editorBox.backgroundColor = theme.colors.inputBg;
      this.editorBox.borderColor =
        this.textarea?.focused === true ? theme.colors.inputFocus : theme.colors.inputBorder;
    }
    if (this.textarea) {
      this.textarea.backgroundColor = theme.colors.inputBg;
      this.textarea.textColor = theme.colors.inputText;
      this.textarea.focusedBackgroundColor = theme.colors.inputBg;
      this.textarea.focusedTextColor = theme.colors.inputText;
      this.textarea.cursorColor = theme.colors.inputFocus;
      this.textarea.placeholderColor = theme.colors.inputPlaceholder;
    }
    this.syntaxStyle = this.createSyntaxStyle();
    if (this.scrollbox) {
      for (const view of this.views.values()) view.box.destroyRecursively();
      this.views.clear();
      this.rebuildBlocks();
    }
    if (this.manager) this.renderManager();
    if (this.modal) this.renderModal();
    if (this.selectState) this.renderSelect();
    this.updateFooter();
    this.renderer.requestRender();
  }

  clearTranscript(): void {
    for (const view of this.views.values()) view.box.destroyRecursively();
    this.views.clear();
    this.blocks.clear();
    this.order.length = 0;
    this.scrollbox?.scrollTo(0);
  }

  manageItems(
    title: string,
    items: ManagedItem[],
    onCycle: (id: string, state: string) => Promise<void> | void,
    actions: ManagedAction[] = [],
  ): Promise<void> {
    this.hideCompletion();
    this.manager?.resolve();
    const state = Promise.withResolvers<void>();
    this.manager = {
      title,
      items: items.map((item) => ({ ...item })),
      index: 0,
      resolve: state.resolve,
      onCycle,
      actions,
    };
    this.renderManager();
    return state.promise;
  }

  promptInput(title: string, placeholder: string): Promise<string | undefined> {
    if (!this.renderer || !this.root) return Promise.resolve(undefined);
    this.inputModal?.resolve(undefined);
    this.inputModal?.box.destroyRecursively();
    const state = Promise.withResolvers<string | undefined>();
    const box = new BoxRenderable(this.renderer, {
      id: "input-modal",
      position: "absolute",
      top: "34%",
      left: "15%",
      width: "70%",
      height: 5,
      border: true,
      borderStyle: "rounded",
      borderColor: this.color("accent"),
      backgroundColor: this.theme.background,
      paddingX: 1,
      flexDirection: "column",
      zIndex: 120,
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: title,
        fg: this.color("accent"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      }),
    );
    const input: InputRenderable = new InputRenderable(this.renderer, {
      width: "100%",
      placeholder,
      placeholderColor: this.color("inputPlaceholder"),
      backgroundColor: this.theme.colors.inputBg,
      textColor: this.color("inputText"),
      focusedBackgroundColor: this.theme.colors.inputBg,
      focusedTextColor: this.color("inputText"),
      cursorColor: this.color("inputFocus"),
      onSubmit: () => this.finishInput(input.value),
    });
    box.add(input);
    this.root.add(box);
    this.textarea?.blur();
    this.inputModal = { title, box, input, resolve: state.resolve };
    input.focus();
    this.updateFooter();
    this.renderer.requestRender();
    return state.promise;
  }

  addCommand(command: SlashCommand): void {
    if (this.options.commands.some((candidate) => candidate.name === command.name)) return;
    this.options.commands.push(command);
  }

  removeCommand(name: string): void {
    const index = this.options.commands.findIndex((command) => command.name === name);
    if (index >= 0) this.options.commands.splice(index, 1);
  }

  getKeybindings(): KeybindingsManager {
    return this.options.keybindings;
  }

  setYolo(enabled: boolean): void {
    this.yolo = enabled;
    this.updateFooter();
  }

  setShowThinking(enabled: boolean): void {
    this.showThinking = enabled;
    for (const block of this.blocks.values()) {
      if (block.kind !== "assistant") continue;
      const view = this.views.get(block.id);
      if (view?.kind === "assistant") {
        view.thinking.visible = enabled && Boolean(block.thinking);
      }
    }
  }

  setVerbose(enabled: boolean): void {
    this.verbose = enabled;
    for (const [id, block] of this.blocks) {
      if (block.kind !== "tool") continue;
      const next = { ...block, expanded: enabled };
      this.blocks.set(id, next);
      this.updateView(next);
    }
    this.updateFooter();
  }

  isVerbose(): boolean {
    return this.verbose;
  }

  notify(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.appendBlock({ id: `notice-${Date.now()}-${this.order.length}`, kind: "notice", text, level });
  }

  confirm(title: string, message: string): Promise<"allow" | "session" | "deny"> {
    this.hideCompletion();
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
    this.hideCompletion();
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

  private symbol(key: SymbolKey): string {
    return this.theme.symbol(key);
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

  private addView(block: TranscriptBlock, follow = true): void {
    if (!this.renderer || !this.scrollbox) return;
    const view = this.createView(block);
    this.views.set(block.id, view);
    this.scrollbox.add(view.box);
    if (follow) this.scrollbox.scrollTo(Infinity);
  }

  private isAtBottom(): boolean {
    if (!this.scrollbox) return true;
    const viewport = this.scrollbox.viewport.height;
    return (
      this.scrollbox.scrollHeight <= viewport ||
      this.scrollbox.scrollTop >= this.scrollbox.scrollHeight - viewport - 1
    );
  }

  private toolStatus(block: Extract<TranscriptBlock, { kind: "tool" }>): "running" | "success" | "error" {
    return block.status ?? (block.isError ? "error" : block.output ? "success" : "running");
  }

  private toolColor(status: "running" | "success" | "error"): string {
    return status === "error"
      ? this.color("error")
      : status === "success"
        ? this.color("success")
        : this.color("tool");
  }

  private toolBackground(status: "running" | "success" | "error"): string {
    return status === "error"
      ? this.color("toolErrorBg")
      : status === "success"
        ? this.color("toolSuccessBg")
        : this.color("toolBg");
  }

  private toolTitle(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
    const status = this.toolStatus(block);
    const icon =
      status === "error"
        ? this.symbol("toolError")
        : status === "success"
          ? this.symbol("toolSuccess")
          : this.theme.spinner[this.toolSpinner % this.theme.spinner.length] ??
            this.symbol("toolRunning");
    const chevron = block.expanded
      ? this.symbol("toolExpanded")
      : this.symbol("toolCollapsed");
    const elapsed =
      status === "running" && block.startedAt !== undefined
        ? formatElapsed(Date.now() - block.startedAt)
        : block.duration;
    return `${chevron} ${icon} ${block.name}${elapsed ? ` · ${elapsed}` : ""}`;
  }

  private updateToolTickerState(): void {
    const running = [...this.blocks.values()].some(
      (block) => block.kind === "tool" && this.toolStatus(block) === "running",
    );
    if (!running) {
      clearInterval(this.toolTicker);
      this.toolTicker = undefined;
      return;
    }
    if (this.toolTicker) return;
    this.toolTicker = setInterval(() => {
      this.toolSpinner = (this.toolSpinner + 1) % this.theme.spinner.length;
      for (const [id, block] of this.blocks) {
        if (block.kind !== "tool" || this.toolStatus(block) !== "running") continue;
        const view = this.views.get(id);
        if (view?.kind === "tool") {
          view.title.content = this.toolTitle(block);
        }
      }
    }, 100);
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
      const thinking = new TextRenderable(this.renderer!, {
        content: block.thinking ?? "",
        fg: this.color("muted"),
        wrapMode: "word",
        width: "100%",
        visible: this.showThinking && Boolean(block.thinking),
      });
      const markdown = new MarkdownRenderable(this.renderer!, {
        content: block.text,
        syntaxStyle: this.syntaxStyle!,
        fg: this.color("assistant"),
        width: "100%",
        conceal: true,
        streaming: true,
      });
      box.add(thinking);
      box.add(markdown);
      return { kind: "assistant", box, thinking, markdown };
    }
    if (block.kind === "tool") {
      const status = this.toolStatus(block);
      box.border = true;
      box.borderStyle = "rounded";
      box.borderColor = this.toolColor(status);
      box.backgroundColor = this.toolBackground(status);
      box.paddingX = 1;
      box.paddingY = 0;
      const title = new TextRenderable(this.renderer!, {
        content: this.toolTitle(block),
        fg: this.toolColor(status),
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
      const preview = new TextRenderable(this.renderer!, {
        content: toolPreview(block.output, block.isError, this.symbol("preview")),
        fg: block.isError ? this.color("error") : this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
        visible: !block.expanded,
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
      box.add(preview);
      box.add(output);
      return { kind: "tool", box, title, args, preview, output };
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
    const follow = this.isAtBottom();
    if (view.kind === "user" && block.kind === "user") {
      view.text.content = `› ${block.text}`;
    } else if (view.kind === "assistant" && block.kind === "assistant") {
      view.thinking.content = block.thinking ?? "";
      view.thinking.visible = this.showThinking && Boolean(block.thinking);
      view.markdown.content = block.text;
    } else if (view.kind === "tool" && block.kind === "tool") {
      const status = this.toolStatus(block);
      view.title.content = this.toolTitle(block);
      view.title.fg = this.toolColor(status);
      view.box.borderColor = this.toolColor(status);
      view.box.backgroundColor = this.toolBackground(status);
      view.args.content = block.argsSummary;
      view.preview.content = toolPreview(block.output, block.isError, this.symbol("preview"));
      view.preview.fg = block.isError ? this.color("error") : this.color("muted");
      view.preview.visible = !block.expanded;
      view.output.content = block.output;
      view.output.visible = block.expanded;
    } else if (view.kind === "notice" && block.kind === "notice") {
      view.text.content = `! ${block.text}`;
    }
    if (follow) this.scrollbox?.scrollTo(Infinity);
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
    if (this.inputModal) {
      if (key.name === "escape") {
        this.intercept(key);
        this.finishInput(undefined);
      } else if (key.name === "return" || key.name === "enter") {
        this.intercept(key);
        this.finishInput(this.inputModal.input.value);
      }
      return;
    }
    if (this.manager) {
      this.handleManagerKey(key);
      return;
    }
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
    if (this.completionVisible()) {
      if (key.name === "up") {
        this.intercept(key);
        this.completionIndex =
          (this.completionIndex - 1 + this.completionItems.length) % this.completionItems.length;
        this.renderCompletion();
        return;
      }
      if (key.name === "down") {
        this.intercept(key);
        this.completionIndex = (this.completionIndex + 1) % this.completionItems.length;
        this.renderCompletion();
        return;
      }
      if (key.name === "escape") {
        this.intercept(key);
        this.hideCompletion();
        return;
      }
    }
    if (bindings.matches(key, "complete")) {
      if (this.completionVisible()) {
        this.intercept(key);
        this.acceptCompletion();
      } else if (this.completeCommand()) this.intercept(key);
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
      if (this.completionVisible()) {
        this.intercept(key);
        const selected = this.completionItems[this.completionIndex];
        const exact = selected && this.textarea?.plainText.trim() === `/${selected.name}`;
        if (exact) {
          this.hideCompletion();
          this.submitEditor();
        } else {
          this.acceptCompletion();
        }
        return;
      }
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
    this.hideCompletion();
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

  private completionVisible(): boolean {
    return this.completionItems.length > 0 && this.completionBox?.visible === true;
  }

  private updateCompletion(): void {
    const value = this.textarea?.plainText ?? "";
    if (!value.startsWith("/") || value.includes(" ")) {
      this.hideCompletion();
      return;
    }
    const query = value.slice(1).toLowerCase();
    const items = this.options.commands.filter((command) =>
      command.name.toLowerCase().startsWith(query),
    );
    this.completionItems = items;
    if (this.completionIndex >= items.length) this.completionIndex = 0;
    this.renderCompletion();
  }

  private renderCompletion(): void {
    if (!this.renderer || !this.root) return;
    if (this.completionItems.length === 0) {
      this.hideCompletion();
      return;
    }
    if (!this.completionBox) {
      this.completionBox = new BoxRenderable(this.renderer, {
        id: "command-palette",
        position: "absolute",
        left: "2%",
        bottom: 7,
        width: "60%",
        height: 10,
        border: true,
        borderStyle: "rounded",
        borderColor: this.color("border"),
        backgroundColor: this.theme.background,
        paddingX: 1,
        flexDirection: "column",
        zIndex: 90,
      });
      for (let index = 0; index < 8; index += 1) {
        const row = new TextRenderable(this.renderer, {
          content: "",
          fg: this.color("fg"),
          wrapMode: "none",
          truncate: true,
          width: "100%",
          visible: false,
        });
        this.completionRows.push(row);
        this.completionBox.add(row);
      }
      this.root.add(this.completionBox);
    }
    const count = Math.min(8, this.completionItems.length);
    const start = Math.max(0, Math.min(this.completionIndex - 3, this.completionItems.length - count));
    this.completionBox.height = count + 2;
    this.completionBox.title = `${this.completionItems.length} commands`;
    this.completionBox.titleColor = this.color("muted");
    this.completionBox.visible = true;
    for (let rowIndex = 0; rowIndex < this.completionRows.length; rowIndex += 1) {
      const row = this.completionRows[rowIndex];
      const itemIndex = start + rowIndex;
      const item = this.completionItems[itemIndex];
      if (!row) continue;
      if (!item || rowIndex >= count) {
        row.visible = false;
        continue;
      }
      const selected = itemIndex === this.completionIndex;
      row.visible = true;
      row.content = `${selected ? "› " : "  "}/${item.name}  ${item.description}`;
      row.fg = selected ? this.color("accent") : this.color("fg");
    }
    this.updateFooter();
    this.renderer.requestRender();
  }

  private acceptCompletion(): void {
    const item = this.completionItems[this.completionIndex];
    if (!item) return;
    this.textarea?.setText(`/${item.name} `);
    this.textarea?.gotoBufferEnd();
    this.hideCompletion();
  }

  private hideCompletion(): void {
    this.completionItems = [];
    this.completionIndex = 0;
    if (this.completionBox) this.completionBox.visible = false;
    this.updateFooter();
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
    this.setVerbose(!this.verbose);
  }

  private footerLeftContent(): string {
    if (this.inputModal) return `${this.symbol("search")} ${this.inputModal.title}`;
    if (this.manager) return `${this.symbol("skills")} managing skills`;
    const usage = this.status.context
      ? `${this.symbol("context")} ${this.status.context}`
      : this.status.tokens
        ? `${this.symbol("context")} ${this.status.tokens} tok`
        : "";
    if (this.modal) return `${this.symbol("permission")} waiting for permission`;
    if (this.selectState) return "select an item";
    if (this.status.busy) {
      const activity = this.status.activity ?? "working";
      const elapsed = this.status.startedAt
        ? `${this.symbol("duration")} ${formatElapsed(Date.now() - this.status.startedAt)}`
        : "";
      const suffix = [
        usage,
        elapsed,
        this.status.queue > 0 ? `${this.symbol("queue")} ${this.status.queue} queued` : "",
        this.yolo ? `${this.symbol("yolo")} YOLO` : "",
      ].filter(Boolean).join(" · ");
      return `${this.theme.spinner[this.spinner % this.theme.spinner.length] ?? "⠋"} ${activity}${suffix ? ` · ${suffix}` : ""}`;
    }
    return `${this.symbol("ready")}${usage ? ` · ${usage}` : ""}${this.status.duration ? ` · ${this.symbol("duration")} ${this.status.duration}` : ""}${this.verbose ? " · verbose" : ""}${this.yolo ? ` · ${this.symbol("yolo")} YOLO` : ""}`;
  }

  private footerRightContent(): string {
    const bindings = this.options.keybindings;
    if (this.inputModal) return "enter confirm · esc cancel";
    if (this.manager) {
      const actions = this.manager.actions.map((action) => `${action.key} ${action.label}`).join(" · ");
      return `↑↓ move · space cycle${actions ? ` · ${actions}` : ""} · enter/esc close`;
    }
    if (this.modal) {
      return `${bindings.get("modalAllow")[0]} allow · ${bindings.get("modalSession")[0]} session · ${bindings.get("modalDeny")[0]} deny`;
    }
    if (this.selectState) return "↑↓ select · enter confirm · esc cancel";
    if (this.completionVisible()) return "↑↓ choose · tab insert · esc close";
    if (this.status.busy) {
      return `${bindings.get("cancel")[0]} abort · ${bindings.get("toggleToolOutput")[0]} tools`;
    }
    return `${bindings.get("submit")[0]} send · / commands · ${bindings.get("toggleToolOutput")[0]} tools`;
  }

  private updateFooter(): void {
    if (!this.footerLeft || !this.footerRight) return;
    this.footerLeft.content = this.footerLeftContent();
    this.footerRight.content = this.footerRightContent();
    this.footerLeft.fg =
      this.modal || this.yolo
        ? this.color("warning")
        : this.status.busy
          ? this.color("accent")
          : this.color("success");
    this.footerRight.fg = this.color("muted");
  }

  private handleManagerKey(key: KeyEvent): void {
    this.intercept(key);
    const manager = this.manager;
    if (!manager) return;
    if (key.name === "escape" || key.name === "return") {
      this.closeManager();
      return;
    }
    const action = manager.actions.find((candidate) => candidate.key === key.name);
    if (action) {
      this.closeManager();
      action.run();
      return;
    }
    if (key.name === "up") {
      manager.index = Math.max(0, manager.index - 1);
      this.renderManager();
      return;
    }
    if (key.name === "down") {
      manager.index = Math.min(manager.items.length - 1, manager.index + 1);
      this.renderManager();
      return;
    }
    if (key.name === "space") {
      const item = manager.items[manager.index];
      if (!item || item.states.length === 0) return;
      const index = item.states.indexOf(item.state);
      item.state = item.states[(index + 1) % item.states.length] ?? item.states[0] ?? item.state;
      this.renderManager();
      void Promise.resolve(manager.onCycle(item.id, item.state)).catch((error: unknown) => {
        this.notify(error instanceof Error ? error.message : String(error), "error");
      });
    }
  }

  private closeManager(): void {
    const manager = this.manager;
    if (!manager) return;
    this.manager = undefined;
    this.managerBox?.destroyRecursively();
    this.managerBox = undefined;
    this.managerRows = [];
    manager.resolve();
    this.textarea?.focus();
    this.updateFooter();
  }

  private finishInput(value: string | undefined): void {
    const modal = this.inputModal;
    if (!modal) return;
    this.inputModal = undefined;
    modal.box.destroyRecursively();
    modal.resolve(value);
    this.textarea?.focus();
    this.updateFooter();
  }

  private renderManager(): void {
    if (!this.renderer || !this.root || !this.manager) return;
    this.managerBox?.destroyRecursively();
    this.textarea?.blur();
    const manager = this.manager;
    const visible = Math.min(10, manager.items.length);
    const box = new BoxRenderable(this.renderer, {
      id: "skills-manager",
      position: "absolute",
      top: "16%",
      left: "10%",
      width: "80%",
      height: visible + 5,
      border: true,
      borderStyle: "rounded",
      borderColor: this.color("accent"),
      backgroundColor: this.theme.background,
      paddingX: 1,
      flexDirection: "column",
      zIndex: 110,
    });
    box.add(
      new TextRenderable(this.renderer, {
        content: manager.title,
        fg: this.color("accent"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      }),
    );
    const start = Math.max(0, Math.min(manager.index - 4, manager.items.length - visible));
    const rows: TextRenderable[] = [];
    for (let rowIndex = 0; rowIndex < visible; rowIndex += 1) {
      const item = manager.items[start + rowIndex];
      if (!item) continue;
      const selected = start + rowIndex === manager.index;
      const row = new TextRenderable(this.renderer, {
        content: `${selected ? "› " : "  "}[${item.state}] ${item.label}`,
        fg: selected ? this.color("accent") : this.color("fg"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      rows.push(row);
      box.add(row);
    }
    const actionHint = manager.actions
      .map((action) => `${action.key} ${action.label}`)
      .join(" · ");
    box.add(
      new TextRenderable(this.renderer, {
        content: `Space cycle${actionHint ? ` · ${actionHint}` : ""} · Enter/Esc close`,
        fg: this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
        marginTop: 1,
      }),
    );
    this.root.add(box);
    this.managerBox = box;
    this.managerRows = rows;
    this.updateFooter();
    this.renderer.requestRender();
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
    this.updateFooter();
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
    this.updateFooter();
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
      this.updateFooter();
      return;
    } else if (key.name === "escape") {
      this.selectState = undefined;
      this.selectBox?.destroyRecursively();
      this.selectBox = undefined;
      state.resolve(undefined);
      this.textarea?.focus();
      this.updateFooter();
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
      height: visible + 7,
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
    this.updateFooter();
  }
}
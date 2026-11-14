import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  MarkdownRenderable,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  stripAnsiSequences,
  type ClipboardService,
  type Selection,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { ImageAttachment } from "@cletus/ai";
import type { KeybindingsManager } from "./keybindings.js";
import type { SymbolKey, Theme, ThemeToken } from "./theme.js";

export type ManagedItem = {
  id: string;
  label: string;
  state: string;
  states: string[];
};

export type ManagedResult = { id: string; label: string };

export type ManagedListTab = {
  kind: "list";
  id: string;
  title: string;
  items: ManagedItem[];
  onCycle: (id: string, state: string) => Promise<void> | void;
  refresh?: () => Promise<ManagedItem[]>;
};

export type ManagedSearchTab = {
  kind: "search";
  id: string;
  title: string;
  placeholder: string;
  search: (query: string, signal: AbortSignal) => Promise<ManagedResult[]>;
  onAccept: (result: ManagedResult) => Promise<void> | void;
};

export type ManagedPromptTab = {
  kind: "prompt";
  id: string;
  title: string;
  placeholder: string;
  onSubmit: (value: string) => Promise<void> | void;
};

export type ManagedTab = ManagedListTab | ManagedSearchTab | ManagedPromptTab;

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
  submit: (text: string, images?: ImageAttachment[]) => Promise<void>;
  followUp?: (text: string, images?: ImageAttachment[]) => void;
  attachImage?: (
    bytes: Uint8Array,
    mediaType: "image/png" | "image/jpeg",
  ) => Promise<ImageAttachment | undefined>;
  abort: () => void;
  commands: SlashCommand[];
  history: string[];
  onExit?: () => void;
  /** Test seam: use a pre-created renderer instead of taking over the terminal. */
  renderer?: CliRenderer;
  /** Test seam: inject a clipboard instead of the host/terminal clipboard. */
  clipboard?: ClipboardService;
};

export type TranscriptBlock =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; thinking?: string; done?: boolean }
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
      separator: TextRenderable;
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
  // Scan lazily: outputs can be megabytes and this runs on every stream tick.
  let line: string | undefined;
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf("\n", start);
    const raw = end < 0 ? output.slice(start) : output.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      line = trimmed;
      break;
    }
    if (end < 0) break;
    start = end + 1;
  }
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
        tabs: ManagedTab[];
        tabIndex: number;
        index: number;
        filter: string;
        query: string;
        input: InputRenderable | undefined;
        inputBox: BoxRenderable | undefined;
        inputTabId: string | undefined;
        results: ManagedResult[];
        resultIndex: number;
        searching: boolean;
        searchError: string | undefined;
        debounce: NodeJS.Timeout | undefined;
        controller: AbortController | undefined;
        resolve: () => void;
        box: BoxRenderable | undefined;
        headerRow: TextRenderable | undefined;
        tabRow: TextRenderable | undefined;
        bodyBox: BoxRenderable | undefined;
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
  private clipboard: ClipboardService | undefined;
  private readonly pendingImages: ImageAttachment[] = [];
  private readonly blocks = new Map<string, TranscriptBlock>();
  private readonly order: string[] = [];
  private readonly views = new Map<string, BlockView>();
  private modal: ModalState | undefined;
  private selectState: SelectState | undefined;
  private historyIndex = -1;
  private historyDraft = "";
  private verbose = false;
  private yolo = false;
  private started = false;
  private stopped = false;
  private readonly onFocusChange = (current: unknown): void => {
    if (this.editorBox) {
      this.editorBox.borderColor =
        current === this.textarea ? this.color("inputFocus") : this.color("inputBorder");
    }
  };
  private readonly onSelection = (selection: Selection): void => {
    if (this.stopped) return;
    const text = selection.getSelectedText();
    if (text) void this.writeClipboard(text);
  };

  constructor(options: TuiAppOptions) {
    this.options = options;
    this.theme = options.theme;
    this.header = options.header;
    this.history = options.history;
    this.showThinking = options.showThinking ?? true;
  }

  async start(): Promise<void> {
    if (this.started) return;
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
    this.started = true;
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
      onContentChange: () => {
        // Typing exits history navigation; programmatic setText during
        // navigation keeps the index (content equals the recalled entry).
        const value = this.textarea?.plainText ?? "";
        const recalled =
          this.historyIndex >= 0
            ? this.history[this.history.length - 1 - this.historyIndex] ?? ""
            : this.historyDraft;
        if (value !== recalled) {
          this.historyIndex = -1;
          this.historyDraft = value;
        }
        this.updateCompletion();
      },
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

    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, this.onFocusChange);
    this.renderer.on(CliRenderEvents.SELECTION, this.onSelection);
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
    void this.clipboard?.dispose();
    this.clipboard = undefined;
    this.modal?.resolve("deny");
    this.modal = undefined;
    this.manager?.resolve();
    this.manager = undefined;
    this.inputModal?.resolve(undefined);
    this.inputModal = undefined;
    this.selectState?.resolve(undefined);
    this.selectState = undefined;
    this.renderer?.keyInput.off("keypress", this.handleKey);
    this.renderer?.off(CliRenderEvents.FOCUSED_RENDERABLE, this.onFocusChange);
    this.renderer?.off(CliRenderEvents.SELECTION, this.onSelection);
    this.syntaxStyle?.destroy();
    this.syntaxStyle = undefined;
    if (this.ownsRenderer) {
      this.renderer?.destroy();
    } else {
      this.root?.destroyRecursively();
    }
    this.root = undefined;
    this.options.onExit?.();
  }

  appendBlock(block: TranscriptBlock): void {
    if (this.stopped) return;
    if (this.blocks.has(block.id)) {
      this.updateBlock(block.id, block);
      return;
    }
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
    if (this.stopped) return;
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
    if (this.stopped) return;
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
    if (this.manager?.box) {
      this.manager.box.backgroundColor = theme.background;
      this.manager.box.borderColor = theme.colors.accent;
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
    this.syntaxStyle?.destroy();
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

  private static filterItems(items: ManagedItem[], query: string): ManagedItem[] {
    if (!query) return items;
    const needle = query.toLowerCase();
    return items.filter((item) => item.id.toLowerCase().includes(needle));
  }

  private managerItems(): ManagedItem[] {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    return tab && tab.kind === "list" ? tab.items : [];
  }

  private visibleManagerItems(): ManagedItem[] {
    const manager = this.manager;
    if (!manager) return [];
    return TuiApp.filterItems(this.managerItems(), manager.filter);
  }

  manageTabs(title: string, tabs: ManagedTab[]): Promise<void> {
    this.hideCompletion();
    if (this.manager) this.destroyManager();
    const state = Promise.withResolvers<void>();
    this.manager = {
      title,
      tabs,
      tabIndex: 0,
      index: 0,
      filter: "",
      query: "",
      input: undefined,
      inputBox: undefined,
      inputTabId: undefined,
      results: [],
      resultIndex: 0,
      searching: false,
      searchError: undefined,
      debounce: undefined,
      controller: undefined,
      resolve: state.resolve,
      box: undefined,
      headerRow: undefined,
      tabRow: undefined,
      bodyBox: undefined,
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
    let running = false;
    for (const block of this.blocks.values()) {
      if (block.kind === "tool" && this.toolStatus(block) === "running") {
        running = true;
        break;
      }
    }
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
        streaming: block.done !== true,
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
        fg: this.color("tool"),
        wrapMode: "word",
        width: "100%",
      });
      const separator = new TextRenderable(this.renderer!, {
        content: "─".repeat(200),
        fg: this.color("border"),
        wrapMode: "none",
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
        fg: block.isError ? this.color("error") : this.color("fg"),
        wrapMode: "word",
        width: "100%",
        visible: block.expanded,
      });
      box.add(title);
      box.add(args);
      box.add(separator);
      box.add(preview);
      box.add(output);
      return { kind: "tool", box, title, args, separator, preview, output };
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
      if (block.done) view.markdown.streaming = false;
    } else if (view.kind === "tool" && block.kind === "tool") {
      const status = this.toolStatus(block);
      view.title.content = this.toolTitle(block);
      view.title.fg = this.toolColor(status);
      view.box.borderColor = this.toolColor(status);
      view.box.backgroundColor = this.toolBackground(status);
      view.args.content = block.argsSummary;
      view.args.fg = this.color("tool");
      view.separator.fg = this.color("border");
      view.preview.content = toolPreview(block.output, block.isError, this.symbol("preview"));
      view.preview.fg = block.isError ? this.color("error") : this.color("muted");
      view.preview.visible = !block.expanded;
      if (block.expanded) view.output.content = block.output;
      view.output.fg = block.isError ? this.color("error") : this.color("fg");
      view.output.visible = block.expanded;
    } else if (view.kind === "notice" && block.kind === "notice") {
      view.text.content = `! ${block.text}`;
    }
    if (follow) this.scrollbox?.scrollTo(Infinity);
  }

  private rebuildBlocks(): void {
    if (!this.scrollbox) return;
    const follow = this.isAtBottom();
    for (const id of this.order) {
      const block = this.blocks.get(id);
      if (!block) continue;
      const view = this.createView(block);
      this.views.set(id, view);
      this.scrollbox.add(view.box);
    }
    if (follow) this.scrollbox.scrollTo(Infinity);
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
    const bindings = this.options.keybindings;
    // Abort/exit stay reachable while a modal or the manager is open.
    if (bindings.matches(key, "abort") || bindings.matches(key, "exit")) {
      this.intercept(key);
      if (this.modal) this.finishModal("deny");
      else if (this.manager) this.closeManager();
      else if (this.inputModal) this.finishInput(undefined);
      else if (this.selectState) this.finishSelect(undefined);
      else if (this.status.busy) this.options.abort();
      else if (!this.textarea?.plainText) this.stop();
      else {
        this.textarea.setText("");
        this.pendingImages.length = 0;
      }
      return;
    }
    // Modals and selects are asked for *by* the manager (install confirms),
    // so they sit above it: route keys to them first or the popup eats the
    // answer.
    if (this.modal) {
      this.handleModalKey(key);
      return;
    }
    if (this.selectState) {
      this.handleSelectKey(key);
      return;
    }
    if (this.manager) {
      this.handleManagerKey(key);
      return;
    }
    if (bindings.matches(key, "copy")) {
      this.intercept(key);
      void this.copyText();
      return;
    }
    if (bindings.matches(key, "paste")) {
      this.intercept(key);
      void this.pasteText();
      return;
    }
    if (bindings.matches(key, "cancel")) {
      this.intercept(key);
      if (this.status.busy) this.options.abort();
      else {
        this.textarea?.setText("");
        this.pendingImages.length = 0;
      }
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
      }
      return;
    }
    if (bindings.matches(key, "historyPrev")) {
      if (this.history.length > 0 && this.historyIndex < this.history.length - 1) {
        this.intercept(key);
        if (this.historyIndex === -1) this.historyDraft = this.textarea?.plainText ?? "";
        this.historyIndex += 1;
        this.textarea?.setText(this.history[this.history.length - 1 - this.historyIndex] ?? "");
        return;
      }
    }
    if (bindings.matches(key, "historyNext")) {
      if (this.historyIndex >= 0) {
        this.intercept(key);
        this.historyIndex -= 1;
        this.textarea?.setText(
          this.historyIndex === -1
            ? this.historyDraft
            : this.history[this.history.length - 1 - this.historyIndex] ?? "",
        );
        return;
      }
    }
    if (bindings.matches(key, "newline")) {
      this.intercept(key);
      this.textarea?.newLine();
      return;
    }
    if (bindings.matches(key, "followUp")) {
      this.intercept(key);
      this.onTextareaSubmit();
      return;
    }
    if (bindings.matches(key, "submit")) {
      if (this.completionVisible()) {
        this.intercept(key);
        const typed = this.textarea?.plainText.trim() ?? "";
        const exact = this.completionItems.some((command) => typed === `/${command.name}`);
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
      const images = this.pendingImages.splice(0);
      this.options.followUp(text, ...(images.length ? [images] : []));
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
    this.historyIndex = -1;
    this.historyDraft = "";
    // Command names never contain "/"; anything else (e.g. an absolute
    // file path like /var/folders/.../paste.png) is a regular message.
    const commandToken = text.split(" ", 1)[0] ?? "";
    if (text.startsWith("/") && !commandToken.slice(1).includes("/")) {
      this.runCommand(text);
      return;
    }
    this.history.push(text);
    this.appendBlock({
      id: `user-${Date.now()}-${this.order.length}`,
      kind: "user",
      text,
    });
    const images = this.pendingImages.splice(0);
    void this.options.submit(text, ...(images.length ? [images] : [])).catch((error: unknown) => {
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
        elapsed,
        usage,
        this.status.queue > 0 ? `${this.symbol("queue")} ${this.status.queue} queued` : "",
        this.yolo ? `${this.symbol("yolo")} YOLO` : "",
      ].filter(Boolean).join(" · ");
      return `${this.theme.spinner[this.spinner % this.theme.spinner.length] ?? "⠋"} ${activity}${suffix ? ` · ${suffix}` : ""}`;
    }
    return `${this.symbol("ready")}${this.status.duration ? ` · ${this.symbol("duration")} ${this.status.duration}` : ""}${usage ? ` · ${usage}` : ""}${this.verbose ? " · verbose" : ""}${this.yolo ? ` · ${this.symbol("yolo")} YOLO` : ""}`;
  }

  private footerRightContent(): string {
    const bindings = this.options.keybindings;
    if (this.inputModal) return "enter confirm · esc cancel";
    if (this.manager) {
      const actions = "type filter · ↑↓ move · space cycle · enter/esc close";
      return actions;
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
    const manager = this.manager;
    if (!manager) return;
    if (key.name === "tab") {
      this.intercept(key);
      manager.tabIndex = key.shift
        ? (manager.tabIndex - 1 + manager.tabs.length) % manager.tabs.length
        : (manager.tabIndex + 1) % manager.tabs.length;
      this.clearManagerSearch();
      manager.index = 0;
      manager.resultIndex = 0;
      this.renderManager();
      this.refreshManagerList();
      return;
    }
    const tab = manager.tabs[manager.tabIndex];
    if (!tab) return;
    if (tab.kind !== "list") {
      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.name === "up" ||
        key.name === "down"
      ) {
        this.intercept(key);
      }
      this.handleManagerInputKey(key, tab);
      return;
    }
    this.intercept(key);
    if (key.name === "return") {
      this.closeManager();
      return;
    }
    if (key.name === "escape") {
      if (manager.filter) {
        manager.filter = "";
        manager.index = 0;
        this.renderManager();
        return;
      }
      this.closeManager();
      return;
    }
    const visible = this.visibleManagerItems();
    if (key.name === "up") {
      manager.index = Math.max(0, manager.index - 1);
      this.renderManager();
      return;
    }
    if (key.name === "down") {
      manager.index = Math.max(0, Math.min(visible.length - 1, manager.index + 1));
      this.renderManager();
      return;
    }
    if (key.name === "backspace") {
      if (!manager.filter) return;
      manager.filter = manager.filter.slice(0, -1);
      manager.index = 0;
      this.renderManager();
      return;
    }
    if (key.name === "space") {
      const item = visible[manager.index];
      if (!item || item.states.length === 0) return;
      const index = item.states.indexOf(item.state);
      item.state = item.states[(index + 1) % item.states.length] ?? item.states[0] ?? item.state;
      this.renderManager();
      void Promise.resolve(tab.onCycle(item.id, item.state)).catch((error: unknown) => {
        this.notify(error instanceof Error ? error.message : String(error), "error");
      });
      return;
    }
    if (!key.ctrl && !key.meta && !key.option && !key.super) {
      const typed = key.sequence;
      if (!typed || typed.length !== 1) return;
      manager.filter += typed;
      manager.index = 0;
      this.renderManager();
    }
  }

  private destroyManager(): void {
    const manager = this.manager;
    if (!manager) return;
    this.manager = undefined;
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.inputBox?.destroyRecursively();
    manager.inputBox = undefined;
    manager.input = undefined;
    manager.box?.destroyRecursively();
    manager.resolve();
  }

  /** Reload the list tab's items, if it knows how. Keeps the popup open. */
  private refreshManagerList(): void {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    if (!manager || tab?.kind !== "list" || !tab.refresh) return;
    void tab.refresh().then((items) => {
      if (this.manager !== manager) return;
      tab.items = items;
      this.renderManager();
    });
  }

  private clearManagerSearch(): void {
    const manager = this.manager;
    if (!manager) return;
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.searching = false;
    manager.searchError = undefined;
    manager.results = [];
  }

  private handleManagerInputKey(key: KeyEvent, tab: ManagedSearchTab | ManagedPromptTab): void {
    const manager = this.manager;
    if (!manager) return;
    if (key.name === "escape") {
      const back = manager.tabs.findIndex((candidate) => candidate.kind === "list");
      if (back < 0) {
        this.closeManager();
        return;
      }
      manager.tabIndex = back;
      this.clearManagerSearch();
      manager.index = 0;
      manager.resultIndex = 0;
      this.renderManager();
      this.refreshManagerList();
      return;
    }
    if (tab.kind === "search" && (key.name === "up" || key.name === "down")) {
      if (manager.results.length === 0) return;
      manager.resultIndex =
        key.name === "up"
          ? Math.max(0, manager.resultIndex - 1)
          : Math.min(manager.results.length - 1, manager.resultIndex + 1);
      this.renderManagerBody();
      this.renderer?.requestRender();
      return;
    }
    if (key.name === "return") {
      if (tab.kind === "search") {
        const result = manager.results[manager.resultIndex];
        if (!result) return;
        void Promise.resolve(tab.onAccept(result)).catch((error: unknown) => {
          this.notify(error instanceof Error ? error.message : String(error), "error");
        });
        return;
      }
      const value = manager.input?.value.trim() ?? "";
      if (!value) return;
      void Promise.resolve(tab.onSubmit(value)).catch((error: unknown) => {
        this.notify(error instanceof Error ? error.message : String(error), "error");
      });
      manager.input?.setText("");
      this.renderManagerBody();
      this.renderer?.requestRender();
    }
  }

  private ensureManagerInput(): void {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    if (!manager || !manager.box || !this.renderer) return;
    const wanted = tab && tab.kind !== "list" ? tab.id : undefined;
    if (manager.inputTabId === wanted) return;
    manager.inputBox?.destroyRecursively();
    manager.inputBox = undefined;
    manager.input = undefined;
    manager.inputTabId = wanted;
    if (!wanted || !tab || tab.kind === "list") return;
    const inputBox = new BoxRenderable(this.renderer, {
      id: "skills-manager-input",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "column",
    });
    const input: InputRenderable = new InputRenderable(this.renderer, {
      width: "100%",
      placeholder: tab.placeholder,
      placeholderColor: this.color("inputPlaceholder"),
      backgroundColor: this.theme.colors.inputBg,
      textColor: this.color("inputText"),
      focusedBackgroundColor: this.theme.colors.inputBg,
      focusedTextColor: this.color("inputText"),
      cursorColor: this.color("inputFocus"),
    });
    input.onContentChange = () => this.onManagerInputChange();
    inputBox.add(input);
    manager.box.add(inputBox);
    manager.inputBox = inputBox;
    manager.input = input;
    input.focus();
  }

  private onManagerInputChange(): void {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    if (!manager || tab?.kind !== "search") return;
    const query = manager.input?.value.trim() ?? "";
    manager.query = query;
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.searching = false;
    manager.searchError = undefined;
    if (!query) {
      manager.results = [];
      manager.resultIndex = 0;
      this.renderManager();
      return;
    }
    manager.results = [];
    manager.resultIndex = 0;
    manager.searching = true;
    this.renderManager();
    manager.debounce = setTimeout(() => {
      void this.runManagerSearch(tab, query);
    }, 250);
  }

  private async runManagerSearch(tab: ManagedSearchTab, query: string): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    const controller = new AbortController();
    manager.controller = controller;
    try {
      const results = await tab.search(query, controller.signal);
      if (this.manager !== manager || controller.signal.aborted) return;
      manager.results = results;
      manager.resultIndex = 0;
      manager.searching = false;
      manager.searchError = undefined;
    } catch (error) {
      if (this.manager !== manager || controller.signal.aborted) return;
      manager.searching = false;
      manager.searchError = error instanceof Error ? error.message : String(error);
    }
    this.renderManager();
  }

  private closeManager(): void {
    if (!this.manager) return;
    this.destroyManager();
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
    const manager = this.manager;
    this.textarea?.blur();
    if (!manager.box) {
      const box = new BoxRenderable(this.renderer, {
        id: "skills-manager",
        position: "absolute",
        top: "12%",
        left: "8%",
        width: "84%",
        border: true,
        borderStyle: "rounded",
        borderColor: this.color("accent"),
        backgroundColor: this.theme.background,
        paddingX: 1,
        flexDirection: "column",
        zIndex: 110,
      });
      const headerRow = new TextRenderable(this.renderer, {
        content: "",
        fg: this.color("accent"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      const tabRow = new TextRenderable(this.renderer, {
        content: "",
        fg: this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      const bodyBox = new BoxRenderable(this.renderer, {
        id: "skills-manager-body",
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
      });
      box.add(headerRow);
      box.add(tabRow);
      box.add(bodyBox);
      this.root.add(box);
      manager.box = box;
      manager.headerRow = headerRow;
      manager.tabRow = tabRow;
      manager.bodyBox = bodyBox;
    }
    this.ensureManagerInput();
    this.syncManagerShell();
    this.renderManagerBody();
    this.updateFooter();
    this.renderer.requestRender();
  }

  private syncManagerShell(): void {
    const manager = this.manager;
    if (!manager || !manager.box || !manager.headerRow || !manager.tabRow) return;
    const tab = manager.tabs[manager.tabIndex];
    const visible = this.visibleManagerItems();
    const total = this.managerItems().length;
    const counts =
      tab?.kind === "list" && total > 0 ? `${manager.title}  ${visible.length}/${total}` : manager.title;
    const active = tab?.kind === "list" ? manager.filter : manager.query;
    manager.headerRow.content = active ? `${counts}  /${active}` : counts;
    manager.tabRow.content = manager.tabs
      .map((candidate, index) =>
        index === manager.tabIndex ? `[${candidate.title}]` : ` ${candidate.title} `,
      )
      .join(" ");
    const rows =
      tab?.kind === "list"
        ? Math.min(8, Math.max(visible.length, 1))
        : tab?.kind === "search"
          ? Math.min(6, Math.max(manager.results.length, 1))
          : 1;
    manager.box.height = rows + (tab?.kind === "list" ? 6 : 7);
  }

  private renderManagerBody(): void {
    const manager = this.manager;
    if (!manager?.bodyBox || !this.renderer) return;
    const body = manager.bodyBox;
    for (const child of [...body.getChildren()]) child.destroyRecursively();
    const tab = manager.tabs[manager.tabIndex];
    if (!tab) return;
    const text = (content: string, fg: string): TextRenderable =>
      new TextRenderable(this.renderer!, {
        content,
        fg,
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
    if (tab.kind === "search") {
      if (manager.searchError) {
        body.add(text(manager.searchError, this.color("error")));
      } else if (manager.searching) {
        body.add(text("searching…", this.color("muted")));
      } else if (manager.results.length === 0) {
        body.add(
          text(
            manager.query ? "no results" : "type to search skills.sh",
            this.color("muted"),
          ),
        );
      }
      const rows = Math.min(6, manager.results.length);
      const start = Math.max(0, Math.min(manager.resultIndex - 2, manager.results.length - rows));
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const result = manager.results[start + rowIndex];
        if (!result) continue;
        const selected = start + rowIndex === manager.resultIndex;
        body.add(
          text(
            `${selected ? "› " : "  "}${result.label}`,
            selected ? this.color("accent") : this.color("fg"),
          ),
        );
      }
      body.add(text("↑↓ pick · enter install · esc back", this.color("muted")));
      return;
    }
    if (tab.kind === "prompt") {
      body.add(text("enter install · esc back", this.color("muted")));
      return;
    }
    const visible = this.visibleManagerItems();
    const rows = Math.min(8, Math.max(visible.length, 1));
    if (visible.length === 0) {
      body.add(text("no matches", this.color("muted")));
    }
    const start = Math.max(0, Math.min(manager.index - 3, visible.length - rows));
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const item = visible[start + rowIndex];
      if (!item) continue;
      const selected = start + rowIndex === manager.index;
      body.add(
        new TextRenderable(this.renderer, {
          content: `${selected ? "› " : "  "}[${item.state}] ${item.label}`,
          fg: selected ? this.color("accent") : this.color("fg"),
          wrapMode: "none",
          truncate: true,
          width: "100%",
        }),
      );
    }
    body.add(text("type to filter · space cycle · esc clear/close", this.color("muted")));
  }

  private getClipboard(): ClipboardService | undefined {
    if (!this.renderer || this.stopped) return undefined;
    if (this.options.clipboard) return this.options.clipboard;
    if (!this.clipboard) {
      this.clipboard = createClipboard({
        host: createHostClipboard(),
        terminal: createRendererClipboardAdapter(this.renderer),
      });
    }
    return this.clipboard;
  }

  private async writeClipboard(text: string): Promise<void> {
    if (!text) return;
    const clipboard = this.getClipboard();
    if (!clipboard) return;
    try {
      const result = await clipboard.writeText(text, { destination: "best-available" });
      if (result.host.status === "written" || result.terminal.status === "attempted") {
        this.notify(`Copied ${text.length} chars`);
      } else {
        this.notify("Clipboard write failed", "warn");
      }
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async copyText(): Promise<void> {
    const textarea = this.textarea;
    if (!textarea) return;
    const text = textarea.hasSelection()
      ? textarea.getSelectedText()
      : textarea.plainText;
    if (!text) {
      this.notify("Nothing to copy", "warn");
      return;
    }
    await this.writeClipboard(text);
  }

  private async pasteText(): Promise<void> {
    const textarea = this.textarea;
    if (!textarea) return;
    const clipboard = this.getClipboard();
    if (!clipboard) return;
    try {
      const result = await clipboard.read({
        preferredTypes: ["image/png", "image/jpeg", "text/plain"],
      });
      if (result.status !== "read") {
        this.notify(
          result.status === "empty" ? "Clipboard is empty" : `Clipboard read: ${result.status}`,
          "warn",
        );
        return;
      }
      const canInsert =
        !this.stopped &&
        !this.modal &&
        !this.manager &&
        !this.inputModal &&
        !this.selectState &&
        textarea.focused;
      const { mimeType, bytes } = result.representation;
      if (mimeType === "image/png" || mimeType === "image/jpeg") {
        if (!canInsert) return;
        if (!this.options.attachImage) {
          this.notify("Image paste not available", "warn");
          return;
        }
        if (bytes.length > 5 * 1024 * 1024) {
          this.notify("Image exceeds 5MB limit", "warn");
          return;
        }
        if (this.pendingImages.length >= 10) {
          this.notify("At most 10 images per message", "warn");
          return;
        }
        const attachment = await this.options.attachImage(bytes, mimeType);
        if (!attachment) {
          this.notify("Could not save pasted image", "warn");
          return;
        }
        this.pendingImages.push(attachment);
        textarea.insertText(`[图片 #${this.pendingImages.length}]`);
        return;
      }
      const text = stripAnsiSequences(decodePasteBytes(bytes));
      if (text && canInsert) {
        textarea.insertText(text);
      }
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error), "error");
    }
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
    this.restoreFocus();
    this.updateFooter();
  }

  /** Focus the manager's input when it is still open, otherwise the editor. */
  private restoreFocus(): void {
    if (this.manager?.input) this.manager.input.focus();
    else this.textarea?.focus();
  }

  private renderModal(): void {
    if (!this.renderer || !this.root || !this.modal) return;
    this.modalBox?.destroyRecursively();
    this.textarea?.blur();
    this.manager?.input?.blur();
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
      zIndex: 130,
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

  private finishSelect(value: string | undefined): void {
    const state = this.selectState;
    if (!state) return;
    this.selectState = undefined;
    this.selectBox?.destroyRecursively();
    this.selectBox = undefined;
    state.resolve(value);
    this.restoreFocus();
    this.updateFooter();
  }

  private handleSelectKey(key: KeyEvent): void {
    this.intercept(key);
    const state = this.selectState;
    if (!state) return;
    if (key.name === "up") state.index = Math.max(0, state.index - 1);
    else if (key.name === "down") state.index = Math.min(state.items.length - 1, state.index + 1);
    else if (key.name === "return") {
      this.finishSelect(state.items[state.index]?.value);
      return;
    } else if (key.name === "escape") {
      this.finishSelect(undefined);
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
      zIndex: 130,
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
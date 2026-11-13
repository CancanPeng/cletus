export type ThemeToken =
  | "fg"
  | "muted"
  | "border"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "user"
  | "assistant"
  | "tool"
  | "code"
  | "inputBg"
  | "inputBorder"
  | "inputFocus"
  | "inputText"
  | "inputPlaceholder";

export type SymbolPreset = "unicode" | "nerd" | "ascii";
export type SymbolKey =
  | "app"
  | "model"
  | "cwd"
  | "branch"
  | "session"
  | "ready"
  | "context"
  | "duration"
  | "queue"
  | "yolo"
  | "permission"
  | "skills"
  | "search"
  | "toolCollapsed"
  | "toolExpanded"
  | "preview";

export type Theme = {
  name: "dark" | "light" | "tokyo-night";
  background: string;
  colors: Record<ThemeToken, string>;
  symbols: Record<SymbolKey, string>;
  symbol: (key: SymbolKey) => string;
};

const SYMBOLS: Record<SymbolPreset, Record<SymbolKey, string>> = {
  unicode: {
    app: "◆",
    model: "◈",
    cwd: "⌂",
    branch: "⎇",
    session: "▣",
    ready: "✓ ready",
    context: "▤",
    duration: "◷",
    queue: "≡",
    yolo: "▲",
    permission: "⚑",
    skills: "❖",
    search: "⌕",
    toolCollapsed: "▸",
    toolExpanded: "▾",
    preview: "→",
  },
  nerd: {
    app: "\uf120",
    model: "\uf2db",
    cwd: "\uf07b",
    branch: "\ue725",
    session: "\uf2c0",
    ready: "\uf00c ready",
    context: "\uf1c0",
    duration: "\uf017",
    queue: "\uf0c9",
    yolo: "\uf0e7",
    permission: "\uf023",
    skills: "\uf085",
    search: "\uf002",
    toolCollapsed: "\uf0da",
    toolExpanded: "\uf0d7",
    preview: "\uf061",
  },
  ascii: {
    app: "*",
    model: "M",
    cwd: "cwd",
    branch: "git",
    session: "id",
    ready: "ready",
    context: "ctx",
    duration: "time",
    queue: "q",
    yolo: "!",
    permission: "lock",
    skills: "*",
    search: "?",
    toolCollapsed: ">",
    toolExpanded: "v",
    preview: ">",
  },
};

const THEMES: Record<Theme["name"], Omit<Theme, "name" | "symbols" | "symbol">> = {
  dark: {
    background: "#16161e",
    colors: {
      fg: "#c0caf5",
      muted: "#565f89",
      border: "#3b4261",
      accent: "#7aa2f7",
      success: "#9ece6a",
      warning: "#e0af68",
      error: "#f7768e",
      user: "#7dcfff",
      assistant: "#c0caf5",
      tool: "#bb9af7",
      code: "#ff9e64",
      inputBg: "#1f2335",
      inputBorder: "#3b4261",
      inputFocus: "#7aa2f7",
      inputText: "#c0caf5",
      inputPlaceholder: "#565f89",
    },
  },
  light: {
    background: "#f7f7fb",
    colors: {
      fg: "#1f2335",
      muted: "#6b7089",
      border: "#d0d5e3",
      accent: "#2e7de9",
      success: "#587539",
      warning: "#8c6c3e",
      error: "#b5294d",
      user: "#007197",
      assistant: "#1f2335",
      tool: "#6c4bb6",
      code: "#965027",
      inputBg: "#ffffff",
      inputBorder: "#d0d5e3",
      inputFocus: "#2e7de9",
      inputText: "#1f2335",
      inputPlaceholder: "#6b7089",
    },
  },
  "tokyo-night": {
    background: "#1a1b26",
    colors: {
      fg: "#c0caf5",
      muted: "#565f89",
      border: "#414868",
      accent: "#7aa2f7",
      success: "#9ece6a",
      warning: "#e0af68",
      error: "#f7768e",
      user: "#7dcfff",
      assistant: "#c0caf5",
      tool: "#bb9af7",
      code: "#ff9e64",
      inputBg: "#1f2335",
      inputBorder: "#414868",
      inputFocus: "#7aa2f7",
      inputText: "#c0caf5",
      inputPlaceholder: "#565f89",
    },
  },
};

export type SymbolConfig = {
  preset?: SymbolPreset;
  overrides?: Record<string, string>;
};

export function getTheme(name: string, symbols?: SymbolConfig): Theme {
  const key = name in THEMES ? (name as Theme["name"]) : "dark";
  if (key !== name) process.stderr.write(`Warning: unknown theme ${name}; using dark\n`);
  const presetName = symbols?.preset ?? "unicode";
  const preset = presetName in SYMBOLS ? presetName : "unicode";
  if (preset !== presetName) {
    process.stderr.write(`Warning: unknown symbol preset ${presetName}; using unicode\n`);
  }
  const resolved: Record<SymbolKey, string> = {
    ...SYMBOLS[preset],
  };
  for (const [keyName, value] of Object.entries(symbols?.overrides ?? {})) {
    if (keyName in resolved && typeof value === "string") {
      resolved[keyName as SymbolKey] = value;
    }
  }
  return {
    name: key,
    ...THEMES[key],
    symbols: resolved,
    symbol: (symbolKey) => resolved[symbolKey],
  };
}

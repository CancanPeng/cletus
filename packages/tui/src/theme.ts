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
  | "code";

export type Theme = {
  name: "dark" | "light" | "tokyo-night";
  background: string;
  colors: Record<ThemeToken, string>;
};

const THEMES: Record<Theme["name"], Omit<Theme, "name">> = {
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
    },
  },
};

export function getTheme(name: string): Theme {
  const key = name in THEMES ? (name as Theme["name"]) : "dark";
  if (key !== name) process.stderr.write(`Warning: unknown theme ${name}; using dark\n`);
  return { name: key, ...THEMES[key] };
}
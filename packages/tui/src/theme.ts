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
  style: (token: ThemeToken, text: string) => string;
};

const PALETTES: Record<Theme["name"], Record<ThemeToken, number>> = {
  dark: {
    fg: 252,
    muted: 244,
    border: 238,
    accent: 39,
    success: 40,
    warning: 214,
    error: 196,
    user: 75,
    assistant: 252,
    tool: 180,
    code: 180,
  },
  light: {
    fg: 235,
    muted: 245,
    border: 250,
    accent: 25,
    success: 28,
    warning: 130,
    error: 160,
    user: 25,
    assistant: 235,
    tool: 94,
    code: 94,
  },
  "tokyo-night": {
    fg: 189,
    muted: 103,
    border: 60,
    accent: 111,
    success: 120,
    warning: 179,
    error: 203,
    user: 117,
    assistant: 189,
    tool: 141,
    code: 141,
  },
};

export function getTheme(name: string): Theme {
  const key = name in PALETTES ? (name as Theme["name"]) : "dark";
  if (key !== name) process.stderr.write(`Warning: unknown theme ${name}; using dark\n`);
  const palette = PALETTES[key];
  return {
    name: key,
    style: (token, text) =>
      text.length === 0 ? "" : `\x1b[38;5;${palette[token]}m${text}\x1b[0m`,
  };
}
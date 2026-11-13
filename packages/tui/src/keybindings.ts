export type Action =
  | "submit"
  | "newline"
  | "abort"
  | "exit"
  | "cancel"
  | "followUp"
  | "scrollUp"
  | "scrollDown"
  | "scrollBottom"
  | "toggleToolOutput"
  | "complete"
  | "historyPrev"
  | "historyNext"
  | "modalAllow"
  | "modalSession"
  | "modalDeny"
  | "copy"
  | "paste";

const DEFAULTS: Record<Action, string[]> = {
  submit: ["enter"],
  newline: ["ctrl+j"],
  followUp: ["alt+enter"],
  abort: ["ctrl+c"],
  exit: ["ctrl+d"],
  cancel: ["esc"],
  scrollUp: ["pgup"],
  scrollDown: ["pgdown"],
  scrollBottom: ["ctrl+end"],
  toggleToolOutput: ["ctrl+o"],
  complete: ["tab"],
  historyPrev: ["up"],
  historyNext: ["down"],
  modalAllow: ["y"],
  modalSession: ["a"],
  modalDeny: ["n"],
  copy: ["super+c", "ctrl+shift+c"],
  paste: ["super+v", "ctrl+shift+v", "ctrl+v"],
};

const ALIASES: Record<string, string> = {
  return: "enter",
  escape: "esc",
  pageup: "pgup",
  pagedown: "pgdown",
};

export type KeyLike = {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
};

const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;

function canonical(name: string, mods: ReadonlySet<string>): string {
  const key = ALIASES[name] ?? name;
  const prefix = MODIFIERS.filter((mod) => mods.has(mod)).map((mod) => `${mod}+`).join("");
  return `${prefix}${key}`;
}

function normalize(binding: string): string {
  const parts = binding.trim().toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean);
  const name = parts.pop() ?? "";
  return canonical(name, new Set(parts));
}

function keyId(key: KeyLike): string {
  const mods = new Set<string>();
  if (key.ctrl) mods.add("ctrl");
  if (key.meta || key.option) mods.add("alt");
  // Shift alone on a single letter is just the capital form (modal y/n);
  // combined with other modifiers it is a distinct chord (ctrl+shift+c).
  const otherMods = key.ctrl || key.meta || key.option || key.super;
  if (key.shift && (key.name.length > 1 || otherMods)) mods.add("shift");
  if (key.super) mods.add("super");
  return canonical(key.name.toLowerCase(), mods);
}

export class KeybindingsManager {
  private readonly bindings = new Map<Action, string[]>();

  constructor(overrides: Record<string, string | string[]> = {}) {
    for (const action of Object.keys(DEFAULTS) as Action[]) {
      this.bindings.set(action, [...DEFAULTS[action]]);
    }
    for (const [rawAction, value] of Object.entries(overrides)) {
      if (!Object.hasOwn(DEFAULTS, rawAction)) {
        process.stderr.write(`Warning: unknown keybinding action ${rawAction}\n`);
        continue;
      }
      const action = rawAction as Action;
      const list = (Array.isArray(value) ? value : [value])
        .map(normalize)
        .filter((key) => key.length > 0);
      if (list.length === 0) {
        process.stderr.write(`Warning: empty keybinding for ${rawAction}\n`);
        continue;
      }
      this.bindings.set(action, list);
    }
    const conflict = this.conflicts()[0];
    if (conflict) {
      throw new Error(
        `Keybinding conflict: ${conflict.key} is bound to ${conflict.actions[0]} and ${conflict.actions[1]}`,
      );
    }
  }

  matches(key: KeyLike, action: Action): boolean {
    return (this.bindings.get(action) ?? []).includes(keyId(key));
  }

  get(action: Action): string[] {
    return [...(this.bindings.get(action) ?? [])];
  }

  list(): Array<{ action: Action; keys: string[] }> {
    return [...this.bindings.entries()].map(([action, keys]) => ({
      action,
      keys: [...keys],
    }));
  }

  conflicts(): Array<{ key: string; actions: Action[] }> {
    const byKey = new Map<string, Action[]>();
    for (const [action, keys] of this.bindings) {
      for (const key of keys) {
        const actions = byKey.get(key) ?? [];
        actions.push(action);
        byKey.set(key, actions);
      }
    }
    return [...byKey.entries()]
      .filter(([, actions]) => actions.length > 1)
      .map(([key, actions]) => ({ key, actions }));
  }
}
import { keyId, type Key } from "./keys.js";

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
  | "modalDeny";

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
};

const ALIASES: Record<string, string> = {
  pageup: "pgup",
  pagedown: "pgdown",
  return: "enter",
  escape: "esc",
  "ctrl+return": "ctrl+enter",
};

function normalize(binding: string): string {
  const lower = binding.trim().toLowerCase().replace(/\s+/g, "");
  return ALIASES[lower] ?? lower;
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
    const conflicts = this.conflicts();
    if (conflicts.length > 0) {
      const first = conflicts[0];
      if (first) {
        throw new Error(
          `Keybinding conflict: ${first.key} is bound to ${first.actions[0]} and ${first.actions[1]}`,
        );
      }
    }
  }

  matches(key: Key, action: Action): boolean {
    return this.get(action).includes(keyId(key));
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
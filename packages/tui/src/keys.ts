export type Key = {
  name: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

const SEQUENCES: Array<[string, string]> = [
  ["\x1b[200~", "paste-start"],
  ["\x1b[201~", "paste-end"],
  ["\x1b[1;5A", "ctrl+up"],
  ["\x1b[1;5B", "ctrl+down"],
  ["\x1b[1;5C", "ctrl+right"],
  ["\x1b[1;5D", "ctrl+left"],
  ["\x1b[1;2A", "shift+up"],
  ["\x1b[1;2B", "shift+down"],
  ["\x1b[1;2C", "shift+right"],
  ["\x1b[1;2D", "shift+left"],
  ["\x1b[A", "up"],
  ["\x1b[B", "down"],
  ["\x1b[C", "right"],
  ["\x1b[D", "left"],
  ["\x1b[5~", "pgup"],
  ["\x1b[6~", "pgdown"],
  ["\x1b[H", "home"],
  ["\x1b[F", "end"],
  ["\x1b[1~", "home"],
  ["\x1b[4~", "end"],
  ["\x1b[3~", "delete"],
  ["\x1b[Z", "shift+tab"],
  ["\x1b\r", "alt+enter"],
  ["\x1b\n", "alt+enter"],
];

const CONTROL: Record<string, string> = {
  "\x03": "ctrl+c",
  "\x04": "ctrl+d",
  "\x0a": "ctrl+j",
  "\x0b": "ctrl+k",
  "\x15": "ctrl+u",
  "\x01": "ctrl+a",
  "\x05": "ctrl+e",
  "\x0f": "ctrl+o",
  "\x0c": "ctrl+l",
  "\x17": "ctrl+w",
  "\x18": "ctrl+x",
  "\x1b": "esc",
  "\r": "enter",
  "\t": "tab",
  "\x7f": "backspace",
};

export class InputParser {
  private buffer = "";

  feed(data: string): Key[] {
    this.buffer += data;
    const keys: Key[] = [];
    for (;;) {
      if (!this.buffer) break;
      if (this.buffer.startsWith("\x1b[200~")) {
        const end = this.buffer.indexOf("\x1b[201~");
        if (end < 0) break;
        const text = this.buffer.slice(6, end);
        this.buffer = this.buffer.slice(end + 6);
        keys.push({ name: "paste", text });
        continue;
      }
      const sequence = SEQUENCES.find(([prefix]) => this.buffer.startsWith(prefix));
      if (sequence) {
        this.buffer = this.buffer.slice(sequence[0].length);
        const name = sequence[1];
        if (name === "ctrl+up" || name === "ctrl+down" || name === "ctrl+left" || name === "ctrl+right") {
          keys.push({ name: name.slice(5), ctrl: true });
        } else if (name.startsWith("shift+")) {
          keys.push({ name: name.slice(6), shift: true });
        } else {
          keys.push({ name });
        }
        continue;
      }
      if (this.buffer.length > 1) {
        if ("\x1b[200~".startsWith(this.buffer)) break;
        if (SEQUENCES.some(([prefix]) => prefix.startsWith(this.buffer))) break;
      }
      if (this.buffer.startsWith("\x1b")) {
        if (this.buffer.length === 1) {
          this.buffer = "";
          keys.push({ name: "esc" });
          continue;
        }
        if (this.buffer.length < 3 && this.buffer[1] === "[") break;
        if (this.buffer.length < 2) break;
      }
      const char = String.fromCodePoint(this.buffer.codePointAt(0) ?? 0);
      if (CONTROL[char]) {
        this.buffer = this.buffer.slice(char.length);
        const name = CONTROL[char] as string;
        keys.push(name.startsWith("ctrl+") ? { name: name.slice(5), ctrl: true } : { name });
        continue;
      }
      this.buffer = this.buffer.slice(char.length);
      keys.push({ name: "char", text: char });
    }
    return keys;
  }

  flush(): Key[] {
    if (!this.buffer) return [];
    const rest = this.buffer;
    this.buffer = "";
    return rest === "\x1b" ? [{ name: "esc" }] : [];
  }
}

export function keyId(key: Key): string {
  if (key.name === "char" && key.text) return key.text;
  if (key.ctrl) return `ctrl+${key.name}`;
  if (key.alt) return `alt+${key.name}`;
  if (key.shift) return `shift+${key.name}`;
  return key.name;
}
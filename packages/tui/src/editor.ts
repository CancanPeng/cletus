import type { Key } from "./keys.js";
import type { KeybindingsManager } from "./keybindings.js";
import { visibleWidth, wrapText } from "./utils.js";

export class Editor {
  value = "";
  cursor = 0;

  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  insert(text: string): void {
    this.value = `${this.value.slice(0, this.cursor)}${text}${this.value.slice(this.cursor)}`;
    this.cursor += text.length;
  }

  handle(key: Key, bindings: KeybindingsManager): "submit" | "changed" | "none" {
    if (bindings.matches(key, "submit")) return "submit";
    if (bindings.matches(key, "newline")) {
      this.insert("\n");
      return "changed";
    }
    if (key.name === "char" && key.text) {
      this.insert(key.text);
      return "changed";
    }
    if (key.name === "paste" && key.text) {
      this.insert(key.text);
      return "changed";
    }
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return "changed";
    }
    if (key.name === "delete") {
      if (this.cursor < this.value.length) {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      }
      return "changed";
    }
    if (key.name === "left" && !key.ctrl) {
      this.cursor = Math.max(0, this.cursor - 1);
      return "changed";
    }
    if (key.name === "right" && !key.ctrl) {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return "changed";
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      const lineStart = this.value.lastIndexOf("\n", Math.max(0, this.cursor - 1)) + 1;
      this.cursor = lineStart;
      return "changed";
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      const lineEnd = this.value.indexOf("\n", this.cursor);
      this.cursor = lineEnd < 0 ? this.value.length : lineEnd;
      return "changed";
    }
    if (key.ctrl && key.name === "k") {
      const lineEnd = this.value.indexOf("\n", this.cursor);
      this.value = this.value.slice(0, this.cursor) + (lineEnd < 0 ? "" : this.value.slice(lineEnd));
      return "changed";
    }
    if (key.ctrl && key.name === "u") {
      this.value = "";
      this.cursor = 0;
      return "changed";
    }
    if (key.ctrl && key.name === "w") {
      const before = this.value.slice(0, this.cursor);
      const match = /(\s*\S+)$/.exec(before);
      const remove = match ? match[0].length : 0;
      this.value = this.value.slice(0, this.cursor - remove) + this.value.slice(this.cursor);
      this.cursor -= remove;
      return "changed";
    }
    if (key.name === "up" || key.name === "down") {
      const direction = key.name === "up" ? -1 : 1;
      const lineStart = this.value.lastIndexOf("\n", Math.max(0, this.cursor - 1)) + 1;
      const column = this.cursor - lineStart;
      const targetStart =
        direction < 0
          ? this.value.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1
          : this.value.indexOf("\n", this.cursor) + 1;
      if (targetStart > 0) {
        const targetEnd = this.value.indexOf("\n", targetStart);
        const max = targetEnd < 0 ? this.value.length : targetEnd;
        this.cursor = Math.min(targetStart + column, max);
        return "changed";
      }
    }
    return "none";
  }

  render(width: number, rows: number): { lines: string[]; row: number; col: number } {
    const hardLines = this.value.split("\n");
    const rendered: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let offset = 0;
    for (let index = 0; index < hardLines.length; index += 1) {
      const line = hardLines[index] ?? "";
      const wrapped = wrapText(line, Math.max(1, width));
      const lineOffset = this.cursor - offset;
      if (index === hardLines.length - 1 || (lineOffset >= 0 && lineOffset <= line.length)) {
        if (this.cursor >= offset && this.cursor <= offset + line.length) {
          const before = line.slice(0, lineOffset);
          const prefixLines = wrapText(before, Math.max(1, width));
          cursorRow = rendered.length + prefixLines.length - 1;
          cursorCol = visibleWidth(prefixLines[prefixLines.length - 1] ?? "");
        }
      }
      rendered.push(...wrapped);
      offset += line.length + 1;
    }
    const viewport = Math.max(1, rows);
    const scroll = cursorRow >= viewport ? cursorRow - viewport + 1 : 0;
    const lines = rendered.slice(scroll, scroll + viewport);
    while (lines.length < viewport) lines.push("");
    return {
      lines,
      row: Math.max(0, Math.min(viewport - 1, cursorRow - scroll)),
      col: Math.max(0, Math.min(width - 1, cursorCol)),
    };
  }
}
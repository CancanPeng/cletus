import stringWidth from "string-width";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleWidth(text: string): number {
  return stringWidth(text.replace(ANSI, ""));
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let result = "";
  let used = 0;
  for (let index = 0; index < text.length; ) {
    if (text[index] === "\x1b") {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(index));
      if (match) {
        result += match[0];
        index += match[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
    const charWidth = stringWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
    index += char.length;
  }
  return `${result}${used < width ? " ".repeat(width - used) : ""}\x1b[0m`;
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of raw.split(/(\s+)/)) {
      if (!word) continue;
      if (visibleWidth(current + word) <= width) {
        current += word;
        continue;
      }
      if (current.trim()) {
        lines.push(current.trimEnd());
        current = "";
      }
      if (visibleWidth(word) > width) {
        let buffer = "";
        for (const char of word) {
          if (visibleWidth(buffer + char) > width) {
            lines.push(buffer);
            buffer = char;
          } else {
            buffer += char;
          }
        }
        current = buffer;
      } else {
        current = word.trimStart();
      }
    }
    if (current || raw === "") lines.push(current);
  }
  return lines;
}
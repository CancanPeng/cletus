import type { Terminal } from "./terminal.js";
import { truncateToWidth } from "./utils.js";

export class FrameRenderer {
  private previous: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;

  constructor(private readonly terminal: Terminal) {}

  render(frame: string[], cursor?: { row: number; col: number }): void {
    const width = this.terminal.width;
    const height = this.terminal.height;
    const normalized = frame.slice(0, height).map((line) => truncateToWidth(line, width));
    while (normalized.length < height) normalized.push(" ".repeat(width));

    let output = "";
    const resized = width !== this.previousWidth || height !== this.previousHeight;
    let prefix = 0;
    while (
      prefix < normalized.length &&
      prefix < this.previous.length &&
      normalized[prefix] === this.previous[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < normalized.length - prefix &&
      suffix < this.previous.length - prefix &&
      normalized[normalized.length - 1 - suffix] === this.previous[this.previous.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const changed = normalized.length - prefix - suffix;
    const full = resized || changed > normalized.length * 0.5;

    if (full) {
      output += "\x1b[2J\x1b[H";
      for (let row = 0; row < normalized.length; row += 1) {
        output += `\x1b[2K${normalized[row] ?? ""}`;
        if (row < normalized.length - 1) output += "\r\n";
      }
    } else if (changed > 0) {
      for (let row = prefix; row < normalized.length - suffix; row += 1) {
        output += `\x1b[${row + 1};1H\x1b[2K${normalized[row] ?? ""}`;
      }
    }

    if (cursor) {
      output += `\x1b[?25h\x1b[${Math.min(cursor.row, height - 1) + 1};${
        Math.min(cursor.col, width - 1) + 1
      }H`;
    } else {
      output += "\x1b[?25l";
    }

    this.previous = normalized;
    this.previousWidth = width;
    this.previousHeight = height;
    if (output) this.terminal.write(output);
  }

  clear(): void {
    this.previous = [];
    this.previousWidth = 0;
    this.previousHeight = 0;
    this.terminal.write("\x1b[2J\x1b[H");
  }
}
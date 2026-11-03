import { describe, expect, it } from "vitest";
import type { Terminal } from "../src/terminal.js";
import { FrameRenderer } from "../src/renderer.js";
import { visibleWidth, truncateToWidth } from "../src/utils.js";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  width = 120;
  height = 40;
  isTTY = true;
  private input: ((data: string) => void) | undefined;
  private resize: (() => void) | undefined;
  write(data: string): void {
    this.writes.push(data);
  }
  onInput(listener: (data: string) => void): () => void {
    this.input = listener;
    return () => {
      this.input = undefined;
    };
  }
  onResize(listener: () => void): () => void {
    this.resize = listener;
    return () => {
      this.resize = undefined;
    };
  }
  start(): void {}
  stop(): void {}
  feed(data: string): void {
    this.input?.(data);
  }
  triggerResize(): void {
    this.resize?.();
  }
}

describe("FrameRenderer", () => {
  it("only rewrites changed lines", () => {
    const terminal = new FakeTerminal();
    const renderer = new FrameRenderer(terminal);
    const frame = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    renderer.render(frame);
    terminal.writes = [];
    const changed = [...frame];
    changed[10] = "changed";
    renderer.render(changed);
    const output = terminal.writes.join("");
    expect(output).toContain("\x1b[2K");
    expect(output).not.toContain("\x1b[2J");
    expect(output.match(/\x1b\[2K/g)).toHaveLength(1);
    expect(output).toContain("changed");
  });

  it("redraws fully on resize", () => {
    const terminal = new FakeTerminal();
    const renderer = new FrameRenderer(terminal);
    const frame = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    renderer.render(frame);
    terminal.writes = [];
    terminal.width = 80;
    renderer.render(frame);
    expect(terminal.writes.join("")).toContain("\x1b[2J");
  });

  it("counts wide characters correctly", () => {
    expect(visibleWidth("你")).toBe(2);
    expect(visibleWidth(truncateToWidth("你", 1))).toBe(1);
  });
});
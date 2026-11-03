import process from "node:process";

export interface Terminal {
  readonly width: number;
  readonly height: number;
  readonly isTTY: boolean;
  write(data: string): void;
  onInput(listener: (data: string) => void): () => void;
  onResize(listener: () => void): () => void;
  start(): void;
  stop(): void;
}

export class ProcessTerminal implements Terminal {
  private started = false;
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<() => void>();
  private readonly onData = (data: Buffer): void => {
    for (const listener of this.inputListeners) listener(data.toString("utf8"));
  };
  private readonly handleResize = (): void => {
    for (const listener of this.resizeListeners) listener();
  };
  private readonly cleanup = (): void => this.stop();

  get width(): number {
    return process.stdout.columns ?? 80;
  }
  get height(): number {
    return process.stdout.rows ?? 24;
  }
  get isTTY(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  onInput(listener: (data: string) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  onResize(listener: () => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
    }
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.handleResize);
    process.on("SIGWINCH", this.handleResize);
    process.on("exit", this.cleanup);
    this.write("\x1b[?1049h\x1b[?2004h\x1b[?25l");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.handleResize);
    process.off("SIGWINCH", this.handleResize);
    process.off("exit", this.cleanup);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.write("\x1b[?25h\x1b[?2004l\x1b[?1049l");
  }
}
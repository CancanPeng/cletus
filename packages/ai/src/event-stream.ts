import type {
  AssistantMessage,
  AssistantStreamEvent,
  LlmContext,
  Model,
  StreamOptions,
} from "./types.js";

export type StreamFn = (
  model: Model,
  context: LlmContext,
  options?: StreamOptions,
) => AssistantEventStream;

type Waiter = (result: IteratorResult<AssistantStreamEvent>) => void;

export class AssistantEventStream implements AsyncIterable<AssistantStreamEvent> {
  private readonly queue: AssistantStreamEvent[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private finalMessage: AssistantMessage | undefined;
  private readonly resultPromise: Promise<AssistantMessage>;
  private resolveResult!: (message: AssistantMessage) => void;
  private rejectResult!: (error: unknown) => void;

  constructor() {
    const { promise, resolve, reject } = Promise.withResolvers<AssistantMessage>();
    this.resultPromise = promise;
    this.resolveResult = resolve;
    this.rejectResult = reject;
    // Consumers may only await result(); avoid unhandled rejection noise.
    this.resultPromise.catch(() => undefined);
  }

  push(event: AssistantStreamEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(message: AssistantMessage): void {
    if (this.closed) return;
    this.push({ type: "done", message });
    this.close(message);
  }

  fail(message: AssistantMessage, error: string): void {
    if (this.closed) return;
    this.push({ type: "error", message, error });
    this.close(message);
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  private close(message: AssistantMessage): void {
    this.closed = true;
    this.finalMessage = message;
    this.resolveResult(message);
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantStreamEvent> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<AssistantStreamEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: () => {
        this.closed = true;
        if (this.finalMessage) this.resolveResult(this.finalMessage);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export function errorStream(
  message: AssistantMessage,
  error: string,
): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.fail(message, error);
  return stream;
}
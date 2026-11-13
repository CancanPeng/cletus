import type {
  AssistantMessage,
  AssistantStreamEvent,
  LlmContext,
  Model,
  StreamOptions,
} from "./types.js";
import { emptyUsage } from "./types.js";

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
  private partialMessage: AssistantMessage | undefined;
  private readonly resultPromise: Promise<AssistantMessage>;
  private resolveResult!: (message: AssistantMessage) => void;

  constructor() {
    const { promise, resolve } = Promise.withResolvers<AssistantMessage>();
    this.resultPromise = promise;
    this.resolveResult = resolve;
    // Consumers may only await result(); avoid unhandled rejection noise.
    this.resultPromise.catch(() => undefined);
  }

  push(event: AssistantStreamEvent): void {
    if (this.closed) return;
    if (event.type === "start") this.partialMessage = event.partial;
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
        for (const waiter of this.waiters.splice(0)) {
          waiter({ value: undefined, done: true });
        }
        // Early consumer exit must still settle result() waiters.
        const aborted: AssistantMessage = {
          ...(this.partialMessage ?? {
            role: "assistant",
            content: [],
            provider: "",
            model: "",
            usage: emptyUsage(),
            timestamp: Date.now(),
          }),
          stopReason: "aborted",
        };
        this.resolveResult(this.finalMessage ?? aborted);
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
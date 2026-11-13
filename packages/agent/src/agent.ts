import type { Message, Model } from "@cletus/ai";
import { runAgentLoop } from "./loop.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
} from "./types.js";

export class Agent {
  private readonly options: AgentOptions;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private systemPrompt: string;
  private messages: AgentMessage[];
  private tools: AgentTool[];
  private model: Model;
  private running = false;
  private controller: AbortController | undefined;
  private abortRequested = false;
  private readonly steering: string[] = [];
  private readonly followUps: string[] = [];
  private idle = Promise.resolve();
  private resolveIdle: (() => void) | undefined;

  constructor(options: AgentOptions) {
    this.options = options;
    this.systemPrompt = options.initialState?.systemPrompt ?? "";
    this.messages = [...(options.initialState?.messages ?? [])];
    this.tools = [...(options.initialState?.tools ?? [])];
    this.model = options.model;
  }

  get state(): AgentState {
    return {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: [...this.tools],
      model: this.model,
      isStreaming: this.running,
    };
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        process.stderr.write(
          `Agent listener error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  async prompt(text: string): Promise<void> {
    if (this.running) throw new Error("Agent is already running; use steer() or followUp()");
    // Queued steering/follow-ups stay queued: the loop drains them per turn,
    // so nothing is lost if the run fails before the first drain.
    await this.run([text]);
  }

  async continue(): Promise<void> {
    if (this.running) throw new Error("Agent is already running; use steer() or followUp()");
    const projection = this.convert(this.messages);
    const last = projection[projection.length - 1];
    if (!last || (last.role !== "user" && last.role !== "toolResult")) {
      throw new Error("Cannot continue: last message is not user or toolResult");
    }
    await this.run([]);
  }

  steer(text: string): void {
    this.steering.push(text);
  }

  followUp(text: string): void {
    this.followUps.push(text);
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort();
    } else {
      // Remember aborts issued before the first run (e.g. dispose()).
      this.abortRequested = true;
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.running) return;
    await this.idle;
  }

  setTools(tools: AgentTool[]): void {
    this.tools = [...tools];
  }

  replaceProjection(messages: AgentMessage[]): void {
    this.messages = [...messages];
  }

  setModel(model: Model): void {
    this.model = model;
  }

  get queuedMessageCount(): number {
    return this.steering.length + this.followUps.length;
  }

  private convert(messages: AgentMessage[]): Message[] {
    if (this.options.convertToLlm) return this.options.convertToLlm(messages);
    return messages.map((message) =>
      message.role === "custom"
        ? {
            role: "user" as const,
            content: `[${message.customType}]\n${message.content}`,
            timestamp: message.timestamp,
          }
        : message,
    );
  }

  private async run(prompts: string[]): Promise<void> {
    this.running = true;
    this.controller = new AbortController();
    if (this.abortRequested) {
      this.controller.abort();
      this.abortRequested = false;
    }
    const idle = Promise.withResolvers<void>();
    this.idle = idle.promise;
    this.resolveIdle = idle.resolve;
    try {
      await runAgentLoop(
        prompts,
        {
          systemPrompt: this.systemPrompt,
          messages: this.messages,
          tools: this.tools,
        },
        {
          model: this.model,
          streamFn: this.options.streamFn,
          ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
          ...(this.options.getApiKey ? { getApiKey: this.options.getApiKey } : {}),
          tools: this.tools,
          ...(this.options.maxTurns !== undefined ? { maxTurns: this.options.maxTurns } : {}),
          convertToLlm: (messages) => this.convert(messages),
          ...(this.options.prepareRequest
            ? {
                prepareRequest: async (context) => {
                  const result = await this.options.prepareRequest?.(context);
                  if (result?.systemPrompt !== undefined) this.systemPrompt = result.systemPrompt;
                  if (result?.messages) this.messages = [...result.messages];
                  if (result?.model) this.model = result.model;
                  return result;
                },
              }
            : {}),
          ...(this.options.beforeToolCall
            ? { beforeToolCall: this.options.beforeToolCall }
            : {}),
          ...(this.options.afterToolCall
            ? { afterToolCall: this.options.afterToolCall }
            : {}),
          drainSteering: () => this.steering.splice(0),
          drainFollowUp: () => this.followUps.splice(0, 1),
        },
        (event) => {
          if (event.type === "agent_end") this.messages = [...event.messages];
          return this.emit(event);
        },
        this.controller.signal,
      );
    } finally {
      this.running = false;
      this.resolveIdle?.();
      this.resolveIdle = undefined;
    }
  }
}
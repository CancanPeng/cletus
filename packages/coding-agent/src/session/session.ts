import {
  streamSimple,
  estimateContextTokens,
  type AssistantMessage,
  type ImageAttachment,
  type LlmContext,
  type Model,
  type StreamFn,
} from "@cletus/ai";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@cletus/agent";
import type { CletusConfig, AuthStore } from "../config.js";
import { cletusHome, resolveApiKey, resolveModel } from "../config.js";
import type { PermissionPolicy } from "../permissions/policy.js";
import type { ResourceLoader } from "../resources/index.js";
import { buildSystemPrompt } from "../prompt/system.js";
import {
  createCoreTools,
  type SubagentRequest,
} from "../tools/index.js";
import { createSubagentRunner } from "../subagent.js";
import { createTaskTool } from "../tools/task.js";
import { SessionManager } from "./manager.js";
import { buildProjection } from "./context.js";
import { compact, shouldCompact } from "./compaction.js";
import type { McpManager } from "../mcp/manager.js";
import type { ExtensionHost } from "../extensions/host.js";

export type CreateSessionOptions = {
  cwd: string;
  config: CletusConfig;
  auth: AuthStore;
  model: Model;
  sessionManager?: SessionManager;
  permissions: PermissionPolicy;
  resources: ResourceLoader;
  mcp?: McpManager;
  extensions?: ExtensionHost;
  onNotice?: (text: string, level?: "info" | "warn" | "error") => void;
  streamFn?: StreamFn;
  home?: string;
};

export class AgentSession {
  readonly agent: Agent;
  readonly manager: SessionManager;
  model: Model;
  private readonly options: CreateSessionOptions;
  private readonly home: string;
  private resources: Awaited<ReturnType<ResourceLoader["load"]>>;
  private readonly streamFn: StreamFn;
  private readonly persisted = new WeakSet<AgentMessage>();
  private systemPrompt = "";

  private constructor(options: CreateSessionOptions, manager: SessionManager) {
    this.options = options;
    this.manager = manager;
    this.model = options.model;
    this.home = options.home ?? cletusHome();
    this.streamFn = options.streamFn ?? streamSimple;
    this.agent = new Agent({
      model: this.model,
      streamFn: this.streamFn,
      cwd: options.cwd,
      initialState: { messages: [], tools: [] },
      maxTurns: options.config.maxTurns,
      maxAutoContinues: options.config.maxAutoContinues,
      getApiKey: (model) => resolveApiKey(options.config, options.auth, model),
      prepareRequest: (ctx) => this.prepareRequest(ctx),
      beforeToolCall: async (call, args) => this.beforeToolCall(call.name, args),
      afterToolCall: async (call, result) => {
        await options.extensions?.afterToolCall(call.name, call.arguments, result);
      },
    });
    this.resources = {
      skills: [],
      prompts: [],
      contextFiles: [],
      readOnlyRoots: [],
    };
  }

  static async create(options: CreateSessionOptions): Promise<AgentSession> {
    const manager = options.sessionManager ?? (await SessionManager.create(options.cwd));
    const session = new AgentSession(options, manager);
    session.resources = await options.resources.load();
    options.permissions.setReadOnlyRoots(session.resources.readOnlyRoots);
    const projection = buildProjection(manager);
    let model = options.model;
    const branch = manager.getBranch();
    for (const entry of branch) {
      if (entry.type === "model_change") {
        try {
          model = resolveModel(options.config, options.auth, entry.ref);
        } catch (error) {
          options.onNotice?.(
            `Could not restore model ${entry.ref}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warn",
          );
        }
      }
    }
    session.model = model;
    session.agent.replaceProjection(projection.messages);
    session.agent.setModel(model);
    session.systemPrompt = buildSystemPrompt({
      cwd: options.cwd,
      tools: [],
      contextFiles: session.resources.contextFiles,
      skills: session.resources.skills,
    });
    session.refreshTools();
    session.agent.subscribe((event) => session.handleEvent(event));
    options.extensions?.bindSession({
      manager,
      notify: (message) => options.onNotice?.(message, "warn"),
    });
    return session;
  }

  private toolsFor(cwd: string, excludeTask: boolean, policy: PermissionPolicy): AgentTool[] {
    const core = createCoreTools({
      cwd,
      policy,
      home: this.home,
      model: this.model,
      sessionId: this.manager.sessionId,
      webSearch: this.options.config.webSearch,
    });
    if (excludeTask) return core;
    const subagent = createSubagentRunner({
      cwd,
      model: this.model,
      streamFn: this.streamFn,
      policy,
      createTools: (childCwd, extra) => this.toolsFor(childCwd, extra.excludeTask, extra.policy),
      buildSystemPrompt: (tools) =>
        buildSystemPrompt({
          cwd,
          tools,
          contextFiles: this.resources.contextFiles,
          skills: this.resources.skills,
        }),
      getApiKey: (model) => resolveApiKey(this.options.config, this.options.auth, model),
    });
    return [
      ...core,
      createTaskTool({ spawnSubagent: (req: SubagentRequest) => subagent(req) }),
    ];
  }

  refreshTools(): void {
    const tools: AgentTool[] = this.toolsFor(
      this.options.cwd,
      false,
      this.options.permissions,
    );
    const names = new Set(tools.map((tool) => tool.name));
    for (const tool of [
      ...(this.options.mcp?.getTools() ?? []),
      ...(this.options.extensions?.getTools() ?? []),
    ]) {
      if (names.has(tool.name)) continue;
      names.add(tool.name);
      tools.push(tool);
    }
    this.options.permissions.setExtraTools(
      (this.options.extensions?.getTools() ?? []).map((tool) => tool.name),
    );
    this.agent.setTools(tools);
    this.systemPrompt = buildSystemPrompt({
      cwd: this.options.cwd,
      tools,
      contextFiles: this.resources.contextFiles,
      skills: this.resources.skills,
    });
  }

  private handleEvent(event: AgentEvent): Promise<void> | void {
    if (event.type === "message_end") {
      if (
        event.message.role === "user" ||
        event.message.role === "assistant" ||
        event.message.role === "toolResult"
      ) {
        // Message identity, not a synthetic key: distinct messages can share
        // a timestamp (or a provider can reuse a tool call id).
        if (this.persisted.has(event.message)) return;
        this.persisted.add(event.message);
        return this.manager.appendMessage(event.message).then(
          () => undefined,
          (error: unknown) => {
            this.options.onNotice?.(
              `Failed to save session: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          },
        );
      }
    }
    if (event.type === "turn_end") {
      void this.options.extensions?.emit({
        type: "turn_end",
        message: event.message,
        toolResults: event.toolResults,
      });
    } else if (event.type === "agent_end") {
      void this.options.extensions?.emit({ type: "agent_end", messages: event.messages });
    }
  }

  private async beforeToolCall(
    toolName: string,
    args: unknown,
  ): Promise<{ block?: boolean; reason?: string } | void> {
    const record =
      args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const extension = await this.options.extensions?.beforeToolCall(toolName, record);
    if (extension?.block) return extension;
    const permission = await this.options.permissions.check(toolName, record);
    if (!permission.allow) {
      return permission.reason !== undefined
        ? { block: true, reason: permission.reason }
        : { block: true };
    }
    return undefined;
  }

  /**
   * Non-vision models get a text placeholder instead of image references.
   * Only touches messages when supportsImages is explicitly false; persisted
   * messages keep their attachments so switching models restores them.
   */
  private projectForModel(messages: AgentMessage[]): AgentMessage[] {
    if (this.model.supportsImages !== false) return messages;
    let stripped = false;
    const projected = messages.map((message) => {
      if (message.role === "user" && message.images?.length) {
        stripped = true;
        const { images: _images, ...rest } = message;
        return { ...rest, content: `${rest.content}\n[图片已忽略：当前模型不支持图片]` };
      }
      if (
        message.role === "toolResult" &&
        message.content.some((block) => block.type === "image")
      ) {
        stripped = true;
        // Keep the text summary: the path and dimensions are still useful for
        // a model that can shell out to an OCR tool instead.
        return {
          ...message,
          content: message.content.map((block) =>
            block.type === "text"
              ? block
              : { type: "text" as const, text: "[图片已忽略：当前模型不支持图片]" },
          ),
        };
      }
      return message;
    });
    if (stripped) {
      this.options.onNotice?.("当前模型不支持图片，图片已忽略", "warn");
    }
    return projected;
  }

  private async prepareRequest(ctx: {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: AgentTool[];
    model: Model;
  }): Promise<{ systemPrompt: string; messages: AgentMessage[] }> {
    this.resources = await this.options.resources.load();
    this.options.permissions.setReadOnlyRoots(this.resources.readOnlyRoots);
    this.systemPrompt = buildSystemPrompt({
      cwd: this.options.cwd,
      tools: ctx.tools,
      contextFiles: this.resources.contextFiles,
      skills: this.resources.skills,
    });
    const converted = this.projectForModel(ctx.messages).map((message) =>
      message.role === "custom"
        ? {
            role: "user" as const,
            content: `[${message.customType}]\n${message.content}`,
            timestamp: message.timestamp,
          }
        : message,
    );
    const llm: LlmContext = {
      systemPrompt: this.systemPrompt,
      messages: converted,
      tools: ctx.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
    const tokens = estimateContextTokens(llm);
    const reserve = this.options.config.compaction.reserveTokens;
    if (shouldCompact(tokens, this.model, this.options.config.compaction)) {
      this.options.onNotice?.("Compacting context...");
      const apiKey = resolveApiKey(this.options.config, this.options.auth, this.model);
      // The trigger above already decided; force so compact() does not
      // re-check with a different (messages-only) token accounting.
      await compact(this.manager, this.model, this.streamFn, {
        keepRecentTokens: this.options.config.compaction.keepRecentTokens,
        reserveTokens: reserve,
        force: true,
        ...(apiKey ? { apiKey } : {}),
      });
      const projection = buildProjection(this.manager);
      this.agent.replaceProjection(projection.messages);
      return {
        systemPrompt: this.systemPrompt,
        messages: this.projectForModel(projection.messages),
      };
    }
    return { systemPrompt: this.systemPrompt, messages: this.projectForModel(ctx.messages) };
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.options.extensions?.emit({ type: "input", text });
    await this.agent.prompt(text, images);
  }

  steer(text: string, images?: ImageAttachment[]): void {
    this.agent.steer(text, images);
  }

  followUp(text: string, images?: ImageAttachment[]): void {
    this.agent.followUp(text, images);
  }

  abort(): void {
    this.agent.abort();
  }

  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    return this.agent.subscribe(listener);
  }

  async compact(instructions?: string): Promise<void> {
    const apiKey = resolveApiKey(this.options.config, this.options.auth, this.model);
    const result = await compact(this.manager, this.model, this.streamFn, {
      keepRecentTokens: this.options.config.compaction.keepRecentTokens,
      reserveTokens: this.options.config.compaction.reserveTokens,
      force: true,
      ...(instructions ? { instructions } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
    if ("skipped" in result) {
      this.options.onNotice?.("Nothing to compact");
      return;
    }
    const projection = buildProjection(this.manager);
    this.agent.replaceProjection(projection.messages);
  }

  async switchModel(model: Model): Promise<void> {
    await this.manager.appendModelChange(model.ref ?? `${model.provider}/${model.id}`);
    this.model = model;
    this.agent.setModel(model);
  }

  async reload(): Promise<void> {
    if (this.agent.state.isStreaming) throw new Error("Cannot reload while running");
    this.options.resources.reload();
    await this.options.extensions?.reload();
    await this.options.mcp?.reload();
    this.resources = await this.options.resources.load();
    this.options.permissions.setReadOnlyRoots(this.resources.readOnlyRoots);
    this.refreshTools();
  }

  getContextUsage(): { used: number; window: number } {
    const projection = buildProjection(this.manager).messages;
    const messages: LlmContext["messages"] = this.projectForModel(projection).map((message) =>
      message.role === "custom"
        ? {
            role: "user",
            content: `[${message.customType}]\n${message.content}`,
            timestamp: message.timestamp,
          }
        : message,
    );
    const tools = this.agent.state.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    return {
      used: estimateContextTokens({
        systemPrompt: this.systemPrompt,
        messages,
        tools,
      }),
      window: this.model.contextWindow,
    };
  }

  getLastAssistantText(): string {
    const messages = this.agent.state.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") {
        return (message as AssistantMessage).content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
      }
    }
    return "";
  }

  async dispose(): Promise<void> {
    this.agent.abort();
    await this.agent.waitForIdle();
    this.manager.dispose();
  }
}
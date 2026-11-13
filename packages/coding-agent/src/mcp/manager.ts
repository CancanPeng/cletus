import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool, ToolResult } from "@cletus/agent";
import { loadMcpConfig, type McpServerConfig } from "./config.js";

type ServerState = {
  name: string;
  config: McpServerConfig;
  client: Client | undefined;
  connected: boolean;
  error?: string;
  tools: AgentTool[];
  toolCount: number;
};

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function toolName(server: string, tool: string): string {
  const raw = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (raw.length <= 64) return raw;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

function textContent(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== "object") return { text: "", isError: false };
  const isError = "isError" in result && result.isError === true;
  if (!("content" in result) || !Array.isArray(result.content)) {
    return { text: "", isError };
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (!block || typeof block !== "object") continue;
    if ("type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      parts.push(block.text);
    } else if ("type" in block && typeof block.type === "string") {
      parts.push(`[unsupported content type: ${block.type}]`);
    }
  }
  return { text: parts.join("\n"), isError };
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly cwd: string;
  private readonly home: string;
  private readonly trustProject: boolean;
  private startPromise: Promise<void> | undefined;

  private constructor(cwd: string, home: string, trustProject: boolean) {
    this.cwd = cwd;
    this.home = home;
    this.trustProject = trustProject;
  }

  static async create(
    cwd: string,
    home: string,
    opts: { trustProject: boolean },
  ): Promise<McpManager> {
    const manager = new McpManager(cwd, home, opts.trustProject);
    const configs = await loadMcpConfig(cwd, home, opts.trustProject);
    for (const [name, config] of Object.entries(configs)) {
      manager.servers.set(name, {
        name,
        config,
        client: undefined,
        connected: false,
        tools: [],
        toolCount: 0,
      });
    }
    return manager;
  }

  private async connectServer(state: ServerState): Promise<void> {
    try {
      const config = state.config;
      const transport = config.url
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
          })
        : new StdioClientTransport({
            command: config.command ?? "",
            args: config.args ?? [],
            stderr: "ignore",
            ...(config.env ? { env: config.env } : {}),
            ...(config.cwd ? { cwd: config.cwd } : {}),
          });
      const client = new Client({ name: "cletus", version: "0.1.0" }, { capabilities: {} });
      const timeout = (config.timeout ?? 60) * 1000;
      const timeoutState = Promise.withResolvers<never>();
      const timer = setTimeout(
        () => timeoutState.reject(new Error(`MCP connect timeout after ${timeout}ms`)),
        timeout,
      );
      try {
        await Promise.race([client.connect(transport), timeoutState.promise]);
      } finally {
        clearTimeout(timer);
      }
      const listed = await client.listTools();
      state.client = client;
      state.connected = true;
      state.toolCount = listed.tools.length;
      const used = new Set<string>();
      state.tools = listed.tools.map((tool) => {
        let name = toolName(state.name, tool.name);
        let suffix = 2;
        while (used.has(name)) name = `${toolName(state.name, tool.name)}_${suffix++}`;
        used.add(name);
        const schema =
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object" };
        return {
          name,
          snippet: tool.description?.split("\n")[0]?.slice(0, 120) ?? `MCP tool ${tool.name}`,
          description: tool.description ?? `MCP tool ${tool.name} from ${state.name}`,
          parameters: schema,
          execute: async (params): Promise<ToolResult> => {
            const result = await client.callTool({ name: tool.name, arguments: params });
            const { text, isError } = textContent(result);
            return {
              isError,
              content: [{ type: "text", text: text || "MCP tool returned no text" }],
            };
          },
        } satisfies AgentTool;
      });
    } catch (error) {
      state.connected = false;
      state.error = error instanceof Error ? error.message : String(error);
      await state.client?.close().catch(() => undefined);
      state.client = undefined;
    }
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = Promise.allSettled(
      [...this.servers.values()].map((state) => this.connectServer(state)),
    ).then(() => undefined);
    return this.startPromise;
  }

  getTools(): AgentTool[] {
    return [...this.servers.values()].flatMap((state) => state.tools);
  }

  getStatus(): Array<{ name: string; connected: boolean; toolCount: number; error?: string }> {
    return [...this.servers.values()].map((state) => {
      const status: { name: string; connected: boolean; toolCount: number; error?: string } = {
        name: state.name,
        connected: state.connected,
        toolCount: state.toolCount,
      };
      if (state.error !== undefined) status.error = state.error;
      return status;
    });
  }

  async reload(): Promise<void> {
    await this.dispose();
    this.startPromise = undefined;
    this.servers.clear();
    const configs = await loadMcpConfig(this.cwd, this.home, this.trustProject);
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, {
        name,
        config,
        client: undefined,
        connected: false,
        tools: [],
        toolCount: 0,
      });
    }
    await this.start();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()].map(async (state) => {
        await state.client?.close().catch(() => undefined);
        state.client = undefined;
        state.connected = false;
      }),
    );
  }
}
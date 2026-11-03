import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { AgentTool, JsonValue, ToolResult } from "@cletus/agent";
import type { SessionManager } from "../session/manager.js";
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionEvent,
  ExtensionHandler,
  ExtensionModule,
} from "./types.js";

type LoadedExtension = {
  path: string;
  tools: AgentTool[];
  commands: Map<string, ExtensionCommand>;
  handlers: Map<string, ExtensionHandler[]>;
  pendingEntries: Array<{ customType: string; data: JsonValue }>;
};

export class ExtensionHost {
  private readonly cwd: string;
  private readonly home: string;
  private readonly trustProject: boolean;
  private readonly builtinTools: Set<string>;
  private readonly builtinCommands: Set<string>;
  private readonly notify: (text: string, level?: "info" | "warn" | "error") => void;
  private readonly extensions: LoadedExtension[] = [];
  private manager: SessionManager | undefined;
  private startEmitted = false;

  constructor(opts: {
    cwd: string;
    home: string;
    trustProject: boolean;
    builtinToolNames: string[];
    builtinCommands: string[];
    notify?: (text: string, level?: "info" | "warn" | "error") => void;
  }) {
    this.cwd = opts.cwd;
    this.home = opts.home;
    this.trustProject = opts.trustProject;
    this.builtinTools = new Set(opts.builtinToolNames);
    this.builtinCommands = new Set(opts.builtinCommands);
    this.notify = opts.notify ?? (() => undefined);
  }

  private log(message: string): void {
    const path = join(this.home, "logs", "extensions.log");
    void mkdir(join(this.home, "logs"), { recursive: true })
      .then(() => appendFile(path, `${new Date().toISOString()} ${message}\n`, "utf8"))
      .catch(() => undefined);
  }

  private async moduleFiles(): Promise<string[]> {
    const dirs = [join(this.home, "extensions")];
    if (this.trustProject) dirs.push(join(this.cwd, ".cletus", "extensions"));
    const files: string[] = [];
    for (const dir of dirs) {
      try {
        for (const name of await readdir(dir)) {
          if (name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js")) {
            files.push(join(dir, name));
          }
        }
      } catch {
        // missing directory
      }
    }
    return files.sort();
  }

  async load(): Promise<void> {
    const files = await this.moduleFiles();
    if (files.length === 0) return;
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    for (const path of files) {
      const extension: LoadedExtension = {
        path,
        tools: [],
        commands: new Map(),
        handlers: new Map(),
        pendingEntries: [],
      };
      const api: ExtensionAPI = {
        on: (type, handler) => {
          const list = extension.handlers.get(type) ?? [];
          list.push(handler);
          extension.handlers.set(type, list);
        },
        registerTool: (tool) => {
          if (this.builtinTools.has(tool.name)) {
            this.log(`Extension tool name conflict: ${tool.name} (${path})`);
            return;
          }
          if ([...this.extensions, extension].some((e) => e.tools.some((t) => t.name === tool.name))) {
            this.log(`Extension tool name conflict: ${tool.name} (${path})`);
            return;
          }
          extension.tools.push(tool);
        },
        registerCommand: (name, def) => {
          const command = name.replace(/^\//, "");
          if (this.builtinCommands.has(command) || extension.commands.has(command)) {
            this.log(`Extension command name conflict: ${command} (${path})`);
            return;
          }
          if ([...this.extensions].some((e) => e.commands.has(command))) {
            this.log(`Extension command name conflict: ${command} (${path})`);
            return;
          }
          extension.commands.set(command, { name: command, ...def });
        },
        appendEntry: (customType, data) => {
          if (this.manager) {
            void this.manager
              .appendCustom(customType, data)
              .catch((error: unknown) => this.log(`appendEntry failed: ${String(error)}`));
          } else {
            extension.pendingEntries.push({ customType, data });
          }
        },
      };

      try {
        const loaded = await jiti.import(path);
        const factory =
          typeof loaded === "function"
            ? (loaded as ExtensionModule)
            : loaded && typeof loaded === "object" && "default" in loaded && typeof loaded.default === "function"
              ? (loaded.default as ExtensionModule)
              : undefined;
        if (!factory) {
          this.log(`Extension ${path} has no default export`);
          continue;
        }
        await factory(api);
        this.extensions.push(extension);
      } catch (error) {
        this.log(
          `Extension ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
        this.notify(`Extension failed: ${path}`, "warn");
      }
    }
  }

  bindSession(opts: { manager: SessionManager; notify?: (text: string) => void }): void {
    this.manager = opts.manager;
    for (const extension of this.extensions) {
      for (const entry of extension.pendingEntries.splice(0)) {
        void this.manager
          .appendCustom(entry.customType, entry.data)
          .catch((error: unknown) => this.log(`appendEntry failed: ${String(error)}`));
      }
    }
    if (!this.startEmitted) {
      this.startEmitted = true;
      void this.emit({ type: "session_start", cwd: this.cwd });
    }
  }

  getTools(): AgentTool[] {
    return this.extensions.flatMap((extension) => extension.tools);
  }

  getCommands(): ExtensionCommand[] {
    return this.extensions.flatMap((extension) => [...extension.commands.values()]);
  }

  async emit(event: ExtensionEvent): Promise<{ block?: boolean; reason?: string } | void> {
    for (const extension of this.extensions) {
      for (const handler of extension.handlers.get(event.type) ?? []) {
        try {
          const result = await handler(event);
          if (event.type === "before_tool_call" && result?.block) {
            return result.reason !== undefined
              ? { block: true, reason: result.reason }
              : { block: true };
          }
        } catch (error) {
          this.log(
            `Extension handler failed (${extension.path}): ${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }`,
          );
          this.notify("Extension handler failed; see extension log", "warn");
        }
      }
    }
    return undefined;
  }

  async beforeToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ block?: boolean; reason?: string } | void> {
    return this.emit({ type: "before_tool_call", toolName, args });
  }

  async afterToolCall(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    await this.emit({ type: "after_tool_call", toolName, args, result });
  }

  async reload(): Promise<void> {
    await this.emit({ type: "session_shutdown" });
    this.extensions.length = 0;
    this.startEmitted = false;
    await this.load();
    if (this.manager) this.bindSession({ manager: this.manager });
  }

  async dispose(): Promise<void> {
    await this.emit({ type: "session_shutdown" });
    this.extensions.length = 0;
  }
}
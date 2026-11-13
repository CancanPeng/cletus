import { matchesGlob, resolve } from "node:path";
import { realResolve, resolveRead, resolveWrite, type SandboxOptions } from "./sandbox.js";

export type PermissionRequest = {
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
};
export type PermissionDecision = "allow" | "session" | "deny";
export type ConfirmFn = (req: PermissionRequest) => Promise<PermissionDecision>;

const READ_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  find: true,
  ls: true,
};

export class PermissionPolicy {
  private readonly sandbox: SandboxOptions;
  private allowWrite: string[];
  private yoloMode: boolean;
  private readonly interactive: boolean;
  private readonly confirm: ConfirmFn | undefined;
  private readonly sessionPaths = new Set<string>();
  private readonly sessionCommands = new Set<string>();
  private readonly sessionMcpTools = new Set<string>();
  private readonly sessionSearches = new Set<string>();
  private readonly sessionCurls = new Set<string>();

  constructor(opts: {
    cwd: string;
    readOnlyRoots: string[];
    allowWrite: string[];
    yolo: boolean;
    interactive: boolean;
    confirm?: ConfirmFn;
  }) {
    this.sandbox = { cwd: opts.cwd, readOnlyRoots: opts.readOnlyRoots };
    this.allowWrite = [...opts.allowWrite];
    this.yoloMode = opts.yolo;
    this.interactive = opts.interactive;
    this.confirm = opts.confirm;
  }

  resolveRead(input: string): Promise<string> {
    return resolveRead(this.sandbox, input);
  }

  setReadOnlyRoots(roots: string[]): void {
    this.sandbox.readOnlyRoots = roots;
  }

  resetSession(): void {
    this.sessionPaths.clear();
    this.sessionCommands.clear();
    this.sessionMcpTools.clear();
    this.sessionSearches.clear();
    this.sessionCurls.clear();
  }

  setAllowWrite(patterns: string[]): void {
    this.allowWrite = [...patterns];
  }

  get yolo(): boolean {
    return this.yoloMode;
  }

  setYolo(enabled: boolean): void {
    this.yoloMode = enabled;
  }

  resolveWrite(input: string): Promise<string> {
    return resolveWrite(this.sandbox, input);
  }

  private async isWriteAllowed(path: string): Promise<boolean> {
    if (this.sessionPaths.has(path)) return true;
    for (const pattern of this.allowWrite) {
      const absolute = pattern.startsWith("/")
        ? pattern
        : resolve(this.sandbox.cwd, pattern);
      try {
        const resolvedPattern = await realResolve(absolute);
        if (matchesGlob(path, resolvedPattern)) return true;
      } catch {
        if (path.startsWith(absolute)) return true;
      }
    }
    return false;
  }

  private async ask(
    toolName: string,
    args: Record<string, unknown>,
    summary: string,
    sessionKey: string,
  ): Promise<{ allow: boolean; reason?: string }> {
    if (!this.interactive || !this.confirm) {
      return { allow: false, reason: "Non-interactive mode requires --yolo for write" };
    }
    const decision = await this.confirm({ toolName, args, summary });
    if (decision === "deny") return { allow: false, reason: "Denied by user" };
    if (decision === "session") this.sessionCommands.add(sessionKey);
    return { allow: true };
  }

  async check(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ allow: boolean; reason?: string }> {
    if (READ_TOOLS[toolName]) {
      const input = typeof args["path"] === "string" ? args["path"] : ".";
      try {
        await this.resolveRead(input);
        return { allow: true };
      } catch (error) {
        return { allow: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }

    if (toolName === "write" || toolName === "edit") {
      const input = typeof args["path"] === "string" ? args["path"] : "";
      let resolved: string;
      try {
        resolved = await this.resolveWrite(input);
      } catch (error) {
        return { allow: false, reason: error instanceof Error ? error.message : String(error) };
      }
      if (await this.isWriteAllowed(resolved)) return { allow: true };
      if (this.yolo) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: "Non-interactive mode requires --yolo for write" };
      }
      const summary =
        toolName === "write"
          ? `Write ${resolved} (${Buffer.byteLength(String(args["content"] ?? ""))} bytes)`
          : `Edit ${resolved} (${Array.isArray(args["edits"]) ? args["edits"].length : 0} edits)`;
      if (this.sessionPaths.has(resolved)) return { allow: true };
      const decision = await this.ask(toolName, args, summary, resolved);
      if (decision.allow) this.sessionPaths.add(resolved);
      return decision;
    }

    if (toolName.startsWith("mcp__")) {
      if (this.yolo) return { allow: true };
      if (this.sessionMcpTools.has(toolName)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: "Non-interactive mode requires --yolo for write" };
      }
      const decision = await this.ask(toolName, args, `MCP tool ${toolName}`, toolName);
      if (decision.allow) this.sessionMcpTools.add(toolName);
      return decision;
    }

    if (toolName === "task") return { allow: true };

    if (toolName === "curl") {
      if (this.yolo) return { allow: true };
      const urls = Array.isArray(args["urls"])
        ? args["urls"].map(String).join(" ")
        : "";
      if (this.sessionCurls.has(urls)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: "Non-interactive mode requires --yolo for curl" };
      }
      const decision = await this.ask(
        toolName,
        args,
        `curl: ${urls}`,
        urls,
      );
      if (decision.allow) this.sessionCurls.add(urls);
      return decision;
    }

    if (toolName === "web_search") {
      if (this.yolo) return { allow: true };
      const query = String(args["query"] ?? "");
      if (this.sessionSearches.has(query)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: "Non-interactive mode requires --yolo for web search" };
      }
      const decision = await this.ask(
        toolName,
        args,
        `Web search: ${query}`,
        query,
      );
      if (decision.allow) this.sessionSearches.add(query);
      return decision;
    }

    if (toolName === "bash") {
      if (this.yolo) return { allow: true };
      const command = String(args["command"] ?? "");
      if (this.sessionCommands.has(command)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: "Non-interactive mode requires --yolo for write" };
      }
      const decision = await this.ask(toolName, args, command, command);
      if (decision.allow) this.sessionCommands.add(command);
      return decision;
    }

    return { allow: false, reason: `Unknown tool: ${toolName}` };
  }
}
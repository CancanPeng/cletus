import { isAbsolute, matchesGlob, resolve } from "node:path";
import { realResolve, resolveRead, resolveWrite, type SandboxOptions } from "./sandbox.js";

export type PermissionRequest = {
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
};
export type PermissionDecision = "allow" | "session" | "deny";
export type ConfirmFn = (req: PermissionRequest) => Promise<PermissionDecision>;

/**
 * A copy of a policy's grants at one point in time. Children inherit this
 * snapshot at spawn; later parent grants never reach a running child and
 * nothing flows back. `interactive`/`confirm` are deliberately not part of
 * it: inheriting grants must never make a child able to prompt.
 */
export type PermissionSnapshot = {
  allowWrite: string[];
  yolo: boolean;
  readOnlyRoots: string[];
  sessionPaths: string[];
  sessionCommands: string[];
  sessionMcpTools: string[];
  sessionSearches: string[];
  sessionCurls: string[];
  sessionExtraTools: string[];
  extraTools: string[];
};

const nonInteractiveDeny = (toolName: string): string =>
  `Denied: ${toolName} not covered by inherited grants or permissions rules (approve it in the main session, add a permissions rule via /permissions add in the TUI or cletus permissions add on the CLI, or use --yolo)`;

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
  private readonly readOnly: boolean;
  private readonly sessionPaths = new Set<string>();
  private readonly sessionCommands = new Set<string>();
  private readonly sessionMcpTools = new Set<string>();
  private readonly sessionSearches = new Set<string>();
  private readonly sessionCurls = new Set<string>();
  private extraTools = new Set<string>();
  private readonly sessionExtraTools = new Set<string>();

  constructor(opts: {
    cwd: string;
    readOnlyRoots: string[];
    allowWrite: string[];
    yolo: boolean;
    interactive: boolean;
    confirm?: ConfirmFn;
    /**
     * Authoritative when present: allowWrite, yolo, readOnlyRoots and all
     * session grants come from the snapshot, NOT from the sibling opts.
     * Callers inheriting should omit those opts to avoid dead arguments.
     */
    inherit?: PermissionSnapshot;
    /** Child-side constraint (not a grant): deny write/edit/bash outright. */
    readOnly?: boolean;
  }) {
    const inherited = opts.inherit;
    this.readOnly = opts.readOnly === true;
    this.sandbox = {
      cwd: opts.cwd,
      readOnlyRoots: inherited ? [...inherited.readOnlyRoots] : opts.readOnlyRoots,
    };
    this.allowWrite = inherited ? [...inherited.allowWrite] : [...opts.allowWrite];
    this.yoloMode = inherited ? inherited.yolo : opts.yolo;
    this.interactive = opts.interactive;
    this.confirm = opts.confirm;
    if (inherited) {
      for (const p of inherited.sessionPaths) this.sessionPaths.add(p);
      for (const c of inherited.sessionCommands) this.sessionCommands.add(c);
      for (const t of inherited.sessionMcpTools) this.sessionMcpTools.add(t);
      for (const q of inherited.sessionSearches) this.sessionSearches.add(q);
      for (const c of inherited.sessionCurls) this.sessionCurls.add(c);
      for (const t of inherited.sessionExtraTools) this.sessionExtraTools.add(t);
      // Registration, not a grant: without it inherited session grants for
      // extension tools would fall through to "Unknown tool".
      this.extraTools = new Set(inherited.extraTools);
    }
  }

  snapshot(): PermissionSnapshot {
    return {
      allowWrite: [...this.allowWrite],
      yolo: this.yoloMode,
      readOnlyRoots: [...this.sandbox.readOnlyRoots],
      sessionPaths: [...this.sessionPaths],
      sessionCommands: [...this.sessionCommands],
      sessionMcpTools: [...this.sessionMcpTools],
      sessionSearches: [...this.sessionSearches],
      sessionCurls: [...this.sessionCurls],
      sessionExtraTools: [...this.sessionExtraTools],
      extraTools: [...this.extraTools],
    };
  }

  resolveRead(input: string): Promise<string> {
    return resolveRead(this.sandbox, input);
  }

  setReadOnlyRoots(roots: string[]): void {
    this.sandbox.readOnlyRoots = roots;
  }

  /** Register extension tool names so they are confirmed, not rejected. */
  setExtraTools(names: string[]): void {
    this.extraTools = new Set(names);
  }

  resetSession(): void {
    this.sessionPaths.clear();
    this.sessionCommands.clear();
    this.sessionMcpTools.clear();
    this.sessionSearches.clear();
    this.sessionCurls.clear();
    this.sessionExtraTools.clear();
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
    const cwd = await realResolve(this.sandbox.cwd);
    for (const pattern of this.allowWrite) {
      const absolute = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
      if (matchesGlob(path, absolute)) return true;
      // The pattern may traverse symlinks; resolve its existing prefix so
      // glob matching sees the same real paths as the sandbox check.
      const firstGlob = absolute.search(/[*?[]/);
      if (firstGlob <= 0) continue;
      const cut = absolute.lastIndexOf("/", firstGlob);
      const prefix = absolute.slice(0, cut);
      const resolved = await realResolve(prefix);
      if (resolved !== prefix && matchesGlob(path, resolved + absolute.slice(cut))) {
        return true;
      }
    }
    return false;
  }

  private async ask(
    toolName: string,
    args: Record<string, unknown>,
    summary: string,
  ): Promise<{ allow: boolean; reason?: string }> {
    if (!this.interactive || !this.confirm) {
      return { allow: false, reason: nonInteractiveDeny(toolName) };
    }
    const decision = await this.confirm({ toolName, args, summary });
    if (decision === "deny") return { allow: false, reason: "Denied by user" };
    // Callers record session grants in their own per-tool sets.
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
      if (this.readOnly) return { allow: false, reason: "Denied: agent is read-only" };
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
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const summary =
        toolName === "write"
          ? `Write ${resolved} (${Buffer.byteLength(String(args["content"] ?? ""))} bytes)`
          : `Edit ${resolved} (${Array.isArray(args["edits"]) ? args["edits"].length : 0} edits)`;
      if (this.sessionPaths.has(resolved)) return { allow: true };
      const decision = await this.ask(toolName, args, summary);
      if (decision.allow) this.sessionPaths.add(resolved);
      return decision;
    }

    if (toolName.startsWith("mcp__")) {
      if (this.yolo) return { allow: true };
      if (this.sessionMcpTools.has(toolName)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const decision = await this.ask(toolName, args, `MCP tool ${toolName}`);
      if (decision.allow) this.sessionMcpTools.add(toolName);
      return decision;
    }

    if (toolName === "task") return { allow: true };

    if (toolName === "curl") {
      if (this.yolo) return { allow: true };
      const urls = Array.isArray(args["urls"])
        ? args["urls"].map(String).join(" ")
        : "";
      // Headers change the request's effect, so they are part of the grant.
      const headerKeys =
        args["headers"] && typeof args["headers"] === "object"
          ? Object.entries(args["headers"] as Record<string, unknown>)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .sort()
              .join("\n")
          : "";
      const requestKey = headerKeys ? `${urls}\n${headerKeys}` : urls;
      if (this.sessionCurls.has(requestKey)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const decision = await this.ask(
        toolName,
        args,
        headerKeys ? `curl: ${urls}\n${headerKeys}` : `curl: ${urls}`,
      );
      if (decision.allow) this.sessionCurls.add(requestKey);
      return decision;
    }

    if (toolName === "web_search") {
      if (this.yolo) return { allow: true };
      const query = String(args["query"] ?? "");
      if (this.sessionSearches.has(query)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const decision = await this.ask(toolName, args, `Web search: ${query}`);
      if (decision.allow) this.sessionSearches.add(query);
      return decision;
    }

    if (toolName === "bash") {
      if (this.readOnly) return { allow: false, reason: "Denied: agent is read-only" };
      if (this.yolo) return { allow: true };
      const command = String(args["command"] ?? "");
      if (this.sessionCommands.has(command)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const decision = await this.ask(toolName, args, command);
      if (decision.allow) this.sessionCommands.add(command);
      return decision;
    }

    if (this.extraTools.has(toolName)) {
      if (this.yolo) return { allow: true };
      if (this.sessionExtraTools.has(toolName)) return { allow: true };
      if (!this.interactive) {
        return { allow: false, reason: nonInteractiveDeny(toolName) };
      }
      const decision = await this.ask(toolName, args, `Extension tool ${toolName}`);
      if (decision.allow) this.sessionExtraTools.add(toolName);
      return decision;
    }

    return { allow: false, reason: `Unknown tool: ${toolName}` };
  }
}
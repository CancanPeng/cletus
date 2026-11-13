import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentMessage, JsonValue } from "@cletus/agent";
import type {
  CompactionEntry,
  CustomEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionEntry,
  SessionInfo,
} from "./types.js";

export function encodeCwd(cwd: string): string {
  // Escape existing dashes first so the mapping stays injective
  // (/a/b and /a-b must not share a session directory).
  return cwd.replace(/^[/\\]/, "").replace(/-/g, "--").replace(/[/\\:]/g, "-");
}

function legacyEncodeCwd(cwd: string): string {
  return cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

export function sessionDir(cwd: string, home = process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus")): string {
  return join(home, "sessions", `--${encodeCwd(cwd)}--`);
}

/** Pre-0.1.1 directory format, kept readable so old sessions stay resumable. */
function legacySessionDir(cwd: string, home: string): string {
  return join(home, "sessions", `--${legacyEncodeCwd(cwd)}--`);
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  return typeof value.type === "string";
}

export class SessionManager {
  readonly sessionId: string;
  readonly filePath: string | null;
  readonly cwd: string;
  private readonly home: string;
  private entries: SessionEntry[] = [];
  private leaf: string | null = null;
  private readonly ids = new Set<string>();
  private appendChain: Promise<void> = Promise.resolve();

  private constructor(
    cwd: string,
    home: string,
    sessionId: string,
    filePath: string | null,
  ) {
    this.cwd = cwd;
    this.home = home;
    this.sessionId = sessionId;
    this.filePath = filePath;
  }

  static async create(
    cwd: string,
    opts: { home?: string; sessionId?: string; parentSession?: string } = {},
  ): Promise<SessionManager> {
    const home = opts.home ?? process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus");
    const dir = sessionDir(cwd, home);
    await mkdir(dir, { recursive: true });
    const sessionId = opts.sessionId ?? randomUUID();
    const header: SessionEntry = {
      type: "session",
      version: 1,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
      ...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
    };
    const filePath = join(dir, `${Date.now()}_${sessionId}.jsonl`);
    await writeFile(filePath, `${JSON.stringify(header)}\n`, "utf8");
    const manager = new SessionManager(cwd, home, sessionId, filePath);
    return manager;
  }

  static async open(filePath: string): Promise<SessionManager> {
    const text = await readFile(filePath, "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let header: SessionEntry | undefined;
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`Warning: skipping malformed session line in ${filePath}\n`);
        continue;
      }
      if (!isSessionEntry(parsed)) {
        process.stderr.write(`Warning: skipping unknown session entry in ${filePath}\n`);
        continue;
      }
      if (!header) {
        if (parsed.type !== "session") {
          throw new Error("Invalid session file: missing header");
        }
        if (parsed.version !== 1) {
          throw new Error(`Unsupported session version: ${parsed.version}`);
        }
        header = parsed;
        continue;
      }
      if (parsed.type === "session") continue;
      entries.push(parsed);
    }
    if (!header || header.type !== "session") {
      throw new Error("Invalid session file: missing header");
    }
    const home = process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus");
    const manager = new SessionManager(header.cwd, home, header.id, filePath);
    manager.entries = entries;
    manager.leaf = entries[entries.length - 1]?.id ?? null;
    for (const entry of entries) manager.ids.add(entry.id);
    return manager;
  }

  static inMemory(cwd: string): SessionManager {
    const header: SessionEntry = {
      type: "session",
      version: 1,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
    };
    return new SessionManager(cwd, process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus"), header.id, null);
  }

  static async list(
    cwd: string,
    opts: { home?: string; limit?: number } = {},
  ): Promise<SessionInfo[]> {
    const home = opts.home ?? process.env["CLETUS_HOME"] ?? join(homedir(), ".cletus");
    const dirs = [sessionDir(cwd, home)];
    const legacy = legacySessionDir(cwd, home);
    if (legacy !== dirs[0]) dirs.push(legacy);
    const candidates: string[] = [];
    for (const dir of dirs) {
      try {
        for (const name of await readdir(dir)) {
          if (name.endsWith(".jsonl")) candidates.push(join(dir, name));
        }
      } catch {
        // missing directory
      }
    }
    const infos: Array<SessionInfo & { mtime: number }> = [];
    for (const filePath of candidates) {
      try {
        const info = await stat(filePath);
        const text = await readFile(filePath, "utf8");
        const lines = text.split("\n").filter((line) => line.trim().length > 0);
        const header = JSON.parse(lines[0] ?? "{}") as Partial<SessionEntry>;
        if (header.type !== "session") continue;
        // Legacy dirs can mix projects whose paths encode identically.
        if (header.cwd !== undefined && header.cwd !== cwd) continue;
        let messageCount = 0;
        let firstUserText = "";
        for (const line of lines.slice(1)) {
          try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry.type !== "message") continue;
            messageCount += 1;
            if (!firstUserText && entry.message.role === "user") {
              firstUserText = entry.message.content;
            }
          } catch {
            // skip corrupt line
          }
        }
        infos.push({
          id: String(header.id ?? filePath.split("/").pop() ?? filePath),
          filePath,
          cwd: String(header.cwd ?? cwd),
          timestamp: String(header.timestamp ?? info.mtime.toISOString()),
          messageCount,
          firstUserText,
          mtime: info.mtimeMs,
        });
      } catch {
        // skip unreadable file
      }
    }
    infos.sort((a, b) => b.mtime - a.mtime);
    return infos.slice(0, opts.limit ?? 50).map(({ mtime: _mtime, ...info }) => info);
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(4).toString("hex");
      if (!this.ids.has(id)) {
        this.ids.add(id);
        return id;
      }
    }
  }

  private async writeEntry(entry: SessionEntry): Promise<void> {
    if (this.filePath) await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    this.entries.push(entry);
    this.leaf = entry.id;
  }

  private appendEntry(
    make: (id: string, parentId: string | null) => SessionEntry,
    explicitParent?: string | null,
  ): Promise<SessionEntry> {
    const task = this.appendChain.then(async () => {
      const parentId = explicitParent === undefined ? this.leaf : explicitParent;
      const entry = make(this.newId(), parentId);
      await this.writeEntry(entry);
      return entry;
    });
    this.appendChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  appendMessage(message: AgentMessage, parentId?: string | null): Promise<MessageEntry> {
    return this.appendEntry(
      (id, parent) => ({
        type: "message",
        id,
        parentId: parent,
        timestamp: new Date().toISOString(),
        message,
      }),
      parentId,
    ) as Promise<MessageEntry>;
  }

  appendModelChange(ref: string): Promise<ModelChangeEntry> {
    return this.appendEntry((id, parent) => ({
      type: "model_change",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      ref,
    })) as Promise<ModelChangeEntry>;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<CompactionEntry> {
    return this.appendEntry((id, parent) => ({
      type: "compaction",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    })) as Promise<CompactionEntry>;
  }

  appendCustom(customType: string, data: JsonValue): Promise<CustomEntry> {
    return this.appendEntry((id, parent) => ({
      type: "custom",
      id,
      parentId: parent,
      timestamp: new Date().toISOString(),
      customType,
      data,
    })) as Promise<CustomEntry>;
  }

  getLeafId(): string | null {
    return this.leaf;
  }

  setLeaf(id: string | null): void {
    this.leaf = id;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getBranch(leafId: string | null = this.leaf): SessionEntry[] {
    if (!leafId) return [];
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const branch: SessionEntry[] = [];
    let current: string | null = leafId;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      const entry = byId.get(current);
      if (!entry) {
        process.stderr.write(`Warning: missing parent ${current} in session\n`);
        break;
      }
      branch.push(entry);
      if (entry.type === "session") break;
      current = entry.parentId;
    }
    return branch.reverse();
  }

  async fork(entryId?: string): Promise<SessionManager> {
    const leaf = entryId ?? this.leaf;
    const branch = this.getBranch(leaf);
    const manager = await SessionManager.create(this.cwd, {
      home: this.home,
      ...(this.filePath ? { parentSession: this.filePath } : {}),
    });
    let parentId: string | null = null;
    const idMap = new Map<string, string>();
    const clones: SessionEntry[] = [];
    for (const entry of branch) {
      if (entry.type === "session") continue;
      const id = manager.newId();
      idMap.set(entry.id, id);
      clones.push({ ...entry, id, parentId } as SessionEntry);
      parentId = id;
    }
    for (const clone of clones) {
      // Compaction entries reference kept messages by id; remap them or the
      // fork projects zero kept messages.
      if (clone.type === "compaction") {
        clone.firstKeptEntryId = idMap.get(clone.firstKeptEntryId) ?? clone.firstKeptEntryId;
      }
      if (manager.filePath) {
        await appendFile(manager.filePath, `${JSON.stringify(clone)}\n`, "utf8");
      }
      manager.entries.push(clone);
      manager.leaf = clone.id;
    }
    return manager;
  }

  dispose(): void {
    // No open handles; appends are awaited by callers.
  }
}
import { readdir, stat } from "node:fs/promises";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";

export function createLsTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
}): AgentTool {
  return {
    name: "ls",
    snippet: "List directory contents",
    description: "List directory entries.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const input = typeof params["path"] === "string" ? params["path"] : deps.cwd;
      const limit = Math.min(Math.max(Number(params["limit"] ?? 200), 1), 1000);
      const path = await deps.policy.resolveRead(input);
      const entries = await readdir(path, { withFileTypes: true });
      const rows: Array<{ name: string; directory: boolean; size: number }> = [];
      for (const entry of entries) {
        if (entry.name === ".DS_Store") continue;
        if (entry.isDirectory()) {
          rows.push({ name: entry.name, directory: true, size: 0 });
        } else {
          try {
            const info = await stat(`${path}/${entry.name}`);
            rows.push({ name: entry.name, directory: false, size: info.size });
          } catch {
            // Broken symlink or vanished entry: list it without a size.
            rows.push({ name: entry.name, directory: false, size: 0 });
          }
        }
      }
      rows.sort((a, b) => {
        if (a.directory !== b.directory) return a.directory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const shown = rows.slice(0, limit).map((row) =>
        row.directory ? `${row.name}/` : `${row.name} (${row.size} bytes)`,
      );
      if (rows.length > limit) shown.push(`[truncated: ${rows.length - limit} entries omitted]`);
      return { content: [{ type: "text", text: shown.join("\n") }] };
    },
  };
}
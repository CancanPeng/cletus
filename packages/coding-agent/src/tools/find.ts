import { glob } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";

const EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

export function createFindTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
}): AgentTool {
  return {
    name: "find",
    snippet: "Find files by glob pattern",
    description: "Find files by glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const pattern = String(params["pattern"] ?? "");
      // fs.glob honors absolute heads and .. hops; keep the walk confined.
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pattern must be relative and stay inside the search path" }],
        };
      }
      const input = typeof params["path"] === "string" ? params["path"] : deps.cwd;
      const limit = Math.min(Math.max(Number(params["limit"] ?? 100), 1), 500);
      const searchPath = await deps.policy.resolveRead(input);
      const found: string[] = [];
      for await (const path of glob(pattern, { cwd: searchPath, exclude: EXCLUDES })) {
        const normalized = path.replace(/\\/g, "/");
        if (
          normalized.split("/").some((part) => part === "node_modules" || part === ".git" || part === "dist")
        ) {
          continue;
        }
        found.push(normalized);
      }
      found.sort();
      if (found.length === 0) {
        return { content: [{ type: "text", text: "No files found" }] };
      }
      const text = found.slice(0, limit).join("\n");
      return { content: [{ type: "text", text }] };
    },
  };
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";

const exec = promisify(execFile);

export function createGrepTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
}): AgentTool {
  return {
    name: "grep",
    snippet: "Search file contents with ripgrep",
    description: "Search files with ripgrep.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        ignoreCase: { type: "boolean" },
        limit: { type: "number" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const pattern = String(params["pattern"] ?? "");
      const input = typeof params["path"] === "string" ? params["path"] : deps.cwd;
      const limit = Math.min(Math.max(Number(params["limit"] ?? 100), 1), 500);
      const path = await deps.policy.resolveRead(input);
      const args = [
        "-n",
        "--no-heading",
        "--color",
        "never",
        "--max-count",
        String(limit),
      ];
      if (params["ignoreCase"] === true) args.push("-i");
      if (typeof params["glob"] === "string") args.push("--glob", params["glob"]);
      args.push("-e", pattern, path);
      try {
        const result = await exec("rg", args, { cwd: deps.cwd, maxBuffer: 10 * 1024 * 1024 });
        const lines = result.stdout.split("\n").filter((line) => line.length > 0).slice(0, limit);
        return {
          content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No matches found" }],
        };
      } catch (error) {
        const err = error as { code?: string | number; stdout?: string; stderr?: string };
        if (err.code === "ENOENT") {
          return {
            isError: true,
            content: [{ type: "text", text: "ripgrep (rg) not found; install ripgrep" }],
          };
        }
        if (typeof err.stdout === "string" && err.stdout.trim().length > 0) {
          return {
            content: [{ type: "text", text: err.stdout.trim().split("\n").slice(0, limit).join("\n") }],
          };
        }
        if (err.code === 1) {
          return { content: [{ type: "text", text: "No matches found" }] };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `rg exited with code ${String(err.code ?? "unknown")}: ${err.stderr ?? ""}`,
            },
          ],
        };
      }
    },
  };
}
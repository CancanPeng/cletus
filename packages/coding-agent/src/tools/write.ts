import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";

export function createWriteTool(deps: { policy: PermissionPolicy }): AgentTool {
  return {
    name: "write",
    snippet: "Create or overwrite a file",
    description: "Write UTF-8 text to a file, creating parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const input = String(params["path"] ?? "");
      const content = String(params["content"] ?? "");
      const path = await deps.policy.resolveWrite(input);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return {
        content: [
          { type: "text", text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}` },
        ],
      };
    },
  };
}
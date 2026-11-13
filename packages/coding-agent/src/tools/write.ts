import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
      // Atomic replace so a crash never leaves a half-written file.
      const temp = join(dirname(path), `.${randomUUID()}.cletus.tmp`);
      await writeFile(temp, content, "utf8");
      await rename(temp, path);
      return {
        content: [
          { type: "text", text: `Wrote ${Buffer.byteLength(content)} bytes to ${path}` },
        ],
      };
    },
  };
}
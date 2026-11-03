import { open, stat } from "node:fs/promises";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";
import { truncateHead } from "./truncate.js";

const MAX_BYTES = 1024 * 1024;

export function createReadTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
}): AgentTool {
  return {
    name: "read",
    snippet: "Read file contents",
    description: "Read a text file with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        offset: { type: "number", description: "First line (1-based)" },
        limit: { type: "number", description: "Maximum lines" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const input = String(params["path"] ?? "");
      const offset = Math.max(1, Number(params["offset"] ?? 1));
      const limit = Math.max(1, Number(params["limit"] ?? 2000));
      const path = await deps.policy.resolveRead(input);
      const info = await stat(path);
      if (info.isDirectory()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot read directory: ${path}` }],
        };
      }
      const handle = await open(path, "r");
      try {
        const size = Math.min(info.size, MAX_BYTES);
        const buffer = Buffer.alloc(size);
        await handle.read(buffer, 0, size, 0);
        if (buffer.includes(0)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot read binary file: ${path}` }],
          };
        }
        const allLines = buffer.toString("utf8").split("\n");
        const selected = allLines.slice(offset - 1, offset - 1 + limit);
        const numbered = selected.map(
          (line, index) => `${String(offset + index).padStart(6)}\t${line}`,
        );
        let text = numbered.join("\n");
        if (info.size > MAX_BYTES) {
          text += "\n[truncated: file exceeds 1MB; showing first 1MB]";
        }
        const truncated = truncateHead(text);
        return { content: [{ type: "text", text: truncated.text }] };
      } finally {
        await handle.close();
      }
    },
  };
}
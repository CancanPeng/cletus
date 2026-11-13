import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";

type Edit = { oldText: string; newText: string };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export function createEditTool(deps: { policy: PermissionPolicy }): AgentTool {
  return {
    name: "edit",
    snippet: "Make precise file edits with exact text replacement",
    description:
      "Replace exact text in a file. Each oldText must occur exactly once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { oldText: { type: "string" }, newText: { type: "string" } },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    async execute(params): Promise<ToolResult> {
      const input = String(params["path"] ?? "");
      const edits = Array.isArray(params["edits"]) ? (params["edits"] as Edit[]) : [];
      const path = await deps.policy.resolveWrite(input);
      const original = await readFile(path, "utf8");
      if (original.includes("\0")) {
        return {
          isError: true,
          content: [{ type: "text", text: `Cannot edit binary file: ${path}` }],
        };
      }
      const crlfCount = original.match(/\r\n/g)?.length ?? 0;
      const bareLf = original.match(/(?<!\r)\n/g)?.length ?? 0;
      const crlf = crlfCount > bareLf;
      const matches: Array<{ start: number; end: number; text: string }> = [];

      for (const edit of edits) {
        let oldText = edit.oldText;
        let newText = edit.newText;
        let count = countOccurrences(original, oldText);
        if (count === 0 && crlf && !oldText.includes("\r")) {
          oldText = oldText.replace(/\n/g, "\r\n");
          newText = newText.replace(/\n/g, "\r\n");
          count = countOccurrences(original, oldText);
        }
        if (count === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: `oldText not found in ${path}` }],
          };
        }
        if (count > 1) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `oldText matched ${count} times in ${path}; include more context`,
              },
            ],
          };
        }
        // Normalize replacement EOLs to the file's dominant style even when
        // oldText already matched with explicit \r\n.
        if (crlf) newText = newText.replace(/\r?\n/g, "\r\n");
        const start = original.indexOf(oldText);
        matches.push({ start, end: start + oldText.length, text: newText });
      }

      matches.sort((a, b) => a.start - b.start);
      for (let index = 1; index < matches.length; index += 1) {
        const previous = matches[index - 1];
        const current = matches[index];
        if (previous && current && current.start < previous.end) {
          return {
            isError: true,
            content: [{ type: "text", text: `Edits overlap in ${path}` }],
          };
        }
      }

      let updated = original;
      for (const match of [...matches].sort((a, b) => b.start - a.start)) {
        updated = `${updated.slice(0, match.start)}${match.text}${updated.slice(match.end)}`;
      }

      const info = await stat(path);
      // Detect concurrent external changes between read and write.
      const current = await readFile(path, "utf8");
      if (current !== original) {
        return {
          isError: true,
          content: [{ type: "text", text: `File changed on disk since it was read: ${path}` }],
        };
      }
      const temp = join(dirname(path), `.${randomUUID()}.cletus.tmp`);
      await writeFile(temp, updated, "utf8");
      await chmod(temp, info.mode);
      await rename(temp, path);

      const diff = createTwoFilesPatch(path, path, original, updated, "before", "after");
      return {
        content: [
          { type: "text", text: `Wrote ${path} (${matches.length} replacements)` },
        ],
        details: { diff },
      };
    },
  };
}
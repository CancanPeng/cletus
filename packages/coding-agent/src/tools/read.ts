import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentTool, ToolResult } from "@cletus/agent";
import type { PermissionPolicy } from "../permissions/policy.js";
import { truncateHead } from "./truncate.js";

const MAX_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detects images by content, never by extension. */
function sniffImage(head: Buffer): "image/png" | "image/jpeg" | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}

/**
 * A PNG must start with the 8-byte signature followed by an IHDR chunk; without
 * it there is nothing to decode. Returns dimensions when they are readable.
 */
function pngInfo(
  data: Buffer,
): { width: number; height: number } | "invalid" | undefined {
  if (data.length < 33 || data.toString("ascii", 12, 16) !== "IHDR") return "invalid";
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Walks JPEG segments to the first SOF marker. No SOF means the payload cannot
 * be decoded, so the caller must not treat it as an image.
 */
function jpegInfo(
  data: Buffer,
): { width: number; height: number } | "invalid" | undefined {
  const SOF = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return "invalid";
    const marker = data[offset + 1] ?? 0;
    if (SOF.has(marker)) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return "invalid";
    offset += 2 + length;
  }
  return "invalid";
}

export function createReadTool(deps: {
  policy: PermissionPolicy;
  cwd: string;
}): AgentTool {
  return {
    name: "read",
    snippet: "Read file contents",
    description:
      "Read a text file with line numbers, or a png/jpeg image as an image block.",
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
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        const data = buffer.subarray(0, bytesRead);

        const candidate = sniffImage(data);
        const imageInfo = candidate
          ? candidate === "image/png"
            ? pngInfo(data)
            : jpegInfo(data)
          : "invalid";
        // A candidate whose structure does not parse is not an image: handing
        // the bytes over as one gives the provider something it cannot decode.
        if (candidate && imageInfo === "invalid") {
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot read binary file: ${path}` }],
          };
        }
        const mediaType = candidate;
        if (mediaType) {
          if (info.size > MAX_IMAGE_BYTES) {
            // Truncating the bytes would hand the model a corrupt image it
            // would then reason about; refuse instead.
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Image exceeds 5MB limit: ${path} is ${Math.round(
                    info.size / 1024 / 1024,
                  )}MB; resize or crop it before reading.`,
                },
              ],
            };
          }
          const dimensions = imageInfo === "invalid" ? undefined : imageInfo;
          const details: string[] = [mediaType];
          if (dimensions) details.push(`${dimensions.width}×${dimensions.height}`);
          details.push(`${Math.max(1, Math.round(info.size / 1024))} KB`);
          return {
            content: [
              {
                type: "text",
                text: `${basename(path)} — ${details.join(", ")}, path: ${path}`,
              },
              { type: "image", mediaType, path },
            ],
          };
        }

        if (data.includes(0)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Cannot read binary file: ${path}` }],
          };
        }
        const allLines = data.toString("utf8").split("\n");
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
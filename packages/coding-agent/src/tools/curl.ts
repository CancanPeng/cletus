import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { AgentTool, ToolResult } from "@cletus/agent";

const execFileAsync = promisify(execFile);
const MAX_CONCURRENCY = 8;
const MAX_BODY = 8000;

type CurlResult = {
  url: string;
  status?: number;
  body: string;
  error?: string;
};

function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

async function fetchOne(
  url: string,
  timeoutSeconds: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<CurlResult> {
  // Per-call nonce so response bodies cannot spoof the status marker.
  const marker = `\n__CLETUS_STATUS_${randomBytes(8).toString("hex")}__`;
  const args = [
    "-sS",
    "-L",
    "--proto-redir",
    "=http,https",
    "--max-redirs",
    "5",
    "--max-time",
    String(timeoutSeconds),
    "--max-filesize",
    "2097152",
    "-w",
    `${marker}%{http_code}`,
  ];
  for (const [key, value] of Object.entries(headers)) args.push("-H", `${key}: ${value}`);
  args.push(url);
  try {
    const result = await execFileAsync("curl", args, {
      timeout: (timeoutSeconds + 5) * 1000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      ...(signal ? { signal } : {}),
    });
    const raw = String(result.stdout);
    const index = raw.lastIndexOf(marker);
    const status = index >= 0 ? Number(raw.slice(index + marker.length).trim()) : undefined;
    const body = index >= 0 ? raw.slice(0, index) : raw;
    return {
      url,
      ...(status !== undefined && Number.isFinite(status) ? { status } : {}),
      body:
        body.length > MAX_BODY
          ? `${body.slice(0, MAX_BODY)}\n[truncated ${body.length - MAX_BODY} chars]`
          : body,
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const detail = error instanceof Error ? error.message : String(error);
    return { url, body: "", error: detail };
  }
}

export function createCurlTool(): AgentTool {
  return {
    name: "curl",
    snippet: "Fetch multiple URLs in parallel with curl",
    description:
      "Fetch up to 20 HTTP/HTTPS URLs concurrently with curl and return a labeled response per URL.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string" },
          description: "URLs to fetch concurrently",
        },
        timeout: { type: "number", description: "Per-request timeout in seconds" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional HTTP headers",
        },
      },
      required: ["urls"],
      additionalProperties: false,
    },
    async execute(params, ctx): Promise<ToolResult> {
      const rawUrls = Array.isArray(params["urls"]) ? params["urls"] : [];
      const urls: string[] = [];
      for (const value of rawUrls.slice(0, 20)) {
        try {
          urls.push(validateUrl(String(value)));
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      }
      if (urls.length === 0) {
        return { isError: true, content: [{ type: "text", text: "curl requires urls" }] };
      }
      const rawTimeout = Number(params["timeout"] ?? 20);
      const timeoutSeconds = Number.isFinite(rawTimeout)
        ? Math.min(Math.max(rawTimeout, 1), 120)
        : 20;
      const headers: Record<string, string> = {};
      if (params["headers"] && typeof params["headers"] === "object") {
        for (const [key, value] of Object.entries(params["headers"])) {
          if (typeof value !== "string") continue;
          // curl -H @file reads local files; CRLF enables header injection.
          if (value.startsWith("@") || /[\r\n]/.test(key) || /[\r\n]/.test(value)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Invalid header: ${key}` }],
            };
          }
          headers[key] = value;
        }
      }

      const results: CurlResult[] = new Array(urls.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < urls.length) {
          const index = next;
          next += 1;
          results[index] = await fetchOne(
            urls[index] as string,
            timeoutSeconds,
            headers,
            ctx.signal,
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, () => worker()),
      );

      const sections: string[] = [];
      for (const result of results) {
        const status = result.status !== undefined ? `HTTP ${result.status}` : "ERROR";
        sections.push(
          `## ${result.url}\n${status}${result.error ? `\n${result.error}` : ""}\n${result.body}`.trimEnd(),
        );
      }
      const text = sections.join("\n\n---\n\n");
      const isError = results.every((result) => result.error !== undefined);
      return {
        isError,
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  };
}

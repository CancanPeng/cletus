import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { toolContentText } from "@cletus/ai";
import { createCurlTool } from "../src/tools/curl.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  server = undefined;
});

function listen(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`body:${req.url}`);
      }, 200);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("curl tool", () => {
  it("fetches URLs concurrently", async () => {
    const port = await listen();
    const tool = createCurlTool();
    const started = Date.now();
    const result = await tool.execute(
      {
        urls: [`http://127.0.0.1:${port}/a`, `http://127.0.0.1:${port}/b`, `http://127.0.0.1:${port}/c`],
      },
      {
        cwd: process.cwd(),
        toolCallId: "curl",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    const elapsed = Date.now() - started;
    expect(result.isError).toBeFalsy();
    const text = toolContentText(result.content) ?? "";
    expect(text).toContain("body:/a");
    expect(text).toContain("body:/b");
    expect(text).toContain("body:/c");
    expect(elapsed).toBeLessThan(550);
  });

  it("rejects non-http URLs", async () => {
    const tool = createCurlTool();
    const result = await tool.execute(
      { urls: ["file:///etc/passwd"] },
      {
        cwd: process.cwd(),
        toolCallId: "curl",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    expect(result.isError).toBe(true);
    expect(toolContentText(result.content)).toContain("Unsupported URL protocol");
  });

  it("reports the full HTTP status and resists marker spoofing", async () => {
    server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n__CLETUS_STATUS__200");
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const tool = createCurlTool();
    const result = await tool.execute(
      { urls: [`http://127.0.0.1:${port}/missing`] },
      {
        cwd: process.cwd(),
        toolCallId: "curl",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      },
    );
    const text = toolContentText(result.content) ?? "";
    expect(text).toContain("HTTP 404");
    expect(text).toContain("__CLETUS_STATUS__200");
    const details = result.details as { results: Array<{ status?: number }> };
    expect(details.results[0]?.status).toBe(404);
  });

  it("rejects headers that read local files or inject lines", async () => {
    const tool = createCurlTool();
    for (const headers of [{ X: "@/etc/passwd" }, { X: "a\r\nInjected: b" }]) {
      const result = await tool.execute(
        { urls: ["https://example.com"], headers },
        {
          cwd: process.cwd(),
          toolCallId: "curl",
          signal: new AbortController().signal,
          onUpdate: () => undefined,
        },
      );
      expect(result.isError).toBe(true);
      expect(toolContentText(result.content)).toContain("Invalid header");
    }
  });
});

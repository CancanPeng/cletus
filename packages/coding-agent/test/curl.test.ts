import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
    const text = result.content[0]?.text ?? "";
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
    expect(result.content[0]?.text).toContain("Unsupported URL protocol");
  });
});

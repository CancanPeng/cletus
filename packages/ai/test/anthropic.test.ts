import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantStreamEvent, Model } from "../src/types.js";
import { streamAnthropic } from "../src/anthropic.js";

const model: Model = {
  provider: "anthropic",
  id: "claude-test",
  baseUrl: "http://127.0.0.1:1",
  apiKeyEnv: "FAKE_ANTHROPIC_KEY",
  contextWindow: 200000,
  maxOutputTokens: 8192,
  supportsThinking: true,
};

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  server = undefined;
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function collect(stream: AsyncIterable<AssistantStreamEvent>): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamAnthropic", () => {
  it("keeps thinking signatures and tool input", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { usage: { input_tokens: 10 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}`;
    const events = await collect(
      streamAnthropic(model, { systemPrompt: "s", messages: [], tools: [] }),
    );
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.stopReason).toBe("toolUse");
      expect(done.message.content).toContainEqual({
        type: "thinking",
        thinking: "plan",
        signature: "sig",
      });
      expect(done.message.content).toContainEqual({
        type: "toolCall",
        id: "toolu_1",
        name: "read",
        arguments: { path: "a.txt" },
      });
      expect(done.message.usage.input).toBe(10);
      expect(done.message.usage.output).toBe(5);
    }
  });

  it("fails the stream on a mid-stream error event", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
        );
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}`;
    const events = await collect(
      streamAnthropic(model, { systemPrompt: "s", messages: [], tools: [] }),
    );
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.error).toContain("Overloaded");
      expect(error.message.stopReason).toBe("error");
    }
  });

  it("fails the stream when the connection ends without message_stop", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "half" } })}\n\n`,
        );
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}`;
    const events = await collect(
      streamAnthropic(model, { systemPrompt: "s", messages: [], tools: [] }),
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.error).toContain("message_stop");
    }
  });

  it("serializes user images as base64 image blocks before text", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const dir = await mkdtemp(join(tmpdir(), "cletus-img-"));
    const imgPath = join(dir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imgPath, bytes);
    let body: { messages: Array<{ content: unknown }> } | undefined;
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as { messages: Array<{ content: unknown }> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"type":"message_stop"}\n\n');
      });
    });
    const events = await collect(
      streamAnthropic(
        { ...model, baseUrl: `http://127.0.0.1:${port}` },
        {
          systemPrompt: "s",
          tools: [],
          messages: [
            {
              role: "user",
              content: "analyze",
              timestamp: 1,
              images: [{ mediaType: "image/png", path: imgPath }],
            },
          ],
        },
        { apiKey: "test" },
      ),
    );
    expect(events.some((event) => event.type === "done")).toBe(true);
    const content = body?.messages[0]?.content as unknown[];
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
    expect(content[1]).toEqual({ type: "text", text: "analyze" });
  });

  it("degrades missing image files to a text placeholder", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const missing = join(tmpdir(), "cletus-img-missing", "gone.png");
    let body: { messages: Array<{ content: unknown }> } | undefined;
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as { messages: Array<{ content: unknown }> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"type":"message_stop"}\n\n');
      });
    });
    const events = await collect(
      streamAnthropic(
        { ...model, baseUrl: `http://127.0.0.1:${port}` },
        {
          systemPrompt: "s",
          tools: [],
          messages: [
            {
              role: "user",
              content: "analyze",
              timestamp: 1,
              images: [{ mediaType: "image/png", path: missing }],
            },
          ],
        },
        { apiKey: "test" },
      ),
    );
    expect(events.some((event) => event.type === "done")).toBe(true);
    const content = body?.messages[0]?.content as unknown[];
    expect(content).toContainEqual({ type: "text", text: `[图片不可用: ${missing}]` });
    expect(content).toContainEqual({ type: "text", text: "analyze" });
  });

  it("sends image blocks inside tool_result", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const dir = await mkdtemp(join(tmpdir(), "cletus-tool-img-"));
    const imgPath = join(dir, "shot.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imgPath, bytes);
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"type":"message_stop"}\n\n');
      });
    });
    await collect(
      streamAnthropic(
        { ...model, baseUrl: `http://127.0.0.1:${port}` },
        {
          systemPrompt: "s",
          tools: [],
          messages: [
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "read",
              content: [
                { type: "text", text: "shot.png \u2014 image/png" },
                { type: "image", mediaType: "image/png", path: imgPath },
              ],
              isError: false,
              timestamp: 1,
            },
          ],
        },
        { apiKey: "test" },
      ),
    );
    const blocks = body?.messages[0]?.["content"] as unknown[];
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" });
    const inner = (blocks[0] as { content: unknown[] }).content;
    expect(inner[0]).toEqual({ type: "text", text: "shot.png \u2014 image/png" });
    expect(inner[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
  });

  it("degrades a missing tool_result image to a text placeholder", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    const missing = join(tmpdir(), "cletus-tool-img-missing", "gone.png");
    let body: { messages: Array<Record<string, unknown>> } | undefined;
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as { messages: Array<Record<string, unknown>> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"type":"message_stop"}\n\n');
      });
    });
    await collect(
      streamAnthropic(
        { ...model, baseUrl: `http://127.0.0.1:${port}` },
        {
          systemPrompt: "s",
          tools: [],
          messages: [
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "read",
              content: [{ type: "image", mediaType: "image/png", path: missing }],
              isError: false,
              timestamp: 1,
            },
          ],
        },
        { apiKey: "test" },
      ),
    );
    const blocks = body?.messages[0]?.["content"] as unknown[];
    const inner = (blocks[0] as { content: unknown[] }).content;
    expect(inner).toEqual([{ type: "text", text: `[\u56fe\u7247\u4e0d\u53ef\u7528: ${missing}]` }]);
  });
});

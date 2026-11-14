import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantMessage,
  type AssistantStreamEvent,
  type Message,
  type Model,
  type ToolContent,
} from "../src/types.js";
import { streamOpenAI } from "../src/openai.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKeyEnv: "FAKE_KEY",
  contextWindow: 1000,
  maxOutputTokens: 100,
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

async function collect(stream: AsyncIterable<AssistantStreamEvent>): Promise<AssistantStreamEvent[]> {
  const events: AssistantStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("streamOpenAI", () => {
  it("merges tool call deltas and usage", async () => {
    process.env["FAKE_KEY"] = "test";
    let requests = 0;
    const port = await listen((req, res) => {
      requests += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":null}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    expect(requests).toBe(1);
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.stopReason).toBe("toolUse");
      const call = done.message.content.find((block) => block.type === "toolCall");
      expect(call).toMatchObject({ name: "read", arguments: { path: "a.txt" } });
      expect(done.message.usage.totalTokens).toBe(7);
    }
  });

  it("retries 429 then succeeds", async () => {
    process.env["FAKE_KEY"] = "test";
    let attempts = 0;
    const port = await listen((req, res) => {
      attempts += 1;
      req.resume();
      req.on("end", () => {
        if (attempts < 3) {
          res.writeHead(429, { "retry-after": "0" });
          res.end("slow down");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    expect(attempts).toBe(3);
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
  });

  it("reports a missing key without throwing", async () => {
    delete process.env["FAKE_KEY"];
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    expect(assistantMessage(model, [], "error").role).toBe("assistant");
  });

  it("emits argument fragments that arrive with the first tool call delta", async () => {
    process.env["FAKE_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":null}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    const startIndex = events.findIndex((event) => event.type === "toolcall_start");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    const deltas = events
      .slice(startIndex + 1)
      .filter((event) => event.type === "toolcall_delta")
      .map((event) => (event.type === "toolcall_delta" ? event.delta : ""))
      .join("");
    expect(deltas).toBe('{"path":"a.txt"}');
  });

  it("fails the stream on a mid-stream error object", async () => {
    process.env["FAKE_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        );
        res.write('data: {"error":{"message":"server overloaded","type":"server_error"}}\n\n');
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") expect(error.error).toContain("server overloaded");
  });

  it("fails the stream when no finish reason arrives", async () => {
    process.env["FAKE_KEY"] = "test";
    const port = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    model.baseUrl = `http://127.0.0.1:${port}/v1`;
    const events = await collect(streamOpenAI(model, { systemPrompt: "s", messages: [], tools: [] }));
    const error = events.find((event) => event.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") expect(error.error).toContain("finish reason");
  });

  it("serializes user images as image_url parts after text", async () => {
    process.env["FAKE_KEY"] = "test";
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
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    const events = await collect(
      streamOpenAI(
        { ...model, baseUrl: `http://127.0.0.1:${port}/v1` },
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
    const content = body?.messages[1]?.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "analyze" });
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
    });
  });

  it("degrades missing image files to a text placeholder", async () => {
    process.env["FAKE_KEY"] = "test";
    const missing = join(tmpdir(), "cletus-img-missing", "gone.png");
    let body: { messages: Array<{ content: unknown }> } | undefined;
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        body = JSON.parse(raw) as { messages: Array<{ content: unknown }> };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    const events = await collect(
      streamOpenAI(
        { ...model, baseUrl: `http://127.0.0.1:${port}/v1` },
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
    const content = body?.messages[1]?.content as unknown[];
    expect(content).toContainEqual({ type: "text", text: `[图片不可用: ${missing}]` });
    expect(content).toContainEqual({ type: "text", text: "analyze" });
  });
});

async function captureBody(
  messages: Parameters<typeof streamOpenAI>[1]["messages"],
): Promise<Array<Record<string, unknown>>> {
  process.env["FAKE_KEY"] = "test";
  let body: Array<Record<string, unknown>> | undefined;
  const port = await listen((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      body = (JSON.parse(raw) as { messages: Array<Record<string, unknown>> }).messages;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
  });
  model.baseUrl = `http://127.0.0.1:${port}/v1`;
  await collect(streamOpenAI(model, { systemPrompt: "s", messages, tools: [] }));
  if (!body) throw new Error("no request body captured");
  return body;
}

function toolResult(toolCallId: string, content: ToolContent[]): Message {
  return { role: "toolResult", toolCallId, toolName: "read", content, isError: false, timestamp: 1 };
}

function assistantWithCalls(ids: string[]): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
    provider: "openai",
    model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("streamOpenAI tool result images", () => {
  it("moves a tool_result image into a trailing user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cletus-openai-img-"));
    const imgPath = join(dir, "a.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imgPath, bytes);
    const messages = await captureBody([
      assistantWithCalls(["call_1"]),
      toolResult("call_1", [
        { type: "text", text: "a.png — image/png" },
        { type: "image", mediaType: "image/png", path: imgPath },
      ]),
    ]);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "a.png — image/png",
    });
    expect(messages[3]).toMatchObject({ role: "user" });
    const parts = messages[3]?.["content"] as unknown[];
    expect(parts[0]).toEqual({ type: "text", text: "↑ 1 image(s) returned by tool calls: a.png" });
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
    });
  });

  it("keeps parallel tool messages contiguous and emits one combined user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cletus-openai-img2-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.jpg");
    await writeFile(a, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(b, Buffer.from([0xff, 0xd8, 0xff]));
    const messages = await captureBody([
      assistantWithCalls(["call_1", "call_2"]),
      toolResult("call_1", [
        { type: "text", text: "a.png" },
        { type: "image", mediaType: "image/png", path: a },
      ]),
      toolResult("call_2", [
        { type: "text", text: "b.jpg" },
        { type: "image", mediaType: "image/jpeg", path: b },
      ]),
    ]);
    expect(messages.map((m) => m["role"])).toEqual(["system", "assistant", "tool", "tool", "user"]);
    const parts = messages[4]?.["content"] as unknown[];
    expect(parts[0]).toEqual({
      type: "text",
      text: "↑ 2 image(s) returned by tool calls: a.png, b.jpg",
    });
    expect(parts).toHaveLength(3);
  });

  it("emits no synthetic user message for text-only tool results", async () => {
    const messages = await captureBody([
      assistantWithCalls(["call_1"]),
      toolResult("call_1", [{ type: "text", text: "plain" }]),
    ]);
    expect(messages.map((m) => m["role"])).toEqual(["system", "assistant", "tool"]);
  });
});

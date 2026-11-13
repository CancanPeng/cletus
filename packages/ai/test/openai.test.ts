import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantMessage,
  type AssistantStreamEvent,
  type Model,
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
});
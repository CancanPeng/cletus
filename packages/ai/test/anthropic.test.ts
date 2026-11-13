import { createServer, type Server } from "node:http";
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

  it("declares and parses native web search results", async () => {
    process.env["FAKE_ANTHROPIC_KEY"] = "test";
    let requestBody: Record<string, unknown> = {};
    const port = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { usage: { input_tokens: 12 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "cletus" },
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Cletus",
                  url: "https://example.com/cletus",
                  encrypted_content: "secret",
                  page_age: null,
                },
              ],
            },
          },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "text_delta", text: "Found it." },
          },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ];
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
    });
    const searchModel: Model = { ...model, webSearch: true, baseUrl: `http://127.0.0.1:${port}` };
    const events = await collect(
      streamAnthropic(searchModel, { systemPrompt: "s", messages: [], tools: [] }),
    );
    const tools = requestBody["tools"];
    expect(Array.isArray(tools)).toBe(true);
    expect(JSON.stringify(tools)).toContain("web_search_20250305");
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.content).toContainEqual({
        type: "serverToolUse",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "cletus" },
      });
      expect(done.message.content).toContainEqual({
        type: "webSearchResult",
        toolUseId: "srvtoolu_1",
        results: [
          {
            title: "Cletus",
            url: "https://example.com/cletus",
            pageAge: null,
            encryptedContent: "secret",
          },
        ],
      });
      expect(done.message.content).toContainEqual({ type: "text", text: "Found it." });
    }
  });
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
});
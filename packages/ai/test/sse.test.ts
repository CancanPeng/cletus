import { describe, expect, it } from "vitest";
import { parseSse } from "../src/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  return new ReadableStream({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("parseSse", () => {
  it("parses events split across chunks and CRLF boundaries", async () => {
    const events = [];
    for await (const event of parseSse(
      streamOf(["event: x\r\nda", 'ta: {"a":1}\r\n\r', "\ndata: second\n\n"]),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "x", data: '{"a":1}' },
      { data: "second" },
    ]);
  });

  it("ignores comments and keeps [DONE] as data", async () => {
    const events = [];
    for await (const event of parseSse(streamOf([": ping\n\ndata: [DONE]\n\n"]))) {
      events.push(event);
    }
    expect(events).toEqual([{ data: "[DONE]" }]);
  });
});
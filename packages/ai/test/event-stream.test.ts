import { describe, expect, it } from "vitest";
import { AssistantEventStream } from "../src/event-stream.js";
import { assistantMessage, type Model } from "../src/types.js";

const model: Model = {
  provider: "openai",
  id: "fake",
  baseUrl: "http://localhost",
  contextWindow: 1000,
  maxOutputTokens: 100,
};

describe("AssistantEventStream", () => {
  it("settles result() when the consumer stops iterating early", async () => {
    const stream = new AssistantEventStream();
    stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
    stream.push({ type: "text_delta", delta: "partial answer" });

    for await (const event of stream) {
      if (event.type === "text_delta") break;
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("fake");
  });

  it("keeps the final message when iteration ends normally", async () => {
    const stream = new AssistantEventStream();
    const final = assistantMessage(model, [{ type: "text", text: "done" }], "stop");
    stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
    stream.end(final);

    for await (const _event of stream) {
      // drain
    }

    expect(await stream.result()).toBe(final);
  });
});

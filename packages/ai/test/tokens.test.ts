import { describe, expect, it } from "vitest";
import { estimateMessageTokens } from "../src/tokens.js";
import type { Message } from "../src/types.js";

describe("estimateMessageTokens with images", () => {
  it("adds 1600 tokens per attached image", () => {
    const base: Message = { role: "user", content: "look", timestamp: 1 };
    const withImages: Message = {
      ...base,
      images: [
        { mediaType: "image/png", path: "/tmp/a.png" },
        { mediaType: "image/jpeg", path: "/tmp/b.jpg" },
      ],
    };
    expect(estimateMessageTokens(withImages) - estimateMessageTokens(base)).toBe(3200);
  });

  it("unchanged for messages without images", () => {
    expect(estimateMessageTokens({ role: "user", content: "abcd", timestamp: 1 })).toBe(5);
  });
});

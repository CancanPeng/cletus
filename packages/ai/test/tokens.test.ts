import { describe, expect, it } from "vitest";
import { estimateMessageTokens, toolContentText } from "../src/tokens.js";
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

describe("estimateMessageTokens with tool images", () => {
  it("adds 1600 tokens per image content block", () => {
    const base: Message = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "shot.png" }],
      isError: false,
      timestamp: 1,
    };
    const withImage: Message = {
      ...base,
      content: [
        { type: "text", text: "shot.png" },
        { type: "image", mediaType: "image/png", path: "/tmp/a.png" },
      ],
    };
    expect(estimateMessageTokens(withImage) - estimateMessageTokens(base)).toBe(1600);
  });

  it("toolContentText flattens text and marks images by basename", () => {
    expect(
      toolContentText([
        { type: "text", text: "shot.png — image/png" },
        { type: "image", mediaType: "image/png", path: "/tmp/dir/a.png" },
      ]),
    ).toBe("shot.png — image/png\n[图片: a.png  image/png]");
  });
});

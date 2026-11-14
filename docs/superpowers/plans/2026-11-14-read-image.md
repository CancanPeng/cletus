# read 工具返回图片（模型主动看图）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `read` 工具在读到 PNG/JPEG 时返回图片块，使模型能主动看图（而不是只处理用户贴的图）。

**Architecture:** 把 `ToolResult.content` 从 `TextContent[]` 放宽为 `ToolContent[]`（`TextContent | ImageContent`），`ImageContent` 只带路径引用不内联 base64。provider 序列化时才读文件转 base64。Anthropic 的 `tool_result` 原生支持图片块；OpenAI 的 `tool` 消息只接受字符串，因此图片按**轮次聚合**成一条合成 user 消息，放在该轮全部 tool 消息之后。

**Tech Stack:** TypeScript ESM (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)、vitest、node:fs。

**Spec:** `docs/superpowers/specs/2026-11-14-read-image-design.md`

## Global Constraints

- 单张图片 ≤ **5 \* 1024 \* 1024 字节**；超限返回 `isError: true`，**绝不截断图片字节**
- 仅识别 `image/png` 与 `image/jpeg`（PNG 魔数 `89 50 4E 47 0D 0A 1A 0A`，JPEG 魔数 `FF D8 FF`）
- **按内容判断，不看扩展名**
- 每张图 token 估算 **1600**（与贴图方案同一常数）
- 附件/文件缺失时降级为文本占位，不让整轮请求失败
- 非视觉模型（`supportsImages === false`）剥掉图片但**保留文字摘要**
- JSONL 只存路径引用；session version 保持 1；旧会话文件必须照常工作
- **不得用 `as TextContent[]` 之类断言绕过编译器**——类型放宽后的报错点是本次重构的安全网
- 不顺手重构 `message.content` 的 `string` 语义
- 测试命令：`pnpm typecheck`；`NODE_OPTIONS=--experimental-ffi npx vitest run <path>`

## Review Focus

1. **超过 5MB 的图片**——用户会误拖一张 8MB 的 Retina 截图。期望：明确的文字错误说明尺寸和上限，不是静默失败，更不是返回半张图。
2. **扩展名与内容不一致**——`image.png` 里其实是文本日志，`data.bin` 里其实是 PNG。期望：按内容处理，两种都正确。
3. **PNG 魔数命中但文件被截断**（只有 10 字节）——期望：不崩溃；能返回图片就返回，尺寸字段缺失即可。
4. **一轮里两个并行 `read` 各自返回图片**——OpenAI 下这会构造出最容易触发 400 的消息序列。期望：两条 tool 消息连续，一条合成 user 消息承载两张图。
5. **视觉模型读图后中途 `/model` 切到非视觉模型**——期望：历史里的图片被剥成占位文本，对话继续，不报错。

---

### Task 1: ai 包类型放宽 + `toolContentText` + token 估算

**Files:**
- Modify: `packages/ai/src/types.ts:4-5`（新增类型）、`packages/ai/src/types.ts:42-49`（toolResult）
- Modify: `packages/ai/src/tokens.ts:29-32`（toolResult 分支）
- Modify: `packages/agent/src/types.ts:30`（`ToolResult.content`）
- Modify: `packages/ai/src/anthropic.ts:84`、`packages/ai/src/openai.ts:74`（先用 helper 压平，Task 2/3 再改成真图片块）
- Modify: `packages/coding-agent/src/cli.ts:363,366,1103`
- Modify: `packages/coding-agent/src/session/transcript.ts:32`
- Modify: `packages/coding-agent/src/session/compaction.ts:117`
- Modify: 18 处测试断言（见 Step 5）
- Test: `packages/ai/test/tokens.test.ts`

**Interfaces:**
- Produces:
  - `export type ImageContent = { type: "image"; mediaType: "image/png" | "image/jpeg"; path: string }`
  - `export type ToolContent = TextContent | ImageContent`
  - `export function toolContentText(content: ToolContent[]): string`
  - `Message` 的 `toolResult` 分支：`content: ToolContent[]`
  - `ToolResult.content: ToolContent[]`（`@cletus/agent`）

- [ ] **Step 1: 写失败测试（token 估算）**

在 `packages/ai/test/tokens.test.ts` 追加：

```ts
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
```

同步把文件顶部 import 改为 `import { estimateMessageTokens, toolContentText } from "../src/tokens.js";` 和 `import type { Message } from "../src/types.js";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/tokens.test.ts`
Expected: FAIL —`toolContentText` 未导出；`content` 类型不接受 `type: "image"`。

- [ ] **Step 3: 加类型**

`packages/ai/src/types.ts`，在 `TextContent` 之后：

```ts
export type ImageContent = { type: "image"; mediaType: "image/png" | "image/jpeg"; path: string };
export type ToolContent = TextContent | ImageContent;
```

同文件把 `Message` 的 `toolResult` 分支 `content: TextContent[]` 改为 `content: ToolContent[]`。

`packages/agent/src/types.ts`：把 `ToolResult.content: TextContent[]` 改为 `ToolContent[]`，并把它加进已有的 `@cletus/ai` type import。

- [ ] **Step 4: 加 helper 与 token 估算**

`packages/ai/src/tokens.ts` 新增导出：

```ts
export function toolContentText(content: ToolContent[]): string {
  return content
    .map((block) =>
      block.type === "text" ? block.text : `[图片: ${basename(block.path)}  ${block.mediaType}]`,
    )
    .join("\n");
}
```

（`import { basename } from "node:path";`——`@cletus/ai` 目前在 `anthropic.ts`/`openai.ts` 已用 `node:fs/promises`，用 `node:path` 不违反其零依赖原则。）

同文件 `estimateMessageTokens` 的最后一个 `else` 分支改成：

```ts
} else {
  for (const block of message.content) {
    total += block.type === "text" ? estimateTokens(block.text) : 1600;
  }
}
```

- [ ] **Step 5: 修复全仓库因类型放宽产生的编译错误**

`pnpm typecheck` 会列出所有报错点。逐一改：

源码（**7 处**）——用 `toolContentText` 压平。**注意 Anthropic 那处要保持块数组形状**，只是合并成单块：
- `packages/ai/src/anthropic.ts:84` → `content: [{ type: "text", text: toolContentText(message.content) }]`（原本是 N 个 text 块，现在合为 1 个；provider 侧语义等价）
- `packages/ai/src/openai.ts:74` → `content: toolContentText(message.content)`（本来就是字符串）
- `packages/coding-agent/src/cli.ts:363`、`cli.ts:366`、`cli.ts:1103`
- `packages/coding-agent/src/session/transcript.ts:32`
- `packages/coding-agent/src/session/compaction.ts:117`

`toolContentText` 从 `./tokens.js` 导入（同包内相对路径，不引入循环依赖：`tokens.ts` 只 import `./types.js`）。

**本步只做压平**，Anthropic/OpenAI 真正发送图片块留给 Task 2/3。此时全仓库还没有任何代码产出 `ImageContent`，所以行为零变化。

测试（18 处）——统一改成用 `toolContentText`，不引入任何类型断言：

| 文件 | 原写法 | 改成 |
|---|---|---|
| `agent/test/agent.test.ts:104` | `results[0]?.content[0]?.text` | `toolContentText(results[0]?.content ?? [])` |
| `coding-agent/test/mcp.test.ts:40` | `result.content[0]?.text` | `toolContentText(result.content)` |
| `coding-agent/test/websearch.test.ts:186,187` | 同上 | 同上 |
| `coding-agent/test/edit.test.ts:51,71,77` | 同上 | 同上 |
| `coding-agent/test/extensions.test.ts:53` | 同上 | 同上 |
| `coding-agent/test/subagent.test.ts:50` | 同上 | 同上 |
| `coding-agent/test/curl.test.ts:48,67,91,111` | 同上 | 同上 |
| `coding-agent/test/bash.test.ts:39` | `partial.content.map((block) => block.text).join("")` | `toolContentText(partial.content)` |
| `coding-agent/test/bash.test.ts:44,67,90,121` | `result.content[0]?.text` | `toolContentText(result.content)` |

每个文件加 `import { toolContentText } from "@cletus/ai";`（`agent.test.ts` 同）。

- [ ] **Step 6: 跑 typecheck 与受影响测试**

Run: `pnpm typecheck`
Expected: 无输出，退出码 0。

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai packages/agent packages/coding-agent`
Expected: 全部 PASS，无回归。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(ai): allow image content in tool results"
```

---

### Task 2: Anthropic `tool_result` 发送原生图片块

**Files:**
- Modify: `packages/ai/src/anthropic.ts:80-87`
- Test: `packages/ai/test/anthropic.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ToolContent`、`ImageContent`
- Produces: 无新导出；`tool_result.content` 现在可能包含 `{type:"image", source:{type:"base64", media_type, data}}`

- [ ] **Step 1: 写失败测试**

在 `packages/ai/test/anthropic.test.ts` 的 `describe` 内追加：

```ts
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
              { type: "text", text: "shot.png — image/png" },
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
  expect(inner[0]).toEqual({ type: "text", text: "shot.png — image/png" });
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
  expect(inner).toEqual([{ type: "text", text: `[图片不可用: ${missing}]` }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/anthropic.test.ts`
Expected: FAIL —两个新用例都不通过（当前走 `toolContentText`，图片被压平成 `[图片: ...]` 文本）。

- [ ] **Step 3: 改成原生图片块**

`packages/ai/src/anthropic.ts` 的 `toolResult` 分支，把 `content:` 那一行换成读文件并分派。该函数已是 async，可直接 await：

```ts
} else if (message.role === "toolResult") {
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    try {
      const data = (await readFile(block.path)).toString("base64");
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mediaType, data },
      });
    } catch {
      blocks.push({ type: "text", text: `[图片不可用: ${block.path}]` });
    }
  }
  append("user", {
    type: "tool_result",
    tool_use_id: message.toolCallId,
    content: blocks,
    is_error: message.isError,
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/anthropic.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/anthropic.ts packages/ai/test/anthropic.test.ts
git commit -m "feat(ai): send image blocks inside anthropic tool_result"
```

---

### Task 3: OpenAI 按轮次聚合图片为合成 user 消息

**Files:**
- Modify: `packages/ai/src/openai.ts:32-48`（`toOpenAIMessage` → `toOpenAIMessages` fold）、`openai.ts:134-137`（调用点）
- Test: `packages/ai/test/openai.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ToolContent`、`ImageContent`
- Produces: 内部函数 `toOpenAIMessages(messages: Message[]): Promise<Array<Record<string, unknown>>>`（替换原 `toOpenAIMessage`，不导出）

**为什么必须按轮次聚合：** OpenAI 要求同一 assistant 轮次的全部 `tool` 消息**连续紧邻**，任何其他角色插在中间都会被拒。把图片逐条插在各自 tool 消息之后，同一轮有多个看图调用时就必然踩坑——`github/copilot-sdk#1922` 记录了完全相同的失败（同一模型同一内容，穿插 → `400 invalid_request_error`；全部挪到该轮 tool 消息之后 → `200 OK`）。

- [ ] **Step 1: 写失败测试**

在 `packages/ai/test/openai.test.ts` 追加。三个用例分别钉住：单图、双图、纯文本轮次。

```ts
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
  expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.png — image/png" });
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
  expect(parts[0]).toEqual({ type: "text", text: "↑ 2 image(s) returned by tool calls: a.png, b.jpg" });
  expect(parts).toHaveLength(3);
});

it("emits no synthetic user message for text-only tool results", async () => {
  const messages = await captureBody([
    assistantWithCalls(["call_1"]),
    toolResult("call_1", [{ type: "text", text: "plain" }]),
  ]);
  expect(messages.map((m) => m["role"])).toEqual(["system", "assistant", "tool"]);
});
```

文件顶部补 import：`import { mkdtemp, writeFile } from "node:fs/promises";`、`import { tmpdir } from "node:os";`、`import { join } from "node:path";`（部分已存在），以及 `import type { Message, ToolContent } from "../src/types.js";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/openai.test.ts`
Expected: FAIL —合成 user 消息不存在，`messages` 只有 3 条。

- [ ] **Step 3: 实现 fold**

`packages/ai/src/openai.ts`：把 `toOpenAIMessage` 替换为对整个数组做一次遍历的 `toOpenAIMessages`。每个非 `toolResult` 消息前，先 flush「待发图片」缓冲：

```ts
async function toOpenAIMessages(messages: Message[]): Promise<Array<Record<string, unknown>>> {
  const result: Array<Record<string, unknown>> = [];
  let pending: ImageContent[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const images = pending;
    pending = [];
    const parts: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: `↑ ${images.length} image(s) returned by tool calls: ${images
          .map((image) => basename(image.path))
          .join(", ")}`,
      },
    ];
    for (const image of images) {
      try {
        const data = (await readFile(image.path)).toString("base64");
        parts.push({
          type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${data}` },
        });
      } catch {
        parts.push({ type: "text", text: `[图片不可用: ${image.path}]` });
      }
    }
    result.push({ role: "user", content: parts });
  };

  for (const message of messages) {
    if (message.role === "toolResult") {
      // Text only: the images travel in the synthetic user message instead,
      // so a `[图片: …]` placeholder here would duplicate them.
      const text = message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      result.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
      pending.push(...message.content.filter((b): b is ImageContent => b.type === "image"));
      continue;
    }
    await flush();
    result.push(await toOpenAIMessage(message));
  }
  await flush();
  return result;
}
```

同时：`toOpenAIMessage` 保留但**删掉它的 `toolResult` 分支**——fold 只把非 `toolResult` 消息交给它，参数类型收窄为 `Exclude<Message, { role: "toolResult" }>`，同时删掉末尾 `role: "tool"` 的返回。调用点改成：

```ts
body.messages = [
  { role: "system", content: context.systemPrompt },
  ...(await toOpenAIMessages(context.messages)),
];
```

注意 `basename` 从 `node:path` import，`TextContent`/`ImageContent` 从 `./types.js` type import。fold 内部不调 `toolContentText`（图片已另行发送，再拼占位文本会重复），Task 1 引入的 `toolContentText` 在本文件保留但只用于非 toolResult 路径（当前就是那个单行 string 分支）。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/openai.test.ts`
Expected: 全部 PASS，含原有的纯文本 tool 用例。

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/openai.ts packages/ai/test/openai.test.ts
git commit -m "feat(ai): lift tool result images into a trailing openai user message"
```

---

### Task 4: `read` 工具识别并返回图片

**Files:**
- Modify: `packages/coding-agent/src/tools/read.ts`（整体）
- Test: `packages/coding-agent/test/read.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ImageContent`
- Produces: 无新导出；`read` 在图片输入时返回 `content: [文本摘要, ImageContent]`

**摘要行格式（固定）：**
`<basename> — <mediaType>, <W>×<H>, <N> KB, path: <absolute path>`
尺寸或大小解析不出来时省略该字段（`<basename> — image/png, path: /abs/path`）。

- [ ] **Step 1: 写失败测试**

新建 `packages/coding-agent/test/read.test.ts`：

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createReadTool } from "../src/tools/read.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cletus-read-"));
  dirs.push(dir);
  return dir;
}

function context(cwd: string) {
  return {
    cwd,
    toolCallId: "t1",
    signal: new AbortController().signal,
    onUpdate: () => undefined,
  };
}

/** 8-byte PNG signature + IHDR chunk declaring the given dimensions. */
function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function policyFor(cwd: string): PermissionPolicy {
  return new PermissionPolicy({
    cwd,
    readOnlyRoots: [],
    allowWrite: [],
    yolo: true,
    interactive: false,
  });
}

describe("read tool images", () => {
  it("returns a text summary and an image block for a PNG", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "shot.png"), png(1280, 720));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "shot.png" },
      context(cwd),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: "text",
      text: `shot.png — image/png, 1280×720, 1 KB, path: ${join(cwd, "shot.png")}`,
    });
    expect(result.content[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      path: join(cwd, "shot.png"),
    });
  });

  it("detects JPEG by magic bytes", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "photo.bin"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "photo.bin" },
      context(cwd),
    );
    expect(result.content[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("reads text when the extension lies", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "image.png"), "just text\n");
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "image.png" },
      context(cwd),
    );
    expect(result.content).toHaveLength(1);
    // Trailing newline yields a second, empty numbered line — that is the
    // existing text-mode behavior, not something this task changes.
    expect(result.content[0]).toEqual({ type: "text", text: "     1\tjust text\n     2\t" });
  });

  it("rejects images over 5MB without truncating", async () => {
    const cwd = await temp();
    const big = Buffer.concat([png(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
    await writeFile(join(cwd, "big.png"), big);
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "big.png" },
      context(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("5MB");
  });

  it("treats a truncated PNG header as an image rather than failing", async () => {
    const cwd = await temp();
    await writeFile(join(cwd, "cut.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = await createReadTool({ policy: policyFor(cwd), cwd }).execute(
      { path: "cut.png" },
      context(cwd),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/read.test.ts`
Expected: FAIL —PNG 当前返回 `Cannot read binary file`。

- [ ] **Step 3: 实现嗅探与图片分支**

`packages/coding-agent/src/tools/read.ts`：

- 新增常量 `const MAX_IMAGE_BYTES = 5 * 1024 * 1024;`
- 新增模块内函数：

```ts
function sniffImage(head: Buffer): "image/png" | "image/jpeg" | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}

function pngSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || data.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Walks JPEG segments to the first SOF marker; returns undefined for truncated files. */
function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1] ?? 0;
    if (SOF.has(marker)) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}
```

- 在 `execute` 里，拿到 `data`（现有 `Math.min(info.size, MAX_BYTES)` 那段）之后、`data.includes(0)` 判断之前插入图片分支：

```ts
const mediaType = sniffImage(data);
if (mediaType) {
  if (info.size > MAX_IMAGE_BYTES) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Image exceeds 5MB limit: ${path} is ${Math.round(info.size / 1024 / 1024)}MB; resize or crop it before reading.`,
        },
      ],
    };
  }
  const size = mediaType === "image/png" ? pngSize(data) : jpegSize(data);
  const details = [mediaType];
  if (size) details.push(`${size.width}×${size.height}`);
  details.push(`${Math.max(1, Math.round(info.size / 1024))} KB`);
  return {
    content: [
      { type: "text", text: `${basename(path)} — ${details.join(", ")}, path: ${path}` },
      { type: "image", mediaType, path },
    ],
  };
}
```

（`import { basename } from "node:path";`）

- 同时把工具描述改成能表达新行为：`description: "Read a text file with line numbers, or an image (png/jpeg) as an image block."`

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/read.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 跑 typecheck 与全量测试**

Run: `pnpm typecheck && NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent`
Expected: 无输出 / 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/tools/read.ts packages/coding-agent/test/read.test.ts
git commit -m "feat(read): return png/jpeg files as image blocks"
```

---

### Task 5: 非视觉模型剥掉 toolResult 图片

**Files:**
- Modify: `packages/coding-agent/src/session/session.ts:228-249`（`projectForModel`）
- Test: `packages/coding-agent/test/session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ToolContent`
- Produces: 无新导出

- [ ] **Step 1: 写失败测试**

在 `packages/coding-agent/test/session.test.ts` 追加（复用该文件已有的 `temp()`、`AssistantEventStream`、`seen` 等 helper 风格）：

```ts
it("strips tool result images for non-vision models but keeps the summary text", async () => {
  const home = await temp();
  const cwd = await temp();
  const manager = await SessionManager.create(cwd, { home });
  const model: Model = {
    provider: "openai",
    id: "no-vision",
    baseUrl: "http://localhost",
    contextWindow: 100000,
    maxOutputTokens: 1000,
    supportsImages: false,
  };
  let seen: LlmContext | undefined;
  const notices: string[] = [];
  const streamFn: StreamFn = (_model, context) => {
    seen = context;
    const stream = new AssistantEventStream();
    stream.end(assistantMessage(model, [{ type: "text", text: "ok" }], "stop"));
    return stream;
  };
  // Append before create: the session replays the branch into the agent, so
  // messages added afterwards would never reach prepareRequest.
  await manager.appendMessage({
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [
      { type: "text", text: "shot.png — image/png, 10×10" },
      { type: "image", mediaType: "image/png", path: join(cwd, "shot.png") },
    ],
    isError: false,
    timestamp: 1,
  });
  const session = await AgentSession.create({
    cwd,
    home,
    config: createDefaultConfig(),
    auth: { keys: {} },
    model,
    sessionManager: manager,
    permissions: new PermissionPolicy({
      cwd,
      readOnlyRoots: [],
      allowWrite: [],
      yolo: true,
      interactive: false,
    }),
    resources: new ResourceLoader(cwd, home),
    streamFn,
    onNotice: (text) => notices.push(text),
  });
  await session.prompt("next");
  expect(notices.some((text) => text.includes("不支持图片"))).toBe(true);
  const toolMessage = seen?.messages.find((message) => message.role === "toolResult");
  expect(toolMessage?.content).toEqual([
    { type: "text", text: "shot.png — image/png, 10×10" },
    { type: "text", text: "[图片已忽略：当前模型不支持图片]" },
  ]);
  await session.dispose();
});
```

该 setup 照抄同文件已有的 `strips images for models without vision` 用例。——新增第二处可能的原因：那个用例已经占用了类似描述，新用例名必须区分开。

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/session.test.ts`
Expected: FAIL —toolResult 里的 `{type:"image"}` 原样透传。

- [ ] **Step 3: 扩展 `projectForModel`**

`session.ts` 的 `projectForModel`，在已有的 user 消息处理之外加 toolResult 分支：

```ts
const projected = messages.map((message) => {
  if (message.role === "user" && message.images?.length) {
    stripped = true;
    const { images: _images, ...rest } = message;
    return { ...rest, content: `${rest.content}\n[图片已忽略：当前模型不支持图片]` };
  }
  if (message.role === "toolResult" && message.content.some((block) => block.type === "image")) {
    stripped = true;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === "text" ? block : { type: "text" as const, text: "[图片已忽略：当前模型不支持图片]" },
      ),
    };
  }
  return message;
});
```

保留文字摘要块——路径和尺寸仍有价值，模型可以改用 bash 调 OCR。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/session.test.ts`
Expected: 全部 PASS，含原有 `supportsImages: false` 用例。

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/session/session.ts packages/coding-agent/test/session.test.ts
git commit -m "feat(session): strip tool result images for non-vision models"
```

---

### Task 6: 输出通道与文档

**Files:**
- Modify: `packages/coding-agent/src/session/transcript.ts:30-36`
- Test: `packages/coding-agent/test/transcript.test.ts`
- Modify: `README.md:88-92`

**Interfaces:**
- Consumes: Task 1 的 `toolContentText`
- Produces: 无新导出

> 注：`cli.ts` 的三处与 `compaction.ts` 的一处在 Task 1 Step 5 已改为 `toolContentText`。本任务只剩 transcript 的 `results` 表构造与文档。

- [ ] **Step 1: 写失败测试**

在 `packages/coding-agent/test/transcript.test.ts` 追加：

```ts
it("renders tool result images as a placeholder line", () => {
  const messages: AgentMessage[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.png" } }],
      provider: "openai",
      model: "fake",
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [
        { type: "text", text: "a.png — image/png" },
        { type: "image", mediaType: "image/png", path: "/tmp/a.png" },
      ],
      isError: false,
      timestamp: 2,
    },
  ];
  const blocks = projectionBlocks(messages);
  const tool = blocks.find((block) => block.kind === "tool");
  expect(tool).toMatchObject({ output: "a.png — image/png\n[图片: a.png  image/png]" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/transcript.test.ts`
Expected: FAIL —`output` 目前是 `a.png — image/png\n`（图片块被 `.text` 取成 `undefined` 后 join 掉）。

- [ ] **Step 3: 改用 helper**

`transcript.ts` 的 `results` 表构造，把

```ts
text: message.content.map((block) => block.text).join(""),
```

改为

```ts
text: toolContentText(message.content),
```

（`import { toolContentText } from "@cletus/ai";`）

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/transcript.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 更新 README**

在 `README.md` 图片段落（约 line 90-92）之后补一句，说明 `read` 现在能看图及其限制：

```markdown
The `read` tool also sees images: reading a `.png` or `.jpeg` returns the picture to the model along with a one-line summary (format, pixel size, absolute path), so it can inspect a screenshot in your project without you pasting it. Files are detected by content, not extension. The 5MB per-image limit applies here too, and images over it are rejected rather than truncated. Non-vision models get the summary plus an ignored-image placeholder.
```

- [ ] **Step 6: 全量验证**

Run: `pnpm typecheck`
Expected: 无输出，退出码 0。

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run`
Expected: 全部 PASS。

Run: `pnpm build`
Expected: 成功，无类型错误。

- [ ] **Step 7: Commit**

```bash
git add packages/coding-agent/src/session/transcript.ts packages/coding-agent/test/transcript.test.ts README.md
git commit -m "docs: describe image reading in read tool"
```

---

## 手动验证（全部任务完成后）

用真实 key 跑一次，因为测试只能钉住请求体形状，钉不住 provider 是否接受：

1. 在项目里放一张截图 `shot.png`
2. 启动 `pnpm dev`，输入「看下 shot.png 里画的是什么」
3. 确认模型真的描述了图片内容（不是「我看不到图」）
4. 同一次会话里再让它一次读两张图，确认 OpenAI 下不返回 400
5. `/model` 切到 `supportsImages: false` 的模型，追问一句，确认对话继续且提示「图片已忽略」
# 图片粘贴（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TUI 粘贴剪贴板截图，随消息发给 Anthropic/OpenAI 视觉模型分析，图片持久化且 resume/compaction 兼容。

**Architecture:** user 消息加可选 `images` 字段（绝对路径引用，不内联 base64）；附件存会话目录；provider 序列化时读文件转 base64。`supportsImages=false` 的过滤在 coding-agent 的投影层做（`@cletus/ai` 是零依赖叶子包，不得 import config）。

**Tech Stack:** TypeScript ESM (strict, exactOptionalPropertyTypes)、vitest、OpenTUI clipboard API。

**Spec:** `docs/superpowers/specs/2026-11-14-image-paste-design.md`

## Global Constraints

- 单张图片 ≤ 5 MB（5 * 1024 * 1024 字节），单条消息 ≤ 10 张，超限粘贴时拒绝并提示
- 仅支持 `image/png` 与 `image/jpeg`
- 每张图 token 估算常数 1600
- provider 请求超限原样透传 API 错误（策略 a），不压缩、不做保留窗口
- 附件缺失降级为文本占位 `[图片不可用: <path>]`，不让整轮失败
- JSONL 只存路径引用；session version 保持 1；旧会话文件无 images 字段必须照常工作
- 不改动既有 `content: string` 调用点语义；不顺手重构
- 测试命令：`pnpm typecheck`；`NODE_OPTIONS=--experimental-ffi npx vitest run <path>`

## Review Focus

1. 旧会话 JSONL（无 images 字段）resume 后照常对话——Task 5 测试钉住
2. 附件文件被删后继续对话不整轮失败——Task 2/3 测试钉住
3. 纯文本粘贴行为零回归（含 ANSI 剥离、modal 打开时不插入）——Task 7 测试钉住
4. busy 时 steer/followUp 路径图片不丢、发送后 pending 清空——Task 7/8 测试钉住
5. 清空输入（esc）同时清 pending 附件，不带进下一条消息——Task 7 测试钉住

---

### Task 1: ai 包类型与 token 估算

**Files:**
- Modify: `packages/ai/src/types.ts:39`（user 消息）、`packages/ai/src/types.ts:63-78`（Model）
- Modify: `packages/ai/src/tokens.ts:18-22`（user 分支）
- Test: `packages/ai/test/tokens.test.ts`（新建）

**Interfaces:**
- Produces: `export type ImageAttachment = { mediaType: "image/png" | "image/jpeg"; path: string }`；user 消息 `{ role: "user"; content: string; timestamp: number; images?: ImageAttachment[] }`；`Model.supportsImages?: boolean`；`estimateMessageTokens` 对 user 消息每张图 +1600

- [ ] **Step 1: 写失败测试** `packages/ai/test/tokens.test.ts`

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/tokens.test.ts`
Expected: FAIL（images 属性不存在 → 类型错误，或差值 0 ≠ 3200）

- [ ] **Step 3: 实现**

`types.ts`：新增 `ImageAttachment` 导出；user 消息加 `images?: ImageAttachment[]`；`Model` 加 `supportsImages?: boolean`。
`tokens.ts` user 分支（注意 system 无 images，需拆开判断）：

```ts
if (message.role === "user") {
  total += estimateTokens(message.content) + (message.images?.length ?? 0) * 1600;
} else if (message.role === "system") {
  total += estimateTokens(message.content);
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/tokens.test.ts && pnpm typecheck`
Expected: PASS，typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/types.ts packages/ai/src/tokens.ts packages/ai/test/tokens.test.ts
git commit -m "feat(ai): add ImageAttachment to user messages and image token estimate"
```

---

### Task 2: Anthropic 图片序列化

**Files:**
- Modify: `packages/ai/src/anthropic.ts:33`（toAnthropicMessages 变 async）、`:106`（调用点）
- Test: `packages/ai/test/anthropic.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ImageAttachment`
- Produces: user 消息带 images 时 content 为块数组，图在前文在后：`[{type:"image",source:{type:"base64",media_type,data}},...,{type:"text",text}]`；读文件失败 → 该图替换为 `{type:"text",text:"[图片不可用: <path>]"}`

- [ ] **Step 1: 写失败测试**（沿用该文件现有 `listen`/`collect`/`model` 基建；用 `mkdtemp` 写临时 png 文件）

```ts
it("serializes user images as base64 image blocks before text", async () => {
  process.env["FAKE_ANTHROPIC_KEY"] = "test";
  const dir = await mkdtemp(join(tmpdir(), "cletus-img-"));
  const imgPath = join(dir, "shot.png");
  await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let body: any;
  const port = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"type\":\"message_stop\"}\n\n");
    });
  });
  await collect(streamAnthropic(
    { ...model, baseUrl: `http://127.0.0.1:${port}` },
    { systemPrompt: "s", tools: [], messages: [
      { role: "user", content: "analyze", timestamp: 1,
        images: [{ mediaType: "image/png", path: imgPath }] },
    ] },
    { apiKey: "test" },
  ));
  const content = body.messages[0].content;
  expect(content[0]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
  });
  expect(content[1]).toEqual({ type: "text", text: "analyze" });
});

it("degrades missing image files to a text placeholder", async () => {
  // 同上，images 指向不存在路径；断言 content 含
  // { type: "text", text: "[图片不可用: <path>]" } 且请求正常完成（done 事件）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/anthropic.test.ts`
Expected: 新增 2 个 FAIL（content 仍是纯文本块）

- [ ] **Step 3: 实现**

`toAnthropicMessages` 改 `async`，user 分支：有 `images?.length` 时先逐张 `readFile`→base64 push image 块（try/catch 降级文本占位），再 push text 块；无 images 走原路径。唯一调用点 `:106` 改 `messages: await toAnthropicMessages(context.messages)`（已在 async IIFE 内）。`node:fs/promises` 增 import `readFile`。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/anthropic.test.ts && pnpm typecheck`
Expected: 全部 PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/anthropic.ts packages/ai/test/anthropic.test.ts
git commit -m "feat(ai): send user image attachments to Anthropic as base64 blocks"
```

---

### Task 3: OpenAI 图片序列化

**Files:**
- Modify: `packages/ai/src/openai.ts:31`（toOpenAIMessage 变 async）、`:95`（调用点）
- Test: `packages/ai/test/openai.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ImageAttachment`
- Produces: user 消息带 images 时 content 为 `[{type:"text",text}, {type:"image_url",image_url:{url:"data:<mediaType>;base64,<data>"}}, ...]`；缺文件降级同 Task 2 文案

- [ ] **Step 1: 写失败测试**（结构同 Task 2，断言 `body.messages[1].content`——index 0 是 system）

```ts
// 断言 content[0] = { type: "text", text: "analyze" }
// 断言 content[1].type === "image_url" 且
// content[1].image_url.url === `data:image/png;base64,${expectedBase64}`
// 第二个用例：缺失文件 → content 含 "[图片不可用: <path>]" 文本块，流正常 done
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/openai.test.ts`
Expected: 新增 FAIL

- [ ] **Step 3: 实现**

`toOpenAIMessage` 改 async；user 分支有 images 时构造块数组（text 在前，image_url 在后，OpenAI 无顺序要求，与 Anthropic 相反是各自惯例）；调用点改 `...(await Promise.all(context.messages.map(toOpenAIMessage)))`。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/ai/test/openai.test.ts && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/openai.ts packages/ai/test/openai.test.ts
git commit -m "feat(ai): send user image attachments to OpenAI as image_url parts"
```

---

### Task 4: agent 包 prompt/steer/followUp 携带图片

**Files:**
- Modify: `packages/agent/src/types.ts`（新增 PromptInput、队列类型）
- Modify: `packages/agent/src/agent.ts:61-82,129`、`packages/agent/src/loop.ts:22,108,123`
- Test: `packages/agent/test/loop.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ImageAttachment`（从 `@cletus/ai` import）
- Produces: `export type PromptInput = { text: string; images?: ImageAttachment[] }`；`Agent.prompt(text: string, images?: ImageAttachment[])`、`steer(text, images?)`、`followUp(text, images?)`；`runAgentLoop(prompts: PromptInput[], ...)`；steering/followUp 队列元素从 `string` 变 `PromptInput`；`drainSteering/drainFollowUp` 返回 `PromptInput[]`

- [ ] **Step 1: 写失败测试**（沿用 loop.test.ts 现有 fake streamFn/emit 基建）

```ts
it("carries images on the initial prompt and steered messages", async () => {
  // config.drainSteering 首次返回 [{ text: "steer", images: [img] }]，之后返回 []
  // streamFn 返回纯文本 done（无 toolCall），第一次响应后 loop 会 drain steering
  // 断言 agent_end 的 messages 中：
  //   user "hi" 带 images: [img]
  //   user "steer" 带 images: [img]
  await runAgentLoop(
    [{ text: "hi", images: [img] }],
    { systemPrompt: "s", messages: [], tools: [] },
    configWithFakeStream, collectEmit, new AbortController().signal,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/agent/test/loop.test.ts`
Expected: FAIL（prompts 类型不匹配 / images 丢失）

- [ ] **Step 3: 实现**

`types.ts` 加 `PromptInput`；`loop.ts` `userMessage(input: PromptInput)` 构造时条件展开 `...(input.images?.length ? { images: input.images } : {})`（exactOptionalPropertyTypes）；所有 `userMessage(text)` 调用点改传对象；steering/followUp drain 循环同步改。`agent.ts` 三个方法加第二参并包成 PromptInput 入队；`run(prompts: PromptInput[])`；`continue()` 传 `[]` 不变。

- [ ] **Step 4: 跑测试确认通过 + 全量**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/agent && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src packages/agent/test/loop.test.ts
git commit -m "feat(agent): carry image attachments through prompt, steer, and followUp"
```

---

### Task 5: 附件存储 + session 链路 + 能力过滤

**Files:**
- Modify: `packages/coding-agent/src/session/manager.ts`（saveAttachment）
- Modify: `packages/coding-agent/src/session/session.ts:279-289`（prompt/steer/followUp）、`:223-270`（prepareRequest 过滤）
- Test: `packages/coding-agent/test/session.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `ImageAttachment`、Task 4 `Agent.prompt(text, images?)`
- Produces: `SessionManager.saveAttachment(bytes: Uint8Array, ext: "png" | "jpg"): Promise<ImageAttachment>`（写 `<会话目录>/<sessionId>.attachments/<8hex>.<ext>`；filePath 为 null 时写 `<home>/tmp/`；返回绝对路径）；`AgentSession.prompt(text: string, images?: ImageAttachment[])`、`steer/followUp` 同签名；prepareRequest 在 `model.supportsImages === false` 时把 user 消息 images 替换为文本占位 `[图片已忽略：当前模型不支持图片]`（追加到 content 尾部）并去掉 images 字段；`getContextUsage` 的投影同样过滤

- [ ] **Step 1: 写失败测试**

```ts
it("saveAttachment writes bytes under the session directory and returns absolute path", async () => {
  const home = await mkdtemp(join(tmpdir(), "cletus-home-"));
  const manager = await SessionManager.create("/tmp/proj", { home });
  const att = await manager.saveAttachment(new Uint8Array([1, 2, 3]), "png");
  expect(att.mediaType).toBe("image/png");
  expect(isAbsolute(att.path)).toBe(true);
  expect(await readFile(att.path)).toEqual(Buffer.from([1, 2, 3]));
});

it("persists user images and keeps them across open (old files without images still load)", async () => {
  // manager.appendMessage({ role:"user", content:"look", timestamp:1, images:[att] })
  // SessionManager.open(manager.filePath!) 后 getBranch 里该消息 images 深等于 [att]
  // 再手写一条无 images 的旧格式 JSONL 行，open 不报错
});

it("strips images for models without vision in prepareRequest projection", async () => {
  // 构造 AgentSession（沿用该文件现有 create 基建），model.supportsImages = false
  // 直接调用私有 prepareRequest 不可行 → 通过 session.prompt 注入 fake streamFn，
  // 断言 streamFn 收到的 context.messages 中 user content 含 "[图片已忽略" 且无 images 字段
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/session.test.ts`
Expected: FAIL（saveAttachment 不存在等）

- [ ] **Step 3: 实现**

manager：`saveAttachment` 用 `randomBytes(4).toString("hex")` 命名，`mkdir recursive` + `writeFile`，mediaType 由 ext 映射（png→image/png，jpg→image/jpeg）。session：三个方法透传 images；抽私有 `projectForModel(messages: AgentMessage[]): AgentMessage[]` 做 supportsImages===false 的过滤（仅在该值为 false 时改动消息，undefined 视为支持），prepareRequest 的 converted 与 getContextUsage 的 messages 都过它。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/session.test.ts && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/session packages/coding-agent/test/session.test.ts
git commit -m "feat(session): persist image attachments and filter them for non-vision models"
```

---

### Task 6: compaction 跳过图片本体

**Files:**
- Modify: `packages/coding-agent/src/session/compaction.ts:72-94`（serializeMessage user 段）
- Test: `packages/coding-agent/test/compaction.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `ImageAttachment`
- Produces: 摘要输入中 user 段每图追加一行 `[attached image: <basename>]`；图片路径全文/base64 不出现

- [ ] **Step 1: 写失败测试**（沿用现有 compaction 测试的 fake streamFn，捕获其收到的 input）

```ts
it("lists attached images by basename in the summary input", async () => {
  // 构造含 images:[{mediaType:"image/png",path:"/x/shot.png"}] 的 user 消息会话
  // force compact，断言 fake streamFn 收到的 user content 含 "[attached image: shot.png]"
  // 且不含 "/x/shot.png"
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/compaction.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`serializeMessage` user 分支：`message.images?.map(img => \`[attached image: ${basename(img.path)}]\`)` 追加到段尾；import `basename` from `node:path`。

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/compaction.test.ts && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/session/compaction.ts packages/coding-agent/test/compaction.test.ts
git commit -m "feat(compaction): reference attached images by name in summary input"
```

---

### Task 7: TUI 粘贴图片与 pending 管理

**Files:**
- Modify: `packages/tui/src/app.ts`（TuiAppOptions、pasteText、submitEditor、onTextareaSubmit、cancel 分支）
- Test: `packages/tui/test/app.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `ImageAttachment`（type-only import from `@cletus/ai`）
- Produces: `TuiAppOptions.attachImage?: (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg") => Promise<ImageAttachment | undefined>`；`submit: (text: string, images?: ImageAttachment[]) => Promise<void>`；`followUp?: (text: string, images?: ImageAttachment[]) => void`。内部 `pendingImages: ImageAttachment[]`

- [ ] **Step 1: 写失败测试**（沿用 setupApp seam；paste 键默认含 `ctrl+v`；clipboard 在测试 renderer 下不可用 → 通过新增私有方法的公开测试入口不可取，改为把 pasteText 的字节处理抽成可注入：setupApp 传 `attachImage` 回调 + 用 `(app as any)` 不允许 → 在 TuiAppOptions 加 `clipboard?: ClipboardService` 测试注入缝，与现有 `renderer?` seam 同风格）

```ts
it("attaches pasted image, inserts placeholder, and sends images with submit", async () => {
  // fake clipboard.read 返回 { status:"read", representation:{ mimeType:"image/png", bytes:png } }
  // attachImage 回调返回 { mediaType:"image/png", path:"/tmp/a.png" } 并记录调用
  // pressCtrlV → flush → 断言输入框含 "[图片 #1]"
  // typeText " analyze" + Enter → 断言 submit 收到 ("[图片 #1] analyze", [att])
  // 再 Enter 输入 "next" → 断言第二次 submit images 为 undefined（pending 已清）
});
it("rejects oversize images with a warning and no placeholder", async () => {
  // bytes 长度 5*1024*1024+1 → attachImage 不被调用，transcript 出现 warn notice
});
it("clears pending images when input is cancelled", async () => {
  // 贴图后 pressEscape（cancel 绑定）→ 再输入 "x" Enter → submit images undefined
});
it("keeps plain-text paste behavior", async () => {
  // fake clipboard 返回 text/plain → 输入框插入文本，attachImage 不被调用
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/tui/test/app.test.ts`
Expected: 新增 FAIL

- [ ] **Step 3: 实现**

- `TuiAppOptions` 加 `attachImage?`、`clipboard?: ClipboardService`（测试缝，getClipboard 优先返回它）；submit/followUp 签名扩展
- `pasteText`：`preferredTypes: ["image/png", "image/jpeg", "text/plain"]`；`representation.mimeType` 为 image/* 时：无 attachImage 回调 → warn "Image paste not available"；bytes > 5MB → warn；pendingImages.length ≥ 10 → warn；否则 await attachImage，成功后 `textarea.insertText(\`[图片 #${pendingImages.length + 1}]\`)` 并 push；文本分支原样保留（含现有 modal/focus 守卫）
- `submitEditor`/`onTextareaSubmit`：取 `const images = this.pendingImages.splice(0)`，非空才作为第二参传（exactOptionalPropertyTypes）；slash 命令分支不消费 pending（命令不发消息，附件保留）；纯图无文字时 text 为占位符本身，非空可发送
- cancel 分支（`:967` 附近 `bindings.matches(key, "cancel")`）：非 busy 清空输入时同时 `pendingImages.length = 0`

- [ ] **Step 4: 跑测试确认通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/tui/test/app.test.ts && pnpm typecheck`
Expected: 全部 PASS（20 个既有用例零回归）

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): paste clipboard images as pending attachments with placeholders"
```

---

### Task 8: cli 接线 + 配置 + README

**Files:**
- Modify: `packages/coding-agent/src/cli.ts`（runTui 的 TuiApp options，`:987-1024` 附近）
- Modify: `packages/coding-agent/src/config.ts`（models 类型自动继承 Model.supportsImages，确认无需显式改动；import-pi 不写该字段）
- Modify: `README.md`（Keys 表 paste 行 + 已知限制）
- Test: `packages/coding-agent/test/config.test.ts`（追加 supportsImages 透传用例）

**Interfaces:**
- Consumes: Task 5 `session.prompt/steer/followUp(text, images?)`、`manager.saveAttachment`；Task 7 `attachImage`/扩展 submit 签名
- Produces: 端到端可用的粘贴→发送链路

- [ ] **Step 1: 写失败测试**

```ts
it("passes supportsImages through resolveModel", () => {
  // config.models 含 { provider:"openai", id:"m", supportsImages:false, ... }
  // resolveModel(config, auth, "openai/m").supportsImages === false
  // 未配置该字段的模型 → undefined
});
```

- [ ] **Step 2: 跑测试确认失败或通过**

Run: `NODE_OPTIONS=--experimental-ffi npx vitest run packages/coding-agent/test/config.test.ts`
Expected: 若 resolveModel 未透传则 FAIL；若 Omit 结构已自动透传则 PASS（记录结果，PASS 时 Step 3 只补显式赋值以对齐现有字段风格）

- [ ] **Step 3: 实现接线**

cli.ts runTui：
- `attachImage: async (bytes, mediaType) => { if (!session) return undefined; return session.manager.saveAttachment(bytes, mediaType === "image/png" ? "png" : "jpg"); }`
- `submit: async (text, images) => ...` 现有逻辑中 `session.steer(text)` → `session.steer(text, images)`；`session.prompt(text)` → `session.prompt(text, images)`
- `followUp: (text, images) => session?.followUp(text, images)`
- config.ts resolveModel：`if (source.supportsImages !== undefined) model.supportsImages = source.supportsImages;`（与相邻字段同风格）
- README：Keys 表加 `Ctrl+V | paste text or image (≤5MB, png/jpeg)`；Permissions 或新小节注明已知限制：图片随历史每轮重发，多图多轮可能撞 provider 请求上限（约 32MB），建议 /compact 或 /new

- [ ] **Step 4: 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全部 PASS，build 成功

- [ ] **Step 5: 手动冒烟（可选，需真实剪贴板）**

`pnpm dev` → 截图 → Ctrl+V → 看到 `[图片 #1]` → 输入 "描述这张图" 发送 → 模型回复描述内容。无视觉模型时确认警告出现。

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/cli.ts packages/coding-agent/src/config.ts packages/coding-agent/test/config.test.ts README.md
git commit -m "feat(cli): wire clipboard image attachments into the session prompt path"
```

---

## Self-Review 记录

- Spec 覆盖：§1→T1，§2→T5，§3→T7，§4→T4/T5，§5→T2/T3，§6→T5/T8，§7→T1/T6，§8→T7（占位符即渲染）+README；spec"busy 时 steer 携带"→T7/T8；"图优先"→T7 preferredTypes 顺序
- 类型一致性：`ImageAttachment`/`PromptInput`/`saveAttachment`/`attachImage` 各任务签名已互查一致
- Review Focus 5 项分别落在 T5/T2+T3/T7/T7+T8/T7 的测试步骤
- 计划偏差说明：spec §6 的"序列化时跳过"实现位置调整为 session 投影层（ai 包零依赖约束），行为与 spec 一致；TUI 测试新增 `clipboard?` 注入缝是 spec 未提的必要测试手段

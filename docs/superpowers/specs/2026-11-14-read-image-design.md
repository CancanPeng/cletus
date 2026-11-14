# 设计：read 工具返回图片（模型主动看图）

日期：2026-11-14
状态：已批准（用户选定：联合类型）

## 意图与背景

上一阶段（`2026-11-14-image-paste-design.md`）打通了**用户贴图**：剪贴板截图 → `saveAttachment` 存盘 → user 消息带 `images` → provider 转 base64。当时明确把「read 工具返回图片」列为非目标。

现在要补上这一条：模型在处理任务时自己决定去看一张图（典型场景：项目里有 `docs/screenshot.png`，或用户说「看下 /tmp/err.png」）。当前 `read` 扫描到 `0x00` 字节就直接返回 `Cannot read binary file`，这条路是断的。

这也是真实 agent 的自然行为：文件存在就 `read` 它，不需要学一个新工具。

## 目标

- `read` 读到 PNG/JPEG 时返回「文字摘要 + 图片块」，模型能真正看到像素
- Anthropic 与 OpenAI 两个 provider 都能送达
- 非视觉模型（`supportsImages === false`）自动降级为文字摘要，不报错
- 会话 JSONL 不被 base64 撑爆；`--json` 输出不含 base64
- 纯文本 read 行为零回归
- 图片文件被删/损坏时降级为占位文本，不让整轮请求失败

## 非目标 / 反目标

- **不做**：终端内渲染图片缩略图（OpenTUI 能力探测，独立课题）
- **不做**：GIF / WebP / HEIC（`ImageAttachment` 联合类型保持 `png | jpeg`）
- **不做**：自动降采样、OCR 后备层（留作非视觉模型将来的独立方案）
- **不做**：`read` 之外的新工具（管道建好后加 `view_image` 几乎是免费的，但当前无必要）
- **不做**：子代理把图片回传给父代理（子代理自己 `read` 就能看，报告仍是文字）
- **反目标**：把 base64 内联进 `ToolResult` / JSONL；为图片重构 `message.content` 的字符串语义

## 已选方案与取舍

- **A（已选）**：扩展 `ToolResult.content` 为 `ToolContent[]`（`TextContent | ImageContent`），`ImageContent` 只带路径引用；provider 序列化时读文件转 base64。
- **B（排除）**：新增独立 `view_image` 工具。管道与 A 完全相同，省掉的只是 `read` 内部几十行；代价是多一个工具要模型学、多一条权限分支、多一份 prompt 预算。A 做完后 B 是顺手事，不是替代方案。
- **C（排除）**：`read` 内部转文字（tesseract OCR 或视觉子代理）。provider 层零改动，但丢掉版式、配色、UI 细节——恰恰是看截图定位 bug 时最需要的。慢，且引入外部依赖。

**为什么 `ImageContent` 带 path 而不是 base64**：与贴图方案保持一致，JSONL 只存路径引用，会话文件不膨胀。代价是序列化时多做一次磁盘读——本来每轮请求就要重发全部历史，这次读可以忽略。

## 设计细节

### 1. 类型（`packages/ai/src/types.ts`）

```ts
export type ImageContent = { type: "image" } & ImageAttachment; // { type, mediaType, path }
export type ToolContent = TextContent | ImageContent;

// toolResult 消息的 content 从 TextContent[] 放宽为：
{ role: "toolResult"; ...; content: ToolContent[]; isError: boolean; timestamp: number }
```

- 传播到 `packages/agent/src/types.ts`：`ToolResult.content: ToolContent[]`。
- **构造侧是纯放宽**：所有 `content: [{ type: "text", text }]` 的构造点（32 处，分布在 12 个工具文件）无需改动。
- **读取侧不是**：放开后 `.content[0]?.text` 在联合类型下不再合法，编译器会报错。已实测受影响点：
  - 源码 4 处 → 走 §5 的 helper
  - 测试 18 处断言（`agent.test.ts`、`bash.test.ts`、`curl.test.ts`、`edit.test.ts`、`extensions.test.ts`、`mcp.test.ts`、`subagent.test.ts`、`websearch.test.ts`）→ 需要收窄，例如加一个 `textAt(result, 0)` 测试 helper，或 `block?.type === "text" ? block.text : ""`
- 编译器会主动标出每一处——这是本次重构的安全网，不要用 `as TextContent[]` 之类的断言绕过它。18 处测试改动是这次改动真实成本的一部分，**不是**顺手能忽略的。

### 2. `read` 工具（`packages/coding-agent/src/tools/read.ts`）

流程调整：读到前 8 字节后先做**魔数嗅探**，命中图片则走图片分支，否则走现有文本分支。

- PNG：`89 50 4E 47 0D 0A 1A 0A`；JPEG：`FF D8 FF`。
- **按内容判断，不看扩展名**：`image.png` 里塞文本照常当文本读，`data.bin` 里是 PNG 就返回图片。
- 图片分支忽略 `offset` / `limit`（对图片无意义）。

返回内容（顺序固定）：

1. 一行文字摘要，例如：
   `screenshot.png — image/png, 1280×720, 412 KB, absolute path: /Users/.../screenshot.png`
2. 一个 `ImageContent` 块。

上限与降级：

- 单张 ≤ **5 MB**（对齐 Anthropic 单图硬限制），与贴图方案共用同一常量。
- 超限 → 返回 `isError: true` 的文字结果说明尺寸和限制，**绝不截断图片字节**（截断的图片是损坏的图片，模型会看到花屏并据此推理）。
- 尺寸靠解析 PNG IHDR（字节 16–24）和 JPEG SOFn 标记得到；解析失败就省略尺寸字段，不影响返回图片。
- 魔数命中但后续解码失败 → 当作普通二进制，返回现有 `Cannot read binary file`。
- `1 MB` 的文本上限对图片不适用（图片走独立的 5 MB 判断）。

### 3. Provider 序列化

**Anthropic**（`anthropic.ts` `toAnthropicMessages`）：`tool_result` 的 `content` 本来就是块数组，直接映射：

```ts
content: message.content.map((block) =>
  block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", source: { type: "base64", media_type: block.mediaType, data } },
)
```

读文件在序列化时进行（该函数已经是 async）。**文字在前、图片在后**：文字是这张图的图注/清单，先读图注符合语义（Anthropic「图在前」的建议是针对 user 消息的，不适用于 tool_result）。

**OpenAI**（`openai.ts`）：`role: "tool"` 消息的 `content` **只接受字符串**，装不下图片。必须把图片「抬」出来：

- `toOpenAIMessage` 从 1→1 改为 `toOpenAIMessages` 返回 `Record<string, unknown>[]`（1→N）。
- 工具消息本身只保留文字；图片另行收集。
- **关键约束（已核实）**：OpenAI 要求每个 `tool_call_id` 的 tool 消息**连续且紧邻**其 assistant 消息，任何其他角色插在中间都会被拒。`github/copilot-sdk#1922` 就是这个坑的实测报告：把 image user 消息插在两条 tool 消息之间，同一模型同一内容返回 `400 invalid_request_error`，报错指向 `messages.[N].role`；把图片全部挪到该轮**所有** tool 消息之后则 `200 OK`。
- 因此：**按 assistant 轮次聚合**，而不是逐条 tool 消息穿插。序列化时维护「本轮待发图片」缓冲，遇到下一个非 toolResult 消息（或消息流结束）时，flush 成**一条**合成 user 消息：
  ```
  assistant { tool_calls: [A, B] }
  tool      { tool_call_id: A, content: "<text>" }
  tool      { tool_call_id: B, content: "<text>" }
  user      { content: [ {text: "↑ 2 image(s) returned by tool calls: a.png, b.png"},
                          {image_url: …}, {image_url: …} ] }
  ```
- 一条合成消息承载全部图片（不是每张一条），减少消息数也减少歧义。
- 构造顺序：`toOpenAIMessages` 改为对整个消息数组做一次 fold，而非 `messages.map(...)` 逐条独立转换。这是本次改动风险最高的点，必须有一个**多图多 tool call** 的请求体形状测试（见测试要点）。

**两处共同**：附件文件缺失 → 降级为 `[图片不可用: <path>]` 文本块并继续请求（与贴图方案同一处理）。

### 4. 非视觉模型

在已有唯一收口 `session.ts::projectForModel` 扩展，不只处理 user 消息：

- `supportsImages === false` 时，把 toolResult 里的 `ImageContent` 剥掉，替换为 `[图片已忽略：当前模型不支持图片]` 文本块。
- 保留 `read` 返回的文字摘要——路径、格式、尺寸仍然有用，模型至少知道那是什么文件，可以改用 bash 调 OCR。
- 选择在投影层而非工具层做：`read` 工具不感知模型能力，所以中途 `/model` 切到非视觉模型能立刻生效，不需要重建工具。

### 5. 输出通道与文本化

新增一个共享 helper（放 `@cletus/ai`，与 `textOf` 同处）：

```ts
export function toolContentText(content: ToolContent[]): string
```

文字块原样拼接，每个图片块补一行 `[图片: <basename>  <mediaType>]`。用它替换现有 4 处工具结果的 `.map(b => b.text).join("")`：

- `coding-agent/src/cli.ts:366`（TUI 事件）、`cli.ts:1103`（`-p` 错误输出）
- `coding-agent/src/session/transcript.ts:32`
- `coding-agent/src/session/compaction.ts:117`

TUI transcript 的 tool 块因此自然显示文字摘要 + `[图片: ...]` 占位行，无需新的渲染组件。

### 6. 权限

**无改动。** 图片只是已放行的 `read` 的一种返回类型，`policy.resolveRead` 的沙箱检查照旧。不新增权限表面，不新增确认弹窗。

### 7. token 估算与 compaction

- `estimateMessageTokens`：toolResult 分支的图片块按 **1600** 计（与贴图方案同一常数）。
- `serializeMessage`（compaction）：走 §5 的 helper，图片变成 `[图片: <basename>]` 一行，图片本体不进摘要输入。
- 已知成本：一张图的 base64 会随历史每轮重发，直到被 compact 裁掉。与贴图方案一致的既有取舍，不另做优化。

## 测试要点

- **ai**：Anthropic `tool_result` 含图片块的序列化（含缺文件降级）；OpenAI **单个** tool 返回图片、**两个并行** tool 各自返回图片（断言两条 tool 消息连续、合成 user 消息在所有 tool 之后、且只有一条）、纯文本轮次不产生合成消息；`toolContentText` 输出；含图 token 估算
- **coding-agent / read**：PNG 魔数命中返回图片块 + 摘要；JPEG 同理；扩展名与内容不一致时以内容为准；超 5 MB 返回错误且不截断；伪 PNG 降级为二进制错误；纯文本文件行为不变（回归）
- **coding-agent / session**：`supportsImages: false` 时 toolResult 图片被剥、文字摘要保留；纯文本 toolResult 不受影响
- **coding-agent / transcript**：工具块输出含图片占位行

## 留给 builder 的决定

- 摘要行的具体措辞与字段顺序
- JPEG SOFn 扫描的实现细节（是否支持渐进式 SOF2）
- helper 放 `@cletus/ai` 还是 `@cletus/agent`（倾向 ai，与 `textOf` 同处，零依赖）

## 约束与风险

- 基线：在 `12e8a75` 上做增量，不顺手重构 `content: string` 的既有语义。
- **OpenAI 合成 user 消息的位置**已由外部证据（`github/copilot-sdk#1922`）确定：必须在整轮所有 tool 消息之后，不能穿插。设计已据此写成按轮次聚合。仍建议在实现后用真实 key 跑一次多图验证——测试只能钉住形状，钉不住 provider 的实际接受度。
- **类型放宽的测试成本**（18 处断言）是本次最容易低估的部分，已接受。方案已定：**联合类型**（`ToolResult.content: ToolContent[]`），不采用新增 `images?` 字段的替代方案——图片就是内容的一部分，两个来源分开会长期要合并。
- 多图多轮可能撞 provider 请求上限，沿用贴图方案的策略 a：原样透传 API 错误，建议用户 `/compact`。写进 README。
- 剪贴板贴图丢图的问题（本次会话实测 `images` 为 `None`）**不在本次范围**，另行排查。
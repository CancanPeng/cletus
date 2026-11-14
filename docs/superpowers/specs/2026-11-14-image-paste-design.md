# 设计：粘贴截图给模型分析（方案 A，最小闭环）

日期：2026-11-14
状态：待批准（builder check 两个问题已由用户裁决：先提交并行改动；限制策略选 a）

## 意图与背景

用户在 TUI 里粘贴剪贴板中的截图，配文字提问，让视觉模型分析（典型场景：截图 UI bug 让 agent 定位修复）。当前 cletus 全链路纯文本：user content 是 `string`，无图片类型；`pasteText()` 只读 `text/plain`；`read` 工具拒绝二进制。

## 目标

- Ctrl+V（现有 `paste` 键绑定）在剪贴板含图片时把图片附加到当前输入，可多张，随下一条消息发送
- 两个 provider（Anthropic / OpenAI）都能把图片送达模型
- 图片持久化，`/resume` 后继续对话仍能带上图片
- compaction、token 估算、`--json` 输出不被图片破坏

## 非目标 / 反目标

- **不做**：read 工具返回图片（模型主动看图）、终端内渲染缩略图（方案 B，后续增量）、`-p` 模式 `--image` 参数、拖拽文件、子代理收图
- **反目标**：把 base64 内联进 JSONL（会话文件爆炸）；为图片重构所有 `message.content` 字符串调用点

## 已选方案与取舍

- **A（已选）**：消息加可选 `images` 字段 + 会话目录存文件。改动约 6 个文件，几十处 `content: string` 调用点零改动。代价：终端里只见占位符。
- **B（未选）**：A + `ImageRenderable` 缩略图。工作量多一半（终端能力探测、回退、布局），用户已确认占位符够用。A 的格式对 B 向前兼容。
- **C（排除）**：`content` 改块数组——侵入全部调用点，违背最小改动意图。

## 设计细节

### 1. 消息格式（`packages/ai/src/types.ts`）

```ts
export type ImageAttachment = { mediaType: "image/png" | "image/jpeg"; path: string };
// user 消息变为：
{ role: "user"; content: string; timestamp: number; images?: ImageAttachment[] }
```

- `path` 为**绝对路径**，指向会话附件文件。可选字段，`exactOptionalPropertyTypes` 下不存在时不写键。
- 旧会话文件无此字段，天然兼容；session version 保持 1。

### 2. 附件存储（`packages/coding-agent/src/session/manager.ts`）

- 新方法 `saveAttachment(bytes: Uint8Array, ext: "png" | "jpg"): Promise<ImageAttachment>`：写入 `<会话文件同目录>/<sessionId>.attachments/<randomId>.<ext>`，返回绝对路径。inMemory 会话（filePath 为 null）写入 `CLETUS_HOME/tmp/`。
- 随机文件名用现有 `randomBytes` 风格；附件只增不删（与会话 JSONL 同生命周期，清理策略留给以后）。
- 上限（用户已确认）：单张 ≤ 5 MB（对齐 Anthropic 单图硬限制），单条消息 ≤ 10 张，超限在粘贴时拒绝并提示。

### 3. 粘贴流程（`packages/tui/src/app.ts`）

- `pasteText()` 改为 `preferredTypes: ["image/png", "image/jpeg", "text/plain"]`；读到 `image/*` 时调用新增回调 `options.attachImage(bytes, mediaType): Promise<ImageAttachment | undefined>`（由 cli.ts 注入，落盘走 manager）。
- 成功后在光标处插入占位符 `[图片 #N]`（N 为本条消息内序号），并 `pendingImages` 数组累积；失败 `notify` 警告，不插占位符。
- 发送（Enter）时把 `pendingImages` 交给 `submit`，然后清空。`submit` 签名扩为 `(text: string, images?: ImageAttachment[]) => Promise<void>`。
- 用户手动删掉占位符文本不取消附件（占位符仅是可见提示）；取消附件的方式 = 清空输入框（Esc/Ctrl+C 现有 cancel 行为同时清 `pendingImages`）。
- busy 时走 steer/followUp 的提交同样携带 `pendingImages`。
- 剪贴板同时有图和文本时：**图优先**（用户场景是贴截图；纯文本粘贴行为不变）。

### 4. 提交链路（`agent.ts` → `loop.ts` → `session.ts` → `cli.ts`）

- `Agent.prompt(text, images?)`、`steer(text, images?)`、`followUp(text, images?)`；`runAgentLoop` 的 prompts 参数从 `string[]` 改为 `Array<{ text: string; images?: ImageAttachment[] }>`。
- `userMessage()` 构造时带上 `images`。持久化（`handleEvent`/`appendMessage`）自动携带，JSONL 只存路径引用。
- 去重键 `keyOf` 不变（timestamp 已足够区分）。

### 5. Provider 序列化

- **Anthropic**（`anthropic.ts` `toAnthropicMessages`）：user 消息有 images 时 content 变块数组：`[{type:"image", source:{type:"base64", media_type, data}}, ..., {type:"text", text}]`（图在前文在后，符合官方建议）。读文件→base64 在序列化时进行（`readFile` async → `toAnthropicMessages` 变 async，调用点仅 1 处）。
- **OpenAI**（`openai.ts` `toOpenAIMessage`）：content 变 `[{type:"text",...}, {type:"image_url", image_url:{url:"data:<mime>;base64,..."}}]`；同样变 async。
- 附件文件缺失/读取失败：降级为文本占位 `[图片不可用: <path>]` 并继续请求，**不让整轮失败**（builder 默认）。
- **provider 硬限制策略（用户已选 a）**：图片随历史每轮原样全量重发，不做压缩/降采样，不做保留窗口。整请求超限（Anthropic 约 32 MB）时 API 报错走现有错误通道。已知限制写进 README：多图多轮对话可能撞请求上限，届时建议 /compact 或 /new。
- 图片 MIME 以存储时的 `mediaType` 为准，不做内容嗅探（来源只有剪贴板，可信）。

### 6. 模型能力检查（`config.ts` + `cli.ts`）

- `Model` / 配置 models 增加可选 `supportsImages?: boolean`；缺省视为 `true`（import-pi 的配置无此字段，默认放行，API 报错由现有错误通道呈现）。
- 显式 `supportsImages: false` 时：粘贴仍允许（附件保留），发送时 `onNotice` 警告"当前模型不支持图片，图片已忽略"，序列化时跳过 images 并替换为文本占位。

### 7. token 估算与 compaction

- `tokens.ts` `estimateMessageTokens`：user 消息每张图 +1600（Anthropic 大图约值的保守常数，builder 默认）。
- `compaction.ts` `serializeMessage`：user 段追加 `[attached image: <basename>]` 行；图片本体不进摘要输入。摘要后的投影里被裁掉的图片自然消失，保留段的 images 字段原样保留。

### 8. 输出通道

- TUI transcript：用户块文本已含 `[图片 #N]` 占位符，无额外渲染工作。
- `--json`：事件里 images 只有路径引用，无 base64，天然安全。
- `-p` 文本模式：无粘贴入口，不涉及。

## 测试要点

- ai：两个 provider 的 user 消息带图序列化（含缺文件降级、supportsImages=false 跳过）；估算含图
- agent：prompt/steer 携带 images 进入 messages
- coding-agent：saveAttachment 落盘路径与往返；resume 后投影保留 images；compaction 跳过图片本体
- tui：paste 回调注入、占位符插入、发送清空、cancel 清空（沿用现有 renderer 测试 seam）

## 留给 builder 的决定

- token 常数、占位符文案微调
- `toAnthropicMessages`/`toOpenAIMessage` 变 async 的具体重构方式
- 附件目录命名细节（不影响 JSONL 兼容）

## 约束与风险

- 基线（用户已确认）：并行的 /fork、/resume 改动已先行提交（`1d746f2`），图片功能在干净基线上做增量，不顺手重构。
- 剪贴板读图依赖 OpenTUI host backend（macOS/Linux），不支持的环境自动落到现状（文本粘贴），无回归。

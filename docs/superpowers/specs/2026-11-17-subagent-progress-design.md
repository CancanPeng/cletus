# 设计：子 agent 执行过程可见（状态行 + 日志）

日期：2026-11-17
状态：待批准

## 意图与背景

`task` 工具派生的子 agent 目前只在结束时返回一份摘要，运行期间主界面卡片是空的，用户不知道它在干什么。管道已现成：工具执行中 `ctx.onUpdate` → `tool_execution_update` → TUI 卡片实时更新（bash 流式输出同款）。缺的只是 `subagent.ts` 把已订阅的事件转发出去。

## 目标

- 收起卡片时能看到子 agent 当前活动（第一行状态行）
- 展开卡片时能看到完整的工具执行日志（含耗时、错误）
- 不改 TUI 渲染层，不动权限/轮次/并发逻辑

## 非目标 / 反目标

- 不做：子 agent 文本/思考流的转发（只报工具活动，报告仍是最终摘要）
- 不做：`-p` 打印模式的进度显示（该模式本来就忽略 update 事件）
- 反目标：无上限的日志把 partial 更新撑爆

## 方案取舍

- **1（排除）**：纯追加日志。简单，但卡片预览只显示第一行，收起时永远停在第一步。
- **2（已选）**：第一行固定为状态行（当前活动 · 第 N/30 轮），下方追加已完成工具的日志。多十几行代码，换来收起状态也有实时动态。

## 设计细节（我的补充决定，可改）

- `SubagentRequest` 增加可选 `onProgress?: (text: string) => void`；`task.ts` 接 `ctx.onUpdate`。回调挂在请求上而非 runner 上，因为 runner 被多个并发 task 共享。
- 输出格式（纯文本，unicode 符号）：
  ```
  ▸ turn 2/30 · bash …
  ✓ read src/app.ts · 0.1s
  ✗ bash pnpm test · 4.2s — exit 1
  ```
- 参数摘要：JSON 压成单行，截 80 字符。
- 日志封顶：保留最近 100 行，超出加 `[earlier activity dropped]` 前缀；整体再按 16KB 截尾。
- 工具结束后无新活动时状态行显示 `▸ turn N/30 · thinking …`。
- `tool_execution_end` 时最终报告替换整个卡片输出（现有行为，不变）。
- 排队消息 "Waiting for subagent slot..." 保持不变。

## 测试

- `subagent.test.ts` 新增：fake stream 先调一个工具再收尾，断言 `onProgress` 收到的文本含状态行与已完成工具日志。
- 新增 `createTaskTool` 转发测试：`ctx.onUpdate` 收到子 agent 进度。
- 现有 2 个子 agent 测试零回归。

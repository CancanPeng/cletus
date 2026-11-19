# 设计：按类型委派子 agent（Claude Code 式，含 per-agent model）

日期：2026-11-17
状态：待批准

## 意图与背景

子 agent 目前只有一种形态：全 core 工具、父模型、通用 prompt。本期让它可按类型委派：markdown 定义文件声明 name/description/tools/model + 正文 system prompt，主模型按 description 自动选择委派，内置只读探索角色。权限沿用上期 B 方案快照（`2026-11-17-subagent-permission-inheritance-design.md`），不新增任何交互。

用户已确认：`model` 字段本期做（贵活/杂活分流是核心卖点）。

## 目标

- `~/.cletus/agents/*.md`（用户级）+ `.cletus/agents/*.md`（项目级，trustProject 门控）定义 agent
- frontmatter：`name`（缺省文件名）、`description`（必填）、`tools`（可选白名单，缺省全部 core）、`model`（可选 ref，走 `resolveModel`）；正文 = system prompt 的 persona 部分
- 内置角色：`explore`（只读）、`general-purpose`（全 core，等价现有默认）；同名覆盖优先级 项目 > 用户 > 内置
- `task` 工具加可选 `subagent_type`；description 动态列出可用 agent 清单（name + description）；不传 = general-purpose，现有调用零破坏
- 每个 agent 可用不同 model：runner 按定义 `resolveModel(config, auth, def.model)`；streamSimple 按 provider 分发、getApiKey 按 model 解析，管道零改动
- 只读角色双保险：工具集过滤 + 子 policy 拒绝 write/edit/bash

## 非目标 / 反目标

- 不做：Plan 角色（cletus 无 plan mode，无消费方）
- 不做：`/agents` 管理 UI（下一期，复用 skills manager 骨架）
- 不做：嵌套委派（excludeTask 不变）、后台 agent/agent teams
- 不做：新权限交互（B 方案快照语义原样）
- 反目标：agent 定义绕过 trustProject 注入 prompt；只读角色靠单层防线

## 方案取舍

- **定义来源（已选）**：独立 `agents/` 目录 + 复用 skills.ts 的加载模式（frontmatter 解析、realpath 去重、trust 门控）。排除：塞进 skills 体系加 kind 字段——语义混杂，skills 的 visibility/override 机制对 agent 无意义。
- **只读 enforcement（已选）**：白名单过滤工具集 + policy 层 `readOnly` 标志拒写。排除：只过滤工具集——将来工具集变化会漏网。
- **model 解析失败（我的决定）**：定义里 model ref 无效时该 agent 从清单剔除并 onNotice 警告，不让整个 task 工具坏掉。

## 设计细节（我的补充决定，可改）

- 新文件 `resources/agents.ts`：`AgentDefinition = { name, description, tools?: string[], model?: string, prompt: string, source: "builtin" | "personal" | "project", path?: string }`；`loadAgents(cwd, home, trustProject)` 返回内置+文件合并去重后的清单。frontmatter 解析函数从 skills.ts 提取共用（导出 `parseFrontmatter`）。
- `tools` 白名单只允许 core 工具名（read/write/edit/bash/grep/find/ls/curl/web_search）；未知名字忽略并警告。`task` 永远排除（防递归，现有机制）。
- 内置 `explore`：tools = [read, grep, find, ls, web_search, curl]，prompt 强调只读探索/汇总发现/不改文件；不加载 contextFiles 和 skills（省 context）。`general-purpose`：全 core，加载 contextFiles+skills（现行为）。
- 自定义 agent 正文替换 persona 段；基础段（工具清单+rules）保留；contextFiles/skills 默认加载（Claude Code 同款），frontmatter 暂不提供 omit 开关（YAGNI，需要时加）。
- `PermissionPolicy` 加构造项 `readOnly?: boolean`：check() 对 write/edit/bash 直接拒（reason: "agent is read-only"）。快照不含 readOnly（它是子侧约束，不是授权）。
- `SubagentRequest` 加 `subagentType?: string`；runner deps 加 `agents: AgentDefinition[]` 与 `resolveModel(ref)`；未知 type 返回 isError 结果列出可用类型（模型可自纠）。
- 进度状态行带类型：`▸ explore turn 1/30 · …`（formatter 加可选 label 参数，默认空不变）。
- usage 统计：subagent details 已含 usage/turns，另加 model ref 字段，父会话统计口径不变（子 usage 不进父 context 统计，现行为）。

## 测试

- agents 加载：frontmatter 各字段/缺省值/必填 description 缺失跳过/同名优先级/trust 门控/未知工具名忽略
- task 工具：description 含清单；subagent_type 路由到对应定义；未知 type 报错列清单；不传 type 走 general-purpose
- runner：explore 拿到的工具集无 write/edit/bash 且 policy 拒写（双保险各自验证）；model 字段解析（fake config 两个 model，断言子请求用了指定 model）；无效 model ref 剔除+警告
- 进度 label；现有 subagent/permissions 测试零回归

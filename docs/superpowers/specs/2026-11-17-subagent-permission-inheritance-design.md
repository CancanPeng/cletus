# 设计：子 agent 权限继承（B 方案 — 静态快照，不弹框）

日期：2026-11-17
状态：待批准

## 意图与背景

子 agent 目前每次新建 `PermissionPolicy`（`subagent.ts:16-22`）：`interactive: false`、无 confirm、`allowWrite: []`。只继承 yolo。后果：普通 TUI 会话里子 agent 只能读——持久 allowlist 不继承、父 session 已批准授权不继承、readOnlyRoots（skills/prompts 只读豁免）也不继承。general-purpose 类子 agent 实际不可用。

讨论过三个方案：A（只补 allowlist 继承）、B（静态快照继承，不弹框）、C（confirm 转发父 TUI，Claude Code 同款）。用户选 B：子 agent 保持完全静默，不被确认框打断父界面。

## 目标

- 子 agent spawn 时继承父 policy 的：持久 allowWrite、yolo（已有）、6 类 session 授权快照、readOnlyRoots
- 快照语义：spawn 时复制；子 agent 运行期间父新批的授权不追加；子 agent 侧无任何回流
- 快照外的写/命令拒绝时，给出可操作的错误信息（提示去主会话批准或加 permissions 规则），让主模型知道该回报而不是重试

## 非目标 / 反目标

- 不做：confirm 转发/弹框排队（C 方案，明确排除）
- 不做：运行中动态同步授权（快照语义的边界，用户已确认）
- 不做：子 agent 授权回流父会话（提权攻击面）
- 不改：TUI、task 工具签名、`-p` 非交互路径（父无 session 授权，B 自动退化，无需特判）
- 反目标：共享可变授权状态（并发子 agent 互相污染）

## 方案取舍

- **A（排除）**：只补 allowlist。零交互但 general-purpose 仍依赖预配置，体验差距大。
- **B（已选）**：静态快照。不碰 UI，父亲批过的路径/命令子 agent 直接可用；新命令仍是死路，但错误信息引导主模型回报。
- **C（排除）**：完整继承 + confirm 转发。需解决弹框排队（现 modal 单槽位会互相 deny）、中断清理、授权归属三个问题；用户不接受子 agent 打断父界面。

## 设计细节（我的补充决定，可改）

- `PermissionPolicy` 新增两个方法：
  - `snapshot(): PermissionSnapshot` —— 导出 allowWrite、yolo、readOnlyRoots、6 个 session Set 的拷贝（类型 `PermissionSnapshot` 从 policy.ts 导出）
  - 构造 opts 增加可选 `inherit?: PermissionSnapshot` —— 用快照初始化各 Set 与 allowWrite/readOnlyRoots/yolo；`interactive`/`confirm` 不受快照影响（子 agent 恒为非交互）
- `subagent.ts` 构造子 policy 时传 `inherit: deps.policy.snapshot()`，其余参数不变（cwd 仍为 deps.cwd）
- 非交互拒绝文案统一改为：`Denied: not covered by inherited grants or permissions rules (approve it in the main session, add a rule via /permissions add, or use --yolo)`——覆盖 write/bash/curl/web_search/MCP/extension 各分支的现有 "Non-interactive mode requires --yolo for X" 文案
- `/new`、`/resume` 走现有 `resetSession()`，之后 spawn 自然拿空快照，无需新代码

## 测试

- policy 单测：snapshot 往返（各 Set + allowWrite + yolo + roots）；快照是拷贝（改父不影響已建子 policy）；inherit 不改变 interactive 行为（快照外写仍拒）
- subagent 测试：父批准过的命令在子 agent 内放行（yolo:false）；快照外命令拒绝且含新文案；现有测试零回归（含"denies write tools without yolo"——该测试父 policy 无授权，语义不变）
- 全套回归

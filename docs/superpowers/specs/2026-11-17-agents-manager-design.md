# 设计：/agents 管理弹窗（查看 + 启停 + $EDITOR 编辑/新建）

日期：2026-11-17
状态：待批准

## 意图与背景

子 agent 类型系统已落地（`2026-11-17-subagent-types-design.md`），但查看/管理只能手写 md 文件。本期加 `/agents` 斜杠命令：复用 skills 的 `manageTabs` 弹窗骨架，查看清单、space 启停、Enter 用 `$EDITOR` 编辑定义文件、New tab 新建。用户已确认走 `$EDITOR` 外部编辑路线（不做弹窗内多行编辑器）。

技术前提已验证：OpenTUI CliRenderer 有 `suspend(): Promise<void>` / `resume(): Promise<void>`（renderer.d.ts:651-652），外部编辑器可安全接管终端。

## 目标

- `/agents` 打开弹窗，Agents 列表 tab：`name · source · model · 工具概要 — description`，字母过滤沿用
- space 循环 `on/off`：off 的 agent 从委派清单剔除（含内置），持久化到 config（agentOverrides，同 skillOverrides 模式）
- Enter 编辑：list tab 新增可选 `onOpen(item)` 回调；触发后关闭弹窗 → suspend TUI → `$EDITOR` 打开定义文件 → 编辑器退出 → resume TUI → resources reload + 刷新
- 内置角色：可启停；Enter 时提示"内置角色不可直接编辑，将创建同名覆盖文件"并在 `~/.cletus/agents/<name>.md` 生成模板后打开编辑器
- New tab（prompt 类型）：输入 name → 校验（合法文件名/不与现有重名，重名提示直接编辑）→ 生成模板 md → $EDITOR 打开
- 编辑器退出后无论是否修改都 reload；文件被删/清空 description 时加载器已有跳过+警告逻辑兜底
- `$EDITOR` 未设置时依次探测 `$VISUAL`、nvim、vim、vi、nano；都没有则 notify 显示文件路径让用户自行编辑

## 非目标 / 反目标

- 不做：弹窗内多行文本编辑控件
- 不做：agent 注册表/搜索安装（无生态，YAGNI）
- 不做：项目级 `.cletus/agents` 的写入（新建/覆盖一律写用户级；项目级文件只读展示，Enter 编辑其原路径文件）
- 不做：运行中打开管理弹窗（同 /skills：isStreaming 时拒绝）
- 反目标：编辑器接管终端时 TUI 仍在渲染/读 stdin（必须 suspend 干净）；suspend 后异常导致 TUI 永久挂起（resume 必须在 finally）

## 方案取舍

- **编辑方式（已选）**：$EDITOR + renderer.suspend/resume。排除：弹窗内编辑器（量翻倍、体验差）；仅显示路径（用户已否决）。
- **启停存储（已选）**：config `agentOverrides: Record<string, "on" | "off">`，加载后过滤。排除：改 md frontmatter 加 disabled 字段 —— 内置角色没有文件可写，且启停是用户偏好不是定义本身。
- **onOpen 扩展（已选）**：ManagedListTab 加可选 `onOpen?: (item) => void`，Enter 有 onOpen 时触发之（并关闭弹窗），无则维持现行为（关闭）。其他 manager 零影响。

## 设计细节（我的补充决定，可改）

- `TuiApp.editFile(path): Promise<void>`：suspend → spawn($EDITOR, [path], stdio inherit) → 等退出 → finally resume。编辑器非零退出码 notify 警告但仍 reload。放 TuiApp 因为 renderer 归它管；spawn 逻辑放 cli 侧传入的回调也行 —— 定为 TuiApp 方法接收 `editorCommand: string`（cli 解析 $EDITOR 后传入），TUI 不读环境变量。
- 模板 md（新建/内置覆盖）：frontmatter description 用占位 `"TODO: describe when to delegate to this agent"` + 内置覆盖时预填原 tools/model；正文一句角色占位。description 是 TODO 占位仍会被加载 —— 可接受（用户马上进编辑器）；若直接退出不改，加载器照常加载，主模型看到 TODO 描述自行判断。
- 过滤生效点：session.toolsFor 构建 agents 列表处（现有 model-ref 过滤旁边）加 `agentOverrides[name] !== "off"`；ResourceLoader 不动（列表 tab 要显示 off 的条目）。
- config 兼容：`agentOverrides` 缺省 `{}`，loadConfig merge 默认值（同 skillOverrides 行）。
- 弹窗关闭后才 suspend（先 closeManager 再 editFile），避免弹窗状态横跨编辑器会话。
- `-p` 模式无 /agents（无 TUI），不做。

## 测试

- config：agentOverrides 默认值/merge 往返
- 过滤：off 的 agent 不进 task 工具清单与 runner（session 层测试或 toolsFor 单测）
- TUI：onOpen 触发（Enter 有/无 onOpen 两种行为）；editFile 用 fake editorCommand（如 `true`/脚本）验证 suspend/resume 配对与 finally（编辑器抛错也 resume）
- cli 接线：模板生成内容、重名校验、内置覆盖预填（纯函数抽出可测）
- 现有 skills-tabs/app 测试零回归

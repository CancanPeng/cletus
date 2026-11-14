# 设计：`/skills` 弹窗改为多 tab，支持字母筛选与边打边查

日期：2026-11-14
状态：待批准

## 意图与背景

`/skills` 弹窗目前是单页列表：↑↓ 移动、`Space` 循环可见性、`Enter`/`Esc` 关闭，另有两个字母动作 `s`（搜 skills.sh）、`i`（从 GitHub 安装）。装了 80+ 个 skill 后翻页很痛苦，用户想要"打字即筛选"。但 `s`/`i` 已经占用了字母键，一打字母就会触发搜索/安装。

解法：把这两个动作拆成独立 tab，把字母键还给筛选。

## 目标

- 弹窗顶部三个 tab：`Skills` / `Search` / `Install`，`Tab` 与 `Shift+Tab` 切换
- `Skills` tab：不区分大小写的子串筛选，`Backspace` 删字符，`Esc` 先清筛选、再关窗
- `Search` tab：输入关键词**边打边查** skills.sh（防抖 + 取消上一请求），结果可 ↑↓ 选、`Enter` 安装
- `Install` tab：输入 `owner/repo#skill`，`Enter` 安装
- 安装成功后刷新 `Skills` tab 的列表，不关窗

## 非目标 / 反目标

- **不做**：`cletus skills list` 等 CLI 子命令的改动；模糊匹配 / 拼音 / 首字母跳转；筛选历史；多选安装
- **反目标**：为了 tab 引入通用路由框架；把 skills 专用逻辑塞进 TUI 组件（TUI 只认通用的 tab 声明）

## 已选方案与取舍

- **A（已选）**：TUI 暴露通用的 `manageTabs(title, tabs)`；`ManageTab` 有 `list` / `search` / `prompt` 三种 kind，skills 的全部业务（查什么、装什么）留在 `cli.ts` 的 tab 声明里。
  - 代价：`manageItems` 被替换，测试要改；比在 `manageItems` 上叠 `actions` 回调多一点结构。
- **B（未选）**：保留 `manageItems`，额外传 `onSearch`/`onInstall` 回调，tab 只是视觉分组。
  - 代价：tab 语义靠字符串判断，`s`/`i` 的键位冲突还得在和输入处理里特判。
- **C（排除）**：把 `s`/`i` 改成 `Ctrl+S`/`Ctrl+I`。用户已否决——要的是 tab。

## 设计细节

### 1. TUI 接口（`packages/tui/src/app.ts`）

```ts
export type ManagedItem = { id: string; label: string; state: string; states: string[] };
export type ManagedResult = { id: string; label: string };

export type ManagedTab =
  | {
      kind: "list";
      id: string;                        // "skills"
      title: string;                     // 键位提示里显示的名字
      items: ManagedItem[];
      onCycle: (id: string, state: string) => Promise<void> | void;
      /** 安装成功后重新拉取列表；省略则不刷新 */
      refresh?: () => Promise<ManagedItem[]>;
    }
  | {
      kind: "search";
      id: string;                        // "search"
      title: string;
      placeholder: string;               // "pdf, testing, design…"
      search: (query: string, signal: AbortSignal) => Promise<ManagedResult[]>;
      onAccept: (result: ManagedResult) => Promise<void> | void;
    }
  | {
      kind: "prompt";
      id: string;                        // "install"
      title: string;
      placeholder: string;               // "owner/repo#skill"
      onSubmit: (value: string) => Promise<void> | void;
    };

manageTabs(title: string, tabs: ManagedTab[]): Promise<void>;
```

`manageItems` 删除（只有 `cli.ts` 与一个测试在用）。

### 2. 键盘路由

`Tab` / `Shift+Tab` 永远切 tab（`Shift+Tab` 反向），在全局 keypress 层拦截。

| 按键 | Skills tab | Search tab | Install tab |
|---|---|---|---|
| 可打印字符 | 追加到筛选串 | 交给输入框 | 交给输入框 |
| `Backspace` | 删一个筛选字符 | 交给输入框 | 交给输入框 |
| `↑↓` | 移动选中项 | 移动结果选中项 | 无 |
| `Space` | 循环可见性 | 交给输入框（空格可打） | 交给输入框 |
| `Enter` | 关窗（现状不变） | 安装选中结果 | 提交安装 |
| `Esc` | 有筛选串→清空；否则关窗 | 回 Skills tab | 回 Skills tab |

实现要点：Search / Install tab 用真实的 `InputRenderable` 并 `focus()`；全局 handler 只 `intercept` 上表里由弹窗接管的键（Tab / 方向 / Enter / Esc），其余放行给输入框——这与现有 `inputModal` 的处理方式一致（全局 handler 先于 renderable 处理，`preventDefault` 能挡住输入框）。

### 3. 边打边查

- 输入变化 → 清 250ms 防抖计时器 → 触发查询
- 新查询开始时 `AbortController.abort()` 掉上一个请求；`searchSkillRegistry(query, signal)` 已支持 `signal`
- 空查询：清空结果与选中项，不发请求
- 请求中：结果区显示 `searching…`；失败显示错误行（不关窗、不弹通知）
- 结果返回：替换列表、`index` 归 0；列表最多显示 6 行，`↑↓` 滚动窗口
- 关窗 / 切走 tab 时 abort 未完成请求并清理计时器，避免 setState 打到已销毁的 box

### 4. 渲染

- tab 条：一行 `BoxRenderable`（`flexDirection: "row"`）+ 每个 tab 一个 `TextRenderable`，当前 tab 用 accent 色并加 `[ ]`
- Skills tab 标题行右侧显示 `3/87` 计数；筛选串以 `/query` 显示在标题下
- 底部提示按当前 tab 变化：`tab switch · type to filter · space cycle · enter/esc close`
- 保留现有 `renderManager()` 的"整块重建"策略（每次按键重建 box），与现有 `renderSelect` 一致

### 5. `cli.ts` 的 tab 声明

```ts
await app?.manageTabs("Skills", [
  { kind: "list", id: "skills", title: "Skills", items, onCycle, refresh: reloadItems },
  {
    kind: "search", id: "search", title: "Search", placeholder: "pdf, testing, design…",
    search: (query, signal) => searchSkillRegistry(query, signal),
    onAccept: (result) => install(entryFor(result)),   // 复用现有 confirm → installRegistrySkill
  },
  { kind: "prompt", id: "install", title: "Install", placeholder: "owner/repo#skill", onSubmit: installFromGithub },
]);
```

`install()` 不再关闭弹窗、不再自己 notify 列表变化——安装成功后通知 "Installed X"，由 TUI 调 `refresh()` 重拉 `resources.load()` 的 skills 并保留当前筛选串。`/skills` 命令返回后仍然 `resources.reload()` + `syncSkillCommands()`。

### 6. 文案与文档

- README 与 `packages/coding-agent/README.md` 的 Skills 段：删掉 `s` / `i` 两条动作说明，改成三 tab 说明与键位表
- 弹窗底部提示与 README 键位保持一致

## 我做的决定（可按你的意见推翻）

- 防抖 250ms；查询词最短 1 个字符
- Search / Install 的 `Esc` 是"回 Skills tab"，不是"直接关窗"（防止误按丢窗口）
- Skills tab 的 `Space` 仍然循环可见性（skill 名不含空格，筛选用不到空格）
- 安装成功后留在当前 tab，`Skills` 列表后台刷新

## 验证

- `pnpm typecheck`
- `pnpm test`：新增 TUI 测试覆盖 tab 切换、字母筛选 + Backspace、Enter 安装选中结果、Esc 逐层退出；现有 `manages list states in a popup` / `collects input and runs manager actions` 两个测试改写为 `manageTabs`
- 手动跑 `pnpm dev`，`/skills` 里敲字母筛选、Search tab 边打边查
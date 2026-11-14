# Skills 弹窗多 tab 与字母筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/skills` 弹窗从单页列表改成 `Skills` / `Search` / `Install` 三 tab，Skills tab 支持字母筛选，Search tab 边打边查 skills.sh。

**Architecture:** `packages/tui/src/app.ts` 里把 `manageItems` 换成通用 `manageTabs(title, tabs)`，tab 分 `list` / `search` / `prompt` 三种 kind。TUI 只负责渲染与按键路由，skills 的业务（查什么、装什么）全在 `packages/coding-agent/src/cli.ts` 的 tab 声明里。弹窗改成一个**常驻外壳 + 局部重建**的结构：标题行、tab 条、结果区各自独立，输入框只在输入型 tab 里存在一次，避免每敲一个字符就重建输入框导致光标丢失。Search 用 250ms 防抖 + `AbortController` 取消上一个请求。

**Tech Stack:** TypeScript 5.9 (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), @opentui/core renderables, vitest + `@opentui/core/testing` 的 `createTestRenderer`。

**Spec:** `docs/superpowers/specs/2026-11-14-skills-tabs-design.md`

## Global Constraints

- TypeScript strict，`exactOptionalPropertyTypes` 开启：可选属性不存在时不得写 `key: undefined`，要写就用联合类型里显式包含 `undefined` 的字段（本计划里的 `manager` 状态全部显式带 `| undefined`，可以写 `undefined`）。
- `noUncheckedIndexedAccess`：数组索引访问结果是 `T | undefined`，必须处理。
- `verbatimModuleSyntax`：只导入类型时用 `import type`。
- 测试命令 `pnpm test <path>`；类型检查 `pnpm typecheck`（含测试目录）。
- 测试文件必须在 `packages/*/test/**/*.test.ts` 下才会被 vitest 收集。
- 键位事实（已用临时探针测试验证过，不要重新假设）：
  - 测试渲染器 `renderer.useKittyKeyboard === true`，但 `mockInput` 默认仍按 raw 模式发字节。
  - `Shift+Tab` 解析为 `{ name: "tab", shift: true, sequence: "\u001b[Z" }`；用 `ctx.mockInput.pressKey(KeyCodes.TAB, { shift: true })` 触发。
  - `Esc` 在 stdin 解析层有 20ms 防抖。测试里 `pressEscape()` 之后要 `await new Promise((r) => setTimeout(r, 60))` 再 `flush()` 才能收到 `escape`。
  - 全局 `keypress` handler 先于 renderable 执行；在全局 handler 里 `key.preventDefault()` + `key.stopPropagation()` 能阻止聚焦中的输入框收到该键（Enter / Tab 都验证过）。
  - `ctx.mockInput.typeText("PDF")` 逐字符发送，大写字母解析为 `{ name: "p", shift: true, sequence: "P" }`——所以筛选必须用 `key.sequence`，不能用 `key.name`，否则大写会变成小写。
- 全局 `keypress` handler 只 `intercept` 弹窗要接管的键；其余放行给输入框。`intercept` 就是现有的 `key.preventDefault() + key.stopPropagation()`。
- 提交信息用 conventional commits：`feat(tui): ...` / `feat(skills): ...` / `docs: ...`。

## Review Focus

- **筛选串含大写或数字**：用户敲 `PDF` 期望匹配 `pdf` 与 `PDF`。用 `key.sequence` 累积、`toLowerCase()` 子串匹配；Task 1 的测试覆盖大写输入。
- **筛选无匹配**：敲了匹配不到任何 skill 的串，期望看到 `no matches` 而不是空白弹窗。Task 1 测试断言。
- **Search 查询失败（网络错误 / skills.sh 500）**：弹窗不关、可继续改关键词重试、显示错误行。Task 2 测试断言。
- **Search 请求进行中继续打字或关窗**：旧请求结果不得覆盖新结果；关窗后不得再有 timer 或渲染落到已销毁的 box。每次输入 `abort()` 上一个；`closeManager`/`stop` 清理 timer 与 controller。Task 2 测试覆盖"快速连打两次只认最后一次"。
- **在 Search / Install tab 里按 Ctrl+C**：应关闭弹窗（现有 abort 行为），不留下悬挂输入框或未完成请求。Task 2 的清理逻辑 + Task 2 测试覆盖。

---

## File Structure

- `packages/tui/src/app.ts`（1685 行）— 修改。新增 `ManagedTab` 家族类型、`manageTabs`、弹窗外壳与三 tab 渲染、按键路由；删除 `ManagedAction`、`manageItems`、`manager.actions`、`managerBox` 字段。文件已是项目里的大文件，沿用现有风格不拆分。
- `packages/coding-agent/src/cli.ts` — 修改。`/skills` 命令改为声明三个 tab。
- `packages/tui/test/app.test.ts` — 修改。两个 `manageItems` 测试改成 `manageTabs`，新增筛选、tab 切换、边打边查、搜索失败、请求取消五个测试。
- `README.md:146-155`、`packages/coding-agent/README.md:119-128` — 修改 Skills 段键位说明。
- `docs/superpowers/specs/2026-11-14-skills-tabs-design.md` — 已存在，不改。

---

### Task 1: 弹窗外壳 + list tab + 字母筛选

**Files:**
- Modify: `packages/tui/src/app.ts`
  - 类型区：`ManagedItem`（25-30 行）后新增 `ManagedResult`、`ManagedListTab`、`ManagedTab`；删除 `ManagedAction`（32-36 行）
  - 字段：`manager`（164-173 行）、`managerBox`（182 行）
  - 方法：`manageItems`（522-542 行）、`handleManagerKey`（1307-1344 行）、`closeManager`（1346-1355 行）、`renderManager`（1367-1428 行）
  - 其他引用点：`setTheme`（约 480 行）、`stop`（约 378 行）、`footerRightContent`（1279 行）
- Test: `packages/tui/test/app.test.ts:314-333`（改写现有 `manages list states in a popup`），`:338-360`（改写现有 `collects input and runs manager actions`）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces:
```ts
export type ManagedItem = { id: string; label: string; state: string; states: string[] }; // 不变
export type ManagedResult = { id: string; label: string };
export type ManagedListTab = {
  kind: "list";
  id: string;
  title: string;
  items: ManagedItem[];
  onCycle: (id: string, state: string) => Promise<void> | void;
  refresh?: () => Promise<ManagedItem[]>;
};
export type ManagedTab = ManagedListTab; // Task 2 扩展成联合类型
manageTabs(title: string, tabs: ManagedTab[]): Promise<void>;
```
  - 私有：`filterItems(items, query)`、`renderManager()`、`renderManagerBody()`、`syncManagerShell()`、`visibleManagerItems()`、`managerItems()`

- [ ] **Step 1: 改写两个现有测试**

把 `packages/tui/test/app.test.ts` 的 `it("manages list states in a popup", ...)` 整体替换为：

```ts
  it("filters managed items by typed letters and still cycles state", async () => {
    const ctx = await setupApp();
    const changes: Array<[string, string]> = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [
          { id: "review", label: "review · personal", state: "on", states: ["on", "off"] },
          { id: "pdf", label: "pdf · personal", state: "on", states: ["on", "off"] },
          { id: "PDFKit", label: "PDFKit · personal", state: "on", states: ["on", "off"] },
        ],
        onCycle: (id, state) => {
          changes.push([id, state]);
        },
      },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[on] review");

    ctx.mockInput.typeText("PDF");
    await ctx.flush();
    const filtered = ctx.captureCharFrame();
    expect(filtered).toContain("/PDF");
    expect(filtered).toContain("[on] PDFKit");
    expect(filtered).not.toContain("review");

    ctx.mockInput.pressBackspace();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("/PD");

    ctx.mockInput.typeText("F");
    await ctx.flush();
    ctx.mockInput.pressArrow("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("› [on] PDFKit");

    ctx.mockInput.typeText(" ");
    await ctx.flush();
    expect(changes).toEqual([["PDFKit", "off"]]);

    ctx.mockInput.typeText("zzz");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("no matches");
    expect(ctx.captureCharFrame()).toContain("0/3");

    ctx.mockInput.pressEscape();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[off] review");

    ctx.mockInput.pressEscape();
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

把 `it("collects input and runs manager actions", ...)` 拆成两个测试——一个只测 `promptInput`，一个测 `manageTabs` 的关闭：

```ts
  it("collects input from the prompt modal", async () => {
    const ctx = await setupApp();
    const input = ctx.app.promptInput("Search skills", "query");
    await ctx.flush();
    ctx.mockInput.typeText("pdf");
    ctx.mockInput.pressEnter();
    await ctx.flush();
    await expect(input).resolves.toBe("pdf");
    ctx.app.stop();
    await ctx.dispose();
  });

  it("closes the manager with Escape", async () => {
    const ctx = await setupApp();
    const manager = ctx.app.manageTabs("Skills", [
      { kind: "list", id: "skills", title: "Skills", items: [], onCycle: () => undefined },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");
    ctx.mockInput.pressEscape();
    await ctx.flush();
    await expect(manager).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test packages/tui/test/app.test.ts -t "filters managed items"`
Expected: FAIL，`ctx.app.manageTabs is not a function`。

- [ ] **Step 3: 替换类型**

在 `packages/tui/src/app.ts` 删除 `ManagedAction` 类型，`ManagedItem` 之后加：

```ts
export type ManagedResult = { id: string; label: string };

export type ManagedListTab = {
  kind: "list";
  id: string;
  title: string;
  items: ManagedItem[];
  onCycle: (id: string, state: string) => Promise<void> | void;
  refresh?: () => Promise<ManagedItem[]>;
};

export type ManagedTab = ManagedListTab;
```

- [ ] **Step 4: 替换 manager 字段**

删除 `private manager: {...} | undefined;`（164-173 行）和 `private managerBox: BoxRenderable | undefined;`（182 行），换成：

```ts
  private manager:
    | {
        title: string;
        tabs: ManagedTab[];
        tabIndex: number;
        index: number;
        query: string;
        resolve: () => void;
        box: BoxRenderable | undefined;
        headerRow: TextRenderable | undefined;
        tabRow: TextRenderable | undefined;
        bodyBox: BoxRenderable | undefined;
      }
    | undefined;
```

- [ ] **Step 5: 加 `filterItems` / 辅助取值，用 `manageTabs` 替换 `manageItems`**

`manageItems`（522-542 行）整体替换为下面四个成员：

```ts
  private static filterItems(items: ManagedItem[], query: string): ManagedItem[] {
    if (!query) return items;
    const needle = query.toLowerCase();
    return items.filter((item) => item.id.toLowerCase().includes(needle));
  }

  private managerItems(): ManagedItem[] {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    return tab && tab.kind === "list" ? tab.items : [];
  }

  private visibleManagerItems(): ManagedItem[] {
    const manager = this.manager;
    if (!manager) return [];
    return TuiApp.filterItems(this.managerItems(), manager.query);
  }

  manageTabs(title: string, tabs: ManagedTab[]): Promise<void> {
    this.hideCompletion();
    if (this.manager) this.destroyManager();
    const state = Promise.withResolvers<void>();
    this.manager = {
      title,
      tabs,
      tabIndex: 0,
      index: 0,
      query: "",
      resolve: state.resolve,
      box: undefined,
      headerRow: undefined,
      tabRow: undefined,
      bodyBox: undefined,
    };
    this.renderManager();
    return state.promise;
  }
```

- [ ] **Step 6: 按键路由**

`handleManagerKey`（1307-1344 行）替换为：

```ts
  private handleManagerKey(key: KeyEvent): void {
    this.intercept(key);
    const manager = this.manager;
    if (!manager) return;
    const tab = manager.tabs[manager.tabIndex];
    if (!tab || tab.kind !== "list") return;
    if (key.name === "return") {
      this.closeManager();
      return;
    }
    if (key.name === "escape") {
      if (manager.query) {
        manager.query = "";
        manager.index = 0;
        this.renderManager();
        return;
      }
      this.closeManager();
      return;
    }
    const visible = this.visibleManagerItems();
    if (key.name === "up") {
      manager.index = Math.max(0, manager.index - 1);
      this.renderManager();
      return;
    }
    if (key.name === "down") {
      manager.index = Math.max(0, Math.min(visible.length - 1, manager.index + 1));
      this.renderManager();
      return;
    }
    if (key.name === "backspace") {
      if (!manager.query) return;
      manager.query = manager.query.slice(0, -1);
      manager.index = 0;
      this.renderManager();
      return;
    }
    if (key.name === "space") {
      const item = visible[manager.index];
      if (!item || item.states.length === 0) return;
      const index = item.states.indexOf(item.state);
      item.state = item.states[(index + 1) % item.states.length] ?? item.states[0] ?? item.state;
      this.renderManager();
      void Promise.resolve(tab.onCycle(item.id, item.state)).catch((error: unknown) => {
        this.notify(error instanceof Error ? error.message : String(error), "error");
      });
      return;
    }
    if (!key.ctrl && !key.meta && !key.option && !key.super) {
      const typed = key.sequence;
      if (!typed || typed.length !== 1) return;
      manager.query += typed;
      manager.index = 0;
      this.renderManager();
    }
  }
```

注意：用 `key.sequence` 而不是 `key.name`，因为大写字母的 `name` 是小写形式（见 Global Constraints）。

- [ ] **Step 7: 渲染外壳与 body**

`renderManager`（1367-1428 行）整体替换为下面三个方法：

```ts
  private destroyManager(): void {
    const manager = this.manager;
    if (!manager) return;
    this.manager = undefined;
    manager.box?.destroyRecursively();
    manager.resolve();
  }

  private renderManager(): void {
    if (!this.renderer || !this.root || !this.manager) return;
    const manager = this.manager;
    this.textarea?.blur();
    if (!manager.box) {
      const box = new BoxRenderable(this.renderer, {
        id: "skills-manager",
        position: "absolute",
        top: "12%",
        left: "8%",
        width: "84%",
        border: true,
        borderStyle: "rounded",
        borderColor: this.color("accent"),
        backgroundColor: this.theme.background,
        paddingX: 1,
        flexDirection: "column",
        zIndex: 110,
      });
      const headerRow = new TextRenderable(this.renderer, {
        content: "",
        fg: this.color("accent"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      const tabRow = new TextRenderable(this.renderer, {
        content: "",
        fg: this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      });
      const bodyBox = new BoxRenderable(this.renderer, {
        id: "skills-manager-body",
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
      });
      box.add(headerRow);
      box.add(tabRow);
      box.add(bodyBox);
      this.root.add(box);
      manager.box = box;
      manager.headerRow = headerRow;
      manager.tabRow = tabRow;
      manager.bodyBox = bodyBox;
    }
    this.syncManagerShell();
    this.renderManagerBody();
    this.updateFooter();
    this.renderer.requestRender();
  }

  private syncManagerShell(): void {
    const manager = this.manager;
    if (!manager || !manager.box || !manager.headerRow || !manager.tabRow) return;
    const tab = manager.tabs[manager.tabIndex];
    const visible = this.visibleManagerItems();
    const total = this.managerItems().length;
    manager.headerRow.content =
      tab?.kind === "list" && total > 0 ? `${manager.title}  ${visible.length}/${total}` : manager.title;
    manager.headerRow.content = manager.query
      ? `${manager.headerRow.content}  /${manager.query}`
      : manager.headerRow.content;
    manager.tabRow.content = manager.tabs
      .map((candidate, index) =>
        index === manager.tabIndex ? `[${candidate.title}]` : ` ${candidate.title} `,
      )
      .join(" ");
    const rows = Math.min(8, Math.max(visible.length, 1));
    manager.box.height = rows + 6;
  }

  private renderManagerBody(): void {
    const manager = this.manager;
    if (!manager?.bodyBox || !this.renderer) return;
    const body = manager.bodyBox;
    for (const child of [...body.getChildren()]) child.destroyRecursively();
    const tab = manager.tabs[manager.tabIndex];
    if (!tab || tab.kind !== "list") return;
    const visible = this.visibleManagerItems();
    const rows = Math.min(8, Math.max(visible.length, 1));
    if (visible.length === 0) {
      body.add(
        new TextRenderable(this.renderer, {
          content: "no matches",
          fg: this.color("muted"),
          wrapMode: "none",
          truncate: true,
          width: "100%",
        }),
      );
    }
    const start = Math.max(0, Math.min(manager.index - 3, visible.length - rows));
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const item = visible[start + rowIndex];
      if (!item) continue;
      const selected = start + rowIndex === manager.index;
      body.add(
        new TextRenderable(this.renderer, {
          content: `${selected ? "› " : "  "}[${item.state}] ${item.label}`,
          fg: selected ? this.color("accent") : this.color("fg"),
          wrapMode: "none",
          truncate: true,
          width: "100%",
        }),
      );
    }
    body.add(
      new TextRenderable(this.renderer, {
        content: "type to filter · space cycle · enter/esc close",
        fg: this.color("muted"),
        wrapMode: "none",
        truncate: true,
        width: "100%",
      }),
    );
  }
```

`body.getChildren()` 在 `Renderable` 基类上已确认存在（`packages/tui/node_modules/@opentui/core/Renderable.d.ts:398`），返回 `Renderable[]`。

- [ ] **Step 8: 修正其余引用**

- `closeManager`（1346 行）改为：
```ts
  private closeManager(): void {
    if (!this.manager) return;
    this.destroyManager();
    this.textarea?.focus();
    this.updateFooter();
  }
```
- `stop()` 里 `this.manager?.resolve(); this.manager = undefined;` 改为 `this.destroyManager();`
- `setTheme` 里 `if (this.managerBox) this.managerBox.borderColor = ...` 改为 `if (this.manager?.box) { this.manager.box.borderColor = theme.colors.accent; this.manager.box.backgroundColor = theme.background; }`，并保留已有的 `if (this.manager) this.renderManager();`
- `footerRightContent` 的 manager 分支改为 `return "type filter · ↑↓ move · space cycle · enter/esc close";`
- `footerLeftContent` 的 `if (this.manager) return \`${this.symbol("skills")} managing skills\`;` 不变。

- [ ] **Step 9: 跑类型检查与测试**

Run: `pnpm typecheck && pnpm test packages/tui/test/app.test.ts`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): manage skills in a tabbed popup with letter filtering"
```

---

### Task 2: search / prompt tab（边打边查）

**Files:**
- Modify: `packages/tui/src/app.ts`（类型区；`manager` 字段；`handleManagerKey`；`renderManager` / `syncManagerShell` / `renderManagerBody`；`destroyManager`；`stop`）
- Test: `packages/tui/test/app.test.ts`（在 Task 1 的两个测试之后新增四个测试）

**Interfaces:**
- Consumes: Task 1 的 `ManagedItem`、`ManagedResult`、`ManagedListTab`、`ManagedTab`、`manageTabs`、`filterItems`、`destroyManager`、`renderManager`、`syncManagerShell`、`renderManagerBody`。
- Produces:
```ts
export type ManagedSearchTab = {
  kind: "search";
  id: string;
  title: string;
  placeholder: string;
  search: (query: string, signal: AbortSignal) => Promise<ManagedResult[]>;
  onAccept: (result: ManagedResult) => Promise<void> | void;
};
export type ManagedPromptTab = {
  kind: "prompt";
  id: string;
  title: string;
  placeholder: string;
  onSubmit: (value: string) => Promise<void> | void;
};
export type ManagedTab = ManagedListTab | ManagedSearchTab | ManagedPromptTab;
```
  - `manager` 状态新增字段：`input: InputRenderable | undefined`、`inputBox: BoxRenderable | undefined`、`inputTabId: string | undefined`、`results: ManagedResult[]`、`resultIndex: number`、`searching: boolean`、`searchError: string | undefined`、`debounce: NodeJS.Timeout | undefined`、`controller: AbortController | undefined`
  - 私有：`handleManagerTabKey(key, tab)`、`handleManagerInputKey(key, tab)`、`onManagerInputChange()`、`runManagerSearch(tab, query)`、`ensureManagerInput(tab)`、`clearManagerSearch()`

- [ ] **Step 1: 写失败测试——tab 切换与 Esc 逐层退出**

在 `packages/tui/test/app.test.ts` 末尾（最后一个 `});` 之前）加：

```ts
  it("switches manager tabs with Tab and exits Escape layer by layer", async () => {
    const ctx = await setupApp();
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "list",
        id: "skills",
        title: "Skills",
        items: [{ id: "review", label: "review · personal", state: "on", states: ["on", "off"] }],
        onCycle: () => undefined,
      },
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf, testing",
        search: async () => [],
        onAccept: () => undefined,
      },
      {
        kind: "prompt",
        id: "install",
        title: "Install",
        placeholder: "owner/repo#skill",
        onSubmit: () => undefined,
      },
    ]);
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");

    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Search]");

    ctx.mockInput.pressTab();
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Install]");

    ctx.mockInput.pressKey(KeyCodes.TAB, { shift: true });
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("[Skills]");
    expect(ctx.captureCharFrame()).not.toContain("[Search]");

    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

测试文件顶部把 `import { createTestRenderer } from "@opentui/core/testing";` 改为 `import { KeyCodes, createTestRenderer } from "@opentui/core/testing";`。

- [ ] **Step 2: 写失败测试——边打边查 + Enter 安装**

```ts
  it("searches as you type and installs the selected result", async () => {
    const ctx = await setupApp();
    const queries: string[] = [];
    const accepted: string[] = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf, testing",
        search: async (query) => {
          queries.push(query);
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (query.toLowerCase() === "pdf") {
            return [
              { id: "a/skills/pdf", label: "pdf · a/skills · 120 installs" },
              { id: "b/skills/pdfpro", label: "pdfpro · b/skills · 30 installs" },
            ];
          }
          return [];
        },
        onAccept: (result) => {
          accepted.push(result.id);
        },
      },
    ]);
    await ctx.flush();

    ctx.mockInput.typeText("pdf");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ctx.flush();
    expect(queries.at(-1)).toBe("pdf");
    expect(ctx.captureCharFrame()).toContain("pdf · a/skills");

    ctx.mockInput.pressArrow("down");
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("› pdfpro · b/skills");

    ctx.mockInput.pressEnter();
    await ctx.flush();
    expect(accepted).toEqual(["b/skills/pdfpro"]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

- [ ] **Step 3: 写失败测试——搜索失败不关窗**

```ts
  it("keeps the search tab open when the registry errors", async () => {
    const ctx = await setupApp();
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf",
        search: async () => {
          throw new Error("skills.sh returned 500");
        },
        onAccept: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.typeText("pdf");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ctx.flush();
    expect(ctx.captureCharFrame()).toContain("skills.sh returned 500");
    expect(ctx.captureCharFrame()).toContain("[Search]");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

- [ ] **Step 4: 写失败测试——只认最后一次查询**

```ts
  it("ignores results from aborted searches", async () => {
    const ctx = await setupApp();
    const settled: string[] = [];
    const done = ctx.app.manageTabs("Skills", [
      {
        kind: "search",
        id: "search",
        title: "Search",
        placeholder: "pdf",
        search: async (query, signal) => {
          await new Promise((resolve) => setTimeout(resolve, query === "p" ? 120 : 5));
          if (signal.aborted) {
            settled.push(`aborted:${query}`);
            return [{ id: "stale", label: "stale result" }];
          }
          settled.push(`fresh:${query}`);
          return [{ id: "fresh", label: "fresh result" }];
        },
        onAccept: () => undefined,
      },
    ]);
    await ctx.flush();
    ctx.mockInput.typeText("p");
    await new Promise((resolve) => setTimeout(resolve, 300));
    ctx.mockInput.typeText("d");
    await ctx.flush();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await ctx.flush();
    expect(settled).toContain("aborted:p");
    expect(ctx.captureCharFrame()).toContain("fresh result");
    expect(ctx.captureCharFrame()).not.toContain("stale result");

    await new Promise((resolve) => setTimeout(resolve, 60));
    ctx.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctx.flush();
    await expect(done).resolves.toBeUndefined();
    ctx.app.stop();
    await ctx.dispose();
  });
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm test packages/tui/test/app.test.ts -t "switches manager tabs"`
Expected: FAIL，`[Search]` 不存在（当前实现只有 list 分支）。

- [ ] **Step 6: 扩展类型与字段**

`ManagedTab` 改为联合类型（见本任务 Interfaces）。`manager` 字段在 Task 1 基础上补：

```ts
        input: InputRenderable | undefined;
        inputBox: BoxRenderable | undefined;
        inputTabId: string | undefined;
        results: ManagedResult[];
        resultIndex: number;
        searching: boolean;
        searchError: string | undefined;
        debounce: NodeJS.Timeout | undefined;
        controller: AbortController | undefined;
```

`manageTabs` 初始化补：`input: undefined, inputBox: undefined, inputTabId: undefined, results: [], resultIndex: 0, searching: false, searchError: undefined, debounce: undefined, controller: undefined`。

`destroyManager` 在 `manager.box?.destroyRecursively()` 之前补清理：

```ts
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.inputBox?.destroyRecursively();
    manager.inputBox = undefined;
    manager.input = undefined;
```

- [ ] **Step 7: 按键路由分发**

`handleManagerKey` 在 `const tab = manager.tabs[manager.tabIndex];` 之后、list 分支之前插入：

```ts
    if (key.name === "tab") {
      manager.tabIndex = key.shift
        ? (manager.tabIndex - 1 + manager.tabs.length) % manager.tabs.length
        : (manager.tabIndex + 1) % manager.tabs.length;
      this.clearManagerSearch();
      manager.query = "";
      manager.index = 0;
      manager.resultIndex = 0;
      this.renderManager();
      return;
    }
    if (!tab) return;
    if (tab.kind !== "list") {
      this.handleManagerInputKey(key, tab);
      return;
    }
```

并把原来那行 `if (!tab || tab.kind !== "list") return;` 删掉（已被上面覆盖）。

新增：

```ts
  private clearManagerSearch(): void {
    const manager = this.manager;
    if (!manager) return;
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.searching = false;
    manager.searchError = undefined;
    manager.results = [];
  }

  private handleManagerInputKey(key: KeyEvent, tab: ManagedSearchTab | ManagedPromptTab): void {
    const manager = this.manager;
    if (!manager) return;
    if (key.name === "escape") {
      const back = manager.tabs.findIndex((candidate) => candidate.kind === "list");
      manager.tabIndex = back < 0 ? 0 : back;
      this.clearManagerSearch();
      manager.query = "";
      manager.index = 0;
      manager.resultIndex = 0;
      this.renderManager();
      return;
    }
    if (tab.kind === "search" && (key.name === "up" || key.name === "down")) {
      if (manager.results.length === 0) return;
      manager.resultIndex =
        key.name === "up"
          ? Math.max(0, manager.resultIndex - 1)
          : Math.min(manager.results.length - 1, manager.resultIndex + 1);
      this.renderManagerBody();
      return;
    }
    if (key.name === "return") {
      if (tab.kind === "search") {
        const result = manager.results[manager.resultIndex];
        if (!result) return;
        void Promise.resolve(tab.onAccept(result)).catch((error: unknown) => {
          this.notify(error instanceof Error ? error.message : String(error), "error");
        });
        return;
      }
      const value = manager.input?.value.trim() ?? "";
      if (!value) return;
      void Promise.resolve(tab.onSubmit(value)).catch((error: unknown) => {
        this.notify(error instanceof Error ? error.message : String(error), "error");
      });
      manager.input?.setText("");
      this.renderManagerBody();
    }
  }
```

注意 `handleManagerKey` 里要先 `this.intercept(key)`（Task 1 已有），这样 Enter / Tab / Esc / 方向键都不会漏给输入框；可打印字符和 Backspace 不 intercept，直接交给输入框。

修改拦截位置：Task 1 的 `handleManagerKey` 在开头无条件 `this.intercept(key)`。Task 2 改成只在处理完的键上 intercept：

```ts
  private handleManagerKey(key: KeyEvent): void {
    const manager = this.manager;
    if (!manager) return;
    if (key.name === "tab") {
      this.intercept(key);
      ...
    }
    const tab = manager.tabs[manager.tabIndex];
    if (!tab) return;
    if (tab.kind !== "list") {
      if (key.name === "escape" || key.name === "return" || key.name === "up" || key.name === "down") {
        this.intercept(key);
      }
      this.handleManagerInputKey(key, tab);
      return;
    }
    this.intercept(key);
    ... // Task 1 的 list 分支保持不变
  }
```

- [ ] **Step 8: 渲染输入框与结果区**

`syncManagerShell` 的 height 计算改为按 tab：

```ts
    const tab = manager.tabs[manager.tabIndex];
    const rows =
      tab?.kind === "list"
        ? Math.min(8, Math.max(this.visibleManagerItems().length, 1))
        : tab?.kind === "search"
          ? Math.min(6, Math.max(manager.results.length, 1))
          : 1;
    manager.box.height = rows + (tab?.kind === "list" ? 6 : 7);
```

`renderManager` 在 `this.syncManagerShell()` 之前调用 `this.ensureManagerInput()`。

新增：

```ts
  private ensureManagerInput(): void {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    if (!manager || !manager.box || !this.renderer) return;
    const wanted = tab && tab.kind !== "list" ? tab.id : undefined;
    if (manager.inputTabId === wanted) return;
    manager.inputBox?.destroyRecursively();
    manager.inputBox = undefined;
    manager.input = undefined;
    manager.inputTabId = wanted;
    if (!wanted || !tab || tab.kind === "list") return;
    const inputBox = new BoxRenderable(this.renderer, {
      id: "skills-manager-input",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "column",
    });
    const input: InputRenderable = new InputRenderable(this.renderer, {
      width: "100%",
      placeholder: tab.placeholder,
      placeholderColor: this.color("inputPlaceholder"),
      backgroundColor: this.theme.colors.inputBg,
      textColor: this.color("inputText"),
      focusedBackgroundColor: this.theme.colors.inputBg,
      focusedTextColor: this.color("inputText"),
      cursorColor: this.color("inputFocus"),
    });
    input.onContentChange = () => this.onManagerInputChange();
    inputBox.add(input);
    manager.box.add(inputBox);
    manager.inputBox = inputBox;
    manager.input = input;
    input.focus();
  }
```

`renderManagerBody` 在 `tab.kind !== "list"` 时渲染 search 的 `searching…` / 错误行 / 结果列表，或 prompt 的提示行：

```ts
    if (!tab) return;
    if (tab.kind === "search") {
      if (manager.searchError) {
        body.add(text(manager.searchError, this.color("error")));
      } else if (manager.searching) {
        body.add(text("searching…", this.color("muted")));
      } else if (manager.results.length === 0) {
        body.add(text(manager.query ? "no results" : "type to search skills.sh", this.color("muted")));
      }
      const rows = Math.min(6, manager.results.length);
      const start = Math.max(0, Math.min(manager.resultIndex - 2, manager.results.length - rows));
      for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
        const result = manager.results[start + rowIndex];
        if (!result) continue;
        const selected = start + rowIndex === manager.resultIndex;
        body.add(text(`${selected ? "› " : "  "}${result.label}`, selected ? this.color("accent") : this.color("fg")));
      }
      body.add(text("↑↓ pick · enter install · esc back", this.color("muted")));
      return;
    }
    if (tab.kind === "prompt") {
      body.add(text("enter install · esc back", this.color("muted")));
    }
```

`text` 是这一步里在 `renderManagerBody` 内部定义的小工厂（每次调用都 `new TextRenderable(this.renderer, { content, fg, wrapMode: "none", truncate: true, width: "100%" })`），避免重复七行样板。

- [ ] **Step 9: 边打边查**

新增：

```ts
  private onManagerInputChange(): void {
    const manager = this.manager;
    const tab = manager?.tabs[manager.tabIndex];
    if (!manager || tab?.kind !== "search") return;
    const query = manager.input?.value.trim() ?? "";
    manager.query = query;
    clearTimeout(manager.debounce);
    manager.debounce = undefined;
    manager.controller?.abort();
    manager.controller = undefined;
    manager.searching = false;
    manager.searchError = undefined;
    if (!query) {
      manager.results = [];
      manager.resultIndex = 0;
      this.renderManager();
      return;
    }
    manager.results = [];
    manager.resultIndex = 0;
    manager.searching = true;
    this.renderManager();
    manager.debounce = setTimeout(() => {
      void this.runManagerSearch(tab, query);
    }, 250);
  }

  private async runManagerSearch(tab: ManagedSearchTab, query: string): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    const controller = new AbortController();
    manager.controller = controller;
    try {
      const results = await tab.search(query, controller.signal);
      if (this.manager !== manager || controller.signal.aborted) return;
      manager.results = results;
      manager.resultIndex = 0;
      manager.searching = false;
      manager.searchError = undefined;
    } catch (error) {
      if (this.manager !== manager || controller.signal.aborted) return;
      manager.searching = false;
      manager.searchError = error instanceof Error ? error.message : String(error);
    }
    this.renderManager();
  }
```

`renderManager()` 会走 `syncManagerShell` + `ensureManagerInput`（同 tab，不重建输入框）+ `renderManagerBody`，因此打字时光标不丢。

- [ ] **Step 10: `stop()` 清理**

`stop()` 里 manager 相关改为：

```ts
    if (this.manager) {
      clearTimeout(this.manager.debounce);
      this.manager.controller?.abort();
      this.destroyManager();
    }
```

- [ ] **Step 11: 跑类型检查与测试**

Run: `pnpm typecheck && pnpm test packages/tui/test/app.test.ts`
Expected: PASS（Task 1 + Task 2 共 4 个新测试加原有测试全绿）。

- [ ] **Step 12: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): add search and install tabs with debounced live search"
```

---

### Task 3: `/skills` 命令改用三个 tab

**Files:**
- Modify: `packages/coding-agent/src/cli.ts:26`（类型导入）、`:614-711`（`/skills` 命令）
- Test: 无新增自动化测试（该文件没有测试覆盖；交互由 Task 1/2 的 TUI 测试与手动验证承担）。必须跑 `pnpm typecheck` 与全量 `pnpm test` 确认没有破坏其它测试。

**Interfaces:**
- Consumes: `ManagedItem`、`ManagedTab`、`manageTabs`（从 `@cletus/tui` 导入）、`searchSkillRegistry`、`installRegistrySkill`、`RegistrySkill`（本文件已导入）。
- Produces: 无对外接口。

- [ ] **Step 1: 导入类型**

`packages/coding-agent/src/cli.ts:9`：

```ts
import type { TuiApp as TuiAppType, SlashCommand } from "@cletus/tui";
```
改为：
```ts
import type { ManagedItem, SlashCommand, TuiApp as TuiAppType } from "@cletus/tui";
```

- [ ] **Step 2: 重写 `/skills` 的 `run`**

把 `run: async () => { ... }`（616-710 行）整体替换为：

```ts
      run: async () => {
        if (!session) return;
        if (session.agent.state.isStreaming) {
          app?.notify("Cannot manage skills while running", "warn");
          return;
        }
        const toItems = (skills: NonNullable<typeof opts.resources.cached>["skills"]): ManagedItem[] =>
          skills.map((skill) => ({
            id: skill.name,
            label: `${skill.name} · ${skill.source} — ${skill.description}`,
            state: skill.visibility === "user-invocable-only" ? "user-only" : skill.visibility,
            states: ["on", "name-only", "user-only", "off"],
          }));
        const loadItems = async (): Promise<ManagedItem[]> => {
          opts.resources.reload();
          return toItems((await opts.resources.load()).skills);
        };
        const install = async (entry: RegistrySkill): Promise<void> => {
          const approved = await app?.confirm(
            "Install skill",
            `${entry.source} · ${entry.skillId}\n\nInstall globally and copy into ~/.claude/skills?`,
          );
          if (approved !== "allow" && approved !== "session") return;
          app?.notify(`Installing ${entry.source}/${entry.skillId}…`);
          await installRegistrySkill(entry);
          syncSkillCommands();
          app?.notify(`Installed ${entry.name}`);
        };
        const installFromPackage = async (value: string): Promise<void> => {
          const split = value.lastIndexOf("#");
          if (split <= 0 || split === value.length - 1) {
            app?.notify("Use owner/repo#skill", "warn");
            return;
          }
          await install({
            id: value,
            source: value.slice(0, split),
            skillId: value.slice(split + 1),
            name: value.slice(split + 1),
            installs: 0,
          });
        };
        const registry = new Map<string, RegistrySkill>();
        let changed = false;
        try {
          await app?.manageTabs("Skills", [
            {
              kind: "list",
              id: "skills",
              title: "Skills",
              items: toItems((await opts.resources.load()).skills),
              refresh: loadItems,
              onCycle: async (name, state) => {
                changed = true;
                const visibility: SkillVisibility =
                  state === "user-only" ? "user-invocable-only" : (state as SkillVisibility);
                opts.config.skillOverrides[name] = visibility;
                await writeJsonAtomic(configPath(opts.home), opts.config);
                opts.resources.setSkillOverrides(opts.config.skillOverrides);
              },
            },
            {
              kind: "search",
              id: "search",
              title: "Search",
              placeholder: "pdf, testing, design…",
              search: async (query, signal) => {
                const found = await searchSkillRegistry(query, signal);
                for (const entry of found) registry.set(entry.id, entry);
                return found.map((entry) => ({
                  id: entry.id,
                  label: `${entry.name} · ${entry.source} · ${entry.installs.toLocaleString()} installs`,
                }));
              },
              onAccept: async (result) => {
                const entry = registry.get(result.id);
                if (entry) await install(entry);
              },
            },
            {
              kind: "prompt",
              id: "install",
              title: "Install",
              placeholder: "owner/repo#skill",
              onSubmit: installFromPackage,
            },
          ]);
        } catch (error) {
          app?.notify(error instanceof Error ? error.message : String(error), "error");
        }
        opts.resources.reload();
        await opts.resources.load();
        syncSkillCommands();
        if (changed) app?.notify("Skills saved");
      },
```

说明：`install` 成功后不再自己 `reload()` + 刷列表，改为依赖 list tab 的 `refresh`——Task 2 的 tab 切回 `list` 时若该 tab 有 `refresh` 会重拉。（若 Task 2 执行时没实现 refresh 调用，则在此处补：`handleManagerKey` 的 tab 切换分支在切到 `kind === "list" && tab.refresh` 的 tab 时调用 `void tab.refresh().then((items) => { tab.items = items; this.renderManager(); })`。）

- [ ] **Step 3: 跑类型检查与全量测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全部 PASS。

- [ ] **Step 4: 手动验证**

Run: `pnpm dev`，输入 `/skills`：敲 `pdf` 看筛选与 `3/87` 计数、`Tab` 到 Search 敲 `pdf` 看边打边查、`Esc` 回 Skills、再 `Esc` 关窗。

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/cli.ts
git commit -m "feat(skills): expose search and install as manager tabs"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `README.md:146-155`
- Modify: `packages/coding-agent/README.md:119-128`

**Interfaces:**
- Consumes: Task 1-3 的最终键位。
- Produces: 无。

- [ ] **Step 1: 替换两处 README 的 Skills 段**

两处都把这段：

```markdown
`/skills` opens a single popup manager inspired by Claude Code. Use Up/Down to move, `Space` to cycle visibility, and `Enter` or `Esc` to close. Changes are saved immediately to `~/.cletus/config.json`.

From the same popup:

- `s` searches skills.sh and installs a selected result
- `i` installs `owner/repo#skill` from GitHub
```

替换为：

```markdown
`/skills` opens a tabbed popup manager (`Skills`, `Search`, `Install`). `Tab` / `Shift+Tab` switch tabs. Changes are saved immediately to `~/.cletus/config.json`.

| Tab | Keys |
|---|---|
| `Skills` | type to filter, `Backspace` to erase, `Up`/`Down` to move, `Space` to cycle visibility, `Esc` clears the filter first, then closes |
| `Search` | type a query; skills.sh is searched as you type, `Up`/`Down` pick a result, `Enter` installs, `Esc` goes back to `Skills` |
| `Install` | type `owner/repo#skill`, `Enter` installs, `Esc` goes back to `Skills` |
```

- [ ] **Step 2: 提交**

```bash
git add README.md packages/coding-agent/README.md
git commit -m "docs: describe the tabbed skills manager"
```

---

## Self-Review

**Spec coverage:**
- 三 tab 与 `Tab`/`Shift+Tab` 切换 → Task 1 Step 7（tab 条渲染）+ Task 2 Step 7
- Skills tab 大小写不敏感子串筛选、Backspace、Esc 逐层 → Task 1 Step 6 + Step 1 测试
- Search tab 边打边查、250ms 防抖、abort 旧请求 → Task 2 Step 9 + Step 2/4 测试
- Search 失败不关窗、显示错误行 → Task 2 Step 8 + Step 3 测试
- Install tab 提交 `owner/repo#skill` → Task 2 Step 8 + Task 3 Step 2 的 `onSubmit`
- 安装后刷新 Skills 列表 → Task 3 Step 2 的 `refresh`
- `manageItems`/`ManagedAction` 删除 → Task 1 Step 3-5
- TUI 不懂 skills 业务 → Task 3 全部逻辑留在 `cli.ts`
- README 两处同步 → Task 4

**Step scan:** 每个 step 给的是签名、结构或精确断言；没有 "handle edge cases" 这类空指令。计划里引用到的 opentui API（`getChildren()`、`InputRenderable.value`、`destroyRecursively()`、`add(obj, index?)`）都已对 `packages/tui/node_modules/@opentui/core` 的 `.d.ts` 核实过。

**Type consistency:** `ManagedItem` / `ManagedResult` / `ManagedListTab` / `ManagedSearchTab` / `ManagedPromptTab` / `ManagedTab` / `manageTabs` / `filterItems` / `managerItems` / `visibleManagerItems` / `destroyManager` / `renderManager` / `syncManagerShell` / `renderManagerBody` / `ensureManagerInput` / `clearManagerSearch` / `onManagerInputChange` / `runManagerSearch` / `handleManagerInputKey` 在各 task 间同名同签名。

**Review Focus 落点:**
- 大写/数字筛选 → Task 1 Step 1（`typeText("PDF")` 命中 `PDFKit`）
- 无匹配 → Task 1 Step 1（`zzz` → `no matches` + `0/3`）
- 搜索失败 → Task 2 Step 3
- 请求期间继续打字 → Task 2 Step 4（断言 `aborted:p` 且不长驻 `stale result`）
- Search/Install 里 Ctrl+C → 现有 `handleKey` 的 abort 分支会调 `closeManager`，Task 2 Step 10 保证 timer/controller 一并清理；这一条没有专门测试（Ctrl+C 在测试渲染器里会结束进程），列为手动验证项。
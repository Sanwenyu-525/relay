# 窄窗外壳折叠点下移实施计划（48rem–64rem 保留三列）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准 spec 把应用外壳的折叠点从 `width < 64rem` 下移到 `width < 48rem`：48rem–64rem（1023px 往下，150% DPI 下最常见的桌面窗口宽度）保留图标导航 + 近期工作 + 内容三列，`< 48rem` 才整体折叠进 `☰` 抽屉。

**Architecture:** 纯 CSS 结构改动（`apps/workbench/src/styles.css`）：把现有 `@media (width < 64rem)` 块按职责拆成「外壳收纳」与「页面密度」两组，前者迁到 `width < 48rem`，后者留在 `< 64rem`；新增一条 `48rem <= width < 64rem` 的变量覆盖，让该区间使用侧栏列宽默认值而不吃用户拖拽宽度；`.app-topbar:not(:has(.breadcrumbs))` 的收起区间从 `min-width: 64rem` 改为 `min-width: 48rem`。**不改任何 TSX、不改业务状态、不改 token 数值。**

**Tech Stack:** React 19 + TypeScript 5.9 + Vite 8；vitest 5（jsdom）+ Playwright 1.63（chromium）。

**Spec:** docs/superpowers/specs/2026-10-15-narrow-window-shell-fold-design.md

## Global Constraints

- 工作目录是脏的（含他人未提交改动与未跟踪新文件）：**只 `git add` 本计划点名的文件**，禁止 `git add -A`、`git checkout`、`git stash`、`git clean`。
- 断点只能用 `breakpoint.medium/large`（48/64rem），写法必须是 range 语法；`tests/responsiveTiers.spec.ts` 是可执行守卫（禁 `.9375rem` 补丁、禁 `max-width` 旧式、禁 min/max 双触发）。
- 不新增/修改任何 token 数值：`design-tokens.json` 实施后必须 diff 为空。
- 不改任何 TSX 结构、`data-testid`、导航语义、草稿保护与命令 Owner。
- 全部命令在 `apps/workbench` 执行；vitest：`pnpm exec vitest run tests/<file>.spec.ts`；浏览器：`pnpm exec playwright test tests/browser/<file>.spec.ts`；类型：`pnpm run typecheck`；构建：`pnpm run build`；文档检查在仓库根：`node scripts/check-docs.mjs`。
- commit message 用英文；每个任务一次提交，只含该任务文件。

## Review Focus

- **390px 单列档不能回归**：`tests/browser/workbench.spec.ts` 的「小窗口」用例（两栏收起 + 抽屉可开）必须仍绿。
- **用户拖拽宽度只在 ≥64rem 生效**：`tests/sidebarResize.spec.ts` 的既有语义不变；48rem–64rem 区间 `--relay-shell-sidebar-width` 必须解析为 `layout.shell.sidebarWidth` 默认值。
- **vitest 不受影响**：jsdom 不做媒体查询计算，所有 `打开导航` / `mobile-new-conversation` 断言保持原样，**不要顺手改 vitest 断言**。
- **协作页自己的容器折叠**（`container collaboration`，约 52rem）按内容列实际宽度自行生效，本计划不新增也不改它。
- 截图 spec（`tests/screenshots/*`，他人未跟踪文件）不改动；其中 `safeClick(... .or(mobile-menu-button))` 在 ≥768px 下变成 no-op，属预期。

## 影响面清单（动手前先读完这张表）

| 文件 | 现状假设 | 本计划动作 | 红绿驱动？ |
|---|---|---|---|
| `src/styles.css:3208-3285`（`< 64rem` 块） | 外壳收纳 + 页面密度混在一个块 | 按下表拆分 | ✅ |
| `src/styles.css:989-992` | 空顶栏收起挂在 `min-width: 64rem` | 改 `min-width: 48rem` | ✅ |
| `tests/browser/responsiveFoldGeometry.spec.ts:83,100-102` | 列数期望 `width < 1024` | 改 `width < 768` + 补三档矩阵 | ✅ 红 |
| `tests/browser/narrowWindowNewConversation.spec.ts:18,127-136` | 843/833 两栏收起、☰ 出现 | 折叠档宽度下移；补 843 三列用例 | 前提校正 |
| `tests/browser/titlebarPlacement.spec.ts:62-68` | 900px 下 `☰` 可见 | 折叠档改 743；补 900px「☰ 隐藏 + 图标栏可见」 | 前提校正 |
| `tests/browser/navigation-active-state.spec.ts:24-41` | 843px 下点 `☰` | 抽屉段改 743；补 900px 走 `次级导航` | 前提校正 |
| `tests/browser/workbench.spec.ts:112-130`（390px） | 两栏收起 | 不改 | — |
| `tests/responsiveTiers.spec.ts` | 守卫 48/64/80/90 + range 语法 | 不改（`48rem <= width < 64rem` 合规） | — |
| vitest 全部（`navigation` / `narrowWindowNewConversation` / `collaborationWorkspace` / `sidebarResize`） | jsdom 无媒体查询 | 不改 | — |

---

### Task 1: 三档矩阵的可执行断言（先红）

**Files:**
- Modify: `apps/workbench/tests/browser/responsiveFoldGeometry.spec.ts`（第 82–109 行的 describe）

**Interfaces:**
- Consumes: 既有 `installTaskDetail(page)` / `connect(page)` 辅助函数与 `columnCount()`。
- Produces: 无新 testid；只改断言与新增 `shellTier()` 辅助。

- [ ] **Step 1: 改断言为 spec §4.1 的三档矩阵**

把第 98–102 行替换为：

```ts
// 应用外壳：<48rem 整体折叠（两栏收起、导航进 ☰ 抽屉）；48rem–64rem 仍是三列；
// ≥64rem 三列且用户拖拽宽度生效。本断言同时守住两档互不打破。
const frameColumns = await columnCount(page, ".app-frame");
expect(frameColumns === 1, `app-frame 列数 ${frameColumns}`).toBe(width < 768);
if (width >= 768) expect(frameColumns).toBe(3);

const shell = async (selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return "missing";
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display === "none" ? "hidden"
      : box.width === 0 || box.height === 0 ? "zero-size" : "visible";
  }, selector);

expect(await shell(".app-navrail")).toBe(width >= 768 ? "visible" : "hidden");
expect(await shell(".app-context-rail")).toBe(width >= 768 ? "visible" : "hidden");
await expect(page.locator(".app-topbar .mobile-menu-button"))
  .toBeVisible({ visible: width < 768 });

// 内容列不得被侧栏挤到阅读下限以下（layout.workspace.centerMin = 26rem）。
if (width >= 768) {
  const rem = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const centre = await page.locator(".app-content").boundingBox();
  expect(centre!.width).toBeGreaterThanOrEqual(26 * rem - 1);
}
```

- [ ] **Step 2: 加一条「用户拖拽宽度不进 48rem–64rem」的断言**

同一 describe 末尾追加：

```ts
test("侧栏列宽：用户拖拽宽度只在 ≥64rem 生效", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await installTaskDetail(page);
  await page.goto(`/tasks/${taskId}`);
  await connect(page);
  await page.getByTestId("task-detail-page-head").waitFor({ timeout: 20_000 });

  // 模拟用户此前在宽档把侧栏拖到 20rem，再把窗口缩到 900px。
  await page.evaluate(() => document.querySelector<HTMLElement>(".app-frame")!
    .style.setProperty("--relay-sidebar-user-width", "20rem"));

  const narrow = await page.evaluate(() => getComputedStyle(
    document.querySelector(".app-frame")!).getPropertyValue("--relay-shell-sidebar-width"));
  expect(narrow.trim()).not.toBe("20rem");

  await page.setViewportSize({ width: 1280, height: 800 });
  const wide = await page.evaluate(() => getComputedStyle(
    document.querySelector(".app-frame")!).getPropertyValue("--relay-shell-sidebar-width"));
  expect(wide.trim()).toBe("20rem");
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm exec playwright test tests/browser/responsiveFoldGeometry.spec.ts`
Expected: FAIL —— 900px 与 1023px 两档当前 `frameColumns === 1` 且两栏 `hidden`；用户宽度那档当前解析为 `20rem`。

- [ ] **Step 4: 提交**

```bash
git add apps/workbench/tests/browser/responsiveFoldGeometry.spec.ts
git commit -m "test(workbench): assert shell tiers fold below 48rem"
```

---

### Task 2: styles.css 折叠点下移

**Files:**
- Modify: `apps/workbench/src/styles.css`（`< 64rem` 块第 3208–3285 行；`:not(:has(.breadcrumbs))` 规则第 989–992 行）

**Interfaces:**
- Produces: 新增 `@media (48rem <= width < 64rem)` 一条规则，只覆盖 `--relay-shell-sidebar-width`。无新 class、无新 token。

- [ ] **Step 1: 把 `< 64rem` 块按职责拆开**

`< 64rem` 块内逐条处置（保持块内原有顺序）：

| 规则 | 处置 |
|---|---|
| `.app-frame { grid-template-columns: minmax(0, 1fr) }` | **迁到 `< 48rem`** |
| `.app-navrail, .app-context-rail { display: none }` + 注释 | **迁到 `< 48rem`** |
| `.brand`（两条）与 `.brand, .navigation-label` 的视觉隐藏 | **迁到 `< 48rem`**；`.brand` 已无渲染点（`AppShell` 用 `.navrail-brand`），连同 `styles.css:523` 的基态规则一并删除；若实施时发现 `.brand` 有渲染点则保留并随块迁移 |
| `.navigation-item` / `.navigation-item--active::before` / `.navigation-count` 的图标栏紧凑化 | **迁到 `< 48rem`** |
| `.app-topbar .mobile-menu-button { display: inline-flex }` | **迁到 `< 48rem`** |
| `.sidebar-resize-handle { display: none }` | **留在 `< 64rem`**（48–64rem 可见但不可拖） |
| `.app-topbar` padding、`.skill-tabs`、`.page-primary/.desktop-rail/.page-state/.unsupported-page` padding、`.rail-trigger`、`h1` 降到 `compactPage` | **留在 `< 64rem`**（页面密度，与外壳收纳无关） |

新块（紧随 `< 48rem` 块之后）：

```css
/* 48rem–64rem：外壳仍是三列，但用户拖拽宽度只作用于 ≥64rem 宽断点基础列
   （见 layout.shell.sidebarWidth 描述）。这里只覆盖列宽变量，不复制 grid 模板：
   基态 .app-frame 的三列模板在本区间继续生效。 */
@media (48rem <= width < 64rem) {
  .app-frame {
    --relay-shell-sidebar-width: var(--relay-layout-shell-sidebarWidth);
  }
}
```

- [ ] **Step 2: 空顶栏收起区间下移**

第 989–992 行改为 `@media (min-width: 48rem)`，并同步注释：`/agent` 无面包屑；该区间 `☰` 已隐藏（外壳未折叠），因此整行收起，不再留一条点开后内容已在屏幕上的空抽屉。

- [ ] **Step 3: 跑 Task 1 的断言确认转绿**

Run: `pnpm exec playwright test tests/browser/responsiveFoldGeometry.spec.ts`
Expected: PASS

- [ ] **Step 4: 断点守卫**

Run: `pnpm exec vitest run tests/responsiveTiers.spec.ts`
Expected: PASS（`48rem <= width < 64rem` 为合法 range 语法且档值合规）

- [ ] **Step 5: 提交**

```bash
git add apps/workbench/src/styles.css
git commit -m "fix(workbench): fold shell navigation below 48rem instead of 64rem"
```

---

### Task 3: 前提校正——既有浏览器 spec 改用真正折叠档的宽度

**Files:**
- Modify: `apps/workbench/tests/browser/narrowWindowNewConversation.spec.ts`（第 18、127–136 行 + 新增用例）
- Modify: `apps/workbench/tests/browser/titlebarPlacement.spec.ts`（第 62–68 行）
- Modify: `apps/workbench/tests/browser/navigation-active-state.spec.ts`（第 24–41 行）

**Interfaces:**
- Consumes: 既有 `connect()` / `installRoutes()` / `menuButton()` 辅助与全部 testid。
- Produces: 无新 testid。这三个文件的前提（「<64rem 两栏收起、☰ 出现」）在 spec 下不再成立。

- [ ] **Step 1: `narrowWindowNewConversation.spec.ts`**

第 18 行改为折叠档宽度（保留「窄窗/短窗」语义与已验收过的窗口尺寸）：

```ts
/** 折叠档与短窗两档：743×782 / 733×591 已落在 width < 48rem，是外壳真正折叠的窗口。 */
const viewports = [{ width: 743, height: 782 }, { width: 733, height: 591 }];
```

第 125–136 行的首个用例：删掉「`.app-context-rail` 隐藏」与「`context-new-conversation` 隐藏」两条断言（743px 下两栏不再收起），改为断言折叠档确实收起了外壳并保留抽屉路径：

```ts
// 前提事实：折叠档外壳收起，导航只能走 ☰ 抽屉。
await expect(page.locator(".app-navrail")).toBeHidden();
await expect(page.locator(".app-context-rail")).toBeHidden();
await expect(menuButton(page)).toBeVisible();
```

同一文件追加一条「折叠点之上仍是三列」用例：

```ts
test("48rem 以上外壳保留三列，新对话留在栏内", async ({ page }) => {
  await page.setViewportSize({ width: 843, height: 782 });
  await page.goto("/agent");
  await connect(page);
  await expect(page.locator(".app-navrail")).toBeVisible();
  await expect(page.locator(".app-context-rail")).toBeVisible();
  await expect(page.getByTestId("context-new-conversation")).toBeVisible();
  // 外壳没折叠，抽屉入口不该再出现：点开只会重复屏幕上已有的内容。
  await expect(page.getByRole("button", { name: "打开导航" })).toBeHidden();
});
```

- [ ] **Step 2: `titlebarPlacement.spec.ts`**

第 62–68 行「窄屏仍保留导航抽屉入口」：视口改 `{ width: 743, height: 900 }`；并在该文件追加一条 900px 的对照用例：

```ts
test("折叠点之上不出现抽屉入口，导航直接可见", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(collaboration);
  await expect(page.locator(".app-topbar .mobile-menu-button")).toBeHidden();
  await expect(page.locator(".app-navrail")).toBeVisible();
  await expect(page.locator('.desktop-titlebar [data-testid="titlebar-search"]')).toBeVisible();
});
```

- [ ] **Step 3: `navigation-active-state.spec.ts`**

第 24 行的 `843×782` 改 `743×782`（抽屉段）；第 41 行回到 `1280×782` 的段保持不变；并在两段之间插入 900px 段，用常驻 `次级导航` 断言唯一选中项：

```ts
await page.setViewportSize({ width: 900, height: 782 });
await page.goto("/tasks?tab=inbox");
const midSecondary = page.getByRole("navigation", { name: "次级导航" });
await expect(midSecondary.locator('a[href="/inbox"]')).toHaveAttribute("aria-current", "page");
await expect(midSecondary.locator('a[href="/tasks"]')).not.toHaveAttribute("aria-current", "page");
```

- [ ] **Step 4: 跑受影响浏览器 spec**

Run: `pnpm exec playwright test tests/browser/narrowWindowNewConversation.spec.ts tests/browser/titlebarPlacement.spec.ts tests/browser/navigation-active-state.spec.ts tests/browser/workbench.spec.ts`
Expected: 全部 PASS（含 390px 单列档）

- [ ] **Step 5: 提交**

```bash
git add apps/workbench/tests/browser/narrowWindowNewConversation.spec.ts apps/workbench/tests/browser/titlebarPlacement.spec.ts apps/workbench/tests/browser/navigation-active-state.spec.ts
git commit -m "test(workbench): retarget narrow-window shell specs to the 48rem fold"
```

---

### Task 4: 全量回归与文档同步

**Files:**
- Modify: `docs/frontend/design-system.md`（§6 断点收敛语义；窗口尺寸段）
- Modify: `docs/frontend/workbench-design.md`（§2 信息架构的外壳栏位与收纳）
- Modify: `CODEX_NEXT_STEP.md`（一行范围、验证结果与限制）
- Verify unchanged: `docs/frontend/design-tokens.json`（必须 diff 为空）

- [ ] **Step 1: 全量 vitest**

Run: `pnpm exec vitest run`
Expected: 与改动前同基线（当前基线：922 项中 1 项已知失败——`collaborationWorkspace.spec.ts` 执行摘要文案与 `ExecutionTrajectorySummary.tsx:117` 不一致，属在途改动，**不得**在本计划里顺手修）。

- [ ] **Step 2: 浏览器全套**

Run: `pnpm exec playwright test`
Expected: PASS。若出现与外壳档位无关的既有 flake，如实记录并单跑复验，不删除失败检查。

- [ ] **Step 3: 类型与构建**

Run: `pnpm run typecheck` → 预期仍有 1 处既有报错 `tests/assistBinding.spec.ts(238,49) TS6133`（他人未跟踪文件），本计划不修。
Run: `pnpm run build` → exit 0。

- [ ] **Step 4: 文档同步**

- `design-system.md` §6「断点收敛」：补外壳折叠点为 `width < 48rem`，64rem 档回归「大屏增强」语义（拖拽手柄、附加装饰）。
- `design-system.md` 窗口尺寸段：把「窄窗档由 ☰ 抽屉承担」的区间从 `< 64rem` 更正为 `< 48rem`，并说明 48rem–64rem 为三列且不吃用户拖拽宽度。
- `workbench-design.md` §2：外壳栏位与收纳规则同步为「三列 → 单列 + 抽屉」，折叠点 48rem。
- `design-tokens.json`：确认 `git diff -- docs/frontend/design-tokens.json` 无本计划引入的改动（本轮之前已有他人改动，勿覆盖）。
- `CODEX_NEXT_STEP.md`：一行记录。

- [ ] **Step 5: 文档检查**

Run（仓库根）: `node scripts/check-docs.mjs`
Expected: exit 0

- [ ] **Step 6: 提交**

```bash
git add docs/frontend/design-system.md docs/frontend/workbench-design.md CODEX_NEXT_STEP.md
git commit -m "docs: document the 48rem shell fold"
```

---

## 剩余限制（写进验收记录，不声称已验证）

- **真实 Windows 窗口**：150% DPI 下拖动窗口跨越 1024px 时两栏与抽屉入口的切换，需实机取证；本次只有真实 Chromium 的 700/767/768/843/900/1023/1024/1280px 证据。
- **抽屉重复读取**：48rem 以上外壳不折叠，抽屉不再出现，因此重复读取只发生在 `< 48rem`（此时两栏 CSS 隐藏但仍挂载）——与改动前一致，未新增代价。
- `.brand` 死代码清理只限本计划触及的那两条窄窗规则与基态规则；若他人正在改 `AppShell.tsx`，只删 CSS、不动 TSX。

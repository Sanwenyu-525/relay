# 协作页 UI 优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按已批准 spec 重塑 `/agent` 工作区级会话页：模式切换 chips 化、文件夹作用域细条化、「查找更多任务」迁入左栏就地展开、左栏补会话区与欢迎引导内嵌。

**Architecture:** 只改前端工作台（apps/workbench）。输入卡一体化与工具行位置已在当前源码成立，本计划将其固化为回归测试，重点做模式 chips 化、助手面板浮层、主区重排与左栏增强。全部视觉取值引用现有 token，预计零新增。

**Tech Stack:** React 19 + react-router 7 + TypeScript 5.9 + Vite 8；vitest 5（jsdom）+ Playwright 1.63（chromium）。

**Spec:** docs/superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md

## Global Constraints

- 工作目录中存在大量未提交的本机整改改动（apps/api、docs 等）：**只 `git add` 本计划任务点名的文件**，不得 `git add -A`、不得 `git checkout`/`stash` 他人改动。
- 不新增色值/字号/圆角/间距/动效 token；视觉一律引用现有 token 变量（`--relay-*`）。
- 不改变任何业务规则、命令、状态机、权限、草稿保护与既有空态三分文案；被移动的入口保持原 testid 与可访问名称。
- 保留 radio 语义（模式切换）、`aria-expanded`（就地展开）、焦点返回与 Esc 行为。
- 全部命令在 `apps/workbench` 目录执行；测试命令：`pnpm exec vitest run tests/<file>.spec.ts`；浏览器：`pnpm exec playwright test tests/browser/<file>.spec.ts`；类型：`pnpm run typecheck`；构建：`pnpm run build`；文档检查在仓库根：`node scripts/check-docs.mjs`。
- commit message 用英文；每个任务一次提交，只含该任务文件。

## Review Focus

- 模式切换改为 chips 后，`conversation-mode` 的 radio 数量与键盘方向键行为不能变；既有的 `assist-conversation-mode-agent/assistant` testid 必须保留。
- 助手面板移入浮层后，AGENT 档下不得残留任何助手控件（旧断言 `assist-assistant-picker` 不存在必须仍成立）。
- 文件夹细条三态（未选择 / 已归属 / NOT_READY）与 `collab-binding` 各状态不得回归；`folder-error`、`collab-unassigned-execution-hint` 保留。
- 「查找更多任务」从主区迁到左栏后，新旧两处不得同时存在入口；`newConversationEntry.spec.ts` 的初始关闭断言要改写为新位置。
- 窄窗（< 48rem）与短窗：chips 换行不溢出、发送键不掉出卡外、抽屉内左栏可用。

---

### Task 1: 会话模式 chips 化与助手面板浮层

**Files:**
- Modify: `apps/workbench/src/components/ConversationModeSwitch.tsx`（模式 chips + 助手浮层）
- Modify: `apps/workbench/src/views/AssistView.css`（`.agent-chat-mode*` 样式；新增 `.agent-chat-assistant-popover`）
- Create: `apps/workbench/tests/conversationModeChips.spec.ts`
- Modify: `apps/workbench/tests/assistantModeSwitch.spec.ts`（助手面板断言前先开浮层）
- Modify: `apps/workbench/tests/browser/uiOption2FirstSession.spec.ts`（第 277–278 行先点开浮层）
- Create: `apps/workbench/tests/browser/composerCardLayout.spec.ts`

**Interfaces:**
- Consumes: 既有 props 不变（`ConversationModeSwitch` 的 12 个 props）；`.agent-chat-composer` / `.agent-chat-composer-tools` / `.agent-chat-send` 既有结构。
- Produces: 新 testid `assist-assistant-popover-toggle`、`assist-assistant-popover`；新 class `.agent-chat-mode-chip`（label）、`.agent-chat-assistant-popover`。既有 testid `assist-conversation-mode-agent`/`assist-conversation-mode-assistant`（radio input）、`conversation-mode`、`conversation-mode-locked`、`assist-assistant-picker`、`assist-remember-toggle`、`assist-readonly-note`、`assist-assistant-create-toggle`、`assist-assistant-save`、`assist-assistant-error`、`assist-assistant-list-loading/error/empty/reload` 全部保留。

- [ ] **Step 1: 写失败测试 `tests/conversationModeChips.spec.ts`**

复用 `tests/assistantModeSwitch.spec.ts` 的挂载与 fixture 模式（`mountWorkbench("/agent")` + relay fixture）。断言：

```ts
// 1) chips 仍是 radio 语义：数量、name、checked 与 testid 不变
const radios = view.wrapper.get('[data-testid="conversation-mode"]').findAll('input[type="radio"]');
expect(radios).toHaveLength(2);
expect(view.wrapper.get('[data-testid="assist-conversation-mode-agent"]').attributes("checked")).toBe("");

// 2) 选中 chip 带 data-state="on"（样式挂点），未选中为 "off"
expect(view.wrapper.get('.agent-chat-mode-chip[data-mode="AGENT"]').attributes("data-state")).toBe("on");
expect(view.wrapper.get('.agent-chat-mode-chip[data-mode="ASSISTANT"]').attributes("data-state")).toBe("off");

// 3) AGENT 档：助手控件不在工具行（旧断言保持成立）
expect(view.wrapper.find('[data-testid="assist-assistant-picker"]').exists()).toBe(false);

// 4) 切到 ASSISTANT：chip 显示当前助手与展开钮；点开前浮层不存在
await view.wrapper.get('[data-testid="assist-conversation-mode-assistant"]').setValue(true);
await flush();
expect(view.wrapper.find('[data-testid="assist-assistant-popover"]').exists()).toBe(false);

// 5) 点开浮层：picker / 只读说明 / 新建表单都在浮层内
await view.wrapper.get('[data-testid="assist-assistant-popover-toggle"]').trigger("click");
await flush();
const pop = view.wrapper.get('[data-testid="assist-assistant-popover"]');
expect(pop.find('[data-testid="assist-assistant-picker"]').exists()).toBe(true);
expect(pop.find('[data-testid="assist-readonly-note"]').text()).toContain("只读");
expect(pop.find('[data-testid="assist-assistant-create-toggle"]').exists()).toBe(true);

// 6) Esc 关闭浮层且焦点回到展开钮
pressEscape(); await flush();
expect(view.wrapper.find('[data-testid="assist-assistant-popover"]').exists()).toBe(false);

// 7) 在途锁定：fieldset disabled 与 lockedReason 原位保留
```

（`pressEscape`/`flush`/`mountWorkbench` 已存在于 `tests/mountApp.tsx`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/conversationModeChips.spec.ts`
Expected: FAIL（`assist-assistant-popover-toggle` 选择器找不到 / chips data-state 缺失）

- [ ] **Step 3: 实现 `ConversationModeSwitch.tsx`**

- fieldset 内两个 `<label className="agent-chat-mode-option">` 改为 `<label className="agent-chat-mode-chip" data-mode={mode} data-state={checked ? "on" : "off"}>`，内部 radio input 与 `<span>` 原样保留（testid、name、checked、onChange 不动）。
- `mode === "ASSISTANT"` 时：chip 文本改为「人设助手」＋当前 profile 名（`profiles.find(p => p.id === assistantProfileId)?.optionLabel`，取不到时省略）；chip 右侧加展开钮 `<button data-testid="assist-assistant-popover-toggle" aria-expanded={assistantOpen} onClick={...}>`（`ChevronDown` 图标）。
- 原 `mode === "ASSISTANT"` 的整个 `<div className="agent-chat-assistant">`（select、loading/error/empty、remember checkbox、只读说明、新建 details）移入条件渲染的 `<div className="agent-chat-assistant-popover" data-testid="assist-assistant-popover">`，由 `assistantOpen` 控制；打开时焦点移入浮层第一个控件，Esc 关闭并把焦点还给展开钮（复用 `AppDialog` 的焦点管理或本地 keydown 处理——与 `AppDialog` 一致即可，不新建模式）。
- `lockedReason` 的 `<p className="disabled-reason" data-testid="conversation-mode-locked">` 位置不变。

- [ ] **Step 4: 实现 `AssistView.css`**

- `.agent-chat-mode-option { min-height: var(--relay-control-height) }`（40px，违反 radius.composer 契约的既有缺陷）替换为 `.agent-chat-mode-chip { min-height: var(--relay-control-height-compact); border-radius: var(--relay-radius-round); border: var(--relay-border-width) solid var(--relay-color-border-control); padding-inline: var(--relay-space-3); }`。
- 选中态：`.agent-chat-mode-chip[data-state="on"] { background: var(--relay-color-selection-bg); color: var(--relay-color-selection-text); border-color: var(--relay-color-action-primary); }`；hover 用 `--relay-color-selection-hover`；焦点环沿用全局 focus token。
- 新增 `.agent-chat-assistant-popover { position: absolute; z-index: var(--relay-zIndex-popover); background: var(--relay-color-bg-surface); border: var(--relay-border-width) solid var(--relay-color-border-control); border-radius: var(--relay-radius-panel); box-shadow: var(--relay-shadow-floating); padding: var(--relay-space-4); }`（浮层才允许阴影）；`.agent-chat-mode { position: relative; }` 作为定位上下文。

- [ ] **Step 5: 组件测试转绿**

Run: `pnpm exec vitest run tests/conversationModeChips.spec.ts`
Expected: PASS

- [ ] **Step 6: 更新 `assistantModeSwitch.spec.ts` 与浏览器规格**

- `assistantModeSwitch.spec.ts`：所有触达 `assist-assistant-picker`、`assist-remember-toggle`、`assist-readonly-note`、`assist-assistant-create-toggle` 的用例，在切换到 ASSISTANT 后、断言前插入 `await view.wrapper.get('[data-testid="assist-assistant-popover-toggle"]').trigger("click"); await flush();`。radio/checked/锁定断言不动。
- `tests/browser/uiOption2FirstSession.spec.ts` 第 277–278 行前插入 `await page.getByTestId("assist-assistant-popover-toggle").click();`。
- 新建 `tests/browser/composerCardLayout.spec.ts`（fixture 复用同目录既有 spec 的挂站方式）：
  - `.agent-chat-composer` 的 boundingBox 包含 `.agent-chat-composer-tools` 与 `.agent-chat-send`；
  - `.agent-chat-mode-chip` 高度 == `.agent-chat-send` 高度（2rem 契约，允许 1px 误差）；
  - 视口 700×800 时 chips 换行且 `document.scrollingElement.scrollWidth <= innerWidth`。

- [ ] **Step 7: 跑受影响测试与类型检查**

Run: `pnpm exec vitest run tests/assistantModeSwitch.spec.ts tests/conversationModeChips.spec.ts tests/assist-flow.spec.ts tests/assistBinding.spec.ts tests/assist-preview.spec.ts tests/collaborationWorkspace.spec.ts`
Expected: 全 PASS

Run: `pnpm run typecheck`
Expected: exit 0

- [ ] **Step 8: 提交**

```bash
git add apps/workbench/src/components/ConversationModeSwitch.tsx apps/workbench/src/views/AssistView.css apps/workbench/tests/conversationModeChips.spec.ts apps/workbench/tests/assistantModeSwitch.spec.ts apps/workbench/tests/browser/uiOption2FirstSession.spec.ts apps/workbench/tests/browser/composerCardLayout.spec.ts
git commit -m "feat(workbench): render conversation mode as compact chips with assistant popover"
```

---

### Task 2: 文件夹作用域常驻细条

**Files:**
- Modify: `apps/workbench/src/views/CollaborationView.tsx`（约 608–634 行 `folder-scope-bar` details → 细条 + 浮层）
- Modify: `apps/workbench/src/views/CollaborationView.css`（`.folder-scope-bar` → `.folder-scope-strip` / `.folder-scope-popover`）
- Create: `apps/workbench/tests/folderScopeStrip.spec.ts`
- Modify: `apps/workbench/tests/collaborationWorkspace.spec.ts`（约 1218 行 `folder-scope-bar` 断言）
- Modify: `apps/workbench/tests/browser/narrowWindowNewConversation.spec.ts`（约 106/110/249/257/316/329 行）
- Modify: `apps/workbench/tests/browser/real-api.spec.ts`（约 146 行）
- Modify: `apps/workbench/tests/browser/uiOption2FirstSession.spec.ts`（约 655 行选择器）

**Interfaces:**
- Consumes: `FolderScope` 组件（props 不变）、`collab-binding` 既有渲染、`folder`/`binding` 状态。
- Produces: 新 testid `folder-scope-strip`、`folder-scope-change`、`folder-scope-popover`；保留 `folder-error`、`folder-scope-not-ready`、`folder-scope-project`、`collab-unassigned-execution-hint`、`collab-binding`（含 `collab-binding-receipt`）。细条 `data-state`：`none | ready | not-ready`。

- [ ] **Step 1: 写失败测试 `tests/folderScopeStrip.spec.ts`**

（fixture 复用 `collaborationWorkspace.spec.ts` 的工作区级挂载：无 folder 时进 `/agent`。）

```ts
// 1) 细条常驻：不再有 details/summary 结构
expect(view.wrapper.find('[data-testid="folder-scope-bar"]').exists()).toBe(false);
const strip = view.wrapper.get('[data-testid="folder-scope-strip"]');
expect(strip.text()).toContain("未选择目录");
expect(strip.attributes("data-state")).toBe("none");

// 2) 未归属提示保留
expect(view.wrapper.get('[data-testid="collab-unassigned-execution-hint"]').text())
  .toContain("先选目录并把它归入项目");

// 3) 点「更换目录」开浮层，内含 FolderScope 原生入口
await view.wrapper.get('[data-testid="folder-scope-change"]').trigger("click");
await flush();
expect(view.wrapper.get('[data-testid="folder-scope-popover"]').find("button").length).toBeGreaterThan(0);

// 4) Esc 关闭、焦点返回触发钮
pressEscape(); await flush();
expect(view.wrapper.find('[data-testid="folder-scope-popover"]').exists()).toBe(false);

// 5) NOT_READY：细条升告警态，保留 NOT_READY 文案与 data-testid
// （fixture 返回 folder.status = "NOT_READY"）
expect(strip.attributes("data-state")).toBe("not-ready");
expect(strip.find('[data-testid="folder-scope-not-ready"]').text()).toContain("目录尚未就绪");

// 6) 已归属：目录名 + 项目名 + canonicalRoot 可读
// （fixture 返回 folder.association）
expect(strip.text()).toContain(".relay-dev");

// 7) binding 通知仍在细条下方渲染，四态 testid 不变
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/folderScopeStrip.spec.ts`
Expected: FAIL（`folder-scope-strip` 不存在）

- [ ] **Step 3: 实现 `CollaborationView.tsx`**

将 `folder-scope-bar` 的 `<details>` 整体替换为：

```tsx
<div className="folder-scope-strip" data-testid="folder-scope-strip"
  data-state={folder === null ? "none" : folder.status === "NOT_READY" ? "not-ready" : "ready"}>
  <Folder aria-hidden="true" />
  <span className="folder-scope-strip-copy">
    {folder === null
      ? <><strong>未选择目录</strong><span className="helper-text">普通讨论无需目录；对项目文件执行写操作前需先选择</span></>
      : <><strong>{folder.displayName}</strong>
        {folder.association !== null && <span className="helper-text" data-testid="folder-scope-project">已归入项目：{folder.association.projectTitle}</span>}
        {folder.association === null && <span className="helper-text">尚未归入项目</span>}
        <span className="helper-text">{folder.canonicalRoot}</span></>}
  </span>
  <button className="agent-chat-tool" type="button" data-testid="folder-scope-change"
    aria-expanded={folderPopoverOpen} onClick={() => setFolderPopoverOpen((open) => !open)}>更换目录</button>
</div>
{folderPopoverOpen && <div className="folder-scope-popover" data-testid="folder-scope-popover">
  <FolderScope state={folderState} onOpen={requestFolderTransition} onNewConversation={startFolderConversation} />
</div>}
{folder?.status === "NOT_READY" && <p className="disabled-reason" role="status" data-testid="folder-scope-not-ready">目录尚未就绪：{folder.reason ?? "UNKNOWN"}。仍可普通讨论，但不能对项目文件执行写操作。</p>}
{folderError && <p className="action-error" role="alert" data-testid="folder-error">{folderError}</p>}
```

- `FolderScope`、`folderError` 渲染移入浮层/细条下方，其余（`!projectScopeActive` 的 `collab-unassigned-execution-hint` 与 `collab-binding` 区块）保持原有顺序不变。
- `folderPopoverOpen` 用本地 `useState`；打开时焦点进浮层、Esc 关闭并焦点回 `folder-scope-change`（与 Task 1 同款焦点处理，可抽一个共用的 `usePopover` 小钩子放 `src/lib/`，两个任务复用——Task 1 先建，Task 2 import）。
- `lucide-react` 增加 `Folder` 图标导入（已依赖 lucide-react 1.47.0）。

- [ ] **Step 4: 实现 `CollaborationView.css`**

`.folder-scope-bar` 的 details 样式替换为：

```css
.folder-scope-strip { display: flex; align-items: center; gap: var(--relay-space-2); padding: var(--relay-space-2) var(--relay-space-4); background: var(--relay-color-bg-canvas); border-top: var(--relay-border-width) solid var(--relay-color-border-separator); font-size: var(--relay-font-size-meta); }
.folder-scope-strip[data-state="not-ready"] { background: var(--relay-color-status-warning-bg); color: var(--relay-color-status-warning-text); }
.folder-scope-strip-copy { display: flex; flex-direction: column; min-width: 0; }
.folder-scope-strip strong { font-size: var(--relay-font-size-body); font-weight: var(--relay-font-weight-medium); }
.folder-scope-strip button { margin-left: auto; }
.folder-scope-popover { position: absolute; z-index: var(--relay-zIndex-popover); background: var(--relay-color-bg-surface); border: var(--relay-border-width) solid var(--relay-color-border-control); border-radius: var(--relay-radius-panel); box-shadow: var(--relay-shadow-floating); padding: var(--relay-space-4); }
```

（细条所在容器需 `position: relative`；若 `.collab-center` 已是定位上下文则不改。）

- [ ] **Step 5: 组件测试转绿**

Run: `pnpm exec vitest run tests/folderScopeStrip.spec.ts`
Expected: PASS

- [ ] **Step 6: 更新既有引用**

- `collaborationWorkspace.spec.ts`：把 `get('[data-testid="folder-scope-bar"]').text()).toContain("未选择目录")` 改为对 `folder-scope-strip` 断言；其余涉及 folder 展开的用例按新交互（点 `folder-scope-change`）改写。
- `browser/narrowWindowNewConversation.spec.ts`：`folder-scope-bar` 的 summary 点击改为点 `folder-scope-change`；对「选择文件夹（可选）」summary 文本断言改为对细条「未选择目录」断言。
- `browser/real-api.spec.ts:146`：`getByTestId("folder-scope-options").click()` → `getByTestId("folder-scope-change").click()`。
- `browser/uiOption2FirstSession.spec.ts:655`：`.folder-scope-bar, .collab-existing-work` → `.folder-scope-strip`。
- 全局搜索确认无其他 `folder-scope-bar`/`folder-scope-options`/`collab-existing-work` 残留引用。

- [ ] **Step 7: 跑受影响测试**

Run: `pnpm exec vitest run tests/folderScopeStrip.spec.ts tests/collaborationWorkspace.spec.ts tests/folderFirstConversation.spec.ts tests/assistBinding.spec.ts tests/newConversationEntry.spec.ts tests/narrowWindowNewConversation.spec.ts`
Expected: 全 PASS

- [ ] **Step 8: 提交**

```bash
git add apps/workbench/src/views/CollaborationView.tsx apps/workbench/src/views/CollaborationView.css apps/workbench/tests/folderScopeStrip.spec.ts apps/workbench/tests/collaborationWorkspace.spec.ts apps/workbench/tests/browser/narrowWindowNewConversation.spec.ts apps/workbench/tests/browser/real-api.spec.ts apps/workbench/tests/browser/uiOption2FirstSession.spec.ts
git commit -m "refactor(workbench): make folder scope a persistent composer strip"
```

---

### Task 3: 「查找更多任务 / 会话」就地展开（TargetPicker 迁入左栏）

**Files:**
- Modify: `apps/workbench/src/components/RecentWorkRail.tsx`（新增就地展开面板 + 迁入 TargetPicker）
- Modify: `apps/workbench/src/views/CollaborationView.tsx`（删除主区 `collab-existing-work` details 与本地 `TargetPicker`）
- Modify: `apps/workbench/src/views/CollaborationView.css`（删除 `.collab-existing-work` 规则；必要时新增 `.recent-work-finder`）
- Create: `apps/workbench/tests/recentWorkFinder.spec.ts`
- Modify: `apps/workbench/tests/newConversationEntry.spec.ts`（约 80 行初始关闭断言改写）
- Modify: `apps/workbench/tests/recentWorkPagination.spec.ts`（若与新面板共存需补分组计数断言——只加不删）

**Interfaces:**
- Consumes: `TargetPicker` 组件整体从 `CollaborationView.tsx` 原样搬入 `RecentWorkRail.tsx`（props `{ client, onOpen }` 不变）；`onOpen` 改为复用 rail 既有的 `open(taskId)`（导航 `/agent?work=<taskId>`—— CollaborationView 内 `setSideTab("DOCUMENT")` 在全新挂载下本就是默认值，行为等价）。
- Produces: 新 testid `recent-work-find-more`（aria-expanded 按钮）、`recent-work-finder`（就地面板 region）；保留 `collab-pick-target`、`collab-target-picker`、`collab-target-select`、`collab-target-open` 原 testid。

- [ ] **Step 1: 写失败测试 `tests/recentWorkFinder.spec.ts`**

```ts
// 1) 左栏底部有就地展开钮，默认收起
const toggle = view.wrapper.get('[data-testid="recent-work-find-more"]');
expect(toggle.attributes("aria-expanded")).toBe("false");
expect(view.wrapper.find('[data-testid="recent-work-finder"]').exists()).toBe(false);

// 2) 主区不再有旧入口
expect(view.wrapper.find('[data-testid="collab-existing-work"]').exists()).toBe(false);

// 3) 点开：面板在专栏内联出现（同一滚动容器），含任务选择器
await toggle.trigger("click"); await flush();
const finder = view.wrapper.get('[data-testid="recent-work-finder"]');
expect(finder.get('[data-testid="collab-pick-target"]').exists() || finder.get('[data-testid="collab-target-picker"]').exists()).toBe(true);

// 4) 选任务并打开 → 导航到 /agent?work=<taskId>
await finder.get('[data-testid="collab-target-select"]').setValue(taskId);
await finder.get('[data-testid="collab-target-open"]').trigger("click"); await flush();
expect(view.router.currentRoute.get value).toEqual({ path: "/agent", query: { work: taskId } });

// 5) Esc 收起且焦点回到展开钮
pressEscape(); await flush();
expect(view.wrapper.find('[data-testid="recent-work-finder"]').exists()).toBe(false);

// 6) 刷新/失权时旧面板清掉（沿用 rail 既有隔离规则）
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/recentWorkFinder.spec.ts`
Expected: FAIL（`recent-work-find-more` 不存在）

- [ ] **Step 3: 实现 `RecentWorkRail.tsx`**

- 新增本地 state `finderOpen`；在 `.recent-work-scroll` 之后、`recent-work-more` 分页按钮之前渲染：

```tsx
<button className="text-button" type="button" data-testid="recent-work-find-more"
  aria-expanded={finderOpen} onClick={() => setFinderOpen((open) => !open)}>
  <Search aria-hidden="true" />查找更多任务 / 会话
</button>
{finderOpen && <div className="recent-work-finder" data-testid="recent-work-finder" role="region" aria-label="查找更多任务">
  <TargetPicker client={client} onOpen={(next) => { setFinderOpen(false); open(next.taskId); }} />
</div>}
```

- 把 `CollaborationView.tsx` 的 `TargetPicker` 函数整体（含 `describeLiveError` import 与 `useState/useEffect/useRef`）搬入本文件；`Plus` 图标 import 随之迁移。Esc 收起：在 finder 面板根节点挂 `onKeyDown`（捕获 Esc → `setFinderOpen(false)` 且焦点回展开钮；沿用 rail 内既有关键处理风格，不新增全局监听）。
- `onOpen` 后调用既有 `onOpen?.()`（关闭抽屉）保持一致。

- [ ] **Step 4: 实现 `CollaborationView.tsx` 删除**

- 删除 `<details className="collab-existing-work" data-testid="collab-existing-work">…</details>` 整块（约 650–654 行）。
- 删除本文件内的 `TargetPicker` 函数定义（约 738–783 行）及随之不再使用的 import（`Plus`、`describeLiveError`、`Link` 若仍被他处使用则保留——以 typecheck 为准）。
- `CollaborationView.css` 删除 `.collab-existing-work` 相关规则。

- [ ] **Step 5: 测试转绿 + 更新 `newConversationEntry.spec.ts`**

Run: `pnpm exec vitest run tests/recentWorkFinder.spec.ts`
Expected: PASS

- `newConversationEntry.spec.ts:80`：`get('[data-testid="collab-existing-work"]').attributes("open")).toBeUndefined()` 改为：

```ts
expect(view.wrapper.get('[data-testid="recent-work-find-more"]').attributes("aria-expanded")).toBe("false");
```

- [ ] **Step 6: 跑受影响测试与类型检查**

Run: `pnpm exec vitest run tests/recentWorkFinder.spec.ts tests/newConversationEntry.spec.ts tests/recentWorkPagination.spec.ts tests/collaborationWorkspace.spec.ts tests/navigation.spec.ts`
Expected: 全 PASS

Run: `pnpm run typecheck`
Expected: exit 0

- [ ] **Step 7: 提交**

```bash
git add apps/workbench/src/components/RecentWorkRail.tsx apps/workbench/src/views/CollaborationView.tsx apps/workbench/src/views/CollaborationView.css apps/workbench/tests/recentWorkFinder.spec.ts apps/workbench/tests/newConversationEntry.spec.ts apps/workbench/tests/recentWorkPagination.spec.ts
git commit -m "feat(workbench): move continue-task picker into the recent work rail"
```

---

### Task 4: 左栏「未归入任务的会话」区与 `?session=` 参数

**Files:**
- Modify: `apps/workbench/src/components/RecentWorkRail.tsx`（追加会话区）
- Modify: `apps/workbench/src/views/CollaborationView.tsx`（`sessionId` 初值支持 `?session=`）
- Create: `apps/workbench/tests/recentWorkSessions.spec.ts`
- Modify: `apps/workbench/tests/collaborationWorkspace.spec.ts`（若既有用例覆盖 sessionId 初值，补一条 `?session=` 不断言的用例即可——只加不删）

**Interfaces:**
- Consumes: `client.getAssistSessions()`（无 target = 工作区级；`RelayAssistSession` 含 `id/title/taskId/projectId/updatedAt`）。
- Produces: 新 testid `recent-work-sessions`（分组容器）、`recent-work-session-<id>`（行按钮）；CollaborationView 从 `search.get("session")` 取初始 `sessionId`（`undefined` 语义不变）。

- [ ] **Step 1: 写失败测试 `tests/recentWorkSessions.spec.ts`**

```ts
// 1) fixture：getAssistSessions 返回一条 taskId=null 的会话「你好」与会话 B（taskId=taskId）
// 2) 左栏出现「未归入任务的会话」分组，只列 taskId=null 的会话
const group = view.wrapper.get('[data-testid="recent-work-sessions"]');
expect(group.text()).toContain("你好");
expect(group.findAll('[data-testid^="recent-work-session-"]')).toHaveLength(1);

// 3) 点会话行 → /agent?session=<id>
await view.wrapper.get(`[data-testid="recent-work-session-${sessionId}"]`).trigger("click"); await flush();
expect(view.router.currentRoute.get value).toEqual({ path: "/agent", query: { session: sessionId } });

// 4) CollaborationView 读取 ?session=：挂载 /agent?session=<id> 后首条草稿/消息绑定该会话
//    （断言 AssistView 以该 sessionId 为 preferredSessionId：消息列表请求 URL 含该 id）
expect(calls).toContain(`/assist-sessions/${sessionId}/messages`);

// 5) 全部会话都有 taskId 时不渲染该分组（无空分组占位）
// 6) 会话读取失败：就地错误文本，不清空任务列表（与 rail 既有隔离规则一致）
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/recentWorkSessions.spec.ts`
Expected: FAIL（`recent-work-sessions` 不存在 / `?session=` 被忽略）

- [ ] **Step 3: 实现 `RecentWorkRail.tsx` 会话区**

- 在 `load` 的 `Promise.all` 中追加 `client.getAssistSessions()`；`Loaded` 增加 `sessions: readonly RelayAssistSession[]`（与 `tasks` 同样的迟到响应隔离：`version !== request.current` 直接 return）。
- 渲染：任务分组之后追加

```tsx
{unassignedSessions.length > 0 && <div className="recent-work-group" data-testid="recent-work-sessions">
  <h3 className="recent-work-group-title">未归入任务的会话</h3>
  <ul className="recent-work-list">{unassignedSessions.map((session) => (
    <li key={session.id}><button type="button" className="recent-work-item"
      data-testid={`recent-work-session-${session.id}`}
      aria-label={`${session.title} · 未归入任务的会话`} title={`${session.title} · 未归入任务的会话`}
      onClick={() => { void navigate(`/agent?session=${encodeURIComponent(session.id)}`); onOpen?.(); }}>
      <span className="recent-work-copy"><span className="recent-work-title">{session.title}</span></span>
    </button></li>))}</ul>
</div>}
```

- `unassignedSessions = sessions.filter((session) => session.taskId === null)`；会话读取失败设 `sessionsError`，在分组位置渲染 `<p className="action-error" role="alert">`（不清 `loaded.tasks`）。
- ** fixture 兼容**：既有用例的 `Routes` 未提供 `/assist-sessions` 时会渲染该错误行。先跑 `recentWorkPagination.spec.ts` 与 `collaborationWorkspace.spec.ts`；若有因新增错误行破列的用例，在对应 fixture 的 Routes 补 `assistSessions: () => response({ items: [] })`（只改测试 fixture，不改产品逻辑）。
- 分组标题样式复用 `recent-work-group summary` 的字号/颜色 token；行沿用 `.recent-work-item`（本任务 Step 5 的密排样式同批生效）。

- [ ] **Step 4: 实现 `CollaborationView.tsx` 的 `?session=`**

- 第 88 行改为：

```tsx
const [sessionId, setSessionId] = useState<string | null | undefined>(
  () => (search.has("new") ? null : (search.get("session") ?? undefined)));
```

- 其余逻辑（`new` 优先、auto 语义）不变；deep-link 与刷新恢复同一会话。

- [ ] **Step 5: 测试转绿**

Run: `pnpm exec vitest run tests/recentWorkSessions.spec.ts`
Expected: PASS

- [ ] **Step 6: 左栏密排与激活行样式（spec §3.1/§4）**

`RecentWorkRail` 相关 CSS（`AppShell.css` 或 `CollaborationView.css` 中 `.recent-work-*` 所在文件——实施时按现有定义位置二选一，不新建第三处）：

```css
.recent-work-item { min-height: var(--relay-control-height-comfort); }        /* 3.5rem → 2.75rem */
.recent-work-item--active { background: var(--relay-color-selection-bg); box-shadow: inset 2px 0 0 var(--relay-color-action-primary); }
.recent-work-item--active .recent-work-title { color: var(--relay-color-selection-text); }
.recent-work-group-title { font-size: var(--relay-font-size-meta); color: var(--relay-color-text-muted); font-weight: var(--relay-font-weight-medium); }
```

新增 vitest 断言（并入 `recentWorkSessions.spec.ts` 或 `recentWorkPagination.spec.ts`，只加不删）：

```ts
// 当前任务行带激活修饰类与 data 挂点（样式由浏览器规格量几何）
expect(view.wrapper.get(`[data-testid="recent-work-${taskId}"]`).classes()).toContain("recent-work-item--active");
```

浏览器规格（新建 `tests/browser/railDensity.spec.ts`）：`.recent-work-item` 实测高度 == 44px（2.75rem，±1px）；激活行存在 2px 左线（`box-shadow` 或对应实现）；窄窗 700px 无横向溢出。

- [ ] **Step 7: 跑受影响测试与类型检查**

Run: `pnpm exec vitest run tests/recentWorkSessions.spec.ts tests/collaborationWorkspace.spec.ts tests/recentWorkPagination.spec.ts tests/assistBinding.spec.ts tests/newConversationEntry.spec.ts`
Expected: 全 PASS

Run: `pnpm exec playwright test tests/browser/railDensity.spec.ts`
Expected: PASS

Run: `pnpm run typecheck`
Expected: exit 0

- [ ] **Step 8: 提交**

```bash
git add apps/workbench/src/components/RecentWorkRail.tsx apps/workbench/src/views/CollaborationView.tsx apps/workbench/tests/recentWorkSessions.spec.ts apps/workbench/tests/recentWorkPagination.spec.ts apps/workbench/tests/collaborationWorkspace.spec.ts apps/workbench/tests/browser/railDensity.spec.ts
git commit -m "feat(workbench): list unassigned sessions in the rail with session deep link"
```

---

### Task 5: 欢迎卡引导内嵌与新对话入口可见化

**Files:**
- Modify: `apps/workbench/src/views/AssistView.tsx`（`firstMessage` 欢迎卡补编号引导，约 735–737 行）
- Modify: `apps/workbench/src/components/AppShell.tsx`（`context-rail-new` 由纯图标改为带文字 chip，约 168–169 行）
- Modify: `apps/workbench/src/components/AppShell.css`（`.context-rail-new` chip 样式）
- Create: `apps/workbench/tests/welcomeGuidance.spec.ts`
- Modify: `apps/workbench/tests/browser/projects-summary-layout.spec.ts` 或对应含栏头断言的浏览器规格（若断言了 `context-new-conversation` 为 icon-button 几何——实施时按 grep 结果只改必需的）

**Interfaces:**
- Consumes: `agent-chat-start` / `agent-assist-session-welcome` 既有结构；`newConversationHref` 既有变量。
- Produces: 欢迎卡新增 `.agent-chat-welcome-steps`（有序列表）；`context-rail-new` 增加可见文字「新对话」（保留 `data-testid`、`aria-label`、`title`、`to`）。

- [ ] **Step 1: 写失败测试 `tests/welcomeGuidance.spec.ts`**

```ts
// 1) 空态欢迎卡含编号引导（选择/上传资料、直接粘贴、确认读取范围）
const welcome = view.wrapper.get('[data-testid="assist-first-message"]');
expect(welcome.text()).toContain("接下来可以这样做");
expect(welcome.text()).toContain("选择或上传资料");
expect(welcome.text()).toContain("直接粘贴内容");
expect(welcome.text()).toContain("先确认读取范围");

// 2) 标题层级：h1「这次想聊些什么？」仍存在且只有一个 h1
expect(welcome.find("h1").text()).toBe("这次想聊些什么？");

// 3) 引导是 ol/li 结构（有序步骤语义）
expect(welcome.findAll(".agent-chat-welcome-steps li")).toHaveLength(2);

// 4) 栏头新对话入口：可见文字 + 原 href
const newLink = view.wrapper.get('[data-testid="context-new-conversation"]');
expect(newLink.text()).toContain("新对话");
expect(newLink.attributes("href")).toMatch(/^\/agent\?new=/);

// 5) 有会话后（发送首条）欢迎卡消失、消息流出现（既有规则不回归）
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/welcomeGuidance.spec.ts`
Expected: FAIL（引导文案不存在）

- [ ] **Step 3: 实现 `AssistView.tsx` 欢迎卡**

在 `agent-assist-session-welcome` 的 `<p className="helper-text">` 之后追加：

```tsx
<div className="agent-chat-welcome-steps">
  <p className="agent-chat-welcome-steps-title">接下来可以这样做：</p>
  <ol>
    <li>选择或上传资料——输入区点「资料」添加文档、代码或日志</li>
    <li>直接粘贴内容——内容较少时直接粘到对话里</li>
  </ol>
  <p className="helper-text">添加资料后，我会先确认读取范围，再继续分析。</p>
</div>
```

样式（AssistView.css）：`.agent-chat-welcome-steps { background: var(--relay-color-bg-subtle); border: var(--relay-border-width) solid var(--relay-color-border-separator); border-radius: var(--relay-radius-control); padding: var(--relay-space-4); }`，`ol` 用 `font-size: var(--relay-font-size-body)`，标题 medium。

- [ ] **Step 4: 实现 `AppShell.tsx` 栏头入口**

- `context-rail-new` 的 `<SquarePen>` 后增加 `<span className="context-rail-new-label">新对话</span>`；`aria-label`/`title`/`data-testid`/`to` 不变。
- `AppShell.css`：`.context-rail-new { ... }` 增加 `gap: var(--relay-space-2)`、`padding-inline: var(--relay-space-3)`、`border-radius: var(--relay-radius-round)`、`border: var(--relay-border-width) solid var(--relay-color-border-control)`、高度 `var(--relay-control-height-compact)`；`.context-rail-new-label { font-size: var(--relay-font-size-meta); }`。窄屏该栏整体隐藏（既有规则），不受影响。

- [ ] **Step 5: 测试转绿 + 类型检查**

Run: `pnpm exec vitest run tests/welcomeGuidance.spec.ts`
Expected: PASS

Run: `pnpm run typecheck`
Expected: exit 0

- [ ] **Step 6: 跑受影响测试**

Run: `pnpm exec vitest run tests/welcomeGuidance.spec.ts tests/assistantModeSwitch.spec.ts tests/assist-flow.spec.ts tests/assistBinding.spec.ts tests/newConversationEntry.spec.ts tests/navigation.spec.ts tests/desktop-titlebar.spec.ts`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```bash
git add apps/workbench/src/views/AssistView.tsx apps/workbench/src/components/AppShell.tsx apps/workbench/src/components/AppShell.css apps/workbench/tests/welcomeGuidance.spec.ts
git commit -m "feat(workbench): embed numbered guidance in the welcome card and label the rail new-conversation entry"
```

---

### Task 6: 全量验证与文档同步

**Files:**
- Modify: `docs/frontend/workbench-design.md`（新增「协作页结构重塑（2026-10-10）」小节）
- Modify: `docs/frontend/design-system.md`（组件规则补 chips/细条/欢迎卡）
- Modify: `docs/superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md`（§3.1 修正：会话区只列 `taskId=null`，并记录 `?session=` 深链）
- Modify: `CODEX_NEXT_STEP.md`（追加一行：范围、验证结果、剩余限制）
- Modify: `docs/testing/overall-acceptance-2026-09-28.md`（本轮行）

- [ ] **Step 1: 类型与全量组件测试**

Run: `pnpm run typecheck` → exit 0
Run: `pnpm exec vitest run` → 全 PASS（基线 858/858，不得下降；新增约 5 个文件）

- [ ] **Step 2: 生产构建**

Run: `pnpm run build` → exit 0

- [ ] **Step 3: 浏览器全量（非真实 API）**

Run: `pnpm exec playwright test` → 全 PASS（含 Task 1 新建的 `composerCardLayout.spec.ts` 与被改的三个规格）

- [ ] **Step 4: 文档检查**

Run（仓库根）: `node scripts/check-docs.mjs` → exit 0

- [ ] **Step 5: 文档同步**

- `workbench-design.md`：新增小节记录——细条契约（`folder-scope-strip` 三态与 `data-state`）、TargetPicker 迁入左栏（`recent-work-find-more`/`recent-work-finder`）、会话区与 `?session=` 深链、输入卡一体化与模式 chips；明确「业务规则与状态绑定不变，仅呈现位置与密度变化」。
- `design-system.md`：在「可复用组件规则」表补三行——`.agent-chat-mode-chip`（radius.round + control.height.compact + selection 态）、`.folder-scope-strip`（canvas 底 + separator 上缘 + warning 升态）、`.agent-chat-welcome-steps`（bg.subtle + separator + radius.control）。不复制数值，只引用 token 名。
- spec §3.1：把「会话与任务同列呈现」修正为「仅 `taskId === null` 的会话成组，任务仍为主列表」，并补 `?session=` 深链一句。
- `CODEX_NEXT_STEP.md` 与验收表：按仓库惯例只写一行概要（范围 + 实际命令结果 + 未做项：真实 Windows、IME/DPI、真实 Provider），不追加逐轮输出。

- [ ] **Step 6: 提交文档**

```bash
git add docs/frontend/workbench-design.md docs/frontend/design-system.md docs/superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md CODEX_NEXT_STEP.md docs/testing/overall-acceptance-2026-09-28.md
git commit -m "docs: record collaboration page restructure and verification results"
```

- [ ] **Step 7: 剩余限制（不在本计划内）**

真实 Windows/WebView2 双状态目视复核、中文 IME 组词不误发、100%/150% DPI 下输入卡不破版、真实 Provider——按验收表惯例保持未验收，不据此判失败也不提升出口。

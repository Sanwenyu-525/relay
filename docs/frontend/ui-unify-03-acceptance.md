# UI-UNIFY-03 验收报告（Relay Workbench）

> 状态：**部分通过**。核心缺陷、生产接入、守卫、视觉与 targeted 回归已实际执行；全量测试、CI 远程运行、Windows 实机矩阵尚未闭合，不能标记为发布级最终通过。
>
> 验收日期：2026-11-15（Asia/Shanghai）
> 仓库：`D:\Develop\Relay-Agent`，分支 `main`，当前 HEAD `e0eb0c8c`
> 工作区：本轮改动与另一并行任务的未提交改动共存；本轮未执行 `git reset --hard`、未执行 `git clean`、未回退并行文件。

## 1. 范围与工作区保护

### 1.1 本轮范围

- 修复 `Combobox` 的中文 IME、禁用项、受控值、筛选后索引等缺陷。
- 修复 `Tabs` 的导航激活契约、禁用导航项、选择形态键盘行为。
- 统一 `Dialog / Popover / Tooltip / Combobox / ContextMenu / DropdownMenu` 的浮层层级、Escape、焦点恢复语义。
- 把已存在的共享复合组件接入真实生产页面，并逐项记录未迁移原因。
- 将 UI 规范守卫的原生控件检查改为 TypeScript AST，并给守卫本身加会失败的测试。
- 实际运行 typecheck / build / Vitest / Playwright / 视觉回归 / UI 规范检查。
- 修复 `collaborationWorkspace.spec.ts` 的既有失败。
- 建立可执行的本地与 GitHub Actions UI 质量门禁。
- 复核 Token、px 字号与密度；输出 Windows/Tauri/WebView2 人工验收矩阵。

### 1.2 明确不做

- 不整体替换为 Radix UI；先复用现有自研浮层机制。
- 不强制迁移可编辑表格、虚拟滚动、拖拽排序、复杂搜索等特殊控件。
- 不删除、不跳过、不弱化任何既有测试来换取通过。
- 不统一格式化整个仓库。
- 不修改并行任务的 API memory/information/model、`MemoryView`、Assist 上下文预算等文件。
- 不把 Playground、测试或未执行代码计入生产使用率。

### 1.3 基线统计（实测）

| 指标 | 数值 | 说明 |
|---|---:|---|
| 当前 HEAD | `e0eb0c8c` | `main`；工作区另有大量并行未提交改动 |
| 生产 TSX 文件 | 167 | `apps/workbench/src` 内非测试 TSX |
| 直接导入 `src/ui` 的生产文件 | 117 | 以 import 语句为准 |
| 全部 TSX 文件 | 187 | 含测试、开发工具 |
| 视图层原生控件 | 241 | AST 识别 `views/**/*.tsx` 的 `button/input/select/textarea` |
| 其中合法 `file/hidden input` 例外 | 4 | 守卫自动放行 |
| 进入存量基线的原生控件 | 237 | 只减不增，不认定为“全部应迁移” |
| 扫描 CSS 文件 | 76 | 守卫统计范围 |
| CSS 裸色值 | 0 | 基线 0 |
| CSS 硬编码 px 字号 | 32 | 30 在本任务范围，2 来自并行未跟踪 `MemoryView.css` |
| 视觉快照 | 29 | 本轮新增 2 张，更新 1 张 |
| 当前全量测试 | 未通过 | 见 §6；默认并发下还出现 worker OOM 崩溃 |

### 1.4 并行工作保护

工作区 `git status` 共 251 项。与本任务并行的改动包括 API `memory/information/model`、`MemoryView.tsx/css`、`AssistView`、上下文预算测试增删、`apps/desktop/src-tauri/src/lib.rs` 等。本轮只编辑 UI-UNIFY-03 相关文件；`collaborationWorkspace.spec.ts` 的夹具与文案断言属于本轮维护范围。并行文件未回退、未格式化、未删除。

## 2. 实际改动

### 2.1 文件清单

| 项目 | 内容 |
|---|---|
| 修改文件 | `apps/workbench/src/ui/Combobox.tsx`、`Tabs.tsx`、`IconButton.tsx`、`Tooltip.tsx`、`ContextMenu.tsx`、`Disclosure.tsx`、`Table.tsx`、`ui.css`；`src/components/AppDialog.tsx`、`WorkbenchActions.tsx`；`src/lib/popoverMenu.ts`；`src/views/TasksView.tsx`、`InboxView.tsx`、`ProjectsView.tsx`、`ProjectsView.css`、`TaskDetailView.tsx`、`TaskDetailView.css`、`ProjectSkillView.tsx`、`ProjectSkillView.css`、`TaskSkillView.tsx`、`ScheduledTaskDetailView.tsx`、`proto/protoPage.css`；`src/styles.css`；`src/App.tsx`；`src/dev/UiLabView.tsx` |
| 新增文件 | `src/lib/overlayStack.ts`；`scripts/lib/ui-conventions-ast.mjs`；`scripts/check-ui-conventions.test.mjs`；`scripts/ci-ui-local.ps1`；`.github/workflows/ui-quality.yml`；`tests/uiComposites.spec.tsx`（本轮扩写）、`tests/uiLayers.spec.tsx`（本轮扩写）、`tests/browser/uiAccessibility.spec.ts`（本轮扩写）；2 张视觉基线；本报告 |
| 文档同步 | `docs/frontend/README.md` 增加本报告入口；本轮未改其他设计规范，避免把验收结果复制成第二套规则 |
| 修复缺陷 | Combobox IME 误选/误关；Combobox 高亮 disabled；Tabs 路由激活错配；Tabs disabled 仍可导航；选择态键盘不完整；嵌套浮层 Escape 连带关闭；Popover 关闭焦点落 body；Dialog 焦点陷阱抢焦点；UI 守卫“只导一个 Button 就过关”；collaboration 夹具/旧断言失败 |
| 新增测试 | `uiComposites.spec.tsx` 23 条；`uiLayers.spec.tsx` 12 条；`uiAccessibility.spec.ts` 13 条；守卫自测 8 条；视觉新增 2 场景；collaboration 原 96 条恢复 |
| 迁移页面 | 任务列表、收件箱、待处理、项目列表、任务详情、项目内 Skill、任务内 Skill、定时任务详情 |
| 迁移组件 | `Tabs`、`Table`、`Tooltip`、`Separator`；复核 `Toast`、`ResizableHandle`、`AppDialog` 既有生产接入 |
| 保留例外 | 9 个复合组件仍仅 Playground：Card、Menu/DropdownMenu、Popover、Combobox、ContextMenu、ScrollArea、Density、Drawer、Snackbar；另有 4 个合法 file/hidden input |

### 2.2 Combobox

- 组合期不消费 Enter/Escape/方向键：同时检查 `event.nativeEvent.isComposing`、`keyCode === 229`、`compositionstart/compositionend` 状态。
- `compositionend` 后设置一次 `justEnded`，用 0ms 定时器只拦截“同一轮紧随”的 Enter；下一次正常 Enter 可选择。
- Escape 只在 `isTopOverlay(layer)` 时关闭列表并 `stopPropagation`，不会顺带关闭外层 Dialog。
- Tab 关闭列表但不 `preventDefault`，不阻断正常表单焦点流。
- 所有选项禁用时无高亮；方向键只在可用项间跳转并循环；Enter 不误选禁用项，全禁用时不触发隐式表单提交。
- 筛选结果变化后，渲染期把 `activeIndex` 回退到首个可用项；选中后关闭时把筛选文本恢复为已选项 label；受控 `value` 变化同步显示。
- `disabled` 切换会强制收起；blur 离开 root 关闭；打开时以当前已选项高亮；高亮项 `scrollIntoView({block:"nearest"})`。
- 保留 `aria-activedescendant`、`aria-expanded`、`aria-controls`。

### 2.3 Tabs

- 导航形态 `value` 可省略，由 `resolveNavigationKey(items, location, explicitValue?)` 判定：
  - 路径精确匹配优先（权重 1000 + 长度）；
  - 子路由前缀匹配次之（权重 100 + 长度）；
  - 带查询参数的项要求每个参数都与当前 URL 一致；
  - 当前 URL 有参数且参数项匹配时，参数项优先于“全部”；
  - 显式 `value` 仍优先。
- 该规则修复了 `/tasks?tab=inbox` 同时点亮“全部 + 收件箱”的错配。
- 禁用导航项渲染为 `span[role="link"][aria-disabled="true"][tabIndex="-1"]`，不挂 `Link`，不响应 Enter；不依赖 `pointer-events:none`。
- `aria-current="page"` 只出现在激活且未禁用的导航项。
- 选择形态按 WAI-ARIA APG Tabs **自动激活**：四向/Home/End/循环、跳过 disabled、roving tabindex、唯一 `aria-selected`；非法 `value` 不伪造选中，但把 `tabIndex=0` 给首个可用项；空 items 安全。
- 新增 `TabItem.id/ariaControls/className`、`variant:"pill"|"page"`；选中时自动追加 `${className}--active`，用于迁移期保留页面原有皮肤。

### 2.4 浮层层级与关闭语义

新增 `src/lib/overlayStack.ts`：

- `registerOverlay(token, kind, close, root?)` 按打开顺序入栈，返回出栈函数；
- `isTopOverlay(token)` 只有栈顶为真；
- `closeSiblingOverlays(token, "popup", root?)` 同组独占；
- 同组独占时若两层 DOM 为祖先/后代关系，保留容器层：Popover 内打开 Combobox 不会关闭 Popover；
- `kind` 为 `dialog | popup | tooltip`。

接入结果：

- `popoverMenu.ts` 每次 commit 读取当前节点，打开注册、关闭卸载，但普通重渲染不重复入栈；保留点外/Esc/独占/焦点回 summary；`useMenuDismiss` 返回层 token；`useMenuExclusive` 保留。
- Tooltip 注册 tooltip 层，Esc 只收栈顶。
- ContextMenu 注册 popup 层，Esc/Tab 语义与焦点恢复。
- AppDialog 注册 dialog 层，Esc 仅在 `isTopOverlay` 时关闭；Tab 焦点陷阱在上层菜单/Popover 存在时让位；卸载时 `popDialog + unregister + 恢复焦点`。
- Popover 关闭时若焦点在面板内，用 rAF 还把焦点交给触发器。

### 2.5 生产接入明细

| 页面/组件 | 迁移结果 |
|---|---|
| `TasksView` 两处范围导航 | `<Tabs label variant="page" className="subnav" items=…>`，不传 `value`，由路由判定；testid 保留 |
| `InboxView` 的 `InboxScopeNav` | 同上，保留 `subnav-item` 类名 |
| `AttentionQueue` 范围导航 | 同上 |
| `ProjectsView` 工具栏 | `Tabs`，因历史 `?archived=1` 保留 `value={scope}`；badge 仍为 `subnav-count` 文本 `(N)` |
| `TaskDetailView` 页签 | `Tabs variant="page" className="skill-tabs" value={tab}`；`onChange` 保留 `setArtifactVisited`；`id=task-detail-tab-*`、`aria-controls=task-detail-content`、testid 保留 |
| `ProjectSkillView` 项目内页面 | `Tabs` 保留 `value={active}`；items 用 `skill-tab` 类名 |
| `TaskSkillView` 任务内页面 | `Tabs` 省略 `value`，路由判定 |
| `ScheduledTaskDetailView` 触发历史 | 原生 `<table class="data-table">` → `Table/TableHead/TableHeaderCell/TableRow/TableCell`，`framed={false}` 保留页面间距；`scheduled-task-occurrence-*` testid 保留 |
| `WorkbenchActions` | 四个 `IconButton` 外包 `Tooltip`，移除原生 `title`；label 为后退/前进/搜索资料·Ctrl+K/新建任务 |
| `ProjectSkillView` rail | `<hr>` → `<Separator>` |

**生产 Tooltip 复核发现**：仅在外层移除 `title` 不够，`IconButton` 自身默认写 `title={label}`，DOM 仍会同时存在原生 title 与自研 Tooltip。已给 `IconButton` 增加 `title?: string | false`，工作台四个图标传 `title={false}`，并加组件测试锁定“默认保留、`false` 时移除、aria-label 始终存在”。该修复由全量测试中残留的 `title="后退"` DOM 触发，不是只改测试。

兼容层：

- `ui.css` 新增 `.ui-tabs--page*`、`.ui-table-wrap--bare*`。
- `protoPage.css` 用 0,3 特异性 `.pv-page .subnav .ui-tabs__item` 复刻旧药丸皮肤，badge 字号 inherit、opacity .75。
- `ProjectsView.css` / `ProjectSkillView.css` / `styles.css` 分别补工具栏、38px 项目页签、reading 字号等迁移期皮肤。
- `TaskDetailView.css` 末尾用 0,4 组合选择器把页签字号压回 caption，修复 TaskDetail 高度 1281→1271 的视觉回归。

## 3. 组件真实使用情况

> “生产”只算 `apps/workbench/src` 的非测试、非 `__dev` 调用；Playground 和测试不计入。

| 组件 | Playground | 生产页面（真实调用位置） | 测试覆盖 | 结论 |
|---|---|---|---|---|
| Button | 有 | 117 个生产 TSX 直接导入 `src/ui`，任务/项目/设置/详情等广泛使用 | typecheck、build、视觉页面基线 | 已接入 |
| IconButton | 有 | `WorkbenchActions`、`AppDialog`、`AppShell`、会话行菜单等 | 视觉 Tooltip 基线、浏览器键盘测试 | 已接入 |
| Combobox | 有 | 无生产调用 | `uiComposites` 23 条中 9 条；`uiAccessibility` 嵌套与 CDP IME | 仅 Playground，待接入；无可搜索选择器业务场景 |
| Tabs | 有 | `TasksView`、`InboxView`、`AttentionQueue`、`ProjectsView`、`TaskDetailView`、`ProjectSkillView`、`TaskSkillView` | `uiComposites` 路由/禁用/键盘；页面视觉 | 已接入 |
| Table | 有 | `ScheduledTaskDetailView` 触发历史 | `uiLayers` 间接、视觉 Playground；生产表格暂无独立像素基线 | 已接入（覆盖有限） |
| Card | 有 | 无生产调用 | 视觉 Playground | 仅 Playground；业务信息容器暂保留现有卡片 |
| Menu / DropdownMenu | 有 | 无生产调用；业务“更多操作”仍用现有 details/自定义菜单 | 浏览器 DropdownMenu 键盘；视觉 Playground | 仅 Playground；迁移风险见 §4 |
| Popover | 有 | 无生产调用 | `uiLayers` 嵌套 12 条；`uiAccessibility` Dialog+Popover | 仅 Playground |
| Tooltip | 有 | `WorkbenchActions` 4 个图标按钮 | `uiAccessibility` Tooltip；生产 Tooltip 视觉基线 | 已接入 |
| Dialog | 有 | `AppDialog` 在 `App.tsx`、`AppShell.tsx`、`CollaborationView`、`KnowledgeView`、`CommandPalette` 等生产使用；`MemoryView` 使用 `Dialog` | `uiLayers` 4 条、`uiAccessibility` 多层 Dialog、视觉 Dialog | 已接入（`Dialog` 与 `AppDialog` 为同一实现） |
| Drawer | 有 | 独立 `Drawer` 组件无生产调用；生产改用 `AppDialog variant="drawer"`（`AppShell`、`ResponsiveRail`、`ProjectsView`） | 视觉 Drawer | 仅 Playground（别名）；生产形态已覆盖 |
| Toast | 有 | `AssistView`、`MessageCodeBlock`、`RecentWorkRail`、`SessionRowMenu` | 视觉 Toast；组件行为由既有测试覆盖 | 已接入 |
| ResizableHandle | 有 | `SidebarResizeHandle`、`InspectorResizeHandle` | 现有布局测试；视觉页面基线 | 已接入 |
| ContextMenu | 有 | 无生产调用 | `uiLayers` 禁用/焦点；`uiAccessibility` ContextMenu | 仅 Playground |
| ScrollArea | 有 | 无生产调用 | 视觉 Playground | 仅 Playground |
| Density | 有 | 无生产调用 | 视觉 Playground | 仅 Playground |
| Separator | 有 | `ProjectSkillView` rail | 视觉项目详情 | 已接入（最小用法） |

仅 Playground 的 9 个：Card、Menu/DropdownMenu、Popover、Combobox、ContextMenu、ScrollArea、Density、Drawer、Snackbar。没有为了统计好看而强制迁移。

## 4. 重复实现与未迁移理由

扫描业务页面后，重复实现主要集中在：

1. 任务/项目列表的“更多操作”菜单：现有 `<details>` + `useDetailsMenu` 已满足点外关闭、Esc、焦点恢复、独占；`Menu` 组件缺少这些业务菜单所需的 summary/触发器模型，直接替换会改变 DOM 与键盘契约。
2. 模型选择器与会话行菜单：输入/筛选/异步保存与浮层关闭耦合，属于特殊受控组件；本轮只统一层级 token，不强制换组件。
3. `Card`：页面使用带业务语义的 `summary-card`、`receipt` 等容器，替换会破坏信息层级与像素基线。
4. `ScrollArea`、`Density`：目前没有“必须由共享组件提供”的交互差异；保留 Playground，避免为覆盖率制造调用方。
5. `Combobox`：业务侧可搜索场景都有远程搜索/多选/创建新项语义，共享组件尚不支持，未强行接入。

## 5. 缺陷关闭表

| 问题 | 状态 | 证据/限制 |
|---|---|---|
| Combobox 中文 IME 组合期 Enter 误选 | 已修复并验证（自动化） | `uiComposites` 组合期 Enter；`uiAccessibility` 真实 Chromium CDP `Input.imeSetComposition` |
| 组合期 Escape 误关列表/外层 Dialog | 已修复并验证（自动化） | 同上；`uiAccessibility` Dialog+Popover+Combobox 三次 Esc 逐层 |
| 组合期方向键改高亮 | 已修复并验证 | `uiComposites` |
| `compositionend` 后同轮 Enter 误挡/漏挡 | 已修复并验证 | `uiComposites` 0ms 定时器序列 |
| 高亮 disabled / Enter 误选 / 全禁用 | 已修复并验证 | `uiComposites` 跳过 disabled、全禁用表单不提交 |
| 筛选后 activeIndex 失效 | 已修复并验证 | `uiComposites` 筛选变化回退 |
| 受控 value 关闭态 label 不同步 | 已修复并验证 | `uiComposites` 受控同步/disabled 收起 |
| Tabs 导航不按路由激活 | 已修复并验证 | `resolveNavigationKey`；`uiComposites` 路由/查询参数/子路由 |
| Tabs disabled 仍可跳转 | 已修复并验证 | `uiComposites` span[role=link]、Enter 不导航 |
| Tabs 选择态键盘/roving/aria-selected | 已修复并验证 | `uiComposites` 四向/Home/End/循环/禁用/空 items/IME |
| 嵌套浮层一次 Esc 连带关闭 | 已修复并验证 | `uiLayers` 4 条；`uiAccessibility` 13 条 |
| Popover 关闭焦点落 body | 已修复并验证 | `uiLayers` 焦点回触发器 |
| Dialog 焦点陷阱抢上层焦点 | 已修复并验证 | `uiAccessibility` 多层 Dialog / Dialog+Popover |
| 卸载后遗留监听器 | 已修复并验证 | `uiLayers` 卸载/快速开关 |
| 生产页面 Tabs 视觉回归 | 已修复并验证 | 视觉全量 29/29 |
| TaskDetail 高度/字号偏差 | 已修复并验证 | 视觉 TaskDetail 通过；`.ui-tabs--page` 被 0,4 选择器覆盖 |
| UI 守卫“只导一个 Button 就过关” | 已修复并验证 | AST 守卫 + 8/8 自测；新页面 0 容忍 |
| collaborationWorkspace 既有失败 | 已修复并验证 | 单独 96/96；失败根因见 §6.2 |
| 生产 Tooltip 同时出现原生 title | 已修复并验证 | `IconButton title={false}`；`uiComposites` 23/23 新增测试；工作台 DOM 不再有 title |
| 全量 Vitest | **未通过** | 单 worker 19 files / 90 failed / 2537 passed；taskDetail 2 条已单独修复并 39/39；其余见 §6.1 |
| 全量 Playwright | **受阻** | 190 条启动后中途 `AGENT_INFRA_CONNECTION_LOST`，未得到 summary；不计数为通过 |
| CI 远程 | **受阻/未完成** | workflow 已建，未在 GitHub 实际运行；当前全量套件为红，无法宣称 gate 绿 |
| Windows/Tauri/WebView2 实机 | **待人工验收** | 未执行 DPI/输入法/拖拽矩阵；不伪造 |
| Token/密度逐项迁移 | **部分完成** | 32 处 px 已分类，未批量改 CSS；MemoryView 2 处外部风险 |

## 6. 自动化测试证据

### 6.1 全量 Vitest

命令：

```powershell
cd D:\Develop\Relay-Agent\apps\workbench
pnpm exec vitest run
```

已实际执行。结果分为三类：

1. `tmp/UI-UNIFY-03/vitest-full-2.log`：255 test files，**2405 passed / 81 failed / 2 worker errors**，exit 1，约 896s；失败集中在 assistantModeSwitch、folderFirstConversation、run 系列、scenarioFixtureContract、useSendRiskGate、contextBudget/Knowledge 等。
2. `tmp/UI-UNIFY-03/vitest-full-3.log`：在与 collaboration 单测并行时运行，collaboration 本文件出现 89 条失败（单独运行 96/96），属于测试进程/端口互相污染，不作为验收口径。
3. `tmp/UI-UNIFY-03/vitest-full-4.log`：默认并发复跑出现 worker exit 134 / 3221226505（内存不足型崩溃），41 failed files / 541 failed tests；崩溃导致失败数不可作为业务结论。

最终口径：`tmp/UI-UNIFY-03/vitest-full-5.log`，单 worker 串行运行，**19 failed files / 90 failed tests / 2537 passed / 255 files**，1434.38s，exit 1。失败文件分布：

| 文件 | 失败数 | 归属判断 |
|---|---:|---|
| `folderFirstConversation.spec.ts` | 22 | 对话入口/并行 API 领域；非本轮 UI |
| `scenarioLabMatrix.spec.tsx` | 19 | 场景实验室历史基线 |
| `scenarioFixtureContract.spec.ts` | 9 | 测试夹具契约 |
| `assistantModeSwitch.spec.ts` | 6 | Assist 会话模式 |
| `taskSkillProposal.spec.ts` | 5 | Assist 提案/并行 API；页面可正常渲染，失败为缺少“命令结果待核对”状态文案 |
| `runControlRevision.spec.ts` | 5 | Run 控制 |
| `run.spec.ts` | 5 | Run |
| `useSendRiskGate.spec.tsx` | 4 | 发送风险门 |
| `run-ui1820.spec.ts` | 3 | Run UI 历史 |
| `liveErrors.spec.ts` | 2 | 网络错误 |
| `taskDetail.spec.ts` | 2 | **已修复的测试契约**：API 5xx 额外触发 `/client-diagnostics` POST，断言从“所有 POST”改为只匹配 `/artifacts`；单独 39/39 |
| `uiFolderNewConversation.spec.ts` | 1 | 新会话创建；与并行 API 相关 |
| `knowledgeSimplify.spec.ts` | 1 | 知识候选列表 |
| `knowledgeCaptureLayout.spec.ts` | 1 | 来源失权重读错误 |
| `firstMessageTransition.spec.ts` | 1 | 首条发送过渡 |
| `taskSkillLive.spec.ts` | 1 | Task Skill live |
| `contextUsagePanel.spec.tsx` | 1 | 上下文用量（并行任务） |
| `responsiveTiers.spec.ts` | 1 | 响应式断点守卫，包含并行 `MemoryView.css` 等既有违规 |
| `assist-target.spec.ts` | 1 | Assist 目标切换 |

其中已单独复核并通过：

- `taskDetail.spec.ts`：39/39，`tmp/UI-UNIFY-03/taskDetail-isolated-2.log`。
- `collaborationWorkspace.spec.ts`：96/96。
- 本轮新增/改写的 UI spec 全部通过。

因此全量 Vitest 仍**未通过**：上述 90 条中，2 条 taskDetail 已在单测中修复但未重新跑全量；其余 88 条是并行任务/历史基线，不能归为 UI-UNIFY-03 已修复。单 worker 串行结果没有 worker OOM，可复现。

### 6.2 collaborationWorkspace

单独串行运行：

```powershell
pnpm exec vitest run tests/collaborationWorkspace.spec.ts --maxWorkers=1 --no-file-parallelism
```

结果：**96 passed / 96**，132.58s，exit 0；日志 `tmp/UI-UNIFY-03/collab5.log`。

根因与修复：

1. 7 个上下文用量用例：夹具缺 0162 起必读 `compaction`，parser 抛“session context usage.compaction 响应格式无效”；补 `compaction` 投影，未改界面断言。
2. 2 个 Review 零 POST：实际 POST 是 API 5xx 触发的 `POST /client-diagnostics`，不是决定写入；断言改为只匹配以 `/decisions` 结尾的 POST。
3. 2 个离页保护文案：`App.tsx` 两处补“丢弃后无法恢复…”，覆盖页面/窗口两条路径。
4. 并行 API 改 DTO：`window_source` 不再接受 `SESSION_TIER`，改为 `MODEL_CATALOG|CAPABILITY_DECLARATION|MODEL_CONFIG|UNKNOWN_FALLBACK`；`compaction` 新增必读 `provider_call_cap_tokens`、`fallback_applied`；夹具已改 `MODEL_CONFIG` 并补空值/`false`。
5. 圆环说明文案改为“占比相对当前模型可用窗口”，测试断言同步；这不是降低断言，而是跟随已变更的 UI 契约。

### 6.3 Targeted UI 测试

| 命令 | 执行情况 | 通过/失败 | 日志 |
|---|---|---|---|
| `pnpm exec vitest run tests/uiComposites.spec.tsx` | 已执行 | 23 / 0 | `tmp/UI-UNIFY-03/uiComposites-2.log` |
| `pnpm exec vitest run tests/uiLayers.spec.tsx` | 已执行 | 12 / 0 | `tmp/UI-UNIFY-03/uiLayers.log` |
| `pnpm exec vitest run tests/taskDetail.spec.ts --maxWorkers=1` | 已执行 | 39 / 0 | `tmp/UI-UNIFY-03/taskDetail-isolated-2.log` |
| `pnpm exec playwright test tests/browser/uiAccessibility.spec.ts` | 已执行 | 13 / 0 | `tmp/UI-UNIFY-03/uiAccessibility-2.log` |
| `pnpm run typecheck` | 已执行 | exit 0 | `tmp/UI-UNIFY-03/typecheck-5.log` |
| `pnpm run build` | 已执行 | exit 0，Vite built | `tmp/UI-UNIFY-03/build-4.log` |
| `node scripts/check-ui-conventions.mjs` | 已执行 | exit 0；裸色 0、px 32、豁免 3 文件 | `tmp/UI-UNIFY-03/ui-check-3.log` |
| `node --test scripts/check-ui-conventions.test.mjs` | 已执行 | 8 / 0 | `tmp/UI-UNIFY-03/guard-tests-2.log` |
| `pnpm run test:visual` | 已执行 | 29 / 0 | `tmp/UI-UNIFY-03/visual-full-4.log` |
| `pnpm exec playwright test`（全量） | 已尝试，未完成 | 未得到 summary | `tmp/UI-UNIFY-03/playwright-browser-full.log` |

文档检查：`node scripts/check-docs.mjs` 已运行，exit 1；失败均为仓库既有缺失的验收截图/raw 日志链接（如 `output/acceptance-raw/...`、`apps/workbench/artifacts/...`），未出现本报告路径的新增断链。该失败不是 UI 变更引入，未通过删除链接来“修复”。

`uiAccessibility` 的 13 条覆盖：Dialog/Tabs/Combobox/ContextMenu/Tooltip/Toast、Dialog+Popover+Combobox 三次 Esc 逐层、Dialog+Tooltip、多层 Dialog、disabled Tabs、真实 Chromium CDP `Input.imeSetComposition` 组合期 Enter/Escape。

**限制**：CDP `Input.imeSetComposition` 只是 Chromium 输入法事件模拟，不等价于 Windows 中文输入法的候选词窗口、按键时序和 WebView2 行为；真实 IME 仍需人工验收。

### 6.4 视觉回归

- 配置：`playwright.visual.config.ts`，端口 `4175`，workers 1，viewport 1440×960，`maxDiffPixelRatio 0.002`，locale zh-CN，timezone Asia/Shanghai，reducedMotion reduce。
- 基线目录：`apps/workbench/tests/visual/uiVisual.spec.ts-snapshots/`，共 **29** 张，文件名带 `-win32`。
- 本轮新增：`tasks-tooltip-win32.png`（生产页 Tooltip）、`tasks-zoom-150-win32.png`（150% 内容缩放）。
- 本轮更新：`overlay-dialog-win32.png`；原因仅是 Playground Dialog 内新增“Popover + Combobox + Tooltip + 第二层 Dialog”设计场景，属于确认过的交互变更，不是掩盖回归。
- 修复过程：首次全量 21/27，失败为项目列表、任务列表、任务详情、窄窗任务列表、125% zoom、playground-buttons 超时；根因是 `Tabs` 迁移后 `.ui-tabs--page` 覆盖旧药丸皮肤。用 `TabItem.className` + 高特异性 CSS 修复后 26/27；TaskDetail 差 10px，根因是共享页签字号覆盖原 `caption`，加 0,4 组合选择器后通过。最终 **29/29 passed**，1.3m。

### 6.5 全量 Playwright

`pnpm exec playwright test` 启动后跑到约 190 条时被 `AGENT_INFRA_CONNECTION_LOST` 中断；日志末尾仍是无 summary 的用例列表，**不能计为通过**。可确认的是 `tests/browser/uiAccessibility.spec.ts` 单独 13/13 通过。其余浏览器回归需要网络/宿主恢复后重跑。

## 7. CI 质量门禁

### 7.1 GitHub Actions

新增 `.github/workflows/ui-quality.yml`：

- `windows-latest`（视觉快照为 win32，不允许把本地 Windows 快照直接用于 Linux 像素断言）；
- Node `24`、pnpm `9.15.9`、`pnpm install --frozen-lockfile`；
- 根依赖 + `apps/workbench` 自有 lockfile 分别安装；
- 安装 Playwright Chromium；
- UI AST 守卫 → 守卫自测 → typecheck → build → Vitest → Playwright → 视觉；
- 失败上传 `test-results/**`、`playwright-report/**`、`tmp/ui-ci/**`。

**状态：未远程运行**。本地没有 GitHub Actions run ID；当前全量 Vitest 与全量 Playwright 均为红，不能声明 CI gate 已绿。

### 7.2 本地等价脚本

新增 `scripts/ci-ui-local.ps1` 与根 `package.json` 的 `ci:ui:local`。脚本与 workflow 执行同一组步骤，日志写入 `tmp/UI-UNIFY-03/ci-<时间>/`；PowerShell 语法解析通过。因全量 Vitest 当前失败，未把它端到端跑成“通过”并截图伪造结论。

## 8. Design Tokens、px 字号与密度

### 8.1 32 处 px 字号分类

| 文件 | 数量 | 字号 | 本轮处理 |
|---|---:|---|---|
| Activity | 1 | 12.5 | 保留；接近 caption，待统一批次 |
| Inbox | 3 | 22/20/12.5 | 保留；页面标题/元信息语义 |
| Knowledge | 8 | 11.5/12.5/22/17/20/15/11.5/15 | 保留；知识页排版层级 |
| Memory（外部） | 2 | 18/12.5 | **不计入本任务可接受存量**；并行未跟踪文件 |
| Projects | 4 | 13.5/12.5/22/13.5 | 保留；项目页标题与密度 |
| ProjectWorkbench | 1 | 17 | 保留 |
| proto | 6 | 22/17/22/18/22/22 | 保留；原型页专用视觉 |
| Reviews | 2 | 12.5/11.5 | 保留 |
| Today | 5 | 18/13.5/17/22/12.5 | 保留 |
| 合计 | 32 | — | 未批量迁移，守卫只减不增 |

结论：**没有完成逐项 Token 迁移**。本轮已把它们冻结在基线中，新增 px 字号会使守卫失败；MemoryView 2 处已在 `ui-conventions-baseline.json` 的 note 中标注为外部风险，合并该文件前应改为 token，或把基线收紧到 30。没有把它们登记为“合理例外”来永久豁免。

### 8.2 密度

- `comfortable` / `compact` 仍由 `Density` 组件与页面根属性控制；Playground 保留两种密度展示。
- 本轮未发现由 Tabs 迁移造成的全局密度跳变；生产页的 38px 页签、工具栏间距由迁移期 CSS 固定在原值。
- 复核限制：没有逐页测量所有表单控件间距；该项归入 P2 剩余工作，未宣称全站一致。

### 8.3 豁免 CSS

守卫 `EXEMPT_FILES` 为 3 个文件（overlay 与 DEV 实验室）。本轮复核了边界：豁免只覆盖非工作台设计系统的 overlay/开发工具样式，不作为业务页面规避通道；没有扩大豁免名单。

## 9. Windows / Tauri / WebView2 人工验收矩阵

**实机 GUI 验收未执行**。本轮只读取了当前 Windows 环境的基线，没有完成 Tauri 安装包启动、WebView2 版本切换、DPI 切换和真实中文输入法的矩阵测试，因此不伪称通过。

当前环境基线（仅作人工验收的起点，不等于测试结果）：

| 项 | 实测值 |
|---|---|
| OS | Microsoft Windows 11 家庭中文版 10.0.22631，build 22631 |
| WebView2 Runtime | Microsoft Edge WebView2 Runtime 157.0.4341.46 |
| 主显示器 | `\\.\DISPLAY5`，2048×1152（虚拟显示适配器） |
| 当前 DPI | `AppliedDPI=120`，即 125%（未覆盖 100/150/200%/混合 DPI） |
| 桌面可执行文件 | `apps/desktop/src-tauri/target/debug/relay-desktop.exe`（2026-11-12 构建，未作为本轮验收启动） |

完整待测矩阵：

| 维度 | 待测值 |
|---|---|
| 操作系统 | Windows 11 22631（当前基线）；发布目标机另记 build |
| WebView2 | 当前 157.0.4341.46；另测目标机实际版本 |
| DPI | 100%、125%、150%、200% |
| 显示器 | 单屏；双屏混合 DPI |
| 窗口 | 1024×768、最大化 |
| 输入法 | 微软拼音/搜狗中文，候选词窗口 |
| 场景 | Agent 输入发送、模型选择、设置表单、项目/任务详情、DropdownMenu、ContextMenu、Tooltip、Combobox、Dialog/Drawer、拖拽侧栏/Inspector、Toast、滚动吸顶表头 |

验收标准：

无文本裁切、无横向溢出、无浮层错位、无 IME 冲突、无焦点逃逸、无重复关闭、无拖拽回弹、无跨屏 DPI 布局异常、无业务操作失效。每项需记录 OS build、WebView2 版本、DPI、窗口尺寸、场景、结果、截图/录像路径。

## 10. 最终结论

**部分通过。**

已经成立：

- Combobox、Tabs、嵌套浮层的 P0 缺陷已实际修复，并有 23 + 12 + 13 条行为测试和 CDP IME 证据。
- 真实生产页面已接入 Tabs、Table、Tooltip、Separator；Toast、ResizableHandle、AppDialog 既有生产接入已核实。
- UI 守卫已 AST 化，8/8 自测通过，能阻止新增原生控件绕过。
- collaborationWorkspace 从既有失败恢复到 96/96。
- typecheck、build、UI 规范检查、视觉回归 29/29 均实际通过。

未成立/受阻：

- 全量 Vitest 未通过：单 worker 串行 19 failed files / 90 failed / 2537 passed；taskDetail 的 2 条诊断 POST 断言已在隔离测试中修复，但全量尚未复跑；其余 88 条为并行/历史基线。
- 全量 Playwright 190 条被基础设施中断，未得到完整 summary。
- CI workflow 未远程运行，当前套件为红，不能宣称 gate 绿。
- Windows/Tauri/WebView2 实机矩阵未执行。
- 32 处 px 字号未完成逐项 Token 迁移；MemoryView 2 处外部风险仍在。
- 9 个复合组件仍仅 Playground，生产接入是“按场景评估后的部分接入”，不是全覆盖。

因此不能标记为“通过”或“发布级最终通过”。后续最小闭合顺序：

1. 以单 worker 全量结果（19 files / 90 failed）为基线，逐条登记失败归属；taskDetail 的 2 条已单独修复，重新全量时验证。
2. 恢复宿主后重跑全量 Playwright，保留 summary。
3. 在 GitHub Actions 实际运行 `ui-quality`，或先让本地 `scripts/ci-ui-local.ps1` 变绿。
4. 按 §9 完成 Windows/Tauri/WebView2 实机矩阵并补截图。
5. 把 30 处本任务范围 px 字号逐项迁 token；MemoryView 2 处合并前处理。

## 11. 日志索引

| 日志 | 用途 |
|---|---|
| `tmp/UI-UNIFY-03/typecheck-5.log` | 最终 typecheck |
| `tmp/UI-UNIFY-03/build-4.log` | 最终 build |
| `tmp/UI-UNIFY-03/ui-check-3.log` | UI 规范检查 |
| `tmp/UI-UNIFY-03/guard-tests-2.log` | 守卫自测 8/8 |
| `tmp/UI-UNIFY-03/uiComposites-2.log` | 23/23 |
| `tmp/UI-UNIFY-03/uiLayers.log` | 12/12 |
| `tmp/UI-UNIFY-03/taskDetail-isolated-2.log` | taskDetail 39/39（诊断 POST 过滤后） |
| `tmp/UI-UNIFY-03/uiAccessibility-2.log` | 13/13 |
| `tmp/UI-UNIFY-03/collab5.log` | 96/96 |
| `tmp/UI-UNIFY-03/visual-full-4.log` | 最终视觉复跑（29/29） |
| `tmp/UI-UNIFY-03/vitest-full-2.log` | 早期全量 81 failed |
| `tmp/UI-UNIFY-03/vitest-full-3.log` | 并行污染，不作数 |
| `tmp/UI-UNIFY-03/vitest-full-4.log` | worker OOM，不作数 |
| `tmp/UI-UNIFY-03/vitest-full-5.log` | 单 worker 最终口径 |
| `tmp/UI-UNIFY-03/playwright-browser-full.log` | 全量浏览器中断记录 |

# 全站 UI 统一：迁移记录与完成度（UI-UNIFY-01，2026-11-12）

配套文件：
- 审计数据与 P0/P1/P2 处置：[`ui-audit-2026-11-12.md`](ui-audit-2026-11-12.md)（由 `node scripts/ui-audit.mjs --write` 生成）
- 规则正文：`design-system/part-06.md` §9.35
- token 定义：`design-tokens.json` 0.6.0
- 验收行：`docs/testing/overall-acceptance-2026-09-28.md` 表首行

## 1. 本批做了什么、没做什么

**做了**：把「同一个语义两个值」的地方收敛到唯一来源（色板、圆角、焦点、卡片分层），
把页面档/工作台档的密度差写进 token，建立 `src/ui` 组件层与 `/__dev/ui` 展示页，
加一条能失败的守卫脚本，并修掉两个真实缺陷（错误态边框被覆盖、开发路由进生产包）。

**没做**（明确不在本批）：重画页面；把 72 处页面的按钮从 34px 抬到 40px；把页面正文从 13px 抬到 16px；
把 892 个原生 `<button>` 一次性换成组件；迁移页面级 CSS 里剩下的 366 处裸色值。

## 2. 页面迁移记录

「迁移」在这里分两层：**token 层**（该页所有颜色/圆角/焦点/阴影已由 token 决定）与
**组件层**（该页的按钮/表单/标签来自 `src/ui`）。两层分开记，避免把「颜色统一了」说成「页面迁移完了」。

| 页面 / 组件 | token 层 | 组件层 | 使用共享组件 | 保留的特殊样式 | 自动化验证 | 需人工验证 |
|---|---|---|---|---|---|---|
| `views/GoalListView.tsx` | 完成（pv） | **完成** | Button / buttonClassName | `.pv-goal-card` 目标卡网格、`.pv-filter` 范围页签 | Vitest goal 32/32 | 否 |
| `components/StatusChip.tsx` | 完成 | **完成** | Badge | 无（仅保留任务状态图标表） | Vitest 组件 12/12、收件箱/任务页渲染 | 否 |
| `/projects` ProjectsView | 完成（pv） | 未迁移 | PageHeader / EmptyState | 项目卡网格与列表视图、新建卡 | Chromium 截图 + 项目 Vitest | 视觉复核 |
| `/tasks` TasksView | 完成（pv） | 未迁移 | PageHeader / EmptyState / StatusChip | 数据表列宽与行密度 | `uiDesignTokens` 4 条 + 任务 Vitest | 视觉复核 |
| `/settings` SettingsView | 完成（非 pv，自带 CSS 但已用 token） | 未迁移 | 无 | 设置分段导航与两个下拉的页内几何 | Chromium settingsUx 3/3、Vitest 52/52 | 视觉复核 |
| `/today`、`/inbox`、`/activity`、`/reviews`、`/knowledge`、`/scheduled-tasks`、`/goals/:id`、`/projects/:id/*` | 完成（pv 皮肤） | 未迁移 | PageHeader / EmptyState | 各自的页面级布局与表格 | 未逐页跑浏览器用例 | 是（逐页视觉复核） |
| `/agent` CollaborationView | 本来就是基准（全 token） | 未迁移（组件已存在） | AppDialog / EmptyState / StatusChip | 输入器与过程区的既定规则 | 既有 96 条协作用例未在本批复跑 | 是 |
| `/__dev/ui` UiLabView | 完成 | 完成（它就是组件层） | 全部基础组件 | 仅展示页骨架 `UiLab.css` | `uiLab.spec.ts` 6/6 | 否 |

说明：`/agent` 的 96 条协作用例本批**没有复跑**——本批没有改动 `AssistView` / `CollaborationView`
及其 CSS（并行会话正在改这两个文件，避免交叉）。它的 token 层未变，因此不作为本批回归项。

## 3. 完成度报告

| 维度 | 状态 | 可核查证据 |
|---|---|---|
| Design Tokens 统一 | **完成（色板/圆角/焦点/阴影）** | `protoPage.css` 裸色值 100+ → 0；`--pv-*` 23 项全部指向 `--relay-*`；`ui-audit` 报平均色差 31.0 → 0 |
| 基础组件库 | **部分完成**：13 个组件 + 3 个统一出口 | `apps/workbench/src/ui/`；`tests/uiPrimitives.spec.tsx` 12/12 |
| 页面视觉统一 | **部分完成**：颜色/圆角/焦点/卡片全站生效；按钮与字号仍两档 | `uiDesignTokens.spec.ts` 4/4（按钮档位、列宽、卡片、焦点）；密度差见 §9.35 表格 |
| CSS 收敛 | **部分完成** | 页面档 CSS 裸色值 366 → 0；全站存量 366 处已锁基线，`check-ui-conventions` 阻止新增 |
| UI Playground | **完成** | `/__dev/ui`；`uiLab.spec.ts` 6/6；生产产物 5 文件无 `__dev` 串 |
| 无障碍交互 | **部分完成**：组件层有 aria 契约与键盘路径 | Switch `role=switch`+`aria-checked`、错误 `role=alert`、IconButton 强制 label、对话框焦点陷阱（复用 AppDialog）；未做全站 axe 扫描 |
| 视觉回归 | **未建立像素基线** | 改用计算值断言（`uiDesignTokens.spec.ts`）；截图证据在 `tmp/UI-UNIFY-20261112/`。理由：并行会话正在改同一批页面，现在钉像素会把无关改动判红 |
| 业务功能回归 | **定向通过** | 定向 Vitest 96/96（goal 32 + 设置/项目/任务 52 + 组件 12）；Chromium 13/13（token 4 + Playground 6 + 设置 3）；**未跑全量** |

## 4. 剩余风险

1. **颜色整体位移**：72 处页面主色从 #23704d 变为 #205d47、分隔线从 #dfe9df 变为 #e8eee8、卡片投影归零。
   对比度只升不降（`color.text.*` 实测 5.86–13.4:1），但这是全站可见的变化，需要真人过一遍。
2. **两档密度仍在**：页面档按钮 34px / 正文 13px 与工作台档 40-48px / 16px 的关系已写进 token，但没合并。
   后续若合并，应作为独立批次并逐页量行高。
3. **组件层只迁移了 2 处**：892 个原生按钮仍是绝大多数。组件与既有类名同构，迁移可以逐文件推进，
   但「新页面默认用组件」目前只靠守卫的 `--pv-*` 与裸色值规则间接约束，还没有「禁止新增裸 `<button>`」的规则——
   因为存量太大，加了只能立刻失败。
4. **`check-docs` exit 1**：历史证据链接缺失（25 处），非本批引入，未修改历史检查来取得通过。
5. **真实桌面未验**：Windows/WebView2、125%/150% DPI、多显示器 DPI 混合下按钮 34px 的命中区与描边像素均未实测。

## 5. 后续建议（按性价比排序）

1. 逐页把 `<button className="x-button">` 换成 `<Button variant>`（DOM 不变，风险最低），每页跑一次定向用例。
2. 迁移页面级 CSS 裸色值：先做 ActivityView / KnowledgeView / InboxView 三个大户（合计 154 处），
   每迁完一个文件就 `check-ui-conventions --update-baseline` 收紧。
3. 决定是否合并两档密度；若合并，先做 `/tasks` 与 `/projects` 两页的行高测量。
4. 等并行会话收口后补像素基线（`toHaveScreenshot`），覆盖用户列的 12 个关键状态。

## 6. UI-UNIFY-02（2026-11-12，同一工作树）

### 6.1 组件层补全

`src/ui` 从 15 个文件增至 19 个：新增 `ContextMenu.tsx`、`Tooltip.tsx`、`ResizableHandle.tsx`、`Drawer.tsx`。`DropdownMenu` 是 `Menu` 的语义别名（不复制实现）；`ResizablePanel` 以 `ResizableHandle` + `useResizeDrag` 落地——协作页与页壳的列宽由各自 grid 轨道持有，再包容器会改 DOM 与既有尺寸断言，因此统一的是手柄机制而不是外壳。侧栏与工作详情面板已改为共用该实现，并顺带修掉侧栏抬手提交旧 `width` 的缺陷。

同时修掉两个真实交互缺陷：

1. `Menu` 的菜单项是 `tabIndex={-1}`，但此前没有「打开后聚焦首项」和方向键导航——键盘用户能打开菜单却进不去。现在打开后焦点进首项，↑/↓/Home/End 移动，Esc 回触发器，Tab 收起。
2. `useDetailsMenu` / `useMenuDismiss` 在渲染期读 ref 并把它放进 effect 依赖：首次挂载时 ref 还是 null，监听器根本不会挂上，Esc/点外面/独占在某些页面静默失效。改为在 effect（commit 后）读取节点，并在每次 commit 后重挂。
3. `ContextMenu` 记录右键 `mousedown` 前的活动元素：右键点空白会先把焦点移回 body，只在 `contextmenu` 时读 `activeElement` 会把焦点还给 body。

### 6.2 全站接入（本轮直接改动）

共 13 个文件、79 处 `<Button>`：

- 页面：`SettingsView`（10）、`CollaborationView`（14）、`AssistView`（22，含 4 个 `IconButton`）、`App.tsx`（6）。
- 组件：`AppDialog` 关闭键、`Feedback` 关闭键、`MessageCodeBlock` 复制键、`ModelConnectionsCard` 刷新键、`DevToolsPanel` 收起键、`WorkbenchActions` 四个图标键、`AppShell` 折叠与移动导航键、`InterventionNotifications` 通知键、`RecentWorkRail` 新建任务键。

保持不动的复杂控件：`WorkspaceClearSessions` 的清空键（图标随 busy 在图标与转圈之间切换，`IconButton` 只接受 LucideIcon）、设置页分组导航（自定义 `aria-controls` 与图标布局，`Tabs` 不覆盖）、输入器发送/停止键之外的搜索框与日期/时区输入（IME、原生日期语义、动态尺寸）。

存量统计（生产 TSX，排除 `src/ui` 与 `src/dev`）：

| 指标 | HEAD | 本会话开始时 | 现在 |
|---|---|---|---|
| 原生 `<button>` | 887 | 未提交工作树已迁移大部分 | 217 |
| 使用共享基础类名的原生 button | 667 | — | 1（上述清空键） |
| 从 `../ui` 取件的文件 | 2 | 109 | 115 |

HEAD 与本会话开始时的差异来自上一轮未提交的迁移，不计入本轮直接改动。

### 6.3 CSS 与 token

- 计入守卫的生产 CSS 裸色值：**24 → 0**。另把 83 处登记为三个豁免文件（Tauri Overlay 42、ScenarioLab 21、AuroraGlassLab 20），它们在脚本 `EXEMPT_FILES` 里写明理由。
- px 字号：**167 → 30**。精确等于 token 的 128 处（11/12/13/14px）换成 `font.size.micro/caption/pageBase/meta`；剩余 30 处是 pv 页标题、统计数字与列表题名的中间档（22/17/12.5/11.5/13.5/20/18/15/10.5px），已登记，合并需独立视觉验收。
- 新增 `color.accent.violet`（引用 `color.palette.violetAccent` #5F3DC4），删除 `AssistView.css` 里的 `:root` 局部定义；守卫现在禁止本地 `--relay-*` 写死字面值。

### 6.4 测试与守卫

- 恒真断言：`uiDesignTokens.spec.ts` 的投影断言改为解析 token 与 computed style 后逐项比较（层数/inset/偏移/模糊/颜色/alpha），变异验证放在 `tests/uiShadowAssert.spec.ts`（5 条）。`frontendDiagnostics.spec.ts` 的 `expect(true).toBe(true)` 改为验证失败后通道仍可用。
- 新增组件行为测试：`uiLayers.spec.tsx` 7 条（ContextMenu/Tooltip/ResizableHandle）、`uiComposites` 的 Menu 键盘用例、`tests/browser/uiAccessibility.spec.ts` 7 条、`tests/browser/uiDensity.spec.ts` 3 条。
- 视觉基线：27 张（页面 11：Agent 空白态、项目/任务列表与详情、今日、待处理、设置、1024 窄窗、125% 缩放、滚动；Playground 分区 7；浮层/状态 9），连续两次全过。
- 守卫接进默认 Vitest 与 `build`；`EXEMPT_FILES` 之外新增三条规则（本地 relay 变量只能派生、新样式文件必须有调用方且无全局选择器/`!important`、新页面原生控件必须走 `../ui`）。

### 6.5 未完成与风险

- 未跑全量 Vitest/Chromium。`collaborationWorkspace.spec.ts` 有 15 条既有失败，已用「撤销本轮改动后同用例仍失败」核对，不是本批引入；未逐条归因其根因。
- 输入框/下拉/多行框未批量迁移（180/81/40 个原生控件保持原样），因为多数承担 IME、日期、动态尺寸或未保存草稿语义。
- 视觉基线来自示例数据与 `/__dev/ui`，没有真实 API/会话的像素基线；真实 Windows/WebView2、125%/150%/200% 系统 DPI、中文 IME 未验。
- 仓库没有 CI 工作流；「CI 集成」落实为默认测试套件 + `build` 前置，不等同远程流水线。
- `check-docs` 的既有 25 条历史缺失链未修。

### 6.6 Windows / WebView2 人工验收矩阵（未执行）

Playwright Chromium 不等于真实 Tauri 窗口。下列项目必须由人在安装态逐项过：

| # | 环境 | 场景 | 通过标准 |
|---|---|---|---|
| 1 | Windows 11，100% DPI，安装版 | 设置 → 模型连接 → 新增连接表单 | 输入框、下拉、按钮高度一致；中文 IME 组合期间 Esc 不关下拉；错误态边框可见 |
| 2 | 125% / 150% / 200% DPI（逐档重启） | `/tasks`、`/projects`、`/settings` 各滚动到底 | 无横向滚动条；表头吸顶不抖；按钮文字不裁切 |
| 3 | 双显示器不同 DPI，跨屏拖动窗口 | Agent 会话 + 工具面板 + 工作详情 | 面板宽度不跳变；分隔条命中区仍可拖；关闭后焦点回触发器 |
| 4 | 安装版 | Dialog / Drawer：Tab 循环、Esc、遮罩点击 | 焦点不逃出面板；Esc 后回到打开它的按钮 |
| 5 | 安装版 | DropdownMenu / ContextMenu：全键盘操作 | 打开即进首项；↑/↓/Home/End 正确；选中后收起并回焦点 |
| 6 | 安装版 | Tooltip：悬停 / 键盘聚焦 / 页面滚动 | 不被卡片裁切；滚动时跟随；Esc 收起 |
| 7 | 安装版 | Toast / Snackbar | 读屏可播报；重复触发不叠两条；不遮挡主操作 |
| 8 | 安装版，窄窗口 1024×768 | 任务列表、设置页、Playground | 无横向溢出；分组导航可键盘到达 |
| 9 | 安装版 | 中文输入：搜索框、任务标题、设置字段 | 组合期间不触发提交/快捷键；光标与候选框位置正确 |

记录方式：每项写清 DPI、窗口尺寸、WebView2 版本与截图路径；未执行的项目不得写成通过。

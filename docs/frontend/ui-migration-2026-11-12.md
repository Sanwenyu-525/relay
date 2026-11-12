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

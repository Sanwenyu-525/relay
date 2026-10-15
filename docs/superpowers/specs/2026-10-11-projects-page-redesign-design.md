# 项目页重设计（摘要条 + 三页签 + 卡片网格 + 详情抽屉）

- 日期：2026-10-11。状态：Accepted（用户 2026-10-11 选定「整体重做 / 跟随原型」后进入实施）。
- 依据：用户提供的静态原型 [projects-redesign.html](../../frontend/mockups/2026-10-11/projects-redesign.html) 与同目录渲染截图 [projects-redesign.png](../../frontend/mockups/2026-10-11/projects-redesign.png)（2026-10-11 收录进仓库）。
- 约束来源：业务交互仍以[工作台交互](../../frontend/workbench-design.md)与契约为准；视觉规则归[设计系统](../../frontend/design-system.md)，数值唯一源为 [design-tokens.json](../../frontend/design-tokens.json)。本 spec 不改变业务状态、权限、命令 Owner、API 与数据库。

## 1. 目标与范围

**目标**：把 `/projects` 从「页头 + 两页签 + 表格列表 + 常驻右栏」改成原型结构：**推进摘要条 → 三页签（全部项目/进行中/已归档）→ 项目卡片网格（含「开启一个新项目」卡）→ 底部范围说明**；项目详情从常驻右栏改为「查看项目」打开的**右侧详情抽屉**。

**本轮做**：

- 新增推进摘要条（正在推进数 / 尚未明确下一步数 + 「去完善」）。
- 页签扩展为三个范围：`all` / `active` / `archived`；默认 `all`（对齐原型）。
- 表格列表改为卡片网格，并新增「开启一个新项目」虚线卡；保留网格/列表视图切换（原型有）。
- 项目详情（打开项目、归档、修订与确切 ID）改为 `AppDialog variant="drawer"`。
- 归档的阻断原因、待核对回执、成功回执仍留在主列就地显示（不随抽屉关闭而消失）。

**本轮不做**（YAGNI）：

- 不改暖白/墨绿基调、字体与页壳；**不新增任何色值、字号、圆角、动效数值**（新页面样式一律写 `views/ProjectsView.css`，`styles.css` 不新增页面私有规则）。
- 不改命令协议、归档幂等/回执核对、分页、搜索范围语义与 `data-testid` 命名。
- 不实现原型里的「记录目标」以外的目标流程改动（沿用既有 `?view=goal` 轻量入口）。
- 不做全站推广。

## 2. 与现有实现的差异与取舍

| 项 | 现状 | 本轮 | 理由 |
|---|---|---|---|
| 右侧摘要栏 | 宽屏常驻 `.desktop-rail` + 窄屏抽屉 | 移除常驻右栏，统一「查看项目」详情抽屉 | 用户明确选择「跟随原型」；卡片已内联展示阶段与下一步，常驻右栏信息冗余 |
| 页签 | 进行中 / 已归档（`?archived=1`） | 全部项目 / 进行中 / 已归档（`?scope=`） | 原型结构；`?archived=1` 作为历史别名继续可用 |
| 默认范围 | 进行中 | **全部项目** | 对齐原型首屏；`status=all` 服务端已支持 |
| 列表形态 | 4 列数据表 | 卡片网格（可切列表） | 原型结构 |
| 新建入口 | 仅页头按钮 | 页头按钮 + 网格内「开启一个新项目」卡 | 原型结构；不产生第二个 primary 竞争（网格内用浅色次要按钮） |

### 2.1 待确认（可逆）

- **默认范围**：`all` 与现状 `active` 不同。live 模式 `status=all` 会同时返回已归档项目，摘要条的计数因此只覆盖**已加载**项；有后续页时摘要条附带「仍有后续页」限定。若产品希望回到「默认只看见进行中」，把 `scopeFromQuery` 的默认值改回 `active` 即可，其余不动。
- **摘要条计数口径**：fixture 为全量精确值；live 为已加载值。两者文案共用，靠旁边的范围说明区分，不伪造全量计数。

## 3. 目标结构

```
/section.skill-page.projects-page
  .projects-inner
    PageHeader  title=项目  lede=让长期目标有序推进，下一步始终清晰。
                actions=[记录目标, 新建项目]
    .projects-summary                      ← data-testid="projects-summary"
    .projects-toolbar
      nav.subnav  [全部项目|进行中|已归档]   ← projects-tab-all / -active / -archived（路由链接）
      .projects-tools [搜索框, 网格/列表切换]
    .projects-grid[.is-list]
      article.project-card ×N              ← data-testid="project-row-<id>"
      button.project-card--new             ← 新建项目卡（仅 all/active 范围、无搜索时）
    .projects-note                          ← data-testid="projects-live-count"（live）
  AppDialog variant="drawer"               ← 项目详情
```

- 页签是**路由链接**（沿用既有 `aria-current`），不用 `role=tablist`——设计系统 §6 规定「路由用链接，同页 Tab 才用 tablist」。
- 卡片内每个交互（名称、更多、设置、查看项目）都是独立 `button`，卡片根 `article` 只承担整卡指针点击的便利；键盘可达路径由名称按钮提供。
- 空态三种区分不变：首装为空 / 搜索无匹配 / 归档范围为空。

## 4. 保留的契约

路由与查询、`createProject` / `archiveProject` / `GetCommandReceipt` 命令 Owner、归档阻断原因与回执核对流程、分页游标语义、搜索只覆盖已加载范围、`data-testid` 命名（`project-row-*`、`project-open`、`project-archive*`、`projects-empty`、`projects-archived-empty`、`projects-live-*`、`goal-create-open`、`project-create-open`、`projects-page-head`）全部保留。

## 5. 验证出口与实际结果

- 类型检查：`apps/workbench` 的 `tsc --noEmit` exit 0。
- 单测（定向）：`projects.spec.ts`（新增摘要条与视图切换两例）、`projectArchiveLive.spec.ts`、`liveWorkspaceLists.spec.ts`、`projectsTitleRefresh.spec.ts`、`listViewCopy.spec.ts`、`createProjectOnboarding.spec.ts`、`createGoalEntry.spec.ts` 全绿。
- 单测（全量）：`vitest run` 100 文件 863 条，861 通过 / 2 失败；两例为既有全量 flake（`run-draft-preview.spec.ts`、`run-events.spec.ts` 的时序断言），单跑各自通过，与本轮改动无关。
- Chromium：新增 `tests/browser/projects-detail-drawer.spec.ts`（替代原 `projects-summary-layout.spec.ts`）、改写 `projects-empty-state.spec.ts` 第二例、改写 `workbench.spec.ts` 项目段落与 200% 缩放两例——全部通过。原 `projects-summary-layout.spec.ts` 因常驻右栏被移除而删除，其覆盖（宽屏常驻、短窗可达、页头入口不重叠）已在新 spec 中按抽屉结构重建，未删除失败检查。
- 出图对照：`apps/workbench/artifacts/screenshots/projects-redesign-list.png`（网格态）与 `projects-redesign-detail.png`（详情抽屉）。
- 文档检查：`node scripts/check-docs.mjs` exit 0；原型收录于 `docs/frontend/mockups/2026-10-11/`。
- **未覆盖**：真实 Windows WebView2 的字体/DPI、中文输入法、屏幕阅读器；`real-api.spec.ts` / `realBusinessAcceptance.spec.ts` 需真实 API 与隔离 PG，本轮未跑。静态图与浏览器证据不等于 Windows 验收。

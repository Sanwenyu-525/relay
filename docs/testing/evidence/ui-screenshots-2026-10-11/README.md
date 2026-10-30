# Relay 工作台 UI 截图与功能流程说明（2026-10-11）

- 截图方式：Playwright 无头 Chromium，Vite `http://127.0.0.1:5173`，视口 1440×960。
- 数据来源：默认是**示例数据（fixture）**；部分 `/agent` 截图连接了本机 API（`http://127.0.0.1:8787`，workspace `b34f1735-…`）。
- 脚本：`apps/workbench/tests/screenshots/capture-non-agent.spec.ts`、`capture-agent-projects.spec.ts`、`capture-agent-supplement.spec.ts`
  （配置文件：`playwright.capture*.config.ts`）。
- 注意：live 连接只存在内存里，整页跳转后会丢失。`projects-live-*` 系列核实后是回落的示例数据，已全部删除；项目页只保留示例数据截图。已用 MD5 去掉内容完全相同的重复图。

> 截图只能看到静态状态，下面按功能写出完整的用户流程。每节包含：用途 / 入口 / 步骤 / 状态 / 关键按钮 / 对应截图 / 示例数据看不到的部分。

---

## 0. 主链路总览

工作台对话 → 归入项目 → 创建任务 → 委托 / 执行 Run → Review（待处理）→ 产物版本 → 完成（完成记录）

| 步骤 | 页面 | 路由 |
|---|---|---|
| 1 对话 | 工作台 | `/agent` |
| 2 归入项目 | 工作台的目录条 / 项目 | `/agent` → `/projects/:id` |
| 3 创建任务 | 全部任务 / 项目任务 | `/tasks?view=create`、`/projects/:id/tasks` |
| 4 委托 / 执行 | 任务详情、Run | `/tasks/:id`、`/runs/:id` |
| 5 Review | 待处理 | `/reviews` |
| 6 产物版本 | 任务详情产物页签、血缘 | `/tasks/:id`（产物）、`/artifact-versions/:id/lineage` |
| 7 完成 | 完成记录 | `/completion-records/:id` |

---

## 1. 工作台（对话）`/agent`

**用途**：主入口。先和 Agent 自由讨论，再选择目录、把会话归入项目，然后从对话里产出任务或产物。

**入口**：左侧导航「工作台」；左栏顶部「新对话」（`context-new-conversation`）。

**布局**：
- 左栏「近期工作」：搜索框、按项目分组的会话 / 任务列表（「未归入项目」单独一组）、刷新、加载更多。
- 中间：会话条（当前会话下拉 + 新建会话 + 刷新会话，居中显示）、消息流（日期分隔、用户 / 助手消息、用量页脚、复制）、目录提示胶囊、输入框。
- 输入框工具栏：模式单选（普通 Agent / 人设助手）、资料（显式选择本次引用的资料）、讨论方式（普通讨论 ▾）、缓存命中与上下文圆环、发送（↑）。
- 关联任务后可切换布局：双栏 / 对话 / 成果（`collab-layout-*`），侧栏有 文档 / 检查 / 历史 三个页签。

**步骤**：
1. 点「新对话」。如果还没有会话，会显示首条消息引导（`assist-first-message`）。
2. 选模式：普通 Agent，或人设助手（会出现助手选择器，可以新建助手：名称、角色、语气、范围；可勾选「记住」）。
3. 可选：点「资料」，显式勾选本次要引用的资料版本。
4. 输入内容并发送。服务端先建会话（标题取自首条消息），再流式返回助手回复（生成中会有预览草稿和进行中的点点），回复完成后显示用量。
5. 目录胶囊提示「未选择目录 / 未归属」：点「更换目录」选择本地目录，然后把会话**归入项目**（发出 binding 命令，会话的 project_id 由空变为项目 ID）。归属后，这条会话出现在左栏对应项目分组下。
6. 助手可能给出候选提案（任务 / 定义变更 / 状态维护）。你可以接受、拒绝或回答澄清问题；状态维护支持撤回和撤销计划。
7. 切换会话：用左栏点选，或用会话条下拉；「刷新会话」会重新拉取消息。

**状态**：示例数据下页面为空（fixture gap）；无会话；首条消息待发送 / 待回执 / 失败可重试；生成中；模型服务出错（会给出模型错误指引）；归档项目只读；目录未就绪或有歧义。

**截图**：
- `agent-fixture-gap.png`：示例数据下的空态
- `agent-connection-dialog-open.png` / `agent-connection-dialog-connected.png`：连接本机 API
- `agent-live-base.png`：live 基础视图
- `agent-new-chat.png`：新对话
- `agent-rail-search.png`：左栏搜索
- `agent-session-selected.png`：选中会话
- `agent-session-select-open.png`：会话下拉
- `agent-new-session.png`：新建会话
- `agent-mode-agent-selected.png` / `agent-mode-assistant-selected.png`：模式单选
- `agent-source-dropdown-open.png`：资料选择器展开
- `agent-discussion-dropdown-open.png`：讨论方式下拉展开
- `agent-folder-change-hover.png` / `agent-folder-change-click.png`：目录胶囊「更换目录」悬停与点击
- `agent-composer-typed.png`：已输入文字（未发送）

**截图未覆盖**：上下文圆环悬停（无头浏览器里截不出悬停效果，截图与 `agent-mode-agent-selected` 完全相同，已删除）、布局切换（双栏 / 对话 / 成果）、系统的目录选择对话框（浏览器自动化无法打开）。真实模型回复、归属命令回执、提案卡片都需要 live 环境加实际发送，这次没有触发，以免产生真实写入和模型调用。

---

## 2. 项目 `/projects`、`/projects/:id/*`

**用途**：长期目标的容器。汇总阶段、下一步、任务、资料、连接，以及按类型区分的工作台。

**入口**：导航「项目」（`/` 默认会跳到这里）。

**步骤**：
1. 列表：用页签筛选 全部 / 进行中 / 已归档；可切换网格或列表视图；顶部有推进摘要（「去完善」）。
2. 「新建项目」（`/projects?view=create`）：填写标题、目标、类型（通用 / 论文 / 开发），可附带初始资料导入文件，然后提交，得到回执。导入是独立的长任务，失败不会回滚已经创建的项目。
3. 「记录目标」（`/projects?view=goal`）。
4. 点选卡片，右侧出现详情，点「打开项目」。项目概览 `/projects/:id`，可以带 `?skill=blueprint`（蓝图）或 `?skill=resume`（续接）。
5. 子页：任务 `/tasks`、资料 `/knowledge`、连接 `/connections`、工作台 `/workbench` → 自动跳到默认的 kind（`general` / `thesis` / `development`）。
6. 归档：点「归档」弹出确认框，确认后得到回执。如果存在阻断项（未完成的 Run 或 Review），会列出归档阻断原因。

**截图**：
- 列表：`projects-list-base`、`projects-tab-{all,active,archived}`、`projects-view-{grid,list}`、`projects-card-hover`、`projects-card-more-menu`、`projects-selected-detail`、`projects-archive-dialog`
- 新建与目标：`projects-create-base`、`projects-goal-base`
- 每个示例项目（`project-workflow-os`、`project-knowledge`、`project-thesis-topic`）各有：`-overview`、`-tasks`、`-knowledge`、`-connections`、`-workbench-{general,thesis,development}`、`-skill-{blueprint,resume}`
- `/workbench` 入口页会跳转到 general，截图与 `-workbench-general` 完全相同，已去重。

**示例数据看不到**：真实创建 / 导入回执、归档阻断、开发工作台的 Gateway 连接能力、论文工作台的资料版本。

---

## 3. 任务：创建 → 委托 / 执行 Run

**入口**：导航「全部任务」`/tasks`（页签：全部 / 收件箱）、`/tasks?view=create`、项目任务页。

**步骤**：
1. 创建任务：填写标题、所属项目、预期结果、验收标准，选择启动方式（我自己 ME / AI 协助 AI_ASSIST / 委托 AI DELEGATE_AI），可设依赖，然后提交得到回执。
2. 任务详情 `/tasks/:id`：页签有 概览 / 产物 / 运行；技能子页 `?skill=definition`（任务定义）、`?skill=verification`（验证计划）。
3. 委托或开始执行后会生成 Run，进入 `/runs/:id`：实时事件流（SSE）、运行控制面板（停止等）、检查结果。
4. Run 产出的产物版本进入 Review。

**截图**：`tasks-all-base`、`tasks-row-hover`、`tasks-inbox-base`、`tasks-create-base`、`tasks-create-picker-open`、`tasks-fixture-empty`、`task-detail-base`（即概览）、`task-detail-tab-artifacts`、`task-detail-more-menu`（运行页签的空态与它完全相同，已去重）、`task-skill-definition`、`task-skill-verification`

**示例数据看不到**：`/runs/:id`（示例数据里没有 Run 链接）、实时事件流、停止执行。

---

## 4. 待处理（Review）`/reviews`

**用途**：处理需要人来判断的事项：产物评审、检查结果确认、权限审批。

**步骤**：从列表选中一项，右侧出现决策面板，核对产物差异和检查项，然后接受、退回或要求修改（需要填写理由）。结果会写入完成依据。归档项目会显示只读原因。

**截图**：`reviews-base`、`reviews-item-selected`、`reviews-filter-open`

**示例数据看不到**：真实的决策命令和回执、版本不一致时的冲突提示。

---

## 5. 产物版本与完成

- **产物版本**：在任务详情的「产物」页签和工作台的成果栏查看。阅读器可以刷新、和基线版本对比、查看文本锁或冲突；如果有更新的版本，会提示先核对差异。血缘页 `/artifact-versions/:id/lineage`。
- **完成**：验收标准都通过、人工验收完成后，生成完成记录 `/completion-records/:id`，汇总完成依据（检查结果、Review 记录）。
- **截图**：无（示例数据里没有可进入的深链）。

---

## 6. 今日 `/today`

**用途**：每天的入口，汇总当天应该推进的任务、续接点和提醒。

**步骤**：打开页面，查看重点，点「继续」进入任务或项目。窄屏下可以通过导航抽屉进入。

**截图**：`today-base`、`today-narrow-base`、`today-narrow-nav-drawer`

---

## 7. 资料 `/knowledge`（含项目资料 `/projects/:id/knowledge`）

**用途**：管理长期资料，分为 Knowledge（资料条目及版本）、Memory（记忆）、Decision（决策版本）、Rule（规则 / 约束）。对话和任务只能引用当前获准范围内的资料版本。

**步骤**：切换类别页签，选中条目阅读，点「新版本」生成新版本，或通过「添加 / 导入」加入资料（网页导入、文件导入）。系统给出的整理候选需要人工确认。

**截图**：`knowledge-base`、`knowledge-add-dialog-or-panel`

**示例数据看不到**：项目资料页（`*-knowledge.png` 在示例数据下显示为 gap）、导入任务、整理候选。

---

## 8. 动态 `/activity`（`/activities`）

**用途**：按时间排列的活动记录，可按项目过滤（`activity-project-filter`），支持续页加载。

**截图**：`activity-base`

---

## 9. 收件箱 `/inbox` → `/tasks?tab=inbox`

**用途**：分派给你、尚未分拣的任务和通知。顶栏也有收件箱入口（`inbox-open`）。

**截图**：`tasks-inbox-base`

---

## 10. 设置 `/settings`

**用途**：显示偏好（例如默认项目工作台 kind）、布局偏好等。

**截图**：`settings-base`

---

## 11. 连接与同步 `/connections`、`/settings/connections`、`/projects/:id/connections`

**用途**：
- 数据来源：顶栏的「示例数据 / 已连接本机 API」按钮打开连接对话框，需要填写 API 地址、Workspace ID、Bearer 令牌。只有 `/health/ready` 返回 200 后才会进入 live 模式；断开后回到示例数据。
- Gateway 连接：外部能力和权限策略。

**截图**：`connections-base`、`connections-dialog-open`、`settings-connections-base`、`agent-connection-dialog-*`、`*-connections.png`

---

## 12. 其他

`unsupported-base.png`：未知路由的兜底页。

## 未截到 / 已知缺口

- `/runs/:id`、`/completion-records/:id`、`/artifact-versions/:id/lineage`：示例数据里没有可进入的链接。
- 工作台：布局切换、系统目录选择对话框。
- 所有真实写入（发送消息、归属、创建、归档、决策）都刻意没有执行。
---

## 补拍（14:2x，第三轮）

所有新截图都用 MD5 和已有图片比对过，与已有图片完全相同的没有保存。

- **工作台**：`agent-context-meter-hover.png`（鼠标真实移入上下文圆环）
- **已连接本机 API 的项目页**（连接后在页面内导航，没有整页刷新，项目为「Windows桌面验收 20261007（测试）」）：
  `projects-live-list`、`projects-live-selected`、`projects-live-overview`、`projects-live-tasks`、`projects-live-knowledge`、`projects-live-connections`、`projects-live-workbench-{general,thesis,development}`
- **live 任务详情**：`task-detail-live.png`
- **重拍成功的交互**：
  - 设置：`settings-section-{ai,execution,workbench}`
  - 今日：`today-plan-note-open`
  - 全部任务：`tasks-filter-project`、`tasks-filter-mode`
  - 任务详情：`task-detail-id-expand`、`task-detail-title-toggle`

### 仍缺
- 工作台布局切换（双栏 / 对话 / 成果）：从左栏点选任务后没出现布局按钮，未拍到。
- 动态、资料页签、新建项目页里的选择器：点击后画面没有变化，示例数据下没有可见的交互效果。
- 任务详情的「运行」「概览」页签：截图与基础视图完全相同，示例数据下没有区别。
- `/runs/:id`、`/completion-records/:id`、`/artifact-versions/:id/lineage`：live 环境的待处理、动态、任务、今日、项目任务和任务详情里都没找到这类链接（库里没有 Run 或完成记录）。
- 系统的目录选择对话框：浏览器自动化打不开，跳过。

---

## 盘点（已拍 / 仍缺）

对照文件夹实盘与上文「补拍（第三轮）」整理，供文档 / 验收直接引用。

- **实际数量**：99 张 PNG + 1 个 README.md（与第三轮「80 → 99、+19」一致，无偏差）。
- **第三轮新增**：19 张（约 14:22–14:23）。

### 已拍（按主题，共 99）

| 主题 | 约张数 | 说明 |
|---|---:|---|
| 工作台 /agent | 17 | 空态、连本机 API、live 基础、会话 / 模式 / 下拉、更换目录、输入框、上下文圆环悬停等 |
| 项目列表 | 12 | 列表 / 页签 / 视图切换、卡片悬停·菜单、新建、记录目标、选中详情、归档确认 |
| 项目详情·示例数据 | 27 | 3 个项目 ×（概览 / 任务 / 资料 / 连接 / 三种工作台 / 蓝图 / 续接） |
| 项目页·live 本机 API | 9 | 列表、选中、概览、任务、资料、连接、三种工作台（第三轮） |
| 任务 | 16 | 全部 / 收件箱 / 创建、筛选、详情基础·产物·技能、live 详情与展开交互等 |
| 设置 | 5 | 基础、连接；AI / 执行 / 工作台分区（第三轮） |
| 今日 | 4 | 基础、窄屏、导航抽屉；计划备注展开（第三轮） |
| 待处理 Review | 3 | 列表、选中、筛选 |
| 资料 | 2 | 基础、添加对话框 / 面板 |
| 动态 | 1 | 基础 |
| 连接 | 2 | 基础、对话框打开 |
| 未知路由 | 1 | 兜底页 |

### 仍缺（硬阻塞为主）

- 工作台布局切换（双栏 / 对话 / 成果）：点选任务后布局按钮未出现。
- 动态、资料页签、新建项目选择器：点击后画面不变（示例数据下无可见交互）。
- 任务详情「运行」「概览」页签：与基础图内容相同，MD5 去重未存。
- Run 详情、完成记录、产物血缘：live 数据里没有可进入的链接。
- 系统目录选择对话框：浏览器自动化打不开，已跳过。
- 真实写入流（发消息、归属、创建、归档、决策）：刻意未拍，以免产生真实写入和模型调用。

### 建议

先用这批做文档 / 验收；剩下几乎全是产品状态或自动化限制，等有真实 Run / 完成记录入口或布局按钮能点到再补。

### 第四轮解阻（2026-10-11 14:59+08）

已在本地 elay_dev / workspace `b34f1735-…` 写入截图种子（脚本 `apps/workbench/scripts/screenshot-deep-link-seed.mjs`，ID 见 `_deep-link-seed-ids.json`）：

| 用途 | ID / 路径 |
|---|---|
| 布局 `/agent?work=` | `a3e57735-932b-4b96-85a9-1ea90bb884f9`（现有 READY 验收任务） |
| Run 详情 | `0898fbbe-288a-493e-98ce-393ac4880ba9` → `/runs/…` |
| 完成记录 | `820ca548-60f9-469b-8fe3-6bff8d9081bb` → `/completion-records/…` |
| 产物血缘 | `ecbe6fcf-5cbe-40fe-b31b-7be578f841fa` → `/artifact-versions/…/lineage` |

**已解阻（下次补拍即可）**
- 工作台布局切换：先 `/agent?work=<layoutTaskId>`，再打开页头「更多操作」，点 `collab-layout-*`
- Run / 完成 / 血缘深链：上表 UUID
- 动态筛选 / 资料页签 / 新建项目类型：截图脚本已改为正确控件（筛选 summary、`knowledge-tab-*`、项目类型 radio）
- 目录选择（浏览器 / Agent）：打开「更换目录」→ 填 `folder-manual-root`（或 API `openWorkingDirectory`）；**不要**指望 Playwright 打开系统对话框

**仍缺**
- 系统原生目录对话框：仅 Tauri 桌面壳（`select_working_directory` / `pick_folder`）可出；自动化与浏览器永远拍不到 OS 窗体，需桌面壳人工点一次

## 补拍（第四轮，2026-10-11 15:06–15:11）

命令与入口：
- Playwright：`npx playwright test --config playwright.capture-round4.config.ts`（深链等）与 `playwright.capture-round4c.config.ts`（布局 / 目录 / 动态 / 资料；**须在当前页连接 live，不可 `goto` 后再连——凭据只在内存**）
- 桌面原生目录框：已运行的 `relay-desktop.exe` + UI Automation 点击「更换目录」→「打开文件夹」，捕获系统「选择文件夹」对话框

本轮新增约 **16** 张（文件夹现 **115** 张 PNG）。主要内容：
- 布局：`agent-layout-{split,chat,result}.png`（`/agent?work=<layoutTaskId>` 后就地连接）
- 深链：`run-detail-live` / `completion-record-live` / `artifact-lineage-live`
- 动态筛选应用：`activity-filter-applied-live`
- 资料 MEMORY 页签：`projects-live-knowledge-memory`
- 新建项目类型 radio：`projects-create-type-thesis`
- 浏览器目录：`agent-folder-change-dialog-live`、`agent-folder-manual-path`
- 桌面：`desktop-relay-window`、`desktop-folder-change-appdialog`、`desktop-os-folder-dialog`（系统「选择文件夹」）

去重：与已有图 MD5 相同的未覆盖保存（如空资料页签切换、未展开的动态筛选）。

**仍缺 / 注意**
- 无。系统目录对话框本轮已在桌面壳拍到。
- 以后自动化补拍务必「先导航到目标 URL，再在当前页点连接」，否则会落回 fixture gap。
- 种子数据未删；ID 仍见 `_deep-link-seed-ids.json`。
# 方案 2 全站页面改造提示词

日期：2026-10-02。角色：方案 2 的实施覆盖规格与接续执行输入。本文初次生成时仅交付提示词；用户随后另行下发开发指令，已有生产接入，事实见[工作台 §17.12](../docs/frontend/workbench-design.md#1712-方案-2-全站生产接入2026-10-02)与[设计系统 §9.3.1](../docs/frontend/design-system.md#931-方案-2-生产接入2026-10-02)。本轮验收、修订的是提示词，不启动产品开发，也不改变任何功能验收结论。

视觉依据为[选定的会话工作区](../docs/frontend/mockups/2026-10-02/conversation-workspace-selected.png)与[37 张配套页面/状态图](../docs/frontend/mockups/2026-10-02/README.md)。业务交互、视觉规则、数值、运行成绩分别以工作台文档、设计系统、tokens、功能验收表为准；本文只组织实施与验收。

---

你负责在 `D:/Develop/Relay-Agent` 中，依据 2026-10-02 方案 2「会话工作区 · 轻侧栏」改造现有 React 工作台。完成生产页面、相关回归、真实运行核对和受影响文档；不要停在分析、静态原型或几处字号调整。

本轮必须覆盖选定聊天页及下表全部 37 个页面/状态单元。它们包括同一路由内的页签、浮层和异常状态，不等于 37 个新路由。依赖顺序仍为共享壳和聊天区 → 列表、阅读、待处理三类样板 → 其余页面；已有实现先核验，实际缺口才修改。每个大模块自检、协调独立核验、修复复验通过后继续，不为已授权的下一批反复请求确认。

**已实施后的接续规则：** 当前共享壳栏位分离、聊天页头收紧、标题的 `titleHref` 键盘入口、三类样板及全站 `PageHeader` 推广已有源码接入。先按下表核对覆盖与当前运行行为，不重做这些结构，不把已有自检记为本次独立验收。当前成绩与未完成出口只读[功能验收表 §9](../docs/testing/overall-acceptance-2026-09-28.md#9-方案-2-全站生产接入2026-10-02)；其中历史失败、环境归属和并行改动必须在当前文件基准复核，不能直接照抄为已修复、已通过或无需处理。接续重点为现有差异整改、完整状态/业务路径核验及真实 API/Windows 证据缺口。

## 1. 开工输入与现状核对

先读取下列入口，按本次涉及范围继续定位组件、契约和测试；不要把所有历史日志读入上下文。

- [AGENTS](../AGENTS.md)、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)、[文档地图](../docs/README.md)、[功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。
- [工作台 §17.6–17.12](../docs/frontend/workbench-design.md#176-连续协作工作区2026-10-01)及[文件夹入口 §18](../docs/frontend/workbench-design.md#18-文件夹入口与对话直接执行)。重点核对 §17.8 的全站出口、§17.11 的委托入口与 §17.12 的已实施接续；§17.9/17.10 保留此前试点依据。
- [设计系统 §9–9.3.1](../docs/frontend/design-system.md#9-整套重做的组件与布局提案2026-10-01)、[唯一 tokens](../docs/frontend/design-tokens.json)、[窗口边界 ADR-007](../docs/decisions/ADR-007-windows-desktop.md)。
- [本轮效果图目录](../docs/frontend/mockups/2026-10-02/README.md)、[生成清单](../docs/frontend/mockups/2026-10-02/generation-prompts.json)、[全局功能核对](../docs/frontend/mockups/2026-10-02/function-facts-global.json)、[资料与执行功能核对](../docs/frontend/mockups/2026-10-02/function-facts-review-knowledge.json)。三份 `*-generation-results.json` 只按待改页面查偏差，不把日志中的示例当需求。
- [契约包](../contracts/README.md)、[HTTP 契约](../docs/api/http-command-contract.md)、[测试计划](../docs/testing/verification-plan.md)，定向读取受影响命令、恢复和交互部分。

运行 `git status --short`，核对现有未提交改动及当前代码。开始前给出简短的范围、文件责任、实施顺序与验证计划；本次默认不新增业务规则、API、数据库 migration、模型策略或权限。

2026-10-02 的接续起点须现场复核：

- 已有 `PageHeader`、`FactBar`、`JudgmentBar`、`DesktopTitleBar`、`RecentWorkRail` 等共享组件；全站页头已推广，`/projects` 保留紧凑页头。复用它们并核对调用分支，不重新创建平行组件体系。
- `/agent` 已收紧长任务标题，并把项目归属与当前需要合并显示；委托执行已进入「更多操作」，禁用原因常驻。该页以 §17.11 接续，不按 §17.7 的旧常驻委托布局回退。
- 文件夹入口、首条发送建立会话和执行摘要已有实现；保留「正在整理／需要补充／候选就绪／任务建立／进入执行」的真实区别，不能把 Task READY 或 Run CREATED 展示为正在写文件。
- 当前 `AppShell` 已将图标导航与近期工作拆为两栏，原侧栏宽度偏好归近期工作栏；沿现有 token、存储键与窄窗抽屉核对，不重建或重置用户偏好。现场若已有新改动，核对后接续，不覆盖他人实现。
- `PageHeader` 已有 `titleHref`，协作页标题链接通向确切任务页；用实际键盘路径核验长名称的可达性与焦点，不把悬停 `title` 属性当键盘证据。
- 设置与连接页已有后续改动：保留真实保存表单、模型验证状态/配置指纹、当前 root-bound 能力配置及目录/资源约束，不按生图时的旧能力清单回退。

## 2. 视觉与共享布局

先实际打开选定图和当前批次的页面图，再看同尺寸运行截图。保持暖白底、森林绿主操作、Sans/ui 字体、细分隔线与轻量分组；不要套用旧逐页提示词中的宋体标题或旧管理页面壳。

### 2.1 共享壳

- 桌面宽窗按「窗口标题栏 → 左侧图标导航 + 项目分组近期工作 + 页面主体」组织。导航与近期工作职责分离，不能只换图标而保留挤压聊天的结构。
- 主导航保留工作台、项目、待处理、资料；「更多入口」保留今日、全部任务、动态、收件箱；底部保留设置、连接与同步。效果图展示了展开后的次级入口，实施须验证展开、当前路由定位与窄窗入口均可达，不据此擅改默认展开偏好。
- 近期工作继续消费真实 Project/Task、原游标和范围，不创建第二套全局会话事实。保持选中项、项目折叠、续页、加载/错误与深链恢复；旧侧栏宽度偏好应有明确兼容处理，不因栏位拆分破坏拖动和键盘调整。
- 顶部后退/前进、搜索、新建与窗口控制复用现有宿主组件。浏览器不绘制可点击的假窗口控制；避免双标题栏、按钮被拖动区吞掉或重复上下文。
- 项目内导航、对象页签与全局导航各有作用域，不合并成一份菜单。全局页面的面包屑不冒充某个项目工作台。
- 宽度不足时按既有窄窗模式收纳导航、切换内容区域；短窗口底部入口和主操作可滚达，不靠整体缩小字体塞内容。

图中栏宽、留白和字体尺度是视觉推荐。不要把图片物理像素直接当 Windows DIP，或把观察到的约 100/340 像素栏宽硬编码为所有视口尺寸。必要的新数值只进入 `design-tokens.json` 并由现有 token 消费链使用；不复制第二份色值、尺寸或比例表，不为单页调整全局标题字号。

### 2.2 聊天与成果

- 页头只保留紧凑名称、真实状态、当前需要与本页首屏主操作。任务说明、技术详情、模式及普通工具入口按需展开，展开不推高页头。长中文任务名不会挤掉状态，完整名称可通过键盘打开。
- 普通状态下消息从完整首段开始，输入器完整位于对话底部。明确消息、正文与主区的滚动 Owner，正确设置伸缩及 `min-height: 0` 等布局约束，避免祖先裁切、层叠遮挡和嵌套滚动互相抢空间。
- 对话、成果、分栏、可调分隔条和窄窗区域切换保留现有行为；无成果时按既有空态收敛，阅读版本切换不会改变审批目标。判断条位于正文纸面外，正文末尾和审批按钮都可达。
- 输入器保持单卡结构，资料数量、意图、缓存/上下文指标和发送动作使用真实投影。缺采集显示未采集，不填 `0%`；模型离线不影响已有消息和正文阅读。
- 上翻后新增消息、SSE 更新或面板尺寸改变不抢阅读位置；「回到最新」恢复跟随。收起成果区、开关菜单和切换会话不丢草稿、原未决命令或阅读意图。
- UNKNOWN、PARTIAL、控制请求等待安全点、执行失败、权限/归档写阻断、读取失败、审批风险、冲突和未决命令必须可发现且完整可读，不能统一塞入「更多」。安全状态需要空间时允许自然滚动。

### 2.3 其他页型

列表以标题、范围/筛选、列表与分页为主体；阅读以名称、确切版本、正文和来源为主体；待处理以对象、正文、条件、影响与判断为主体；设置和创建页保留自然长表单。不要把每个页面都变成聊天三栏，也不要为统一外观给每个页面强加 `FactBar`。去掉重复说明前先确认它不承载唯一范围、错误或权限事实。

## 3. 完整页面覆盖

表中的图片均位于 `docs/frontend/mockups/2026-10-02/`。按现有路由和组件落地；同页状态复用同一命令 Owner，不因图片另建业务流程。下表覆盖本轮 37 项，选定聊天图另外作用于 `/agent`。

| 编号 | 图片 | 当前入口 / 承载组件 | 必须保留的功能与状态 |
|---|---|---|---|
| UI-01 | [today.png](../docs/frontend/mockups/2026-10-02/today.png) | `/today`；`TodayView` | 今日范围、焦点/待处理入口、真实统计、加载和读取失败 |
| UI-02 | [project-overview.png](../docs/frontend/mockups/2026-10-02/project-overview.png) | `/projects/:id?skill=overview`（默认可省略）；`ProjectSkillView` | 项目概况、状态、目标和该页已有 Skill 页签 |
| UI-03 | [development-workbench.png](../docs/frontend/mockups/2026-10-02/development-workbench.png) | `/projects/:id/workbench/development`；`ProjectWorkbenchView` | 开发工作台、原 AI 入口、成果和工具能力限制 |
| UI-04 | [thesis-acceptance.png](../docs/frontend/mockups/2026-10-02/thesis-acceptance.png) | `/reviews?id=<reviewId>`；`ReviewDecisionPanel` 的 `CRITERION` 态 | 论文确切正文、验收条件、依据与人工判断 |
| UI-05 | [projects.png](../docs/frontend/mockups/2026-10-02/projects.png) | `/projects`；`ProjectsView` | 项目范围、搜索、分页、归档与读取失败；接续已有页头试点 |
| UI-06 | [create-project.png](../docs/frontend/mockups/2026-10-02/create-project.png) | `/projects?view=create`；`LiveCreateProjectFlow` | 分步创建、名称/类型、蓝图意图、资料独立登记、校验与原回执 |
| UI-07 | [tasks.png](../docs/frontend/mockups/2026-10-02/tasks.png) | `/tasks`；`TasksView` | 全局任务范围、仅已加载页过滤、分页和既有新建入口，不新增排序控件 |
| UI-08 | [inbox.png](../docs/frontend/mockups/2026-10-02/inbox.png) | `/tasks?tab=inbox`（`/inbox` 为别名）；`TasksView` | 未归属项目的人工任务、范围切换、过滤、刷新/续页与打开原任务；不新增归类写入口 |
| UI-09 | [project-tasks.png](../docs/frontend/mockups/2026-10-02/project-tasks.png) | `/projects/:id/tasks`；`ProjectTasksView` | 项目作用域、搜索、任务选择、状态/执行者/依赖、合法开始与新建、原回执恢复 |
| UI-10 | [task-detail.png](../docs/frontend/mockups/2026-10-02/task-detail.png) | `/tasks/:id`；`TaskSkillView → TaskDetailView` | 任务定义、验收、依赖、版本、合法主操作与执行入口 |
| UI-11 | [artifact-editor.png](../docs/frontend/mockups/2026-10-02/artifact-editor.png) | `/tasks/:id?tab=artifacts`；`ArtifactPanel` 编辑态 | 人工编辑、版本基线、草稿、保存新版本与只读原因 |
| UI-12 | [general-workbench.png](../docs/frontend/mockups/2026-10-02/general-workbench.png) | `/projects/:id/workbench/general`；`ProjectWorkbenchView` | 通用工作台的任务、成果与原 AI 入口 |
| UI-13 | [thesis-workbench.png](../docs/frontend/mockups/2026-10-02/thesis-workbench.png) | `/projects/:id/workbench/thesis`；`ProjectWorkbenchView` | 论文资料、草稿、完整正文、确切版本与原 Assist 导航 |
| UI-14 | [knowledge.png](../docs/frontend/mockups/2026-10-02/knowledge.png) | `/knowledge`；`KnowledgeView` | 全局资料/记忆/决定/规则、筛选和既有收录入口 |
| UI-15 | [knowledge-detail.png](../docs/frontend/mockups/2026-10-02/knowledge-detail.png) | `/knowledge?kind=KNOWLEDGE&item=<id>&version=<n>`；`KnowledgeReader`，项目资料亦可使用相应深链 | 完整正文、来源、历史版本、读取失败与无模型阅读 |
| UI-16 | [project-information.png](../docs/frontend/mockups/2026-10-02/project-information.png) | `/projects/:id/knowledge`；`KnowledgeView` | 项目资料/记忆/决定/规则、原作用域与版本 |
| UI-17 | [activities.png](../docs/frontend/mockups/2026-10-02/activities.png) | `/activity`（`/activities` 为别名）；`ActivityView` | 动态筛选、真实时间/事件、分页与对象追溯 |
| UI-18 | [run-control.png](../docs/frontend/mockups/2026-10-02/run-control.png) | `/runs/:id`；`RunView + RunControlPanel` | 执行详情、步骤、合法控制；暂停请求与已暂停分开 |
| UI-19 | [run-paused.png](../docs/frontend/mockups/2026-10-02/run-paused.png) | 同 `/runs/:id` 的 `PAUSED` 态 | 安全点、恢复与接手准入；暂停不代表已获得执行权 |
| UI-20 | [run-unknown.png](../docs/frontend/mockups/2026-10-02/run-unknown.png) | 同 `/runs/:id`；`FileWriteDispositionPanel` | 原动作/回执与核对入口；UNKNOWN 不盲重试 |
| UI-21 | [reviews.png](../docs/frontend/mockups/2026-10-02/reviews.png) | `/reviews` 或 `?id=<reviewId>`；`ReviewsView + ReviewDecisionPanel` | 待审列表、确切目标正文、过期/失权、判断与写入回执 |
| UI-22 | [action-approval.png](../docs/frontend/mockups/2026-10-02/action-approval.png) | 同 `/reviews?id=<reviewId>` 的 `ACTION_APPROVAL` 态 | 特定动作批准、实际目标/差异/风险与绑定身份；见下方校准 |
| UI-23 | [connections.png](../docs/frontend/mockups/2026-10-02/connections.png) | `/connections`（`/settings/connections` 为别名）；`ConnectionsView` | 全局选择项目后进入连接；连接、能力与权限分开 |
| UI-24 | [settings.png](../docs/frontend/mockups/2026-10-02/settings.png) | `/settings`；`SettingsView` | 本设备真实保存表单、展示偏好、模型验证六态/配置指纹/最近验证与错误分类；Worker 未探测不能以 API 诊断代替 |
| UI-25 | [search.png](../docs/frontend/mockups/2026-10-02/search.png) | 顶栏/Ctrl+K；`CommandPalette + AppDialog`，无 `/search` UI 路由 | 既有资料检索与快捷操作、键盘选择、范围与合法动作 |
| UI-26 | [version-conflict.png](../docs/frontend/mockups/2026-10-02/version-conflict.png) | `/tasks/:id?tab=artifacts`；`ArtifactPanel` 冲突态 | 409/版本冲突，保留本地草稿与原命令 |
| UI-27 | [task-completed.png](../docs/frontend/mockups/2026-10-02/task-completed.png) | `/completion-records/:id`；`CompletionRecordView` | 真实 CompletionRecord、绑定产物/验收/来源，完成不靠模型判断 |
| UI-28 | [delegate.png](../docs/frontend/mockups/2026-10-02/delegate.png) | `/tasks/:id?tab=runs`；`TaskDelegatePanel`，协作页亦复用 | Task 状态/执行权/START 准入、确切资料冻结、可选受管读取或 Mock 动作、禁用原因与原回执；协作页收进更多操作 |
| UI-29 | [task-create.png](../docs/frontend/mockups/2026-10-02/task-create.png) | `/tasks?view=create`；`CreateTaskView`，保留 `project`/`tab=inbox` 查询 | 创建任务、选择项目与执行准备；不自动启动 Run |
| UI-30 | [project-blueprint.png](../docs/frontend/mockups/2026-10-02/project-blueprint.png) | `/projects/:id?skill=blueprint`；`BlueprintView` | 项目蓝图提议、正文、基线与原接受入口 |
| UI-31 | [task-definition.png](../docs/frontend/mockups/2026-10-02/task-definition.png) | `/tasks/:id?skill=definition`；`TaskDefinitionView` | 完善任务定义的既有 Skill 与提议，不绕过事实入口 |
| UI-32 | [verification-plan.png](../docs/frontend/mockups/2026-10-02/verification-plan.png) | `/tasks/:id?skill=verification`；`VerificationPlanView` | 读时派生的只读验收预览与确切条件，不是冻结运行计划；建议经原服务端合并确认区处理，未执行不显示通过 |
| UI-33 | [project-resume.png](../docs/frontend/mockups/2026-10-02/project-resume.png) | `/projects/:id?skill=resume`；`ProjectResumeView` | 项目接续、真实基线/变化/下一步，缺基线明确说明 |
| UI-34 | [attention-queue.png](../docs/frontend/mockups/2026-10-02/attention-queue.png) | `/tasks?tab=attention`；`AttentionQueue` | 人工待处理汇总、类型/原因/状态与原对象深链，无批量批准 |
| UI-35 | [project-connections.png](../docs/frontend/mockups/2026-10-02/project-connections.png) | `/projects/:id/connections`；`ProjectConnectionsView` | 项目连接/权限、归档和撤销限制、原命令 |
| UI-36 | [artifact-lineage.png](../docs/frontend/mockups/2026-10-02/artifact-lineage.png) | `/artifact-versions/:id/lineage`；`ArtifactLineageView` | 确切版本来源、比较/锁定、影响检查、修改候选/组和组合检查单 |
| UI-37 | [project-assist.png](../docs/frontend/mockups/2026-10-02/project-assist.png) | `/projects/:id?skill=assist`；`AssistView targetKind="PROJECT"` | 项目作用域、会话/选源/意图、提议正文与接受 |

实施前校准图片偏差：

- UI-22 的清单名称仍写「特定 Git 动作批准」，图片实际展示文件写入审批。以服务端 `action_type`、实际文件目标、changeset、版本/hash 和 Review 绑定为准；不凭标题扩成 Git commit、push、任意 Shell 或通用写权限。
- UI-03 中 Git diff、受控测试与 Coding CLI 的当前入口/不可用说明保留；有真实接口和准入依据才显示结果，不能因图中示例输出造成功日志。
- UI-23 的「连接与同步」是既有导航名称；全局入口先选择项目，当前没有独立同步动作。不要新增虚假的同步按钮或把连通显示为已授权。
- UI-23/35 的生图依据只列了早期四项能力，当前连接页已列八项。保留现有 FILE_WRITE、GIT_READ、GIT_WRITE、CLI_RUN 等配置入口；目录绑定与策略资源要求按当前 `rootBoundCaps` 与服务端契约核对，FILE_READ 的根目录约束同样保留。配置入口可用不等于 Git/CLI 动作触发协议、Git diff 或交互终端已接入，不能据配置成功画执行成功。
- UI-08 收件箱是未归属项目的人工任务，UI-34 是人工待处理汇总，UI-21 是 Review；三者语义不互换。
- UI-02/30/33/37 复用项目 Skill 页面四个内页签和打开工作台入口。UI-02 图多画的项目五导航不能直接叠到这些页面；五导航仅在当前实际使用 `ProjectNav` 的页面保留。
- UI-12/13/03 当前是只读工作视图，通过既有导航打开 Assist。图中的内嵌候选/输入属于布局建议；如调整为内嵌呈现，必须复用当前 Assist 组件和原 Task/Project 身份，不能新建会话状态、发送/保存协议或绕过原接受入口。
- UI-06 的 Pack 当前是固定注册表的只读目录，没有选择、启用或编辑组合动作。已有真实创建流程保持名称/类型写入、目标暂存蓝图意图、创建后资料独立登记的边界，不能把它们并成图片暗示的一次原子创建。
- UI-16 的 `project-information` 文件名指项目资料；`function-facts-global.json` 中同名条目却指项目总览。以本表、生成清单、资料功能核对与当前 `KnowledgeView` 映射为准，不能据此新建项目信息编辑页。
- 图中的侧栏「搜索项目或任务」没有当前全量检索接口；现有命令面板只检索四类资料。保留现有可用检索与范围说明，记录这项图片差异，不造可提交的假入口或用资料检索冒充任务搜索。
- UI-17 的技术 ID 筛选按现有输入控件；UI-24 保留页签切换，不把摘要画成同时可用动作；UI-35 的页面顺序属于服务端模板只读，默认工作台类型沿现有保存命令，不增加拖拽配置；UI-37 的纸夹图标不授予上传能力。
- UI-20 的冻结文本差异不是实时磁盘 Git diff；人工处置结束旧 Run 并保留当前文件/候选残留，不确认全部写入成功。当前未接入的 Run 级独立资源查询和 Worker 可执行性探测仍明确受限。
- 生成图中的漏绘导航、示例计数/日期、文案和按钮位置均按当前代码、契约及生成偏差校准；完整入口比逐字照抄图片更优先。字体和比例需真实窗口验证，不以图片拟合覆盖唯一 tokens。

## 4. 分批实施与责任

1. **基线与映射。** 在当前源码上建立「图 → 路由/查询/页签 → 组件 → 数据/命令 → 本批验证」的覆盖表，标出已实现、待调整和当前未接入能力。沿用现有预览和测试设施采样，只保存本批必要图片与短摘要。
2. **共享壳与聊天。** 复核已有 `AppShell` 两栏、共享样式及 `/agent` 的紧凑任务头、文件夹入口和消息/输入布局；修正实际差异，回归所有导航、深链、近期工作续页、显示偏好、草稿保护与异常常驻。
3. **三类样板。** 列表用 `/projects`，阅读用资料详情，待处理用 `/reviews` 的阅读/判断状态。分别对照 UI-05、UI-15、UI-21/22，验证当前共享原语及读写行为；已有样板通过后跳过重做，不能以三个样板代替完整覆盖。
4. **完整覆盖复核。** 对其余列表与创建表单、项目/任务详情、三工作台、编辑/来源/完成凭据、知识、Skill/Assist、设置/连接逐项核验；查漏修正 Run、UNKNOWN、暂停/接手、冲突等关键状态。可以按真实依赖调整内部顺序，但覆盖表不得漏项，不能只凭组件已接入勾选业务通过。
5. **整体回归与交付。** 在最终文件基准复核全部 37 项和聊天页，运行相关自动化、浏览器、真实 API 及 Windows 检查；修正明显布局差异与交互回归，同步实际状态后交付。

当前 Agent 负责协调与共享文件。确有互不冲突的大子任务才派发；子代理显式使用 `model: "gpt-6.1-sol"`，不得选择锁定其他模型的角色或静默降级。每次写清拥有的文件、允许范围、验证出口，并告知不是唯一参与者、不得回退他人改动。`AppShell`、全局样式、tokens、路由与文档汇总由一个 Owner 维护，页面执行者按已确定接口协作；不为每次小改另派代理。

## 5. 数据与业务边界

- 保留 React/TypeScript/Vite、Tauri 和既有后端组合、路由/查询语义、`data-testid`、查询客户端和命令组件。允许必要展示重组，不引入新 UI 框架、第二套状态库或业务缓存。
- Live 使用真实后端事实，fixture 只在显式测试/预览中使用。服务故障不能自动切示例，图片名称/统计/日期不能硬编码到生产页面。
- 写入沿原 Application Owner，遵守 `allowed_actions`、`command_id`、`expected_revision`、确切版本与权限；提交中防重入，超时待核对保留原 ID。查询按作用域/目标/版本隔离，晚到响应不覆盖新选择，SSE 不重复订阅。
- Task、Run、Session、执行权、Review、Verification 和完成凭据分开。模型回复、提议接受、验证通过、暂停请求和操作批准各自不冒充任务完成或接手。
- 保存产生不可变新版本；验收条件变化、权限撤销、失权、归档、冲突、读取失败和回执待核对保留真实反馈与草稿。所有权限原因只复用既有判定，不在页头另算一套。
- 文件夹入口保持打开目录与讨论的轻路径；显示当前目录不授予写入权，明确执行请求仍经已有候选/Task/Run 应用链。页面读取和打开面板不发送写命令。
- 不为这次 UI 对齐新增后端功能、migration、任意终端、远程配对、自动调度或新模型调用。真实 Provider 与副作用按当前明确授权范围处理，不把历史授权扩大为本轮演示许可。发现必要契约差异时说明具体缺口，继续不依赖它的页面工作。

## 6. 验证与完成条件

在 `apps/workbench` 目录运行现有命令，按文件变化选择有意义的定向测试；共享壳完成及最终交付需要受影响的完整工作台回归。

```sh
npm run typecheck
npm run build
npm test
npm run test:browser
npx playwright test --config scripts/playwright.ui-align.config.ts
```

既有视觉脚本主要覆盖 `/agent`，执行成功不证明 37 项都通过。按本轮页型/状态扩展现有采样，或用现有测试设施补齐必要场景；不要另建未接生产的独立应用。组件定向检查优先复用 `navigation`、`recentWorkPagination`、`sidebarResize`、`workBreadcrumbScope`、`collaborationWorkspace`、`collaborationLayoutPreferences`、`folderFirstConversation`、`delegate-task`、`draftGuardCoexistence`、`knowledgeReading`、`reviews`、`run-ui1820`、`run-file-write-disposition` 等相关测试。不能删失败断言或改测试只让新 DOM 自证通过。

当前必需检查失败就保持该出口未通过，不能用「既有失败」或「其他 Agent 改动」放行。先区分真实回归、环境错误、计时偶发与过时断言；清楚的缺陷按本次受影响范围修复，断言与契约冲突时核对依据后修正测试并保留原失败说明，环境问题按相同有效配置复跑。修复后重跑失败项与受影响回归；最终结论绑定稳定的当前文件基准，旧状态下类型/构建通过不证明最终树通过。

必须逐项核验：

- **视觉与空间：** 同尺寸并排查看目标图和真实截图，检查导航/近期工作/主体比例、紧凑标题、密度、正文/输入/判断区及状态可读性。样本包含选定图相应宽窗、1280×720、960×640 和窄窗；宽窗采样按具体参考图原始尺寸设置，并记录标题栏是否计入客户区。普通默认分栏、普通判断且详情收起时沿用 §17.6 的 1280×720 基准，聊天记录与成果正文各至少 240 CSS px；安全异常和短窄窗以内容/操作可滚达为准。逐项标明视觉达标、状态核验、业务核验与未覆盖项，明确重要差异及原因，不以全局 DOM 接入或无溢出代替按图目视核对。
- **输入与键盘：** 中文长名称、长消息/表格/正文、中文 IME 的 Enter/Escape、可见焦点、菜单/详情关闭后回焦点、键盘全文名入口、tab 导航、分栏和减少动效。合成 composition 事件不能当真实 Windows IME 通过。
- **连续工作：** 上翻不抢滚动、回到最新、切任务/会话/区域后草稿和未决命令保留；刷新/重连深链不串作用域；长列表游标续页、归档/失权缓存和导航可达。
- **状态：** loading、刷新、empty、读取失败、disabled 及原因、提交中、401/403、409、422、失效审批、UNKNOWN、PARTIAL、等待安全点、取消/接手与完成；不能用统一红条或 loading 代替真实区别。
- **真实业务：** 受影响的既有创建/编辑/判断/控制路径在隔离真实 API/PG 上核验回执与重读结果。浏览器拦截成功只证明 fixture 行为；不为每张图额外调用真实 Provider 或触发外部副作用。
- **Windows：** 按现有桌面构建与隔离验收入口验证确切新包的实际窗口、原生目录选择、标题栏、100%/目标 DPI 和独立内容缩放、真实中文输入、窄/短窗、关闭/重开后恢复。复用 [start-acceptance-session.ps1](../apps/desktop/scripts/start-acceptance-session.ps1) 等已有流程，先核对包和会话身份再操作，不使用开发 fixture 入口替代业务验收，不随意操作用户库。

大模块由执行者自检后，协调方在当前产物上独立核验；有问题修复复验再推进。只记录实际运行的结果；环境或能力缺失时明确未运行项与原因，继续完成独立可做部分，但该出口保持未验收，不能宣称完整桌面交付。

## 7. 文档与最终汇报

结束前执行 Documentation Impact Check，仅更新受影响的已有文档：交互归 `workbench-design.md`，视觉归 `design-system.md`，数值归 `design-tokens.json`，功能成绩只归 `overall-acceptance-2026-09-28.md`，模块/下一步只归 `CODEX_NEXT_STEP.md`。默认无需求、架构、API、数据库变化；若实际出现差异，按项目规则说明 Breaking Change、责任和依据，不为视觉任务创建无意义 ADR 或空文档。

在仓库根目录运行 `node scripts/check-docs.mjs`，并人工核对事实与当前/历史边界。完整过程输出和批量截图放忽略的 `output/acceptance-raw/<本次任务>/`；只保留必要短摘要和有意义的失败样本，不每轮新增报告或全仓 hash 清单。

最终汇报包含：改动及原因、37 项与聊天页的实际覆盖、运行命令/环境/基准和结果、独立核验与修复、文档同步、未运行项及剩余限制。实现、自检、独立核验、真实 API、Windows 与安装验收分别表述；页面截图、旧成绩或目录包不能自动升级为整体交付。不要未经当前用户指令提交/push Git、对外发送项目材料或创建新的长期 goal。

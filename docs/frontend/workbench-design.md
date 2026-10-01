# 工作台与前端交互设计

> 2026-09-24：既有页面已迁入 React，保留原路由/query、视觉与人工业务交互；逐页覆盖和自检见 [M02 开发记录](../development/m02-react-migration.md)。本文件的业务交互规范不因框架迁移改变；真实 Windows 窗口仍须单独验收。

更新：2026-10-01。状态：交互规范含 Proposed 细节。用户已选择「工作主线」作为整套 UI 重做基准，第 17 节的共享页壳、协作区和七类业务页面已有实现，最后视觉 QA 正在收口；第 14、16 节保留此前方向与阶段边界。保留 General、Thesis、Development 三套内置工作台、原路由/query、状态和命令 Owner。实际验证只看[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，本轮尚不代表全部页面/状态、真实 Windows 或 M01–M07 任一模块总出口通过。

角色：页面结构与业务交互主文档。视觉/组件规则见[设计系统](design-system.md)，数值见 [tokens](design-tokens.json)；技术依赖见[技术选型](../architecture/技术选型.md)。视觉组件不得反向改变本文的业务权限与状态语义。

## 1. 前端与分发推荐

工具链、状态/查询库及组件依赖按[技术选型](../architecture/技术选型.md)选择，不在本文重复版本表。UI 状态只包含当前选择、面板展开、编辑草稿；服务端查询缓存不成为一套可独立修改的 Task 状态。精确版本及本轮采用证据见 M01/M02 开发记录。

用户已确认 Windows 可安装应用、独立窗口和启动入口。目标 React 页面在桌面壳中加载随包静态资源，业务经已鉴权 loopback HTTP 调用本机 API；来源配置与开发 Vite 分开，不能假定生产同源。框架与生命周期见 [ADR-007](../decisions/ADR-007-windows-desktop.md)及[部署设计](../deployment/本机部署.md)，仍为 Proposed。选择依据本项目需求与验证，不继承 Manga 的技术栈。

若已有正式前端工程，编码 Agent 先检查兼容性，不为遵循草案机械重写；记录决策差异。同一查询缓存只保留一个 Owner，失效/重取遵守 revision，旧响应不得覆盖新状态。组件库默认样式必须映射本项目语义 token；长列表是否虚拟化按实际需要决定。

维护准入的 `MAINTENANCE_DRAINING/MAINTENANCE_UNAVAILABLE` 按服务端 code 显示固定中文说明，不直接呈现底层配置明细；提示新操作暂不可用及仍可读取/请求取消，不能据此把在途工作显示为已停止。响应丢失仍按原命令回执核对规则处理，不归因为维护拒绝。首片没有维护状态页或 UI 开关，操作入口与边界见[部署说明](../deployment/本机部署.md#draining-新工作准入门)，实际前端/桌面验证只看功能验收表。

## 2. 信息架构与路由

目标信息架构按第 14 节围绕继续工作、表达目标、执行进展、产物与人工判断组织；主入口、导航分层和面板布局为 Proposed。原 Today、Projects、Tasks、Knowledge、Activity 同级导航作为既有基线保留说明，不再作为未来改造必须照搬的要求；旧路由和深链接仍需兼容。Goal 与 Artifact 不因本次调整新增一级管理页，聊天也不成为另一套业务事实源。

下表是既有路由与对象映射，不表示每个对象都必须占一个一级导航或独立全屏页面。当前源码根路由进入 `/projects`，独立 `/agent` 读取已有 Assist 会话；这些实现事实不等于第 14 节的一体协作体验已经完成。

| 路由 | 主内容 | 持久事实 |
|---|---|---|
| /agent | 协作工作区：近期工作、持续对话、确切产物、人工判断与完成确认；选择确切任务目标 | 原 Task/Run/Review/Artifact/Assist 事实；不新增执行权，不建第二套状态 |
| /today | 焦点、可开始/继续、等待/阻塞 | Pin/Later/Focus 的用户选择 |
| /inbox | 跳转至 `/tasks?tab=inbox`，查看无项目人工任务、快速录入 | Task，不自动建 Project |
| /projects | 项目列表、类型与归档 | Project |
| /tasks | Workspace 任务列表，按项目/状态/模式筛选 | Task 查询投影 |
| /knowledge | Workspace 资料，按项目/来源/最近筛选 | Knowledge 查询投影 |
| /activity（/activities 同入口） | 全局业务事件，按 Project/Task/Run 与时间筛选、游标续页；当前只按 actor kind 展示 | Activity 只读查询投影 |
| /projects/:id/overview | State、关键产物/决定、下一步 | State 及带版本投影 |
| /projects/:id/tasks | 任务列表、筛选、详情 | Task/验收/执行者 |
| /projects/:id/knowledge | 资料、Memory、Decision、Rules 分页签 | 各自类型 Owner |
| /projects/:id/workbench/:kind | 内置场景页面组合 | 只有展示选择，kind=general/thesis/development |
| /projects/:id/connections | 项目 Connection、受管资源与 PermissionPolicy 设置 | Gateway 设置命令；创建连接不授予权限 |
| /tasks/:id | 任务详情、产物、Run、验收 | Task 主视图，无 Project 也能打开 |
| /runs/:id | 步骤、等待、控制请求、证据 | Run/调用/验证查询 |
| /artifact-versions/:id/lineage | 确切产物版本及其直接父来源 | Artifact Lineage 只读关系投影 |
| /completion-records/:id | 一次完成提交时的验收、人工接受或自动验证及产物版本 | CompletionRecord 确切历史只读投影 |
| /reviews | 待判断 Inbox | Review；按紧急性和时间排序，不自动批准 |
| /connections、/settings/connections | 当前实现为 Project ID 入口；连接健康与执行配置属后续范围 | 入口不写入，转至项目级设置 |

页壳：左侧全局导航，中央工作内容，右侧可收起 AI Panel；窄屏右侧变抽屉，关键按钮始终可键盘触达。项目名、Task ID/标题、当前版本与执行者在操作附近可见，防止跨项目误操作。

2026-09-28 标题栏接续：[完整窗口 v2](mockups/2026-09-28/README.md)左侧不显示 `Relay Agent`，使用后退、前进、搜索和新建任务。后退/前进只遍历本次应用内已观察到的路由历史，无可用历史时禁用；不根据浏览器总历史长度猜测可返回页面。搜索复用同一 Ctrl+K 面板和作用域；新建任务只打开既有创建流程，在当前项目路由下预填项目 ID，并由原表单允许核对、更改及提交前验证，不自动提交。导航继续经过未保存草稿离开保护与原准入约束，不建立第二套业务命令。代码已接入，真实 Windows 操作仍以确切产物验证为准。

中间空白支持拖动和双击最大化/还原，业务按钮区域排除拖动；右侧窗口按钮调用宿主操作。关闭仍按原草稿和运行安全退出流程，不直接销毁绕过生命周期；失败就地显示错误。页面切换、连接中和服务失败不应让窗口控制消失。后续验收覆盖无历史禁用、搜索/创建复用、草稿保护、键盘操作、缩放不遮挡及真实 Windows 拖动/双击/最小化/还原/关闭；本轮静态图未执行这些运行时验收。

Ctrl+K 提供搜索、新建任务/项目、打开项目、收件箱快捷入口、委托当前任务和打开 Activity；操作复用 GUI 的准入条件。原总纲的 Start Focus 与后置完整 Focus Mode 有歧义，暂不据此实现计时/Work Session，待确认项见设计审计。

2026-09-26 M05 全局入口开发切片：`Ctrl+K` / `⌘K` 与顶栏按钮打开同一命令面板，Esc 关闭、Tab 保持焦点在面板内并在关闭后返回触发控件。搜索只调用当前 `/search` 支持的 Knowledge/Memory/Decision/Rule，按 Workspace 或确切当前 Project 作用域读取，每页最多 20 条并提供游标续页；结果显示类型、版本、摘要、来源引用和作用域，点选后通过资料页查询确切条目。Project/Task 没有全局搜索端点，面板不伪造其结果；输入明确 Project ID 时先 `GET /projects/:id` 核对再打开。新建项目/任务只导航到原真实表单，不由面板写入。当前 Task 由单读和 `allowed_actions` 提示决定是否展示可用 Delegate 导航，点击只进入 Task 的委托确认区；当前 Run 与 OPEN Review 通过现有查询定位并打开原页，不由面板直接委托或审批。当时 Activity/Today 尚无 API，随后 P13/P15 切片已按下段接入。fixture 不调用真实搜索，关闭或切换范围后旧搜索结果不能覆盖新范围。这些是组件开发自检范围，不是独立业务或桌面验收。

2026-09-26 M05 P13 Today 前端开发切片：live `/today` 使用 `GET /today?date&timezone` 的服务端投影，按返回顺序分别展示 `eligible_items`、`blocked_pinned_items` 和其余 `waiting_items`；受阻置顶是等待组子集，页面不重复计数为额外候选。每项展示 `reason_codes`、`evidence_refs`、`allowed_actions`、Task revision、优先级和截止本地日期/时区。只有 eligible 且服务端允许 `START` 的任务显示开始入口，该入口仍打开 Task 详情供用户确认。Pin、Later、Focus 只使用对应选择命令；Focus 同时显示选择原时区与查询时区，跨时区 `active_in_query=false` 时不暗示该 Focus 正在影响排序。Task 优先级/截止编辑使用 Task revision；选择命令使用 Today 全局 selection revision。409 冲突保留表单和原 command_id，重读版本后由用户明确重新提交；响应不明保留原 ID/载荷，先查命令回执，404 后才允许同 ID 重试。切日期/时区重查，旧查询结果不覆盖新范围。fixture 明示无真实 Today 投影，不生成假排序。该切片仅为前端开发自检，尚非真实桌面或 M05 独立验收。

同日 M05 P15 Activity 前端开发切片：live `/activity` 和 `/activities` 读取 `/activities` 的服务端业务事件，按 Project/Task/Run UUID 与本机输入后转为 UTC 的 `[from,to)` 时间区间筛选，按服务端游标继续读取，不据单页数量推断历史总量。仅显示服务端安全摘要、actor kind、事件类型、时间和原命令 ID；不直接展示 actor_ref 或原始 fact_refs。typed entity_refs 只在当前已有页面且服务端已核实同 Workspace 可见时提供 Project/Task/Run/Review/Artifact Version/Completion 链接，目标页面仍重新鉴权；其他类型明确没有直达页，不拼猜 URL。筛选、刷新、权限失效或路由变化会清空旧结果并隔离迟到响应。fixture 不生成 Activity。此处为前端开发自检，不等于完整审计或桌面验收。

同日 M05 P15 Run Trace 与 Artifact Lineage 前端切片：live Run 页按需读取 `/runs/:run_id/trace`，分别列出服务端 Step/Attempt、模型调用元数据、Context Manifest 与可见来源、验证会话和检查、Review 决定、Gateway Operation/Invocation、Run Effect。`result_available` 仅表示有结果引用，不代表成功；Review 的 APPROVE 不代表外部动作已执行，Effect UNKNOWN 仍需按原动作核对。Manifest 来源不可用时不展示来源 ID、版本或 hash，也不展示模型隐藏思考或原始调用正文。Task 产物版本、Activity 的 Artifact Version 引用及 Trace 验证目标可进入 `/artifact-versions/:id/lineage`；该页只呈现服务端确切 typed direct_parents 关系与可读父版本，不由标题、时间或版本号推断因果。不可用父来源不展示 ID；可读的 CompletionRecord 父来源链接确切详情，其他没有确切页面的父类型保持文本；历史正文仍由原内容接口单独鉴权读取，不能以最新版替代。刷新、目标切换及 403/404 会清空旧证据并隔离迟到响应；fixture 明示没有真实 Trace/Lineage。该切片经前端定向开发自检，独立业务和桌面验收仍后置。

同日 M05 P15 CompletionRecord 前端切片：live `/completion-records/:id` 只读服务端确切历史完成凭据，区分当前指针与重开后的旧凭据，列出当时验收版本的目标、输出约束、条件与来源，人工接受或自动验证事实，以及当时关联的产物版本/sha256。可从 Task 当前完成指针、项目恢复页和 General 工作台的 State `completed_highlight_refs`、Activity 的 Completion 引用进入；旧凭据重开后仍从 Activity 进入，不依赖 Task 当前指针。来源 Run 和确切产物版本分别链接原 Run 与 Lineage 页并重新鉴权。任一历史引用 `UNAVAILABLE` 时只显示不可用，不显示该项 ID、正文或 hash，不拿当前最新版补齐；403/404、刷新和切换范围清旧证据并隔离迟到响应。fixture 不制造真实凭据。这是组件开发自检，独立业务与 Windows 验收后置。

完成凭据呈现补充（2026-09-30）：主区先展示完成依据、本轮接受的确切版本、当时验收修订、当前指针及本设备时区下的提交时间，再展开历史验收与来源规格。只有 `is_current=true` 使用“这项工作已完成”；历史记录使用“历史完成依据”，尚未读到凭据时仅称“完成凭据”。右栏提供确切版本、当前 Task 与 Activity 只读入口；“前往任务重开”只是导航，仍须在原任务入口明确提交。窄窗沿用只读操作抽屉，不复制业务命令 Owner。

2026-09-30 M04 首输出追溯：原 Run Trace 模型调用区显示“首文本回调”和“首预览写入”的服务端观察时间，缺失或旧服务字段显示“未记录”。两值绑定原调用，不从完整草稿或结束时间推断；预览消失后仍可查看历史观察时间。窗口正文进入视口的时间由独立 Windows 验收观测，不能由这两个时间替代。

首次使用只收集项目名、目标、可选导入。无模型连接时仍能创建项目并手工录入状态；连接模型后提供 Initial State、轻量 Milestone、Next Action、Workbench 建议，用户查看并 Apply 后才写入对应事实。建议过期需重读，不自动应用，不把模型配置作为创建项目前置条件。

当前真实 CreateProject 命令仅持久化名称和 Project Type。`/projects?view=create` 的 live 引导允许填写可选项目目标与选择本地 `.md/.txt`；目标按 API 地址、Workspace 和新 Project ID 暂存为待预览的人工蓝图意图，刷新后可在该项目蓝图页恢复，直到用户明确生成服务端 `USER_DRAFT` 候选；它不是已确认 Goal，也不自动请求模型或应用蓝图。可选资料只接受非空 UTF-8 文本，最多 256 KiB；创建项目成功后，单独以 `MANAGED_TEXT` Knowledge 命令登记，失败不回滚 Project。文件名、媒体类型、文本及 SHA-256 与确切 Project ID、command_id 一起冻结；响应不明先查原回执，未找到才允许同 ID、同载荷重试。成功登记、明确取消或结束本次引导并新建其他项目时清除当前创建草稿中的资料正文；原资料命令待核对时不能丢弃该草稿。会话存储不可用时阻止可能丢草稿的创建。fixture 仍为示例预览。以上是 2026-09-26 的前端实现边界，资料不会在此流程自动发送给 Assist 或模型。

2026-09-20 蓝图交互补充（Proposed）：首个 [Relay Skill](../architecture/relay-skills.md) 将此流程命名为“从目标创建项目蓝图”。先创建最小项目，再生成建议；拒绝建议保留项目。预览只使用同一内置组件注册表和只读投影；Diff 展示状态、Goal 关联、新任务与导航变化。Rules、Workflow 与验证配置单列“后续配置建议”，按钮打开各自确认入口，不能被“应用蓝图”顺带生效。

生成中、校验失败、待预览、提交中、回执核对中、冲突/过期、拒绝、已应用必须可区分。修改内容或选中项形成新候选后重新预览；接受绑定项目、候选 hash 和基线版本。超时查询原回执；冲突保留用户草稿并显示当前差异，不自动覆盖。切页后的结果始终回到原目标。基础导航、Review/恢复入口不允许被隐藏；模型建议不能生成任意新路由。Goal 修改或 Skill 升级只提示新提案，不自动重排导航。

2026-09-26 0025 live 蓝图切片：`/projects/:id?skill=blueprint` 同页提供人工草稿与第一方 Skill 生成两条入口，fixture 仍是示例。人工草稿明确标记 `USER_DRAFT`；用户可指定现有 ACTIVE Goal、项目类型允许的 phase、最多 5 个新 HUMAN/INBOX Task、下一步和默认 View kind，并可选择 Pack 的确切版本作来源。草稿意图不会自动成为 Goal，Pack 选择不授予权限。提交后读取服务端不可变候选及候选 SHA-256、Project/State/View 基线、Diff、固定模板页面顺序；编辑已保存候选通过 `supersedes_proposal_id` 创建新候选。只有候选仍待确认、正文可读且服务端未判失效时，显式 Apply/Reject 才发送命令；Apply 结果单列真实 Goal 关联、Task ID、State 和 View 修订，Rules/Workflow 后续建议不随之应用。Skill 来源不可用时服务端返回 `content_availability=SOURCE_UNAVAILABLE` 与空的 candidate/baseline/diff；页面清除旧表单和预览，只显示候选状态与 hash，禁用确认。冲突与响应不明冻结原 command_id/载荷，优先查原回执；无回执才允许原样重试或在冲突后明确重新确认。Skill 入口先创建 PROJECT Assist 会话，再以 `goal-to-project-blueprint@1.0.0` 发送 `desired_outcome/goal_id/pack_ref`，202 仅表示消息排队。页面按 assistant message ID 读取完成/失败状态与 `error_code`，只选择 `origin=SKILL` 且 `skill_message_id` 精确相同的服务端提案；模型 `draft` 是只读建议，不由前端改写为人工候选。当前前端定向测试与构建是开发自检，真实 Provider、桌面交互和 M05 独立验收仍后置。

内置 Pack 在现有引导/配置入口作为可选领域组合展示，不增设安装市场。区分“本次选择”“已应用配置”和“当前工具权限”；显示成员版本、缺失能力及用户修改冲突，不能仅显示“Pack 已安装”暗示全部生效。Proposal Diff 基于真实影响说明哪些规则/执行配置需要另行确认、哪些活动执行可能失效；多个命令分别反馈结果。旧配置恢复使用“恢复配置建议”，明确需要新修订，不能承诺撤销外部效果。

Run Detail/Assist 增加轻量 Sources View：展示实际 Manifest 引用、版本、允许查看的片段与排除/裁剪原因。只读接口重新鉴权，禁止显示无权对象的名称/ID/数量；来源缺失与未选中分开，不冒充完整 Inspector 或展示模型思考。Projection Profile 仅控制已授权事实的呈现，不改变 Today 的业务排序、必需 Review 可见性和 Context 规则。完整比较/搜索 Inspector 按后续路线实现。

## 3. 三套工作台

| 工作台 | 当前主区 | 辅区 | 已有操作入口 |
|---|---|---|---|
| General | 当前选中或 State 下一步 Task 的目标、既有产物、真实 Run 步骤 | AI 辅助、资料目录、任务选择与项目上下文 | 打开该 Task、打开同 Task Assist；保存与完成仍在原业务页确认 |
| Thesis | 资料/草稿版本目录与确切正文并排阅读 | AI 辅助、版本归属与现有来源入口 | 选资料或产物版本、打开所属 Task Assist 生成候选 |
| Development | 确切产物版本目录与正文、已加载 Task 的 Run 列表 | 对应 Run 的真实检查证据、项目 OPEN Review、连接能力事实与 AI 辅助 | 阅读版本、打开原 Run/Review、打开所属 Task Assist |

配置是代码内注册的组件组合，不生成任意路由或执行脚本。缺少相应 capability 显示“未连接/未启用”并引导到设置，不能显示假测试或假 diff。浏览其他 kind 只更换本地展示路由；只有显式保存默认视图才修改 ViewConfiguration，Run contract hash 必须不变。

Project Type 决定 phase 词汇，例：GENERAL 的 PLANNING/EXECUTING/REVIEW；THESIS 的 TOPIC/LITERATURE/METHOD/EXPERIMENT/WRITING/REVIEW；DEVELOPMENT 的 DISCOVERY/DESIGN/IMPLEMENTATION/VALIDATION/RELEASE。这是推荐内置词汇，可版本化配置；用户显式设置阶段，系统不按 Task 完成数量自动跳阶段。

M05 P14 三工作台当前实现（2026-09-30）：`/projects/:id/workbench/:kind` 提供 `general/thesis/development` 三种代码内注册的事实视图，从原项目页和项目内导航进入，右侧保留返回原项目页、任务与资料的入口。切换路由只更换浏览组合；Project Type 与 phase 始终读取同一 Project/State，页面不提交 Task、Run 或执行配置命令。General 默认围绕 State 下一步，用户可从已加载任务中切换当前浏览 Task；目标、产物、步骤与 AI 辅助链接均绑定该 Task。项目下一步与当前浏览任务不同时分别标明。目标与验收来自 Task 单读，步骤只来自其确切 Run；没有步骤时不编造工作流程。任务列表明确已读条数与 `next_cursor`，可继续加载，不将首 50 条称作全量。

Thesis 的左侧目录展示本次查询返回的项目/Workspace 可见资料中的前 6 项当前版本；草稿目录包含 State 当前选用版本，另从 State 下一步与已加载的进行中/待审 Task 中最多读取前 6 个 Task 的产物版本。未展开资料、未覆盖任务与读取失败均有说明。右侧阅读区按显式选中的资料版本或 ArtifactVersion 获取确切正文，核对 Project、Task、版本和摘要；历史版本不可读时不以最新版补齐。知识与产物的选中状态同时区分对象类型和 ID，浏览选择不产生接受或保存。Development 复用产物版本阅读，主列展示已加载 Task 关联的前 8 个 Run，辅区按选中产物归属 Task 读取对应 Run Trace 的真实 checks，并展示本项目 OPEN Review 与 Connection 状态/能力声明。历史结果与所选版本的绑定、当前是否适用分别说明，PASS 不单独证明 Task 完成；Connection 能力不代表 Permission 或工具可执行。

General 的 AI 深链打开当前浏览 Task；Thesis/Development 阅读产物时打开该产物所属 Task，无 Task 目标时使用项目 Assist。所读资料或产物不会通过深链自动选为模型来源，用户仍在原 Assist 来源选择器显式选择可读版本。读取失败、失权或目标/客户端切换移除旧正文与证据并隔离迟到响应。fixture 只显示已有示例摘要并明示演示，不生成真实正文、Run 或检查。项目级产物总列表、Development 的 Git 状态/diff、受控测试与 Coding CLI 仍没有本页可用协议；页面明确显示未接入，不把布局复刻表述为这些业务能力已交付。本切片的组件、类型和构建自检不代表真实桌面或 M05 独立验收。

同日 M05 P14 live 收件箱增量：`/tasks?tab=inbox` 只调用 `GET /tasks?inbox=true`，按服务端 `next_cursor` 继续加载未归属 Project 的人工任务。状态、执行模式与标题筛选只作用于已加载页；页面分别显示已加载项数、当前筛选可见项数和后续页状态，不把首 50 项或当前筛选结果称为全空间总数。刷新、读取错误或失权时清除旧条目；切到其他范围或 Workspace 后，旧请求不能覆盖新范围。fixture 与真实结果不混用。该收件箱切片先于下述全空间列表接线，仅为组件开发自检，独立验收后置。

`/inbox` 是上述收件箱的替代路由，直接跳转到 `/tasks?tab=inbox`；顶栏图标和 Ctrl+K 提供辅助快捷入口，不新增侧栏一级项。fixture 同样走原收件箱示例，live 模式由原真实查询负责；命令面板的 Activity 入口按当前已接入的只读 API 描述。

同日 M05 P14 live 列表增量：`/projects` 分别以 `status=active|archived` 读取进行中与已归档项目，`/tasks` 以 `scope=all` 读取项目内及未归属任务；两处均按服务端游标续页，刷新、失权、切范围或 Workspace 时清除旧数据并忽略迟到响应。名称、项目、状态、模式与标题筛选只作用于已加载项，显示已加载数、当前可见数与后续页，不把它们称作全量。Project 列表没有 Goal/摘要/待审数；下一步只展示服务端 `next_action_task_id`，未单读 Task 时不推断标题。已归档范围保留 Project 历史入口；归档按钮的真实命令接线见下段，旧 fixture 列表继续保持示例交互。本段是前端开发自检，独立业务和桌面验收后置。

同日 P14 ArchiveProject live 增量：仅进行中列表里当前确切为 ACTIVE 的项目可发起归档；按按钮先单读 Project 的归档状态与修订，弹窗显示目标/修订并要求再次确认。提交严格冻结 `{command_id,expected_revision}` 与 Project ID；浏览器会话只按 base URL、Workspace 保存这些最小未决字段。网络、5xx 或回执格式不明时先查原命令回执；只有 `COMMAND_NOT_FOUND` 才开放同 ID/同目标/同修订重试。换 Project、归档 tab、Workspace 或重载后不能用新作用域重放旧命令；返回原 Workspace 时可继续核对。`PROJECT_ARCHIVE_BLOCKED` 按服务端固定代码显示处理方向，尤其 UNKNOWN Effect 与资源占用必须核对原事实，租约过期不视为安全；修订冲突清原命令并重读列表，再次归档必须重新确认；已归档冲突引向历史范围。成功后重读当前列表，切入已归档范围会重新查询，历史 Project 仍可打开。fixture 归档仍是原演示语义；组件开发自检不等于真实桌面或独立验收。

同日 CreateTask live 增量：`/tasks?view=create` 按用户操作读取 `status=active` 的真实 Project 列表并按服务端游标续页，点击某项才关联，绝不自动选择首项。名称搜索和数量只覆盖已加载页；项目页路由预填、已知 ID 手动输入与未归属项目的 Inbox Task 继续可用。读取失败、失权或切换 Workspace 时清除旧列表与跨空间 Project 选择，迟到响应不能回写。提交 CreateTask 时冻结目标 Project、完整载荷和 command ID；响应不明先查原回执，仅明确 `COMMAND_NOT_FOUND` 后才允许原 ID、原载荷重试。切换 Workspace 不重挂这张未决表单，以便切回原连接后核对；fixture 仍用原示例选项。本段仅为组件开发自检，独立验收后置。

同日 P14 归档项目首批前端门槛：蓝图及其 Skill 生成、项目连接与权限设置、工作台默认 View、项目任务页的新建/开始入口、Project Assist 均以当前已读取的 `Project.archived_at` 控制新的业务写入。已归档、Project 事实加载中或读取失败时显示原因并禁新命令；工作台和蓝图仍可浏览已获授权的历史投影。蓝图 Project 查询失权时清除旧候选正文。Project Assist 的新取消命令同样禁用；已发命令仍可按原 ID 查询回执，并在原入口允许原 ID、原载荷恢复。项目任务的开始命令在当前浏览器会话按 base URL、Workspace、Project 保存最小原命令字段；切换作用域立即清旧任务快照并隔离迟到响应，回到原作用域才能核对回执，不能拿新 Workspace 的客户端重放旧命令。Task Assist、Run 停止、Review 拒绝、Today 清 Focus 及其他 Task/Knowledge 独立页不属于这批 UI 接线；ArchiveProject 按钮在上文另一增量接入，不据此宣称全部写入口都已禁用。fixture 行为不变；组件自检不代表桌面与独立验收。

同日 P14 归档项目直达页第二批前端门槛：Task 详情、Definition/Verification 只读页与 Task Assist 从确切 Task 归属单读 Project；Definition/Verification 本身不发写命令，仍可查看已接受事实及历史 Trace。Task 详情的 Delegate、Artifact 新建/续写、选为当前项目版本、人工完成/重开，以及 Task Assist 的新会话、消息、取消和提案接受，在项目已归档或 Project 事实尚未确认/失权时禁用新命令；无项目的 Inbox Task 不受项目归档误禁。Run 控制与 Review 决定也核对其 Task→Project 归属和当前 `archived_at`，历史记录可读，归档后不再发新的 Stop、Reject 等控制或决定。切 Task/Run/Review/Workspace 清除旧归档判断并隔离迟到结果；既有未决命令仍可查询原回执。创建任务从进行中列表显式选择项目，项目页预填和手填 ID 在原 CreateTask 命令生成之前再单读确认为 ACTIVE；读取失败或已归档时保留草稿且零提交，留空创建 Inbox 任务不需要 Project 核对。Knowledge、Today 与 Web Import 独立入口尚未接这批归档状态门槛；服务端归档写栅栏才是最终约束。fixture 行为不变；定向组件自检不代表独立或 Windows 验收。

同日 P14 归档项目第三批前端门槛：live Knowledge、Memory、Decision、Rule 的项目关联新建、版本、归档、停用或替代操作，依据记录的实际 Project 或 Rule 的 Task→Project 归属核对当前 `archived_at`；状态加载中、失权或已归档时禁新写，提交前再单读，失败不产生命令。Workspace 级资料和规则仍可写；列表、搜索或详情读取失权时清除旧内容。项目 `WEB_FETCH` 导入同样在提交前重读 Project，归档后仍可按 Job ID 读历史并核对原命令回执；仅明确 `COMMAND_NOT_FOUND` 后才开放原 ID/载荷重试，项目状态及可用连接重读会隔离迟到结果。Today 的 Project Task Pin/Later/Focus/计划在新命令前核对当前 Task 归属与 Project 状态，旧候选在归档后不再可用于提交并重读 Today；无项目的 Inbox Task 不因其他 Project 归档而禁用。`target_kind:null,target_id:null` 清除 Focus 是 Workspace 选择，不关联旧 Project，仍可按原 selection revision 提交。已发送而响应不明的命令保留原 ID 与原载荷核对；最终仍由服务端归档写栅栏裁决并发变化。fixture 不调用这些真实写接口；组件自检不代表独立或 Windows 验收。

0024 ViewConfiguration 当前入口规则（2026-09-30）：项目工作台入口 `/projects/:id/workbench` 在 live 模式先读取该项目服务端 ViewConfiguration；查询失败时留在错误页并可重试，不猜测默认值。项目已保存的 View `revision>0` 优先；尚未保存、`revision=0` 时使用本设备显式保存的默认工作台偏好，没有该偏好则沿服务端按 Project Type 解析的初始 kind。显式 `/projects/:id/workbench/:kind` 路由不受默认偏好替换。项目设置“连接与权限”页和工作台页都显示独立 View 修订、服务端解析的默认模板版本/SHA-256、`pages` 实际顺序与可见标记。工作台的三个 tab 只供临时浏览；只有项目设置明确选择并提交、或在工作台明确“设为默认”，才 POST `{command_id,expected_revision,kind}`。不提供逐页编辑，保存不改变 Project Type/State、Task/Run 或执行配置。响应不明时在当前浏览器会话冻结原 ID/修订/kind，查原回执；未找到才允许原样重试。409 冲突也核对原回执和最新配置，保留用户选择，用户明确重新确认后才用新修订、新 ID 提交。fixture 入口使用本设备偏好，未保存时沿用通用示例，不写真实配置；组件与路由自检不代表真实桌面或独立验收。

同日 Connections 设置增量：`/projects/:id/connections` 从项目导航进入，读取本项目 Connection 状态、capability、WEB_FETCH `allowed_host`、ManagedResource 根与独立 PermissionPolicy 当前/历史版本；全局 `/connections` 和 `/settings/connections` 当前仍只提供 Project ID 入口，尚未接入新项目列表投影作选择器。三个配置列表和每项策略的版本列表最多读服务端前 100 条且无游标，页面明确显示这一范围；Connection/ManagedResource 的创建与停用另按详情读取核对，不把截断列表当全量。FILE_READ 连接根目录不在读取 DTO 中，详情明确“连接目录未由此接口公开”，受管资源另列且不推断同根；不展示完整 config、secret 或凭据。用户可创建 WEB_FETCH/FILE_READ（或已有 Fake 能力）连接、停用连接，登记/停用受管资源，并明确新建、修订、撤销策略。策略默认选择 DENY；WEB_FETCH 策略提交明确 host 与空 resource_id，FILE_READ/FAKE_WRITE 明确选择 ACTIVE 受管资源 ID，连接创建不自动创建策略或视为授权。策略显示 AUTO/ASK 仅为版本事实，仍须有效连接及目标匹配，主机不同不宣称准入。命令携原 `command_id` 与版本前提，冲突保留输入和原 ID，响应不明冻结其余变更、查询原回执，确认未找到后仅以原 ID/原载荷重试。成功还以服务端最新查询确认状态；停用/撤销后保留历史可见。不调用连接 `/test`，fixture 无真实设置。该组件自检不代表真实 Windows、Provider 或 M05 独立验收。

2026-09-28 Windows 文件写入根身份提示：项目 Connections 的受管资源列表读取服务端 `file_write_identity_bound`，逐项显示“已绑定”或“未绑定”。未绑定时说明若要在 Windows 使用 `FILE_WRITE`，须在 Windows 停用并重新登记目录；这只是登记身份状态，不宣称 Connection、Permission、Task 绑定或动作批准已齐备。字段缺失的旧服务端响应按未绑定显示。定向组件 9/9 通过；确切桌面包的 WebView2 自动化已核对已绑定资源的真实显示并留图，人工操作仍待验。

## 4. 任务与版本交互

闭环 Skill 入口按[首批设计](../architecture/relay-skills.md#7-首批闭环能力与后续目录)接入：任务页提供“完善任务定义/生成验收方案”，项目页提供“继续这个项目”，创建引导保留蓝图预览。委托前展示并确认任务与验收版本；组合“确认并委托”须区分提案已应用与 Delegate 成功，失败后不能显示已开始。恢复摘要标注来源及时间，过期后重新读取；没有比较基线不显示虚构的上次变化。Repair 显示失败证据、新版本及复验状态；交接包区分等待安全点与已接手，仅需判断的场景留在 Review。这些交互不新增一级导航或要求八个独立页面。

2026-09-26 M05 项目恢复页前端增量：fixture 的原“继续项目”演示保持原样；live `/projects/:id?skill=resume` 改为只读当前事实速览，分别查询 Project、State、项目任务首分页、State 指定下一步的 Task 单读、OPEN Review、项目 Decision 和 State 当前选用的 ArtifactVersion（按 Artifact 详情核对）。页面明确已加载的任务/Review/Decision 范围，不把首分页或前 5 条称作完整历史；产物详情不可读取时保留 State 版本引用并标记不可用，不用最新版替代。没有上次查看基线，不显示进度推断、变化比较或模型建议；刷新不改变 Task/Run，也不宣称 Skill 注册已交付。跨项目旧响应不覆盖当前页面；组件自检不是独立桌面验收。

M04/P12 任务 Skill 当前页面（2026-09-30）：fixture 的“完善任务定义/生成验收方案”仍是交互预览；live `/tasks/:id?skill=definition` 与 `?skill=verification` 将已接受事实、生成建议和确认区放在同页。当前 Task 与验收目标、来源、版本、条件及方法来自 `GET /tasks/:id`，默认收进可展开的“已接受的当前事实”；内嵌原 Task Assist，并分别优先选择当前注册表中可调用的任务定义或验收方案 Skill，不自动发送。模型文字建议与服务端最终合并提案分开展示，生成不会修改 Task 或执行权。普通 Task Assist 仍可讨论或提 Markdown 候选，Project 目标的 `TASK_DEFINITION` 仍是新任务提案。

同页建议的阅读顺序：定义页先读当前目标与服务端合并提案的目标、结果说明、保留/新增条件；验收页先读当前派生检查项的“检查项／方式／当前状态”表及版本基线，所有派生项仍明确未执行。提案确认操作移入单实例右栏，窄窗在主区之后排列；只移动操作 DOM，不复制或卸载 Assist 写入 Owner。会话、原始建议、资料与技术来源可展开，原命令恢复和两步确认保持原路径。

有确切 `executor.run_id` 时读取该 Run 的 Trace，来源区展示实际 Verification Session、验收版本、CheckPlan hash、检查结果与目标产物版本，并链接原 Run/版本来源；历史结果不自动证明当前检查仍有效或 Task 已完成。无 Run 指针、来源不可读各有明确说明，旧响应不能覆盖新任务。当前验收 DTO 的 `expected_outputs` 只读其已声明字段，Task 单读仍未提供输入资料绑定。验收页的 CheckPlan 准入预览没有独立应用命令；可确认的 Task 验收变更只走下文服务端 Assist 提案接受入口，不能把 fixture 建议视为已生成或已应用。

同作用域父 Task 正在重读或读取失败时隐藏旧已接受事实、右侧来源、Assist 历史与合并提案，禁用新的发送和接受；原 Assist 命令 Owner 保持挂载，用户可清空未发送草稿，已发未决命令仍按原 ID、原载荷查询回执或恢复。不能通过错误时卸载建议区丢失原命令，也不能让迟到的旧读取重新展示内容；原命令核对成功后保留其发送之后新编辑的草稿。上述机制已实现；开发自检和浏览器复核仍不等于真实 Windows、Provider 或整套页面验收。

同日 M04/P12 第一方 Skill/Pack 接线：live 项目/任务 `?skill=assist` 读取工作空间 `/skill-definitions`，普通 Assist 仍为默认；仅展示与已单读目标匹配的 Skill。用户显式选择注册表中目标匹配且 `call_supported=true` 的精确 Skill 版本后，界面展示注册表版本/摘要、依赖、只读或仅建议状态及缺失能力；发送 `skill_ref` 与该定义允许的 `skill_input`，不同时发送普通 `intent`。`command_id`、来源版本与完整载荷在响应不明时冻结，原回执核对和同 ID 重试沿用 Assist。服务端消息的 `skill_output` 只读呈现任务定义建议、项目速览、验收方案建议及项目蓝图建议；蓝图模型输出不直接提供应用按钮，应用依据是单独保存的服务端蓝图候选。展示输出目标/基线/时间、事实与输出摘要，来源链接只依据服务端返回的可用引用；`UNAVAILABLE` 来源不展示原 ID 或正文。旧普通消息三字段为 null，继续照常阅读；202/失败/取消不会被当成建议完成。Task Skill 在服务端另生成可审查的合并提案时，才提供明确确认入口。任务/项目事实页仍显示已接受的当前事实，不把输出标为已应用。无额外 Connector 能力要求不等于模型 Provider 可用。live 创建项目引导与 `/settings` 只读显示服务端 Pack 固定成员、版本、摘要、可调用状态与缺能力；`AVAILABLE` 表示当前 Pack，`HISTORICAL_ONLY` 仅保留旧版读取，查看清单不授权、不启用规则或启动 Run。fixture 不读取真实注册表。此为组件开发自测范围，非真实 Provider/桌面或独立验收。

后端冻结定义兼容补充：Assist 历史行的 `definition_availability=HISTORICAL_ONLY` 表示当前注册表不再提供此版本、但持久冻结的定义与依赖仍自洽；消息保留原 ID、版本、摘要，明确标为“仅可查阅，不能新调用或接受”，不得把冻结身份中的 `availability=CALLABLE_*` 解释为当前可调用。选择框始终只从当前 `/skill-definitions` 生成，不用新版替代历史来源。`output_availability` 独立表示 `PENDING`、`HISTORICAL_SNAPSHOT`、`NO_OUTPUT`、`UNAVAILABLE`；仅服务端仍判定目标与来源可读的已完成历史输出才显示类型化内容。冻结损坏或来源/目标失效时不推测历史正文；普通旧消息仍按无 Skill 来源展示。

同日 Task Definition 只读预览补充：Assist 中该类型输出先核对 `target_id` 与当前任务会话，再核对基线 `task_id/project_id/task_revision/acceptance_revision`，随后单读当前 `GET /tasks/:id`。当前目标、预期产物 `kind`、条件字段和任务模式与模型建议分列；条件只按文字/必需性/方法完全相同计数，不从未重复项推断将删除旧条件或最终新增建议条件。Task/验收 revision 与输出基线不同时标记过期；重新读取遇到 404/失权会清除旧 Task 事实和建议内容。当前验收 `expected_outputs.kind` 可由真实 Task DTO 读取，未声明时显示未声明；最终合并效果与接受资格以后端 Task Owner 提案及命令为准；原模型字段对照仍不提供 Apply。Verification Plan 区分历史 `checks` 与当前 `additional_checks` 模型输出；当前 `check-plan-preview` 显示 Task/验收/规则/Workflow 来源、原因代码与派生条件，但它不是 Run 冻结计划或执行结果，也不拿历史 Run Trace 充当当前准入。Project Resume 的 `next_steps` 明确为模型文字，不视为 Today 合格 Task，也不提供启动动作。

2026-09-26 M04/P12 0023 Task 接受接线：live Assist 的 `TASK_CONTRACT_CHANGE` 与 `VERIFICATION_PLAN_CHANGE` 提案只展示服务端 `payload_available=true` 的最终合并 payload，逐项标出 `PRESERVED/SUGGESTED`、保留/新增条件 ID、目标与结果契约；模型的建议模式不随接受命令生效。读取确切 Task 核对 `base_revision/base_acceptance_revision` 后，用户先展开确认操作、再明确确认接受，才以 `command_id`、两个 expected revision 和 `payload_hash` 调用 Accept。AI 持有执行权时不能接受，须经原 Run 页请求人工接手并确认执行权转移，不能由提案按钮完成交接。回执不明保留同一 ID 与载荷，先查询回执或原样重试；409 保留提案与合并内容并提示重生成，不覆盖当前验收。失权时隐藏 payload 并禁用确认。旧普通 Assist 的候选产物和新任务提案沿原接受请求，不附 Task CAS 字段。`verification-plan` 旧定义标为历史不可新调用；注册表 `call_supported/accept_supported` 而非前端写死版本决定当前候选；同一 Skill 的新版本优先排列。`task-to-execution-contract@1.1.0` 的 `expected_outputs.description` 与 Task 当前结果说明同列比较，最终生效说明读取服务端合并 `required_output_spec`。Pack 旧版本只读，当前 `1.3.0` 优先排列；成员有接受能力也不表示浏览 Pack 就已接受。当前 `/tasks/:id/check-plan-preview` 只读 Task 验收、规则与固定 Workflow 的准入派生，`admission_available` 与原因由服务端给，始终不是冻结 Run 计划、已执行验证或 PASS。此处为组件开发自测，不是独立或桌面验收。

2026-09-26 M04 普通 Assist 生成中草稿前端增量：live 项目/任务 Assist 只对当前会话中 `intent=DISCUSS`、无 Skill、未请求取消且状态为 `PENDING/RUNNING` 的 ASSISTANT 消息，以约 400 毫秒的有界间隔读取其原 `session_id/message_id` 的 `/live-preview`。有首片段时用纯文本显示明确标记的“生成中草稿”和预览修订；它不是完整回复、结构化提案或已接受产物，截断也单独标明。首片段前保持等待状态。终态、取消或失败时清除草稿并从原消息列表读取最终状态；`preview_available=false`、预览 404/失权、会话或目标及 Workspace 切换立即清除旧草稿并隔离迟到响应，消息列表失权也清除旧消息与提案。重新连接后按同一会话和消息 ID 重读，不把旧草稿移入新会话；Skill 和结构化提案消息不请求 raw 预览。原写命令回执和归档禁写流程不由该只读入口改变。延迟片段组件模拟只验证界面状态，不作为真实 Provider 首字延迟或 Windows 交互证据。

任务顶栏分别显示工作状态、执行模式、当前执行者。Me/Assist/Delegate 是交互意图，不用一个彩色状态覆盖三者；Delegate 前展示 Project、验收版本、工作配置与作用域。

人工路径：录入 → 整理为 Ready → 开始 → Markdown 编辑/保存版本 → 选择要接受的版本 → 检查 required 项 → 完成。未保存草稿离开页面提供保留/放弃选择；草稿只是客户端输入，不显示成已发布 Artifact。

保存版本命令发出时固定 command_id、目标 Artifact、所依据的 revision 和原正文。网络超时、5xx 或响应无法核对时保留这份原请求，编辑器可继续写新草稿，但在原命令结果确定前禁用再次保存；查询回执必须匹配原命令类型与 Task/Artifact 目标，不能换 ID 盲重试。原回执确认保存 A 后，后来编辑的 B 仍是未保存草稿；服务端列表与 revision 更新后，保存 B 才使用新 command_id。明确的校验/修订冲突拒绝可释放原 ID；409 显示自己草稿和服务器版本差异，不自动丢稿或覆盖。

产物页呈现与失败补充（2026-09-30）：主区按确切版本读取已保存正文，并提供本地编辑/安全预览；正文失败可显式重试，不换为最新版。Task 上下文可展开，页签与刷新错误/重读入口常显；保存、当前选用和完成保持原组件的单实例操作区，窄窗移到主区之后。409 或已核实的基线变化在同页对照本地草稿与当前确切正文，只有显式确认才调整草稿基线。Task 单读或产物列表 403/404 后隐藏旧服务端事实、正文、名称和版本身份，同时保留用户未保存输入与原命令；随后 503 不恢复失权内容，成功读取或更换目标后才清除失权状态。普通 Task 刷新失败保留页面与原 Owner 并禁新写，不能把旧显示内容当作已刷新成功。

产物版本列表突出“当前选用”“本轮接受”“最新”三个不同标记。完成后编辑按钮引导重开，不悄悄改旧版本。Markdown 默认禁用原始 HTML/危险链接，预览只渲染安全内容，不执行资料中的脚本。

2026-09-24 M03 Task 产物增量：真实「产物」页签从受权 `GET /tasks/:id/artifacts` 恢复该 Task 的全部 Artifact/不可变版本，刷新后仍按服务端确认的人工 Artifact 与其 revision 续写；列表加载中或失败时保留本地草稿，禁止把未知列表当空列表创建/完成，可重新读取。版本行以 `artifact_version_id` 唯一标识，即使多个 Artifact 都有 v1 也不会混同。“最新”取各 Artifact 自身最新版本，“当前选用”取 Project State，“本轮接受”只取 Task 当前 CompletionRecord；刷新后不会自动选中最新版作为待接受版本。同页重开直接成功或原回执确认后，都清空本轮待接受选版与条件勾选，历史版本仍可手动重选；其他客户端造成的验收 revision 变化也清空旧轮选择。重开清空服务端当前接受指针而不删除历史。浏览器全刷新需要重新建立内存 Bearer 连接，本片没有把凭据持久化。定向真实 PG/浏览器结果见 [开发自检](../../apps/workbench/results/m03-task-artifacts-evidence.txt)；后续组件修复见本片自检，未重建冻结 Windows 包，桌面端与 M03 总验收待独立复跑。

2026-09-30 M04 真实读取委托接线：任务详情与协作页共用 `TaskDelegatePanel`，默认不附加读取；用户可显式选择一次受管文件读取或网页读取，与附加 Mock 文件动作互斥，切换时清除旧选择及输入。配置仅在选择读取后加载，只列本项目 ACTIVE 且含对应能力的连接、ACTIVE 受管目录；文件连接与目录是否匹配由服务端准入核对，前端不推断未公开的连接根目录。文件目标为目录内相对路径，网页为无用户信息/片段的 http(s) URL；网页主机、重定向及网络准入仍由服务端决定。加载、失败、缺配置或无效目标禁用委托，提供显式重读；切 Task/Project、读取种类、连接或目录后不复用旧输入，迟到响应不能污染新目标。提交将 `file_read_action` 或 `web_fetch_action` 随原 Delegate 固定，结果不明时配置冻结且只查原 `command_id` 回执。该入口表达用户已选的读取意图，运行仍经 Gateway 和原审批/完成 Owner；模型原生工具输出当前仍主动拒绝。

## 5. Run 控制与 Review

| 真实事实 | UI 文案与操作 |
|---|---|
| control=PENDING | “已请求暂停/停止/接手，等待安全结束”；保留当前执行者；可查看在途动作 |
| Run=PAUSED | “已暂停”；可恢复或请求接手；提示是否仍占资源 |
| WAITING_APPROVAL | “等待你的判断”；直达绑定版本的 Review |
| UNKNOWN | “执行结果尚未确认”；说明已知/未知、核对入口；无强制成功按钮 |
| Verification=PASS，Task 未 DONE | “检查已通过，等待提交”；不显示已完成 |
| Run=FAILED | 展示失败与产物保留；重试创建新 Run |
| Handoff APPLIED | “已交接，可编辑”；展示最新产物/未决建议和原 Run 链接 |

Review 卡片固定展示：为何需要你、具体版本/目标、影响、证据、允许动作。审批与接受分别使用对应按钮；不使用含糊的“继续”统一替代。动作内容 hash/目标变化后按钮禁用并说明过期，刷新不会自动重新批准。

2026-09-23 P07 开发增量：`/reviews` 在示例模式展示只读样例；显式连接本机 API 后读取待审列表与确切请求，按服务端 `allowed_decisions` 提供类型化按钮。修正预算需要输入明确次数，`REQUEST_CHANGES` 需要说明。决定请求携带 Review revision 与目标摘要；若响应丢失，页面保留原 `command_id` 供回执核对，不将批准文案写成动作已执行。本段仅记录界面实现与开发自检，完整业务及桌面验收另行进行。

待审呈现补充（2026-09-30）：宽窗为请求列表与右侧判断区，类型筛选只改变当前列表，不触发决定或卸载原未决命令。所选请求的产物名称只从同 Task、确切绑定版本读取；元数据不可读时保留原版本身份，不按最新版替代。右侧常显原因、必要绑定字段与类型化操作，完整证据、影响和补充说明按需展开。请求正在读取或读取失败时禁新决定，无项目请求也适用；已有未决命令仍可核对原回执。窄窗将同一判断区排列在列表之后。

2026-09-23 P08 开发增量：真实任务详情仅在 `executor.run_id` 非空时给出 `/runs/:id` 入口；示例模式不构造 Run。Run 页读取步骤、最近尝试、未决 Review、待处理控制请求与未决动作 ID，UNKNOWN 只提示核对，不提供强制改成功的按钮。PAUSE/CANCEL/HANDOFF/CANCEL_TASK 使用 Task 与 Run 双版本提交；202 回执只表示 `PENDING`，安全点可能随后处理，以服务端查询为准；PAUSED 可提交 Resume。命令响应丢失或成功响应无法核对时保留原 `command_id`，仅查询回执；回执须匹配命令类型、Run 和控制类型后才解除未决状态，不产生新控制请求。当前页面只列未决动作 ID，完整动作核对详情仍需后续接口与交互；组件自检不等于桌面验收。

2026-09-26 M04 Run DRAFT 草稿预览前端增量：live Run 仅在当前 Task 仍由该 Run 执行、Run 与当前 DRAFT Step 都为 `RUNNING`、且没有待处理控制请求时，约每 400 毫秒串行读取 `/runs/:run_id/draft-preview` 的持久化 Markdown 前缀；SSE `run_hint` 仍只促使重读权威 Run 事实。首片段前不制造正文；有正文时按纯文本显示“生成中草稿”、预览修订及截断标记，并明确尚非受管 Artifact、Verification PASS 或 Task 完成。预览以 `step_attempt_id`、`attempt_claim_epoch`、`model_call_id` 为轮次身份，身份变化先清旧片段，新轮次再显示；旧请求迟到不能覆盖新身份。`preview_available=false`、控制或取消、终态、失权/404、切 Run/Task/Workspace 立即清预览；终态回到原 Run/Artifact 查询事实。该只读预览不改变控制命令、原回执恢复或归档禁写；fixture 不生成预览。延迟首片组件测试不是实际 Provider 首字延迟、Windows 或独立验收证据。

2026-09-24 M03 G03 查询片：Run 页的“执行结果未知或待核对”现合并展示 P08 未结清效果与该 Run 的 Gateway UNKNOWN 原 `operation_id`。文案要求先核对目标与效果证据，证据不足时保留待核对；不提供盲重试、换 ID、恢复写入或直接标记成功入口。字段没有逐项状态，页面不能把所有条目都称为已执行或已失败。Gateway UNKNOWN 变化目前没有专属 Run SSE 事件；手动刷新、重开页面或约 15 秒周期重读可获取最新查询投影。完整动作核对详情仍需后续接口与交互。

2026-09-24 M03 Mock 动作 UI 开发增量：Task「执行记录」页签仍默认提交普通固定 Markdown Delegate。用户主动勾选文件动作时，页面只读取当前 Project 已生效的 `FAKE_WRITE` Connection 和受管目录，由用户填写目录内完整目标路径与内容；缺少配置或必填项时不提交。可选 `mock_gateway_action` 随原 Delegate `command_id` 一起发送，202 之后按既有回执规则处理，响应不明不改 ID 重试。Connection、目录和策略的创建/变更仍由 P09 HTTP 入口负责，页面选择不授予权限，Gateway 在效果前继续核对。Run 页新增按需读取的动作历史，显示原 operation_id、目标、Operation/Invocation 状态；它是当前查询结果，不把批准当作写入成功，也不提供 UNKNOWN 直接结清按钮。此处是前端接线与定向自检，完整桌面业务链仍按 M03 状态记录。

2026-09-27 M06 部分文件写入处置接线：Run 页展开 Gateway 动作历史后，对原 `WRITE_FILE`/`APPLY_CHANGESET` 动作按 `operation_id` 读取不可改写的逐文件账本和当前文件摘要；两种来源分别标明，`PARTIAL`/`UNKNOWN` 不显示为成功。只有服务端预览返回 `can_dispose=true` 时，页面才允许打开二次确认，明确说明“保留当前文件并结束旧 Run”，并冻结原 `invocation_id`、Run/Task 修订、当前观察摘要与 `command_id` 提交。缺停机证明、文件不可安全读取或其他栅栏未满足时展示阻断原因；409 后重读事实。响应不明时按 API/Workspace/Operation 作用域在浏览器会话中暂存原命令身份和冻结载荷，不存令牌或文件正文；重开页先查询原回执，只有明确 `COMMAND_NOT_FOUND` 才可用同一 ID 与同一载荷重试，不换 ID 自动提交。成功后重读 Run、Task 和原动作证据，历史页展示处置时持久保存的逐文件摘要。此切片只提供状态/摘要与人工决定，不生成文本 diff；完整 Windows 桌面与 M06 总验收以独立证据为准。

无回执 Windows `UNKNOWN` 账本的预览在同一面板新增当前目标 File ID 和候选残留的路径、File ID、摘要；明显标注候选不能归因于原调用，也不自动移动或删除。目标缺失显示为当前观察，不解释为原动作未执行。服务端 `can_dispose=true` 时另用二次确认说明“保留当前目标与候选，结束旧 Run”；提交仍绑定原 Invocation 与观察摘要，409 后重新读取。已处置的历史页保留当时目标和候选事实，不把结清显示为写入成功。

2026-09-27 后续冻结计划差异增量：同一 Run 页按需读取原 Operation 的 `file-write-diff`，逐文件展示准备时核验的基线与冻结目标文本，采用行号和增删标记；文本较长时按原文对照。页面显式标注这是计划，不是已应用文件的差异，并与原执行账本、当前文件摘要分开展示。历史动作无基线正文、二进制、超限、摘要不符或路径不安全时显示具体不可用原因和已有摘要，不从当前磁盘补造旧文本。加载、失败和重试只影响此只读面板，不触发文件写入或人工处置；React 定向组件自检及新 release 的真实 WebView2 自动化点击与截图检查通过，人工交互与安装包体验仍待验证。

2026-09-24 M03 React 首片：真实 Task 的「执行记录」页签对有 Project、READY/HUMAN 且服务端 `allowed_actions` 提示可开始的任务提供单独 Delegate；创建 Task 的模式选择不创建 Run。真实创建成功结果中的任务 ID 可点击，直接进入该任务详情；原返回任务入口与示例模式保持不变。提交绑定 Task revision 与新 `command_id`，202 回执核对 Task/Run 身份后进入实际 Run；响应不明时保留原 ID，只查询匹配 `DelegateTask`、Task ID 和结果的回执。Review 决定的即时响应与原命令回执也核对 `ResolveReview`、Review ID、决定及版本，匹配失败维持未决。此处是前端组件接线与回执保护，独立 Worker/SSE、真实 PG 联动与桌面运行仍由 M03 分片验收。

2026-09-24 M03 事件客户端准备片：真实 Run 首读服务端 Run/Task/Reviews 后，用内存 Bearer 的 `fetch` 订阅该 Run 的 SSE；`after` 只记录完整、连续的十进制事件序号。事件正文只作重新查询提示，不能直接改写任务、运行或审批事实；重复事件忽略，缺号或截断后保留旧游标补历史，较大的正文不进入页面状态。短时间密集事件合并读取 Run/Task/Reviews，周期读取和手动刷新仍校正来源 Manifest；断流显示重连，鉴权失效停止旧凭据订阅并重新查询，离页只 Abort 订阅而不发取消命令。该准备片先由受控流组件与浏览器自检验证；后续受控服务端断流实测见下段，其他网络故障仍须单独核对。

同日的 M03 组合开发自检使用冻结 Windows release、WebView2、隔离 PostgreSQL 18.6、真实 API 与 Mock Worker：Run 页从历史事件启动并在 Worker 提交后重读权威快照；页面离开未提交控制命令；受控 WebView `fetch` 中断后按原序号补读；阻断 SSE 时服务端快照校正页面；宿主强杀后四个进程停止，重启页面从持久历史重读，原命令保持一份。无 Bearer、错误 Origin/Host 和跨 Workspace SSE 均被拒绝，测试核对 URL、浏览器存储和宿主日志无令牌。可复跑输入、精确包哈希、原始日志及未验证边界见 [M03 SSE 桌面自检](../../apps/desktop/results/m03-sse-webview-evidence.txt)。该次 CDP 离线仿真未切断已经建立的 loopback SSE，故未证明产品同页自动重连。随后在**同一冻结 release** 上的[独立同页断流反例](../../apps/desktop/results/m03-sse-same-page-evidence.txt)以隔离 PG 表锁唯一定位正在轮询的 SSE 会话，精确终止该会话；旧 WebView 请求关闭后，未离页的 RunView 自行携已消费的 `after=1` 重连。测试仅延迟这条已发出的请求，让真实 Mock Worker 提交 seq 2–31，再放行历史补读；页面随后重读权威 Run 快照并显示修订 v6，宿主与 API 原进程仍运行。该有界片已独立复跑通过，但只覆盖这一种受控服务端断流；其他网络故障、完整 M03/G01–G08 和 Windows 安装交付仍未验收。

2026-09-23 P10 开发增量：`/knowledge` 与 `/projects/:id/knowledge` 共用真实资料页；项目页按项目参数读取，服务端可同时返回适用的 Workspace 事实。四类页签分别读取 Knowledge 的不可变版本、Memory 的确认修订、Decision 的替代指向、Rule 的版本及作用域/强度/检查路径；新建、追加版本、归档或停用携带独立 `command_id` 与变更时的 `expected_revision`。Memory 新建和修订均须由用户勾选明确确认；Decision 替代保留旧决定可查；Rule 表单区分 HARD/PREFERENCE 和 PRE_ACTION/POST_CHECK/SEMANTIC/HUMAN，冲突或检查路径不可用时保留输入并展示服务端拒绝原因。搜索使用服务端有界字面接口（每页 20 条、游标续页），支持中文短词并忽略迟到响应。命令响应丢失或回执无法核对时保留原 ID，仅查同一命令回执；切换资料类型期间禁用再次写入。示例模式只说明未接入，不伪造资料；人工新建仍限受管文本、笔记及产物版本引用。此处记录开发实现与组件自检，不代表真实桌面验收。

2026-09-26 P17 前端开发增量：项目 Knowledge 页的真实 API 模式可从本项目 ACTIVE 且含 `WEB_FETCH` 能力的 Connection 中选择一个，提交无用户信息、无片段的 http(s) URL。选择器展示连接 ID 与服务端返回的 `allowed_host`；该值为 null 时只显示 ID，不推断主机。URL 是否匹配连接主机仍以服务端准备期判断为准。201 回执只显示 QUEUED，后续按 Job ID 读取 QUEUED/RUNNING/SUCCEEDED/FAILED、失败原因和原 Gateway Operation/Invocation 状态；`WAITING_APPROVAL` 时优先链接目标同时匹配 `operation_id` 与 `import_job_id` 的 OPEN Review，未查到时指向现有待审入口，不在此处自行批准。成功时按返回的 `knowledge_version_id` 精确核对项目 Knowledge 的不可变 `WEB_PAGE` 版本，再显示正文摘录与详情入口；同 URL 的其他版本不充当结果。响应不确定时保留原 `command_id` 和冻结的 URL/Connection，只查询原回执或以相同 ID/载荷重试；切换项目或连接后隔离旧异步响应。当前 API 没有 Job 列表或按版本 ID 直查 Knowledge 的端点，故页面展示 Job ID 并提供按 ID 恢复查询；资料列表尚未投影对应版本时保留版本 ID 和刷新提示。Workspace Knowledge 页与 fixture 不展示导入表单，PDF/向量导入、Connection 管理和跨 Workspace 写入不属于此切片。组件测试与构建不构成真实 Provider、Windows 或 M04 独立验收。

2026-09-23 P11 开发增量：真实 `/runs/:id` 的步骤附近提供只读“本次输入来源”，从该 Run 的 Manifest 列表与详情查询读取构建状态、版本摘要、预算、实际可读片段及合法排除。BUILD_CONTEXT 尚未开始、进行中、失败（必需来源缺失或超预算）和已完成但无 Manifest 分别显示；历史 Manifest 无预算时标明未记录。相关来源区分标题字面命中与同范围最近资料补位，片段正文始终按纯文本展示。详情由服务端按当前权限重新过滤；重新读取、切换 Run 或连接时先清除旧正文，迟到的旧请求不能覆盖当前视图。若预算用量因隐藏来源被置空，只显示权限过滤提示，不据此推断无权来源的数量；无权来源及其排除项不显示 ID、名称、正文或条数。示例模式不生成来源，页面不提供完整 Inspector 或模型隐藏思考。当前组件自检不代表真实桌面验收；已打开页面上的权限变化需要重新读取来源才能反映。

批量 Review 不属于 V1；一个请求一个明确决定。拒绝操作不显示为“执行失败”，请求修改需展示原契约与修正预算。

## 6. AI Panel 与可追溯性

2026-09-29 目标结构接续：协作可以成为第 14 节的中央主工作区；AI 不再必须安置在右侧辅助栏。下述来源、目标、提案与执行权规则同时约束中央协作区和保留的上下文 Panel。带日期的开发记录描述当时实现，不证明目标布局已落地。
2026-09-29 独立聊天验收修复：独立页采用紧凑目标头、可滚动消息区和首屏输入区，资料、发送选项及提案按需展开；原项目/任务 Assist 的布局保持。首次打开及本人发送后滚动到末尾；用户上翻历史时，刷新与新回复不抢走阅读位置。切换会话、新建或离开有未发送内容时先询问；存在未确认命令时内部切换被阻止。外部路由离开经确认后，仅在当前浏览器 sessionStorage 中按 API/Workspace 保存原命令及目标身份供回来查询回执，不存消息正文或凭据，不支持窗口关闭后的持久恢复；缺原载荷且回执查不到时不能换新 ID 重发。真实浏览器、Windows WebView2 开发宿主与 Mock 的独立验证及发布限制见[验收记录第 11 节](../development/ui-live-integration-2026-09-28.md#11-独立-agent-聊天验收2026-09-29)。

Panel 顶部显示当前 Project/Task、只读 Assist 或 Delegate 模式、采用的来源版本。切页时旧响应留在原会话；发送按钮冻结请求目标，迟到响应不能注入新 Task。

输出分为建议、候选产物、可接受提案。接受前展示差异和目标；Task 被 AI 占有时“保存编辑”改为接手入口，不绕过执行权。隐藏模型私有推理；可查看输入来源、步骤结果与验证证据。

2026-09-26 M04 前端开发自检范围：沿原有项目/任务路由的 `?skill=assist` 子页提供可达的会话入口，不新增一级路由。仅 live 连接读取真实目标、会话、消息与类型化提案；fixture 明确不提供模型回复。新建会话和发送消息均使用 `command_id`，发送时把当前显式选中的 `{kind, root_id, version}` 随本次消息冻结，项目/任务切换后旧异步结果不进入新目标。页面区分排队、运行、失败、取消中与取消终态；202 只表示排队，状态来自后续查询；未知模型用量显示“未知”，不伪装成 0。新建会话、消息、取消与提案接受响应不确定时保留原命令 ID 查询回执，重试只复用原 ID 和载荷。提案展示具体目标、基准修订、完整候选内容及服务端状态；接受只调用受控 Accept 命令，由服务端按提案基准修订校验，409 保留冲突说明并重读 EXPIRED。Task 委托入口也可显式选择同作用域不可变来源版本，随 Delegate 命令冻结。该前端切片的组件/类型/构建自检不代表真实 Provider、桌面窗口或 M04 独立验收。

2026-09-29 独立 Agent 聊天页开发增量：主侧栏增加 `/agent` 入口；页内左区读取当前 Workspace 的真实 Assist 会话列表，进入时优先打开最近会话，右区复用原 `AssistView` 的目标单读、消息、来源、提案、发送、取消与原命令回执。点列表项先按会话 ID 单读并核对其 Project/Task 归属，目标和会话切换重建对应视图，旧请求与未发送草稿不能进入新会话。新建入口从可分页的项目或任务列表选择目标；即使目标已有会话，也保持未选中状态且不显示旧正文和输入，直到用户明确选择旧会话或创建新会话。新会话由原 Assist 命令创建；创建成功后刷新左区列表。项目/任务原 `?skill=assist` 子页继续默认选已有会话。示例模式明确无真实会话、消息或模型回复；本页不赋予工具执行权，不提供模型切换或配置写入。当前为前端开发自检，真实 API、Windows 桌面交互与独立验收需另行取证。

### 6.1 输入区运行反馈（2026-09-25，待实现）

输入区外侧柔和流光作为当前运行的辅助提示，配合上方一行真实阶段说明、“查看进度”和适用的控制入口。它不表示完成百分比，也不能替代状态文字。此节记录设计要求，不代表已实现或通过桌面验收；视觉及动效规则见[设计系统](design-system.md#71-输入区运行流光2026-09-25待实现)。

反馈绑定当前会话明确关联的 Task 与具体 Run；未绑定运行时保持普通输入区。其他会话、其他 Task 或全局后台任务不能触发此处流光，其状态由独立的全局入口呈现。切换目标后忽略旧 Run 的迟到事件，查看进度及控制命令始终指向绑定的 Run。运行依据来自服务端权威状态与实际步骤事件，不能以是否正在输出文字判断：工具调用期间没有文本仍可能在执行。数量、阶段和结果只显示真实可追溯信息，没有依据时使用一般阶段文案，不虚构来源数量或进度。

下表是展示映射，不新增业务状态枚举；命令准入和恢复仍遵循第 5 节及既有契约。

| 真实事实或展示情形 | 边框表现 | 文字与操作 |
|---|---|---|
| 空闲或无绑定 Run | 普通静态边框 | 正常输入提示 |
| 排队等待执行 | 静态弱强调 | 排队中；不伪装为已执行 |
| 已确认正在执行 | 柔和局部光带流动 | 实际阶段，如读取文件、调用工具、生成内容；查看进度及允许的停止入口 |
| 等待批准或人工验收 | 停止流动 | 等待你确认／产物已生成，等待验收；打开绑定版本的 Review |
| 暂停或停止请求尚未确认 | 停止流动，保留静态状态提示 | 正在暂停／正在停止，等待安全结束；查看在途动作，不提前宣称已暂停或已停止 |
| 已暂停 | 静态边框 | 已暂停；仅在允许时提供继续入口 |
| 服务端已确认取消 | 普通静态边框 | 已停止；保留已产生结果的查看入口 |
| 运行结束 | 光带平滑淡出，恢复普通边框 | 按真实结果提供入口；生成结束不等于 Task 完成，仅在业务完成事实成立时显示任务已完成 |
| 已确认失败 | 停止流动 | 错误图标、原因及允许的恢复入口；仅可安全重试时提供重试 |
| 连接中断，尚无法确认当前状态 | 静态边框 | 连接中断，正在核对运行状态；保留最后确认状态及其时间，不推断任务已停止 |
| 外部动作结果 UNKNOWN | 静态警告 | 执行结果待核对；提供核对入口，不直接重试或更换动作 ID |

等待人工、控制待确认、连接状态不确定及 UNKNOWN 均不能沿用正常执行流光；连接恢复后重读权威快照再决定展示。停止与完成竞争时以服务端结算结果为准，完成先发生则显示真实完成结果，不强制显示“已停止”。

运行状态与输入能力分开：执行中可保留下一条消息的草稿编辑，不因流光锁定输入。发送行为必须对应实际支持的能力；未实现执行中补充指令或排队时，不展示这些承诺，保留草稿并说明发送限制。提供独立的运行提示动效开关，关闭动效不停止任务，也不隐藏状态文字、查看进度和控制入口。

实现验收应覆盖：工具阶段无文本时仍正确反馈；切换 Task/Run 后旧事件不污染输入区；等待审批停止流动；停止请求与最终结果分开；断线重连与 UNKNOWN 核对；生成完成但待验收；动效关闭及系统减少动态效果时状态仍可读；键盘焦点和草稿编辑不受影响。上述场景尚未因本文补充而执行。

## 7. 视觉与可访问性基线

依据原始参考及延展图采用暖纸色浅色基线、墨绿操作和宋体标题，深色主题未定义。颜色、字号、间距、圆角、布局断点及组件状态统一见[设计系统](design-system.md)和 [tokens](design-tokens.json)；此处不另定数值。表格允许局部横向滚动，详情不靠悬浮才能看见，不单靠颜色传达状态。

表单有可见 label、字段错误、焦点回落；弹窗具备焦点管理和 Esc 行为；危险/外部动作按钮含具体动词与目标。Loading 有范围：读取、提交中、核对中、后台运行分开。无数据给出下一步；不可用功能说明缺哪个配置，不产生无效点击。

2026-09-28 UI 联通精修增量（见[开发记录](../development/ui-live-integration-2026-09-28.md)）：今日页采用日期眉线 + 中文 display 主标题（「把今天留给重要的事」）+ 焦点卡，查询日期/时区与刷新降为紧凑工具行；任务行的延后与计划表单收进「延后与计划」details，排序依据、证据与允许操作维持既有 details；状态与修订等资格信息保留原文案语义。动态页行显示服务端摘要、本地时间与可导航引用，事件类型有中文映射（未知类型回退原代码），Activity ID / 原 command_id 收进「追溯详情」details，不再挤占标题与引用。任务详情侧栏「三个独立事实」标题改为「当前状态」，三字段仍分列显示；验收依据面板预期产物以条目 chips 呈现，CheckPlan 摘要用等宽 hash 样式（`hash-code`），长 ID 允许换行。顶栏数据来源按钮增加状态圆点，live 为墨绿点、示例为灰点；文字标签仍是主要指示，不单靠颜色。以上均只消费既有 token。

设置页当前实现（2026-09-30）：`/settings` 的基本设置提供本设备时区与默认工作台显示偏好，明确保存到 `localStorage`，不写 Project、ViewConfiguration 或服务配置。未保存的默认工作台继续按第 3 节入口规则解析；已保存项目 View 优先，显式 kind 路由不变。时区目前只影响本设备展示（顶栏日期、消息时间、完成凭据提交时间、Review 请求时间、资料保存时间与 Run 步骤起止时间），不改变 Today 查询时区、稍后处理日期或业务时间事实。外观仅浅色，未实现的主题选择禁用并说明原因；存储失败就地反馈，不能显示已保存。

模型端口卡仍只读 `GET /model-port`：Mock 端口 / 真实 Provider / 配置残缺三种状态用文字表达，Mock 状态明确说明“这是当前阶段既定门槛，不是故障”；页面只显示模型名与端点地址，**不读取、不显示、不修改任何 API 密钥**，模型配置仍归服务实例环境变量，不提供服务配置写命令。原有 Pack 固定清单（`pack-catalog`）与“打开连接设置”入口保留；示例模式显示“没有真实服务实例状态”并保留 Pack 清单预览，读取失败就地显示并可重读。分组导航定位当前区域或打开原连接入口；该页不引入新 token 与授权能力。

同日今日页截图专项整改（用户看过运行截图后反馈"粗糙"，按[专项提示词](../../prompts/ui-live-integration-polish.md)第 4 节执行，前后截图见[今日页专项证据](../testing/evidence/ui-live-integration-2026-09-28/today-polish/)）：今日主标题改用 `compactPage`（角色规则同步 design-system 第 4 节）；眉线只保留查询日期与星期，选择版本收进「安排说明」；服务端判定长句改为一句用户语言加「安排说明」details；查询工具条组成日期（统一控件样式）· 当前时区 · 调整时区（展开为独立编辑行，错误贴近字段，取消不改已生效时区）· 刷新，首次加载显示读取中且不显示"0 个任务"。任务行：项目列显示真实项目标题（按 Project 单读，读取失败回退"所属项目"），状态/优先级/截止/置顶/延后收纳为一行元信息（未设置项不显示），资格文案按真实状态区分「可开始 / 可继续 / 待处理」，动作文案改为置顶/取消置顶、设为今日焦点、取消延后、打开任务；原始 reason_codes/证据/允许操作保留在「排序依据与允许操作」details。今日焦点改为紧凑单列：未选显示一句提示（有候选引导从任务中选择），已选以任务名为视觉中心并显示可核实的项目与状态，焦点不在当前查询时如实说明且不显示可执行绿勾，时区与生效细节收进「焦点详情」。全空改为单一空态（当前日期下没有可安排的任务 + 新建任务/查看全部任务真实入口），零数量分组收为一行提示，不再重复铺满整页。live 模式移除底部"已连接本机 API · 写入真实 PostgreSQL"重复提示（连接详情保留该说明），示例模式的底部示例标识保留。共享层：文本输入/下拉继承 UI 字体并统一最低几何（高度/边框/圆角），`html` 增加 scroll-padding-top 供锚点/焦点滚动避开 sticky 顶栏（桌面含标题栏）。文案仅调整展示语言，API 字段、命令与状态枚举不变。

2026-09-29 今日页右判断栏接续（对照 [2026-09-28 完整窗口图](mockups/2026-09-28/README.md) 与 today.png 内容原图实现；live 截图见 [今日页证据](../testing/evidence/ui-live-integration-2026-09-28/page-prompts/)）：视口 ≥80rem 时主列右侧常驻右判断栏（80–90rem 窄栏 20rem，≥90rem 标准栏 25.5rem，细分隔线分组，断点按 design-system 第 5 节），内容为「等待你的判断」——live 模式查询 `GET /reviews?status=OPEN` 显示真实待审条数与类型中文标签，读取失败或零请求如实说明，不伪造计数——加「推荐依据」三条机制说明与「稍后处理的任务仍保留在任务列表」注记；窄于 80rem 时右栏不常驻，保留既有「待审与人工判断」横幅入口（≥80rem 隐藏，入口文案与计数边界不变）。今日焦点卡升级：标题行并列「已置顶」徽标（仅焦点任务真实置顶时显示），焦点任务名为宋体 compactPage 视觉中心，元信息改细线分隔（状态/优先级/截止，未设置项不显示），焦点任务在可开始组时主操作为「开始任务 / 继续任务」（按任务状态措辞）链至任务详情，否则保留「打开任务」文字链接；「清除今日焦点」命令不变。任务行资格文案改用 status-chip（success/neutral）并右置，与「打开任务」同一簇；置顶/设为今日焦点/取消延后命令按钮保留在原动作行且首个按钮顺序不变。眉线日期改为中文长格式。「延后与计划」「排序依据与允许操作」「安排说明」等展开入口由动作绿改为次要文字色、hover 下划线。Review 类型中文标签收进 `lib/labels.ts`（`reviewKindLabels`）供待审中心与今日页共用。命令、API 字段与分组语义不变。

2026-09-29 效果图一比一对照接续（全页 fixture 截图见 [对照证据](../testing/evidence/replica-2026-09-29/)）：项目列表页按 projects.png 对齐——右栏增加「项目摘要」栏标题与宋体项目名（原 h2 拆分为栏标题 + 名称两级），「当前项目」kicker 移除；进行中/已归档页签与搜索框合并为同一行（分隔线由行承载，窄窗换行）；列表行尾增加「›」打开指示（仅交互行，表头不显示）；「新建项目」主按钮按图改为纯文字。侧栏待审计数徽标改为墨绿底白字（对照导航徽标）。任务详情、三工作台、知识与动态的空态为 fixture 模式如实规则（不生成虚构资料/记录），live 结构已在此前验收中覆盖；效果图右栏中的任务标签、计划完成等字段当前契约未定义，不虚构实现。逐页剩余偏差以真实契约字段与 token 数值为准，示例文案与示例日期不复制为产品事实。

同日 live 状态页对照接续（真实命令构造状态，截图见 [live 对照证据](../testing/evidence/replica-2026-09-29/live/)）：运行详情页改为「主列 + 右栏」结构——新增「运行信息」栏（运行编号/运行状态/任务状态/当前执行者/等待原因，均引用既有字段），「控制请求」与「资源与租约」面板移入右栏，主列保留暂停摘要、Gateway 动作历史、步骤时间线与 Trace；纯布局移动，控制命令与文案不变。完成凭据页同样拆为「主列 + 提交事实右栏」。产物保存的版本冲突提示由红色 action-error 改为琥珀 warning-callout（保留服务端版本/提交基线的确切数字与"草稿不会被覆盖"语义），并附「查看版本历史与差异」入口。live 对照路径：知识登记→阅读器（UI-15）、委托→运行控制→真实暂停（UI-18/19）、开始→逐项勾选验收→完成→完成凭据（UI-27）、UI 保存 v1→并发写手推进两版→UI 保存吃 409（UI-26）。执行结果未确认（UI-20）与 Git 动作批准（UI-22）无法在自然业务流程中构造（分别需 debug 进程强杀与 Gateway Git 审批配置），按不造假原则不在本轮截图比对；两者界面实现在 M03–M06 模块验收中覆盖。工作区另存在并行会话的未提交 Agent 聊天切片（未跟踪文件），本轮未触碰。

同日侧栏拖拽调宽接续：视口 ≥64rem 时侧栏右缘分隔条可拖拽调整宽度（10–20rem，双击复位），也支持键盘左右方向键按 1rem 步进并带 `role="separator"` 值语义；宽度为纯展示偏好，仅保存在 `localStorage`（`relay.workbench.sidebarWidthPx`），不承载业务事实。用户宽度经 `--relay-sidebar-user-width` 只注入 `.app-frame` 基础列宽，≤63.9375rem 断点仍用固定 compactWidth 显式列宽，收起/抽屉行为不变；分隔条在窄断点隐藏。拖拽用指针捕获，不改变导航焦点序（Tab 顺序为导航 → 内容 → 分隔条）。

## 8. 前端验收

组件测试覆盖版本冲突、待决请求、审批过期、空列表和不可用 capability；桌面 E2E 覆盖人工完成/重开、窗口重载/重连、切工作台不变 Run、AI Panel 迟到响应、Later 持久化。并发冲突由桌面 UI 与受控测试客户端竞争验证，不据此增加产品多窗口。开发浏览器组件测试可辅助，不能代替真实壳内 E2E。前端模拟数据仅用于开发，发布必须连真实 API。

视觉验收按[设计系统第 8 节](design-system.md#8-验证与交付边界)执行，文档/token 静态检查与真实页面验收分别报告。

## 9. 静态页面效果图

2026-09-19 按用户提供的[论文验收页参考图](../../thesis-review-original-20260919.png)延展其他页面：暖白底色、墨绿强调色、宋体标题、细分隔线与宽留白，保留一致的左侧导航和右侧上下文区域。该轮只形成视觉概念，不新增功能承诺，也不将 Proposed 决策标为 Accepted。

| 页面 | 效果图 | 主要呈现 |
|---|---|---|
| 今日工作台 | [today.png](mockups/2026-09-19/today.png) | 人工置顶焦点、可开始任务、待审入口与推荐依据 |
| 项目总览 | [project-overview.png](mockups/2026-09-19/project-overview.png) | 已确认状态、待明确问题、版本化产物与下一步 |
| 开发工作台 | [development-workbench.png](mockups/2026-09-19/development-workbench.png) | 隔离变化集、差异、检查证据与人工接受；接受不等于写回或 Git 提交/推送 |

截至2026-09-20，已延展为32张生成图与1张原始参考，覆盖基础页面、关键流程状态及首批四项 Skill 交互；上表保留首批3张入口。完整清单、基础批次5张修正版及已知偏差见[效果图目录](mockups/2026-09-19/README.md)，实施输入见[33个逐页开发提示词](page-development-prompts.md)。

图片通过内置 Image Gen 生成，[首批提示词](mockups/2026-09-19/prompts.md)及效果图目录中的后续记录保留生成依据。图片中的项目状态、代码片段、版本及检查结果都是示例，不能作为真实运行或测试证据；图像偏差按目录及开发提示词修正，不覆盖业务规范。字体、尺寸与可访问性仍需在后续实现中验证。

## 10. 成果共创与变化守护探索

2026-09-27 实施接续：恢复速览已接已关联 Goal、读取完成时间和来源缺口；产物来源页可读确切版本正文、选择同一产物的比较基线并主动查询已登记直接引用。人工修订仍经原不可变版本和 CAS 命令。变化检查仅覆盖已登记直接边，空结果不代表无影响；锁定、局部自动改写、跨成果传播和后台监控仍属下文待定方案。实际文件、并发修订复核和验证边界见 [25 日开发记录](../development/product-supplement-2026-09-25.md)，不以这些增量宣称本节全部完成。

2026-09-25，Proposed，未因本文补充而实现或验收。产品责任边界见 [Master Spec](../../Personal_Workflow_OS_Master_Spec.md#02-协作形态补充2026-09-25proposed)，实施范围见[协作形态探索补充](../requirements/v1-scope.md#协作形态探索补充)。本节描述候选交互，不新增一级导航或变更当前路由；自动监控不前移到 V1。

### 10.1 已确认的锁定与影响检查规则

2026-09-28，**产品规则已确认；四项独立验收退回项已修复并完成定向自检，待协调侧独立复验**。隔离 Windows 宿主的通知投递、点击和回窗已有[定向证据](../testing/evidence/collaboration-controls-windows-notifications.txt)，尚非安装包或协调侧验收。用户逐项选择原文锁定、章节/段落粒度、只约束 AI、局部冲突局部暂停，以及手动检查、先列影响再选范围、明确引用与 AI 推测分组。本节取代下文历史探索中对应的待定项，不代表全篇 Proposed 已转为 Accepted。实现边界与证据见[本轮开发记录](../development/collaboration-controls-2026-09-28.md)。

| 决策 | 已确认行为 | 取舍 |
|---|---|---|
| 锁定内容 | 用户按章节或段落锁定原文；AI 不得自动修改锁定部分。可以指出问题、提出候选，但应用前须由用户解除锁定。 | 保护确切文本，不依靠模型判断“意思没变”。 |
| 人工编辑 | 锁定只约束 AI；用户可直接编辑，保存为新版本后，该部分继续锁定并保护修改后的原文。 | 保留人工控制，不能借刷新版本让 AI 覆盖用户修改。 |
| 发现冲突 | 保留锁定原文，说明与新证据的冲突；暂停依赖该冲突的部分，继续不受影响的独立工作。未解决冲突不能被整体完成声明掩盖。 | 避免局部冲突停掉全部工作，同时不绕过原 Task 完成契约。 |
| 检查触发 | 首版只在用户主动点击“检查影响”时执行，不在每次修改或发布新版本后自动分析。 | 减少无用分析和模型额度消耗；没有检查就不能声称后台已发现冲突。 |
| 修改入口 | 先列影响与依据，用户选定处理范围后 AI 才生成修改候选，不自动应用修改。 | 影响分析的模型调用与生成修改候选是两件事；前者不获得修改权限。 |
| 证据分组 | 分开展示“明确引用”和“AI 推测可能相关”，推测项须经用户确认才进入处理范围。 | 引用存在不等于本次变化必然要求修改；缺少引用证据不能宣称清单完整或无影响。 |

沿用既有版本、权限和验收约束：分析与候选保留确切来源/目标依据；应用前重新核对目标、来源、锁定与批准，不能继承旧版本的验证。AI 推测仍受已有显式选源、外发、预算与 Provider 门槛约束，不能用本次产品选择绕过这些门槛。

本轮采用确切 Markdown 原文、唯一匹配及相邻结构保守映射，并在 Artifact/AI 写入 Owner 执行端保护；移动、拆分、合并或删除不能靠行号或提示词绕过。保护判断保留原始换行与行尾空格；旧锁记录若与原版本的确切选区不一致，保留为不可映射并拒绝 AI 写入，等待人工核对。无法可靠映射时不静默丢锁。显式引用维护与更深的间接影响分析仍超出本轮范围；具体工程取舍、测试与待验限制见[本轮开发记录](../development/collaboration-controls-2026-09-28.md)。

### 候选闭环：实验结果更新

1. 用户在项目中发布新的受管实验结果版本；首个探索可由用户主动点击检查影响，输入格式及导入方式待定。
2. 系统依据明确引用列出相关图表和章节，显示旧/新来源版本及判断依据。直接使用旧数据的图表标记“待更新”；引用旧结果的章节标记“待复核”；模型推测的语义影响单列“可能相关”，等待确认，不直接宣布论点失效。
3. 用户查看局部差异，选择本次处理范围。已锁定内容禁止自动修改，但仍展示过时提示；未选择部分保持原版本，未解决影响继续可见。
4. Agent 在确认范围与预算内生成候选新版本。应用前核对来源、目标及锁定状态；分析后又发生变化时重新检查，不覆盖用户新编辑或复用失效批准。
5. 用户审查新版本并执行对应验证/接受流程；只有业务完成事实成立后更新项目当前状态，保留旧版本、来源与历史证据。未处理影响不因某一图表更新而被全部标为解决。

项目总览优先呈现真实状态、完成证据、阻塞和下一步；成果页呈现引用、影响、差异与局部操作；AI Panel 解释依据并协助处理当前对象。守护发现的变化先作为待处理建议，只有确实需要批准的动作才进入绑定目标版本的 Review，避免每条通知都制造一次审批。

未来自动触发时，用户需能查看监控范围及暂停监控；同一变化的重复信号应合并，未变化或无可行动内容时不重复打扰。通知说明“变化是什么、依据是什么、需要你做什么”，不能用“有新动态”代替判断。暂停监控与取消已发出的执行是不同操作。

“撤销”需要显示实际边界：内部成果可通过发布恢复内容的新版本实现，仍须重新验证；外部副作用按既有恢复契约核对或补偿，不能承诺通用回滚。即时比较面板可以辅助选择范围，写入仍通过现有领域命令，不绕过权限、revision 或审批。

### 探索验证判据

- 用户离开再返回时，无需翻聊天即可定位已确认成果、未决影响和下一步；每项结论能追溯来源版本。
- 明确引用与模型推测分别展示；没有依赖证据时，不伪造完整影响清单或声称“没有影响”。
- 修改范围之外及锁定部分不被自动覆盖；锁定部分过时仍有提示；并发编辑导致原提案失效时保留用户输入。
- 旧来源生成的候选不会被当作基于新来源已验证；局部完成不会隐藏其他未解决影响。
- 重复事件不产生重复提醒或重复执行；停止、预算耗尽及需要人工决定时可明确解释等待原因。

以上是尚未执行的场景判据。锁定粒度和手动影响检查以第 10.1 节为准，提醒以第 11.5 节为准；关系维护、聚合窗口及评价基线仍需设计，不作为当前模块已通过的测试证据。

## 11. AI 并行开发的注意力与验收体验

2026-09-27 实施接续：`/tasks?tab=attention` 提供跨项目人工待处理投影，Today 与全部任务页提供入口；原收件箱仍为未归属项目的人工任务。队列分组显示开放 Review、已读 Task 和其当前 Run 的未决操作/控制请求，分页或读取失败明确标为不完整，保留原业务身份和处理入口。Task 验收区展示条件、受验对象、计划关联、历史检查、当前完成凭据和缺口；Trace 未提供撤销事实时历史 PASS 的当前适用性保持未核实，组合版本保持未验证。实现及限制见 [26 日开发记录](../development/product-supplement-2026-09-26.md)；下文提醒策略与体验效果仍为候选。

2026-09-26，Proposed。本节承接[产品目标](../../Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)，描述待细化的业务交互，不是当前 UI 已实现说明。范围和启动前待讨论项见[需求补充](../requirements/v1-scope.md#ai-并行开发体验补充)；不新增一级导航，优先组合 Today、Project/Task、Review、Run Trace 与现有 Skill 入口。

### 11.1 按人工介入组织待处理项

队列以“需要用户处理什么”为主，保留项目、任务与执行来源。普通执行进度可展开查看；排序解释、等待原因、延后影响和下一步操作须有事实依据，未知影响明确标注，模型建议不作为确定截止时间。

| 观察到的情况 | 建议交互 | 执行边界 |
|---|---|---|
| 正常执行，无需人工介入 | 后台推进，汇总进度 | 不因用户切换 Focus 改变 Run 契约 |
| 可在既有授权内修复的问题 | 展示修复/复验进展与剩余预算 | 沿用有界修复，不隐瞒必需人工决定或扩大权限 |
| 候选成果产生或已有任务完成 | 汇总待验收或完成记录，允许集中查看 | 候选、验证通过与业务完成分开；不对已完成任务虚构额外审批 |
| 缺少关键决定、发生冲突或预算耗尽 | 展示原因、选择及后果，按待定策略提醒 | 需要等待的执行仍等待；延后查看不等于批准 |
| 状态、外部效果或回执无法确认 | 显示未知、最后确认时间与核对入口 | 不按失联时长推断成功，也不盲重试外部动作 |

同一事项的重复信号合并，批量处理首先指集中审查，不默认一键批准不同目标。每项决定仍绑定确切对象和版本；决定已被其他入口处理或依据变化时刷新，禁止提交过期决定。Later、静音或 Focus 不隐藏尚未解决的必需项，也不消除阻塞。运行期间提醒的产品规则见第 11.5 节，尚未实现；不在本节承诺后台内容监控。

待验收积压时，候选体验是展示积压并建议暂缓新委托或降低并发。阈值与控制策略待确认；不能只靠前端隐藏按钮实现调度，也不能自动取消在途动作或替用户接受成果。

### 11.2 恢复摘要与接手

摘要围绕当前项目或任务提供：目标与上次确认事项、比较基线后的变化、已验证成果及未决风险、当前需要的决定、决定后的下一步。每项结论可展开来源、版本与时间；没有可靠的上次查看基线时只展示当前快照，不声称“自上次以来”。来源缺失或过期时保留缺口，不用生成文本补成事实。

摘要中的操作进入既有命令入口，提交前重新核对状态与版本。打开摘要不取得执行权，阅读 Review 不等于 Handoff；真正接手仍需显示等待安全点与已接手的区别。交付摘要补充行为变化、设计原因、影响模块和剩余限制，依据不足的原因标为待确认，帮助用户按需恢复对实现的理解。

### 11.3 面向需求的验收视图

视图按“用户目标 → 必须成立的行为 → 变更影响 → 验证方式 → 实际证据 → 覆盖缺口”组织。每条重要行为关联已接受的验收条件或显式标注为候选；附来源、是否必需、受验对象、检查/人工判断、证据有效性及下一步。已有需求、历史缺陷、代码差异和依赖可用于提出遗漏候选，但文件引用不等于已证明语义影响；确定影响、可能影响和未分析范围分开。

单项结果沿用[验证契约](../../contracts/03-verification-and-approval.md#3-单项检查与总决策)；未建立检查关联、已有检查未运行、检查器错误、证据不足、历史结果当前不适用和不适用条件分别呈现，不混成绿色通过。视图标签不是新增持久化状态或 Verification 总决策。覆盖完整性未知时明确保留，不以代码覆盖率或通过测试数计算“需求已全部覆盖”。

Worker 自报完成、生成测试或另一 Agent 赞同均不能直接成为 PASS。沿用受保护的基准检查与版本绑定；测试修改、删减、跳过可见，必需检查缺口仍阻止按原契约完成。新增的风险建议需审查，不能静默改写冻结验收；实质变更按原契约产生新版本并处理活动 Run。

多个任务各自通过后，展示是否验证了最终组合版本及共享接口、数据变化的影响。隔离工作目录不证明组合正确；组合版本没有对应证据时显示未验证，不把各分支成绩自动相加。人工决定逐项绑定当前目标，证据或目标变化后重新核对。

### 11.4 候选端到端体验

用户在两个项目发起多个任务并离开；返回后从统一队列先定位需要的决定，进入恢复摘要理解变化，再从验收视图查看重要行为、真实证据与缺口。处理决定或验收后，队列从领域事实更新，其他未解决事项继续保留。

优先以一个真实执行入口证明上述链路。外部工具未提供可信关联、状态、版本或回执时显示未知或待人工核对；不得仅凭聊天摘要自动更新 Task 完成状态，不在本节指定 Connector、协议或数据库结构。该体验的场景反例及衡量方法统一见[验证提案](../testing/verification-plan.md#11-ai-并行开发体验验证提案)。

### 11.5 已确认的人工介入提醒规则

2026-09-28，**产品规则已确认；宿主权限、最小化后回窗与待处理空态已修复并完成定向自检，待协调侧独立复验**。隔离 Windows 宿主的原生系统投递与点击已[实测](../testing/evidence/collaboration-controls-windows-notifications.txt)；安装包及协调侧复验仍待完成。用户选择仅提醒必须介入的事项、应用内与 Windows 通知结合、同一事项仅一次，并合并短时间内的多个事项。证据与限制见[本轮开发记录](../development/collaboration-controls-2026-09-28.md)。

1. 仅对已发现且必须由用户介入的事项主动提醒，例如待审批、锁定内容的待处理冲突、无法自行继续的失败或结果不明。普通进度和成功完成留在页面中，不发此类主动提醒；若执行完成后还需人工验收，提醒依据是待验收事项而非“执行成功”。
2. 限 Relay 正在运行期间：应用内始终保留未解决事项及待处理标记；用户不在 Relay 窗口时额外发送 Windows 通知。不承诺应用退出后的通知或常驻后台服务。
3. 同一事项只提醒一次，不定时催促，也不增加“稍后提醒”。只有新的、需要用户介入的变化才再次通知；重复事件、刷新和重新查询不能当作新变化。
4. 短时间内多个事项合并为一条系统通知，例如“3 个事项需要你处理”，点击进入待处理列表。每项的业务身份、原因与原处理入口独立保留；单项通知进入对应原事项。
5. 通知不等于审批或处理完成。已解决或版本变化的事项在打开时按原事实核对；通知关闭、未显示或被系统限制，也不能抹掉应用内未解决事项。

选择理由：将打扰集中在可行动的人工作业，避免普通进度、重复催促和通知连发。内容影响分析仍是第 10.1 节的手动动作；本节不启动后台影响扫描，也不自动降低并发或取消运行。

实现默认聚合窗口为 3 秒；事项身份与变化由业务 ID/revision 及数据库回执去重，投递拒绝或失败不抹掉应用内事项。该秒数属于工程默认值，不是用户选择；Windows 实际投递/点击仍须按[验证计划第 13 节](../testing/verification-plan.md#13-锁定影响检查与提醒的已确认规则验收)在真实安装宿主核验。

## 12. 人和 AI 共用的知识库体验

2026-09-28 实施接续：知识详情沿原知识版本提供 Markdown/纯文本完整阅读、目录、来源和历史选择；显式旧引用缺失时展示错误，不以最新内容兜底。项目导读读取既有 Goal、决定、规则和资料，未建立的流程/关键关系保留缺口。产物收录先读取确切版本并显示目标范围，由用户核对后调用原命令；笔记修订冻结起草 revision，冲突保稿。已保存网页快照无需访问原网页，收录不等于验收或 AI 外发授权。实际场景与边界见 [27 日补充开发记录](../development/product-supplement-2026-09-27.md)；人工编排、AI 自动沉淀和原件同步仍待设计，真实 Windows 阅读与理解效果尚未验证。

视觉接续：用户已确认 [2026-09-27 知识库三张概念图](mockups/2026-09-27/README.md)，覆盖导读、正文阅读和收录确认。确认的是视觉方向；下述 Proposed 交互的契约与实现状态不因此改变。

2026-09-27。承接[知识库范围](../requirements/v1-scope.md#人和-ai-共用的知识库补充)，补全既有 UI-14–16 的阅读要求；项目导读与沉淀交互的具体方案仍 Proposed。保留 `/knowledge` 与 `/projects/:id/knowledge` 入口，聚合展示 Knowledge/Memory/Decision/Rule 时仍按各自语义读写；不增加一级导航或把四类内容写成万能文档。

### 12.1 从项目理解进入知识

用户可从知识列表、搜索、项目资料或当前任务的确切引用进入正文，再返回原上下文。列表提供标题、范围、来源类型和当前版本等有依据的信息，摘录用于定位；搜索无结果、读取失败和内容不可用分别呈现。

项目导读候选围绕目标与范围、核心流程说明、关键决定、验收要求和经验组织已有内容。目标和当前状态取原事实投影，其他内容按明确引用导航；没有相应资料时显示待补充，不自动生成“完整项目说明”。导读是否支持人工编排、关系如何保存及更新仍待设计，不以一排管理表格代替完整的阅读路径。

### 12.2 正文、历史与来源

资料详情以完整正文为主体，支持 Markdown 安全渲染或纯文本阅读；存在标题结构时可提供文内目录，不强行给纯文本生成章节。来源、版本、更新时间和确切关联作为辅助信息，ID/hash 不占据阅读主体。只取到摘录或部分内容时明确说明，不标为全文。

用户能辨别当前版本与所选历史版本，切换时标题、正文和来源共同绑定目标；权限失效、原内容缺失、格式不支持、正文加载失败或来源变化都有明确状态，不能拿最新版填充旧版本。受管历史内容仍可读时，不因原网页变化就隐藏该快照；打开当前原件须说明它可能与快照不同。相关任务、产物或决定只展示可验证的引用，没有关联数据不伪造反向链接。

本机 API 与已保存内容可用时，关闭模型或断开外部网络仍可浏览受管知识；外部原件在线访问另行说明。阅读、搜索和切版本不会调用模型或自动发送正文；“用于 AI”通过原选源/权限入口明确范围与版本，不能以阅读行为代替授权。

### 12.3 修订与沉淀

笔记编辑保存为新版本，冲突保留草稿，历史引用不随保存改变。外部原件和产物引用以来源入口或新笔记方式处理，不提供看似编辑副本却悄悄写回仓库/原产物的操作。原件引用、快照与本地笔记在界面上可区分。

AI 可提出整理建议，用户查看内容、来源、归类与目标范围后再确认保存；产物提升关联确切 ArtifactVersion，不自动收录全部聊天、候选和日志。表示“人工确认”时需说明确认了收录、摘要还是特定内容判断；没有对应事实只显示来源，不猜测确认状态。Knowledge 阅读不自动将其升级为 Decision/Rule，知识里的验收说明链接原验收条件和证据，不独立宣布 Task 完成。

建议沉淀、导读与确认信息缺少实际 API/字段时列出缺口并先定契约，不制造假成功。当前页面是否达到这些要求须另以[第 12 节阅读与来源场景](../testing/verification-plan.md#12-共享知识库的阅读与来源验证)核验，本文不是已实现或体验通过的记录。

## 13. 交互反馈与业务状态绑定

2026-09-30 M04 失败诊断：Assist 消息保留服务端 Relay 错误码，并在 `FAILED` 且存在 `provider_error_kind` 时显示对应中文处理指引；与设置页的连接验证共用同一套指引。鉴权、限流、超时、断流、协议和网络失败分别表达；没有类别的历史消息及预算/业务失败不猜测 Provider 原因。展示失败不重新发送消息，不增加自动重试或模型配置写入。

Run 页按需展开的 Trace 与协作页「检查」使用同一组件，逐条显示原模型调用的用途、Attempt、Manifest、Provider 请求身份，以及语义检查的条件和检查尝试；失败类别沿用上述中文指引。调用失败不等于 Run 失败，当前执行状态仍读取 Run 事实。STARTED、COMPLETED、CANCELLED、本地处理故障及无分类历史不显示 Provider 失败指引；未知用量不补零，不提供换动作身份或自动重跑入口。

2026-09-29 设计补充：将已有业务约束映射到鼠标、键盘与异步反馈，不增加命令、授权或新状态枚举。以下为跨页目标规范，实际覆盖程度须逐场景验证。视觉见[控件状态](design-system.md#61-交互状态的统一表达2026-09-29)及[静态图](mockups/2026-09-29/README.md)。

| 场景与责任对象 | 激活后立即反馈 | 确认后可发生的变化 | 异常与恢复 |
|---|---|---|---|
| 查看版本 / ArtifactVersion | 仅切换查看目标，正文标出确切版本 | 读取成功展示该版本；当前选用与正在查看分别标记 | 不可读就近说明，不能用最新版代替；不自动选用或接受 |
| 保存修订 / 原业务写入入口 | 保留草稿，显示保存中，冻结本次目标与版本基准 | 保存成功显示新版本；不继承旧验证或接受 | 冲突保留草稿并提供对照；回执不明先核对原命令，不能连点另发 |
| 接受并完成 / 完成用例 | 清楚展示产物、验收依据及有效检查，提交中禁止重复 | 只有完成提交确认才显示任务已完成及对应完成记录 | 版本/条件/权限改变即失效；重读后重新判断；回执不明显示核对入口 |
| 动作批准 / Review、Gateway | 保留原动作、作用范围与影响，提交判断中 | 只确认判断已记录；执行结果另从原动作读取 | 过期或权限撤销不能提交；批准不显示为执行成功 |
| 暂停、取消 / Run 控制 | 显示请求已提交或待确认，保留当前执行者 | 按实际收敛状态显示已暂停/已取消 | 未安全结束不提前宣布完成；暂停不授予编辑权 |
| 请求接手 / Handoff | 请求受理后显示等待安全交接，正文保持只读 | 交接确认且执行权已转移才启用人工保存 | 未确认在途动作先核对；超时不是交接成功；Review 不替代接手 |
| 外部动作结果未确认 / 原 Operation、Invocation | 持续显示影响对象、待核对范围与核对入口 | 按核对/处置的确切结果刷新，不把结清等同成功 | 不换动作 ID、Adapter 或盲目重试；UNKNOWN 不是新增 Run 枚举 |
| 知识来源选择 / Context 输入 | 阅读、来源预览、勾选各自独立 | 显式选择确切版本才进入相应请求；仍按权限检查 | 来源失效不能静默替换；外部正文不能升级成规则或授权 |

网络请求结束、HTTP 受理、命令已应用和业务完成是不同层级。文案必须写清已确认哪一步；普通读请求失败不标成外部副作用 UNKNOWN。具体回执核对及同 ID 重试仅遵守该命令已定义的恢复契约；没有恢复接口时明确未确认并保留关联信息，不虚构按钮能力。

版本、任务、项目和 Workspace 切换后，旧异步响应不能改变当前对象、焦点或通知。未决命令关联原作用域；返回原对象再提供恢复，不在新对象重放。后台 Run 不因关闭抽屉、切页或 Esc 被隐式取消；离开未保存编辑须保护草稿。权限撤销时清除不可继续展示的内容，不能以保留旧快照规避鉴权。

标题栏搜索、创建入口遵守第2节当前能力，结果中不虚构尚未接入的对象类型。窗口关闭是宿主行为，不能用“正在保存”动画承诺后台继续；按桌面生命周期契约执行。锁定内容的修改与手动影响检查遵守第10.1节，提示不能擅自解锁或把候选影响标成已确认。人工介入提醒遵守第11.5节，不为普通 hover、每段流式输出或重复刷新产生提醒。

前端验收逐项记录触发方式、即时反馈、持久事实、允许的下一步和恢复证据，见[第15节](../testing/verification-plan.md#15-交互状态与反馈验收)。图像是状态示意，不能替代这些证据。

## 14. 以目标协作为中心的工作台改造

2026-09-29。来源：用户指出页面偏向传统 SaaS、Agent 协作重心不足，要求先设计、不改代码；随后在三个视觉方向中选择方向 1「对话主轴 · 双页工作桌」。[已选视觉参考](mockups/2026-09-29/collaboration-dialogue-selected.png)确定对话主轴、独立产物区和近期工作导航的方向；以下状态深化为设计提案，尚未授权代码实施。图中全部内容是设计演示，不能作为运行事实；“Run 已暂停于等待判断”不作为状态文案采纳，等待判断与实际 PAUSED 必须分别读取和表达。相关产品定位见 [Master Spec 第 86 节](../../Personal_Workflow_OS_Master_Spec.md#86-information-architecture)，视觉层级归[设计系统](design-system.md#51-协作工作区的视觉层级)，验收场景归[测试计划第 16 节](../testing/verification-plan.md#16-agent-协作主线验收提案)。

### 14.1 问题与设计目标

现有路由和页面结构先呈现项目/任务对象，再由用户打开 Assist、Run、产物与 Review。新增独立聊天入口改善了会话可达性，但仍需要用户在不同页面拼合目标、执行进展与结果。此判断来自源码与交互文档，不是本轮真实窗口视觉审查或用户研究结论。

目标是让用户持续回答四个问题：这次要完成什么、Agent 正在做什么、已经形成什么结果、现在需要我决定什么。Project 提供长期上下文，Task 是受控工作单位，Run、Artifact、Review 保持各自责任；它们不必一一对应顶层页面。协作区是这些事实的组合展示，不新增“工作会话完成”等第二套业务状态。

### 14.2 入口与导航提案

| 位置 | 目标职责 | 与既有能力的关系 |
|---|---|---|
| 默认工作入口 | 继续近期工作、查看正在执行及需要判断的事项、输入新目标 | 推荐复用 `/agent` 承载，正式默认路由待视觉与路径评审；本轮不修改根路由。Today 的日期、Focus/Pin/Later 规则继续独立有效 |
| 左侧导航 | 采用已选图的近期工作主组，项目、全部任务、知识为辅助定位；搜索与设置保持可达 | 动态、连接、全局待审和 Today 保留在次级入口，不删除路由。近期工作每行显示工作名与所属项目；范围和排序仍待确认，不把会话列表冒充全部工作 |
| 项目入口 | 恢复目标、当前成果、未决事项和下一步，再进入具体工作 | 列表、筛选和批量管理保留为辅助视图；不删除旧深链接或人工路径 |
| 工作主区 | 同一目标下的讨论、计划、实际执行进展与必要确认 | 复用原 Assist/Task/Run/Review 身份；会话消息不等于执行记录，计划建议不等于已启动 |
| 产物区 | 直接阅读、比较和按权限编辑确切产物版本 | 是可独立操作的正文区域，不把文档和 diff 塞成聊天附件摘要；未有产物时不制造空的“完成结果” |
| 详情层 | 来源、步骤、调用、版本、审计与高级配置按需展开 | 不默认铺 ID/hash/技术错误栈；不折叠阻塞原因、影响范围、必要证据或当前执行权 |

打开首页不自动新建会话、Task 或 Run，也不自动调用模型。已有工作直接继承并显式显示已核对的 Project/Task；新目标可以先作为本地未提交输入，选择或确认所属项目/任务后才按现有能力发送。无目标会话不是当前已具备能力，不为省一个选择步骤暗中创建业务对象。自由文本中的动词不自动构成 Delegate、批准或完成授权。

### 14.3 一项工作的连续交互

1. **恢复或表达目标。** 回到工作时显示真实进展、确切产物与待办；缺少变化基线时不声称“上次之后新增”。输入与当前目标放在同一视野，目标歧义在提交前澄清。
2. **确认工作边界。** 展示结果要求、来源、范围与必要验收条件。简单讨论可用 Assist；生成计划和执行委托分别表达。已有条件复用，只有缺失或发生变化时才要求补充，不用大表单重复录入。
3. **执行并查看结果。** 主区展示实际阶段、最近有依据的进展及停顿原因；产物区可阅读生成中草稿或已保存版本，两者明确区分。不显示虚构百分比、隐藏推理或把工具调用次数当作价值。
4. **在需要时作出判断。** 同一工作区就近呈现原 Review 的目标、版本、影响和证据，提供准确动作；确认后保留判断结果与后续执行状态。信息不足、过期或失权时禁用并说明原因。
5. **验收与继续。** 对照要求检查确切产物与证据，允许人工修订或请求安全接手。只有完成用例确认后显示业务完成；下一步建议可见，但不自动启动下一任务。

“在同一工作区”指维持目标、上下文与返回位置，可以切面板或打开必要详情；不要求所有内容堆在一个滚动区。普通推进不应强迫用户在 Task、Assist、Run、Review 页面反复寻找下一操作。深层审计、项目管理与设置仍可使用独立页面。

### 14.4 状态、人工路径与责任边界

| 场景 | 主要呈现与操作 | 必须保持的业务边界 |
|---|---|---|
| 新用户或无近期工作 | 目标输入、创建/选择项目或人工任务入口 | 不伪造历史、示例进展或默认模型调用 |
| 无模型、离线或服务读取失败 | 区分模型不可用与业务服务不可用，展示已有可读内容及明确限制 | 模型不可用不阻断服务支持的人工阅读/编辑；服务不可用时不承诺保存成功 |
| 正在执行 | 实际阶段、当前执行者、产物/草稿、暂停或停止入口 | 控制意图持久化；请求中不显示已停止，不因切面板改变 Run |
| 待判断或有阻塞 | 优先显示为何需要人、影响及允许操作 | 复用原待办与 Review，不新增另一套审批队列；Focus/Later 不隐藏必需介入 |
| 失败或外部结果待核对 | 保留可读产物、原因与原操作的恢复入口 | 失败、普通读错误与外部 UNKNOWN 分别表达；无协议支持的动作不造按钮 |
| 人工接手 | 显示请求中、安全交接结果及最新可编辑版本 | Review 不转移执行权，暂停也不等于可编辑；完成交接后才启用受保护写入 |
| 切换工作或重新进入 | 恢复确切对象、版本和已持久化进展；保护未提交输入 | 不改变会话归属、不重放命令，迟到响应隔离；窗口关闭后的输入/回执恢复能力须单独设计验证 |

查询沿用原鉴权与来源可用性，写入沿用 Application/领域 Owner。跨对象的聚合读取如现有接口不足，应列出缺口并另行设计，禁止直接写数据库、创建持久化第二投影或自行扩张权限。本次没有 API/schema/状态枚举变更；自然语言入口不引入自治调度、多 Agent Router、跨项目默认执行或关闭窗口后继续运行的承诺。

### 14.5 设计与后续落地次序

方向 1 已由用户选择；本节保留原先“先选视觉、再深化、另行授权实施”的顺序。深化覆盖下述完整状态，三种工作台共享这条主线：论文保留章节与证据、开发保留 diff 与测试、通用保留文档和结果操作。未接入的开发工具不因采用相同布局成为已支持能力。

仍待确认：正式默认路由及稳定工作深链接；近期工作的展示范围和排序；跨窗口恢复所需存储与安全边界。对话/产物的状态主次及新目标归属步骤按下述方案深化，精确尺寸需用真实内容验证。涉及能力缺口时先核对真实 API，不以新界面文案承诺已支持。

后续实现需另有明确授权，先完成一条端到端路径并验收，再推广同类页面。既有列表、手工编辑、搜索、知识阅读、设置和深链接须保留可达性；旧图的布局一致性不作为阻止已选新方向的理由。当前 M01–M07 状态、运行证据和发布出口不因本次设计提案发生变化。

### 14.6 已选方向的工作区与动作

完整窗口沿用第 2 节的共享 Windows 标题栏，与下方业务上下文栏分开；[补入标题栏的修订图](mockups/2026-09-29/collaboration-dialogue-window.png)作为当前视觉参考，原选稿保留历史。标题栏包含后退、前进、搜索、新建任务、空白拖动区和窗口控制；所有后续状态与窄窗稿都计入它的高度。关闭及导航继续保护未提交草稿，窗口按钮不触发 Run 控制，也不承诺关闭后后台常驻。

2026-09-29 实施结果（开发自检，非 Windows 验收）：`/agent` 已按本节组织为协作工作区，根路由仍为 `/projects`，旧路由与深链接全部保留。

2026-10-01 入口精修：无选中任务时突出「选择要推进的任务」，也可从共享近期工作继续；右侧只提供产物、判断与完成的阅读指引。展开选择后，任务列表加载、读取失败或为空时禁用选择与打开，未选择任务时不能打开；恢复确切任务期间显示读取状态。选择与打开只读取现有 Task，并进入原 `?work={taskId}`，不创建 Task、会话或 Run，不调用模型。讨论、委托、判断与完成继续分别确认；活跃工作区和写入入口沿用原组件。

2026-09-30 入口修复：全局主导航和窄屏导航抽屉增加「协作」入口，直接打开 `/agent`；真实任务详情提供「进入协作工作区」，通过 `?work={taskId}` 定位当前任务。此前近期工作列表仅在 `/agent` 内显示，外部页面没有入口，导致从默认项目首页无法发现协作界面。导航只切换视图并读取已有事实，不自动创建会话、Task 或 Run，也不调用模型；示例模式进入协作页仍明确说明缺少真实工作。默认首页继续为 `/projects`。

同日按用户要求，近期工作改为所有 live 页面共享的常驻导航：项目、任务、知识、设置及其他页面均由 `AppShell` 显示，切页保留同一列表；窄屏在完整导航抽屉中提供相同入口，选工作后关闭抽屉并进入原 `/agent?work={taskId}`。连接切换重建列表以隔离旧 Workspace；重读先清旧条目，分页失权同样隐藏旧列表，读取失败不使用写入回执待核对的文案。示例模式仍不伪造历史工作。全局列表的只读查询与当前页面查询各自独立，不把读取列表视为创建或启动工作。

同日布局精修：用户选择保留现有“双页工作桌”风格。近期列表改为独立滚动，导航与开始工作入口不再被长列表推出窗口；完整工作名可通过悬停或可访问名称读取。讨论/文档是否并排按工作区实际可用宽度判断，保留用户侧栏宽度偏好；窄窗用原页签切换，高度不足允许滚到末段操作。无会话时显示“开始讨论”和明确的新建入口，必须点击并收到创建结果后才能发送；不自动创建、不以装饰输入框冒充可发送能力。会话创建失败、原命令待核对、查询回执与重试继续走同一 Assist 入口。视觉规则见[设计系统第 5.1 节](design-system.md#51-协作工作区的视觉层级)。

真实状态纠偏：正文加载、失败和无版本分别呈现；读取失败保留请求的确切版本与保存时间，提供“重试读取正文”和任务产物入口，不自动重试，不将 GET 失败写成“完成被拒绝”。用户切换版本后，迟到响应不能覆盖新选择；正文尚在读取时禁用比较，避免旧请求与加载状态争用。无正文时不撑满阅读纸面。协作委托设置默认折叠，折叠保留输入；不可用原因在入口下可见，提交中、失败或结果未知自动展开并保留原 `command_id` 与核对入口，不能通过折叠重新提交。通知入口挂在顶栏，展开可查看待处理、状态及显式权限按钮，关闭弹层不改变后台轮询或业务状态，也不自动请求通知权限。

按[含标题栏的修订图](mockups/2026-09-29/collaboration-dialogue-window.png)复核后的实际结构是「全局左栏（近期工作）→ 顶部目标与事实条 → 对话中栏 + 右栏三页签」。首版把近期工作做成协作页内嵌的第二栏，与图的单栏结构不一致，本轮已合并进 `AppShell` 左栏；协作页不再有自己的左栏。

| 区域 | 已实现内容 | 边界 |
|---|---|---|
| 全局左栏「近期工作」 | 所有 live 页面常驻，窄屏进入导航抽屉；直接读取 `GET /tasks?scope=all`，范围与排序在界面上常驻写明；项目标题来自已读取的进行中 Project 列表，未命中时明确不可读取；协作选中项由 URL `?work={taskId}` 承担 | 范围是工作空间全部任务，保留原游标读取；无与上次读取的比较基线，服务端未返回 `updated_at` 的行排在后面，不补造时间。示例模式没有 client，不渲染该分组，也不伪造历史 |
| 顶部目标与事实条 | 持续显示所属 Project、目标、任务/验收版本；事实条固定三格：现在需要什么（含外部结果待核对、失败原因、待判断 Review）、绑定了哪些确切版本、证据入口 | 外部结果未核对时优先于「等待人工判断」显示，不被待办挤走；等待判断与实际 PAUSED 分别读取，不合并成一句状态 |
| 工具带 | 执行控制（默认折叠，状态行常驻；有控制请求、未结清动作或失败时自动展开）、文件与运行工具入口、模型端口只读状态合并为一行 | 折叠只影响呈现，控制入口与执行权事实不隐藏；模型端口不可读时显示读取失败，不显示为「已连接」 |
| 工作主区 | 独立委托入口 + Assist 讨论流（头像、时间戳、AI 浅底、日期分隔线）+ 常驻输入区 | 委托、讨论、批准、完成是四个独立动作；聊天里的「开始」不构成委托授权；对话区不重复目标标题 |
| 右栏三页签 | 文档（版本列表、文档头、正文、两版比较、生成中草稿）、检查（执行进展、Run Trace、当前准入预览）、版本历史（逐版本来源关系） | 生成中草稿与不可变版本分开；最新/当前选用/本轮接受分别表达；正文默认展开的是产物声明的 latest，不用数组末位冒充最新 |
| 开发工具 | 占用右栏而非叠加第四列：文件 / 变更 / 终端 / 运行记录 + 底部执行输出与交互终端抽屉 | Git 仍无只读接口、交互终端协议待设计，面板显式声明未接入；不提供暂存/提交/推送或可执行提示符 |

对话区默认展开的确切版本正文不再要求先点「展开阅读」；「展开阅读」保留为切换其他确切版本的入口。输入区工具条中「附件」与「@ 引用」无接口，显式标注待接入并不可点击，「知识」是真实可用的资料来源选择器。

2026-09-30 参考图接续修复：目标与事实条限定在讨论主栏，文档从右栏顶部独立阅读，版本列表和比较入口按需展开；正文独立滚动，判断和底部输入在宽窗首屏可达。判断区常驻确切产物 UUID、验收修订/条件 ID，动作判断常驻动作类型与实际目标；详细 hash 和证据可展开。窄窗切换讨论、文档、检查、历史或工具只改变展示，文档子树保持挂载以保留判断反馈及待核对原命令。

本轮同时修正协作页 Review 的无条件禁用：Task/Project/Review 已匹配且当前读取成功时允许提交；读取中、归档、读失败、归属不匹配仍禁止。刷新期间不能沿用旧请求提交，成功重读清除旧错误。决定继续通过原 Review 接口绑定 revision/target_hash，响应丢失只核对原 command_id。自动化与视觉证据见[接续记录](../development/ui-live-integration-2026-09-28.md)，不据此替代真实数据库提交或 Windows 验收。

工作主区以当前 Task 为锚点；纯项目 Assist 仍走 `/projects/:id?skill=assist`，未关联 Task 时不显示任务执行或完成控件。中央按顺序展示目标摘要、事实条、讨论记录与输入；右侧按需展示确切产物正文、执行证据或版本来源，以及与产物绑定的判断。消息中的产物链接只负责打开正文，不承载唯一版本事实。切换右栏页签属于展示操作，保持相同业务对象和返回位置。

左栏切换工作沿用全局未提交修改保护（`App` 的 `useBlocker`）：未发送的消息或待核对命令存在时先确认，不静默丢弃。对话区内部的会话切换与新建仍走工作区自己的更具体提示。

| 动作 | 所在位置与明确意图 | 提交后确认什么 |
|---|---|---|
| 发送讨论 / 请求产物候选 / 请求任务建议 | 输入区显式显示当前 Assist 意图及作用目标，沿用已有意图能力 | 对应消息或提案的实际状态；不启动 Delegate |
| 委托 Agent 执行 | 目标范围旁的独立入口；提交前就近核对范围、来源及验收条件 | 原 Delegate 命令及 Run 事实；不从聊天中的“开始”推断授权 |
| 接受版本 / 请求修改 | 精确产物 Review 的证据区 | 原 Review 判断结果；请求修改不等于已启动新的执行 |
| 批准动作 / 拒绝动作 | 动作 Review 的影响与权限区 | 原动作判断；外部执行结果仍单独读取 |
| 请求人工接手 | 顶部上下文栏的执行控制区 | 请求状态、安全交接及执行权，不能只显示按钮成功 |
| 验收并完成 | 产物与判断区的完成用例确认 | 完成用例确认及完成凭据；不复用“发送”或“继续”按钮 |

### 14.7 完整状态设计

下表是选定方向的状态深化，不是新增状态枚举；每行映射到已有对象和允许操作，多个状态可同时存在。出现待核对或权限问题时，其原因优先于普通进展，不能被新消息挤走。

| 场景 | 主区、产物与输入 | 用户路径与保护 |
|---|---|---|
| 首次使用 / 无近期工作 | 中央显示“这次想推进什么”；输入先保留本地草稿，右区不显示空产物或虚构进展 | 发送前选择已有项目/任务，或显式进入创建入口；创建与发送分开。人工任务入口同样可达，打开页不自动建对象 |
| 恢复已有工作 | 选中近期工作后先核对 Project/Task；分别读取会话、Run、确切版本与未决 Review，局部显示加载/失败 | 不默认把最新 Assist 归为当前 Run；恢复失败不悄悄换工作。无变化基线只标当前事实及读取时间；保留旧深链及返回位置 |
| 明确范围 / 尚未委托 | 目标旁展开已有结果要求、范围、来源、验收条件；输入显示讨论或提案意图 | 复用已有信息，只补缺项。建议先由用户明确采用，再通过独立委托入口启动；缺验收修改接口时保留只读限制 |
| 正在执行 / 生成中草稿 | 事实条显示实际步骤、最近事件、执行者；右区明确“生成中预览 · 未保存版本”，已保存版本可单独查看 | 预览更新不抢焦点、不覆盖人工草稿；查看旧版本不改变执行。输入是否可发送按真实会话能力，不能暗示能修改在途 Run；暂停/停止始终可达 |
| 暂停请求中 / 已暂停 | 控制区分别显示“已提交暂停请求”和已确认的 PAUSED，正文可读 | 等待判断不写成暂停；已暂停仍按当前执行权只读，恢复和接手为不同入口。回执不明先核对原控制命令 |
| 等待用户判断 | 右区同时呈现确切版本/动作、影响、必要证据与对应 Review 操作；主区保留目标、讨论和事实状态 | 缺证据、版本过期、条件改变或失权时禁用相关提交并解释；提交后显示判断已记录和实际后续状态，不宣称动作成功或任务完成 |
| 执行失败 / 查询失败 | 执行失败显示原 Run 原因与已保存成果；单一区域读失败只影响该区域，保留目标和允许访问的内容 | 普通读取可刷新；执行恢复仅提供协议允许的动作，不泛化为一键重跑。无模型时保留服务支持的人工路径，业务服务不可用不承诺保存 |
| 外部结果待核对 | 持续展示受影响对象、原动作与不确定范围，保留可读产物和证据入口 | 先查原 Operation/Gateway/Trace；只有真实协议提供时才显示写入式核对或处置。缺接口明确“待接入”，不放可点击的假核对按钮，不换 ID 或 Adapter |
| 产物审阅 / 长文与比较 | 右区打开已保存版本；“展开阅读”“比较版本”进入独立正文区域，持续保留目标与返回讨论入口 | 当前查看、最新、当前选用和本轮接受分开；比较绑定两份确切版本，生成中草稿不冒充不可变版本。返回恢复阅读位置与输入草稿 |
| 人工接手 / 修订 | 请求后显示“等待安全交接”，产物继续只读；确认取得执行权后才呈现编辑器和保存入口 | 接手失败或在途效果不明保持保护；保存形成新版本，冲突保留草稿并对照基线。新版本不继承旧验证或接受 |
| 完成 / 保存进展 | 验收区展示产物、有效条件和证据；完成确认后显示凭据与已保存成果，讨论记录仍可读 | 完成回执不明保留原命令核对；完成失败不显示成功。下一步建议仅是入口，打开或切换不会自动执行；重开沿原业务入口 |
| 窄窗口 / 长内容 | 单列切换讨论、产物、判断；目标、执行状态和必要介入提示不随内容切换消失 | 正文、diff 与证据使用各自阅读区域，输入不遮挡末段及按钮；视图切换不改变 Run，细节见设计系统第 5.1 节 |

### 14.8 现有能力与待设计接口

复用 AgentChatView/AssistView 的目标与会话、RunView 的事件和控制、ArtifactPanel 的不可变版本与人工保存、ReviewsView 的判断、版本比较和旧路由。2026-09-29 实施后，这些能力被提取为共享组件，任务详情、运行页、待审页与协作工作区调用同一条命令路径，不存在第二套业务状态：`TaskDelegatePanel`、`RunControlPanel`、`ReviewDecisionPanel`、`TaskCompletionPanel`、`useRunDraftPreview`、`ArtifactReaderPanel`。

仍然存在的缺口与本轮处理：

| 缺口 | 本轮处理 | 状态 |
|---|---|---|
| 近期工作的范围/排序 | 明确为「工作空间全部 Task + 服务端 `updated_at` 倒序」，界面写明并显示读取时点 | 已接入（客户端补读服务端已有字段，无 API 变更） |
| Task、Run、Assist 的明确关联与稳定深链接 | 协作工作区按 Task 锚点读取；Task 自身持有 `executor.run_id`，不由客户端猜最近 Run | 已接入 |
| 跨窗口草稿及原命令恢复 | 未提交输入仍只在本窗口内保护；离开页面只保留原命令身份供回执核对 | 部分；跨窗口草稿恢复仍未接入 |
| 真实 Git diff/受控测试/Coding CLI | 见 14.9；Git 读接口不存在，面板显式声明未接入 | 未接入 |
| 独立资源/租约查询、验收标准修改、UNKNOWN 写式核对 | 仍无服务端接口，界面只读或显式说明 | 未接入 |

### 14.9 开发工作的工具入口

2026-09-29 用户指出选稿还缺 Git 面板、终端等 Agent 工作工具。将其纳入方向 1 的开发场景设计，见[开发工具示意图](mockups/2026-09-29/collaboration-development-tools.png)；图内代码、文件名、分支及变化数量均为演示，不是仓库事实。此补充不授权代码实施或任意 Shell，不把截图中的子智能体区扩展为多 Agent Router。

共享标题栏继续负责窗口与全局快捷操作；下方工作区工具入口负责当前项目/任务的“文件、变更、终端、运行记录”。“运行记录”只打开已有 Run 事实，避免图中播放图标与“运行”短标签被误认为启动按钮；执行仍通过独立委托或受控命令入口。写作场景以产物/来源为主，开发场景按关联资源和能力显示 Git 等工具，不要求所有项目常驻全部面板。

| 工具 | 面板与用户价值 | 能力与操作边界 |
|---|---|---|
| 文件 / 产物 | 右侧目录和正文，定位当前工作的输出；长文件可展开阅读 | 受管 Artifact 与工作目录文件标明来源，二者不混成同一版本；目录浏览接口未具备时标待接入，不推断全盘可读 |
| Git 变更 | 右侧显示仓库/受管目录、分支、已暂存/未暂存/未跟踪文件及 diff；长 diff 独立展开 | 状态来自确切工作目录和读取时点，不将工作区全部改动归因给当前 Agent。暂存、提交、推送分别表达，审批绑定确切变化及基线；接受 diff 不等于写回、commit 或 push。读失败/非 Git 仓库不能显示为干净 |
| 执行输出 | 底部面板展示确切 Run/命令的输出、状态、退出结果和来源 | 只读日志与交互输入分开；关闭面板不停止进程，打开不执行命令。输出流未接入时不能把已有 Trace 冒充终端 stdout |
| 交互终端 | 底部独立页签，目标是人工就近处理开发命令 | 新能力待设计：受管 cwd、人工执行身份、进程生命周期、权限、审计、资源排他和取消/断连恢复必须先定。人工打开终端不授予 Agent 权限，不绕过 AI 在途写入/接手保护；没有协议前不提供可执行提示符 |
| 运行记录 / 检查 | 复用现有 Run 步骤、事件、控制和真实检查证据；可从变更跳到对应证据 | 查看不启动 Run；测试未运行、运行失败、检查通过与业务完成分别表达；受控测试和 Coding CLI 仍需实际接入 |

工具面板共享当前作用域但不拥有业务状态；切换项目后不把旧终端重绑到新目录。底部关闭仅隐藏，停止执行必须使用明确控制并读取结果。未知外部结果沿原动作核对；Git 写操作也不能通过终端入口绕过原审批或资源冲突。

这轮确定的是入口和布局补充。Git 属于既有 F19 设计范围，当前 ProjectWorkbenchView 仍标明真实 Git diff、受控测试和 Coding CLI 尚未接入；交互终端的具体协议与安全边界仍待设计。后续应先接确切仓库的只读状态/diff及已有运行记录，再按独立授权接 Git 写入与交互终端，不能仅实现按钮外观就宣称能力完成。

2026-09-29 实施结果（开发自检，非 Windows 验收）：`/agent` 的底部工具面板已按上表接入三项已有协议的能力，并对其余两项显式声明未接入。

| 工具 | 本轮接入内容 | 仍缺什么 |
|---|---|---|
| 文件 / 产物 | 左侧列出该 Project 已登记的受管目录（含状态、修订、是否已绑定写身份）；受管产物与工作目录文件分别说明来源，产物正文按确切版本在右侧阅读 | 目录浏览与工作目录文件列表没有服务端接口，标待接入，不推断本机任意路径可读 |
| Git 变更 | 面板显式声明「当前没有受管目录的只读 Git 状态或 diff 接口」，并写明非 Git 目录与读取失败都不得显示为干净 | `git-adapter.ts` 已有 `gitGetStatus`/`gitGetDiff`，但**没有 HTTP 路由**；接入需新增只读路由并限定在已登记受管目录内，同时保留 `GIT_READ` 权限与资源排他。本轮未新增该接口，也未提供暂存/提交/推送按钮 |
| 执行输出 | 读取 `GET /runs/:id/operations` 已在服务端保存的 `result_ref`，只在该字段真实存在时显示 stdout/stderr，并绑定原 operation_id、原 Invocation ID、退出码、结果与截断标记 | 实时输出流没有协议；面板打开不执行命令，关闭不停止进程 |
| 交互终端 | 面板显式声明未接入，不提供可执行提示符 | 受管 cwd、人工执行身份、进程生命周期、权限、审计、资源排他与断连恢复协议待设计 |
| 运行记录 / 检查 | 面板只打开既有 Run 事实（`/runs/:id`） | 受控测试与 Coding CLI 仍未接入 |

2026-09-29 客户端变更说明：真实 stdout 此前已被服务端返回但被 `getRunGatewayOperations` 丢弃，本轮只补读该既有字段，**未修改任何 HTTP 接口、数据库或权限语义**。

## 15. 项目接续点（N01，2026-09-29 开发自检）

入口挂在既有「继续这个项目」页（`/projects/{project_id}?skill=resume`），不新增路由，也不改动该页原有只读速览。页面此前声明“没有上次查看基线，不显示变化对比”，现在由用户显式保存的接续点提供这个基线；未选择接续点时仍然只显示现时事实。

- **保存**：名称必填（1–120），说明可选。按钮在名称为空、正在核对或上一次保存结果未确认时禁用，并显示具体原因，不静默失败。
- **提交结果不确定**：冻结原 `command_id` 并保留在会话内，只提供「查询原命令回执」；回执确认前不生成新命令、不重复保存。回执的 `command_id`、项目与名称对不上时按无法核对处理。
- **比较**：只列可核对的事实差异——State 版本/阶段/下一步是否变化、捕获后新增的未决任务与选用成果版本、每条捕获引用的变化（未变化/已修订/已终结/当前不可见/仍是当前选用版本/已有更新版本）。本版不生成解读，页面据此不展示“建议的下一步”一类模型结论。
- **纳入集合（已收敛，非全量）**：Project State 的阶段与 revision、未终结 Task 的 id+revision、State 当前选用成果版本。Decision / Rule / Knowledge / Memory **不进入接续点**；需要溯源时走各自页面。`state_artifact_refs` 只插不删，因此重新选用新版本后接续点会同时捕获新旧两个版本，界面按引用逐条显示，不合并成一条。
- **“当前不可见”的真实含义**：V1 没有 Task 或成果版本的删除入口，且本表外键会阻止删除，因此该状态主要覆盖跨项目或脏引用，**不是常规业务路径**，界面不应对此作删除恢复的暗示。
- **边界**：保存不停止正在执行的 Run；打开本页不会自动重设基线。删除接续点、后台自动快照与恢复配置建议不在本片范围。提交结果始终待核对时，本会话没有退出路径（与既有面板一致，属已知规格缺口）。

对应契约见 [HTTP 契约第 10.51 节](../api/http-command-contract.md#1051-n01-项目接续点2026-09-29开发自检)；验收过程与结论见 [N01 独立验收记录](../testing/n01-independent-acceptance.md)。真实 Windows 人工路径未做。

恢复页呈现补充（2026-10-01）：当前项目事实先于接续点保存表单；读取时点、非原子查询及范围说明放入可展开区，缺失来源和局部读取失败仍在对应区块显示。保存新接续点默认折叠且保持原 Owner 挂载，未决回执或错误时展开，原命令身份与再次提交门槛不变。已保存接续点、显式比较与当前事实相互区分，不据此生成模型建议。

## 16. 整套页面呈现纠偏（2026-09-30）

本节保存 2026-09-30 的呈现与恢复调整；本轮工作主线的导航、标题字体、技术身份和判断区布局以第 17 节及设计系统第 9 节为准，不把本节旧布局当作当前验收基准。

用户反馈偏差可能覆盖所有页面后，本轮从共享字体与页壳开始，复核普通页、三工作台、知识阅读、任务详情和运行页；没有改变默认路由、业务 Owner、执行权、权限、HTTP 契约或数据库。

- 三工作台的配置、知识页的管理与高级筛选、动态的高级范围改为可展开辅助区，首屏优先展示当前对象。折叠区保持挂载，关闭后再展开不丢草稿或原命令。活动深链带 Task/Project/Run 范围时自动展开并标明「已应用范围」，避免过滤仍生效却看不见范围。
- 知识页按所选版本显示阅读标题、目录与来源，历史 v2 不借用当前 v3 标题。目录定位正文并标明当前项；列表、搜索、管理、来源及新版本编辑入口仍可达。
- 正文与预览中的合法 Markdown 管道表格按表头、单元格和列对齐呈现；行列不符时保留源文本，不补造单元格。表格单元格沿用安全行内渲染，HTML 与未支持链接协议不会成为可执行内容。宽表只在可聚焦的表格区域横滚；窄窗搜索结果跟随弹层单层滚动，键盘选中和确切资料导航沿用原行为。
- 任务列表保留全部筛选和范围抽屉。任务详情并列展示状态、验收修订和选用产物，原编辑入口集中在右栏，前置依赖仍按原页签语义显示。运行页保留步骤、Trace、事件、控制、错误和 UNKNOWN；布局变化不能把调用失败解释为业务完成。
- 协作页把判断说明折叠，以便正文和讨论获得空间；确切版本 UUID、验收修订、条件与动作身份仍常驻。请求修改缺说明时自动展开并提示，零写命令；检查、历史、工具及窄窗讨论/文档切换保留反馈和讨论草稿。短窗口展开大量判断证据后，操作可在判断区滚动到达。
- 人工待处理和项目/任务内 Assist 复用普通页内边距，协作内嵌 Assist 保持工作桌布局。面包屑的技能名称与实际页面选择一致；项目缺失或未知技能显示总览，任务缺失或未知技能显示任务详情，Assist 不再回退为蓝图或定义标签。
- 效果图对照后的阅读顺序：任务详情先列当前验收标准，再列证据汇总；蓝图先读当前候选摘要差异和确认区，再到生成/人工编辑表单，完整候选身份与来源可展开核对。三工作台的真实 Task、目录与版本阅读边界见第 3 节，任务定义/验收的同页 Assist 和确认门槛见第 4 节，本设备显示偏好见第 7 节。创建任务宽窗使用标签/输入分列。Run 时间线的节点、时间、状态均使用原步骤事实，中文标签不改变排队、运行结束、失败、控制待确认或 UNKNOWN 的语义。

视觉数值和字体事实见[设计系统](design-system.md)，截图、回归与证据边界见[视觉 QA](../../design-qa.md)。只读夹具中的 Trace、CheckPlan、来源 Manifest 未接入时继续局部报错，不伪造 PASS；完整 Windows/IME/DPI、真实业务全链及特殊状态的独立视觉验收仍需后续取证。

## 17. 整套 UI 重做提案（2026-10-01）

用户明确要求整套 UI 重做，并以附件选择[工作主线图](mockups/2026-10-01/work-first.png)（1487×1058 图像像素）。本节拥有本轮改造范围和连续工作流；[研究审查](../research/agent-ui-review-2026-10-01.md)拥有源码、外部来源和缺陷依据，[设计系统第 9 节](design-system.md#9-整套重做的组件与布局提案2026-10-01)拥有组件与布局规则。状态：实施基本完成，最后视觉 QA 正在收口；源码实现和各层验证分别记录。第 14/16 节保留历史选择，不把旧图当作本轮布局验收结果。

### 17.1 目标与交互顺序

用户应能从项目/近期工作找到确切目标，明确讨论或执行意图，在同一上下文查看进展、阅读成果、核对来源并处理判断，最后单独确认业务完成。普通首屏先显示名称、版本、当前需要什么与可用动作；技术诊断按需展开，UNKNOWN、原未决命令、审批影响与权限拒绝保持可发现。

导航按工作定位组织，近期工作仍在所有 live 页面可达；它的长度不能挤走固定导航。Task 与 Assist 会话分别选择，同 Task 多会话可返回原记录。输入按钮明确显示真实意图，提案必须有可见的预览/接受路径，发送讨论不暗含委托、批准或完成。成果阅读、编辑、比较、选用和本轮接受继续分开，界面把动作放到对应对象旁。

### 17.2 完整页面与状态覆盖

| 页面家族 | 必须保留的入口与能力 | 重做验证重点 |
|---|---|---|
| 全局与定位 | `/`→`/projects`、`/today`、`/tasks` 的 inbox/attention、`/inbox` 别名、近期工作、Ctrl+K、通知、前后退 | 超过八条及游标续页；范围和 Today 时区；跨 Workspace 清理；草稿和原未决命令保护 |
| 项目规划与接续 | `/projects` 创建/归档范围、`/projects/:id` 的 overview/blueprint/resume、项目任务 | 目标与下一步优先；蓝图候选/合并/确认；接续基线差异；归档阻断、部分成功、失权和冲突 |
| 三工作台 | `/projects/:id/workbench` 与 general/thesis/development | 同一事实和确切版本的任务/资料目录、正文、Run 证据、同任务 AI；浏览视图与默认设置分开；未接入工具的准确状态 |
| Task 与成果 | 任务创建、详情 overview/artifacts/runs、definition/verification、版本 lineage、completion-records | 目标/验收合并提案；新版本不可变；正文失败、比较、冲突草稿；权限/执行权；有效判断和完成凭据、重开 |
| 协作与执行判断 | `/agent?work=`、项目/Task Assist、`/runs/:id`、`/reviews`、`/activity` 与 activities 别名 | 多会话、显式选源、非空提案、读取/生成失败分开；Delegate、控制、Review；UNKNOWN/PARTIAL/无回执；断线/重启沿原身份核对 |
| 资料与搜索 | `/knowledge`、项目知识、kind/item/version/q、命令面板搜索、页内收录/续版与 URL Import | 中文/范围搜索；阅读历史版与来源；Memory/Decision/Rule 各自责任；导入状态；冲突/失权保留草稿和原命令 |
| 配置与权限 | `/connections`、settings/connections 别名、项目连接、`/settings`、API 连接面板 | API/模型/能力/权限分别呈现；模型验证指纹；本设备偏好；资源/策略的新版本、停用、冲突及回执恢复 |

当前没有独立 `/search` 或 `/capture` 页面路由；搜索和收录是上述入口中的状态，不为图像数量制造新页面。旧路由/深链接保留可达性，导航位置可以调整，不能删掉旧业务能力。

所有家族覆盖：有数据/空态、首次加载/局部重读、读失败/403/404、归档只读、409 冲突、写入中/结果待核对；执行家族另覆盖排队、控制请求中、停止中、已暂停、失败、UNKNOWN 和终态。宽/窄/短窗口、键盘和中文 IME 为横向维度；Windows DPI 与真实宿主分别验收。

### 17.3 实施顺序与出口

先选择整套方向，再冻结共享壳层、基础组件和主要流程；优先修复研究中 P1 断点，以完整用户路径验收后推广其他页面家族。三张概念图只供方向选择，不缩减完整覆盖。

重点回归路径：人工项目→蓝图→任务→产物两版→验收/完成/重开；长期 Assist 的超过八条工作、多会话、候选提案接受与返回；Mock 委托→动作审批→断线/UNKNOWN→核对/取消/接手；资料收录→中文搜索→历史版/续版冲突→三工作台→显式选源与新成果来源。保留已有领域/数据库/恢复测试，不以视觉通过替代这些路径。

具体设计不新增业务状态、执行权限、模型调用策略或写入 Owner。本轮没有 API/数据库变化，数值继续由唯一 tokens 管理。结果只登记[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，旧成绩不自动覆盖重做版本。

### 17.4 当前实现与恢复边界

- 共享主导航为工作台、项目、待处理、资料，其他既有入口保留。近期工作按 Project 分组、按 Task 去重，取消固定八条截断，沿服务端游标续页；失权清除受限缓存。标题带复用真实搜索、新建任务与应用内前后退，浏览器显示业务入口，窗口控制仅由桌面宿主提供。协作面包屑同时绑定 workId 和连接 epoch，旧对象或旧连接的晚到响应不能更新当前上下文。
- 项目、Today、Tasks、三工作台、知识、资料版本、设置和连接采用紧凑页头、内容纸面与就近动作。名称、目标、版本、验收条件和下一步优先，UUID、hash、阶段原值等仍可展开核对；未知自定义阶段不替换成推断状态。新建任务优先按真实项目名称选择，手动 Project ID 收入详情；依赖提示使用用户语言，仍保留原 API 载荷与显式归属。
- 同页互斥页签采用水平 tablist/tab/tabpanel，方向键、Home/End、禁用项和 IME 过滤由同一键盘处理入口负责；路由导航继续使用链接。设置页各宽度共用水平页签；任务成果与协作右栏切换保留同一草稿和命令组件，不挂载宽窄两份 Owner。
- 协作区分别选择 Task 与 Assist Session，讨论、Markdown 提议、Task 提议及 Skill 操作显示真实意图，非空候选提案保持可见。成果优先阅读 Review 绑定的确切版本；缺失该版本明确报错，不能用最新版本替代。历史阅读、比较、选用、Review 判断与业务完成保持独立。验收条件文字仅在父级核对相同 acceptanceRevision 与对应 criterion_id 后显示，真实 ID 留在对象详情。
- 多个草稿 Owner 共同注册离开保护。未发送输入可经明确确认丢弃；提交中或原命令待核对时不能丢弃、切换连接或用新命令身份绕过。Review 列表重排、所选项移除或 Task 读取失败时保留原判断 Owner 和原回执核对入口，禁用新决定。旧会话回执核对先通过组合导航保护，再切换会话和路由；晚到结果不拉回先前目标。资料切换类型或成果行也先保护编辑草稿，错误、冲突和取消收录保留可继续的输入。
- 普通判断条常驻确切对象、主要条件/影响和接受/请求修改动作，完整依据及说明按需展开；动作审批的实际动作、目标、风险及 UNKNOWN 不静默折叠。展开依据或长审批时整成果区域纵向滚动，短窄窗口采用自然高度，末尾动作可到达。完整待审页保留阅读正文；任何接受判断都不自动宣称 Task 完成。

这些实现未改变判读模型、路由语义、allowed_actions、只读边界或服务端命令 Owner。当前组件与只读浏览器证据不能替代第 17.3 节四条完整业务路径、全部 33 页面/状态或最新 Windows/IME/DPI/安装验收；后续控件修复后的最终隔离前端生产构建已通过，实际范围归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 17.5 最大化优先的控件与交互接续（2026-10-01）

用户要求本轮先保证最大化桌面窗口正常使用，缩窗重排暂不作为本轮验收出口；原有适配实现继续保留，未据此宣称缩窗/DPI通过。全局控件外观、状态与公共代码入口统一归[设计系统第 6.2 节](design-system.md#62-全局控件与交互实施基线2026-10-01)，数值仍只归 tokens。

- 标题搜索准确显示“搜索资料”，关键词只查询 Knowledge/Memory/Decision/Rule；打开导航与查询不制造业务命令，不扩大成项目/任务名称检索承诺。
- 新建任务校验失败时保留输入、显示关联错误，并聚焦首个无效字段；修正该字段不自动跳到下一字段。明确创建成功并替换表单、且无上层弹层时焦点落在结果标题；迟到结果不抢走当前弹层焦点，不自动开始或完成任务；原回执/冲突与命令身份门禁不变。
- readiness 检查期间冻结 API/Workspace/令牌输入，激活只使用本次被核对的值；live 模式输入锁定，不暗示编辑已切换连接。关闭使原检查失效，失败恢复编辑并保留输入，令牌仍仅驻内存且关闭清除。
- 资料类型与开发工具的互斥页签复用全局键盘处理器，保持现有读取、草稿保护及未决结果门禁；执行输出只是展开/收起，不等于运行/停止命令。弹层 Esc 在 IME 组合期不执行关闭，其他退出仍调用页面既有保护逻辑。
- 普通长页的滚动约束从共享页壳保证，不仅对协作页生效；资料正文加载、新建任务展开项目后仍可访问侧栏底部及表单末尾。此处修复呈现，不改 API、数据库或领域权限。
- 用户五图反馈接续：控件焦点沿原边界向内显示；会话下拉、新建与刷新保持同一高度；工具右栏与主区同底；近期项目分组可见 hover/pressed。点击模型连接摘要仅开合只读说明，工具按钮与摘要开合前后保持同一位置，正文自然在下方展开；不会因阅读说明触发验证、创建会话或运行命令。公共视觉规则归设计系统第 6.2 节。

本轮最大化窗口和组件的实际验证范围、原失败与修复复验只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护，不自动覆盖正式发布包、完整业务写入/恢复、长审批、聊天草稿、真实 IME 或安装。

### 17.6 连续协作工作区（2026-10-01）

用户已授权直接实施 Agent UI 对照后的连续工作区方案。沿用工作主线、暖白/墨绿、现有路由和共享控件；本轮重组展示，不改变 Task、Run、Review、HTTP API、数据库或命令协议。**Breaking Change：No**。研究依据与公开产品观察边界归[Agent UI 研究接续](../research/agent-ui-review-2026-10-01.md#7-连续工作区研究与实施接续2026-10-01)。

- 任务标题、当前需要、执行步骤与合法控制组成紧凑页头，项目/任务修订及诊断按需展开。等待判断、停止请求与 UNKNOWN 不被折叠成成功或已暂停；控制仍使用服务端事实与原命令。
- 对话与成果默认同时查看，可拖动分隔条、左右方向键调整和双击复位；另有专注对话/成果模式。`CollaborationLayoutPreferences` 只保存展示模式和对话比例，独立本设备键 `relay.workbench.collaborationLayoutPreferences`、格式版本 1。无效、不可读或不可写存储回退默认；不保存任务、权限、连接或命令身份。默认比例消费唯一 token，交互范围由展示偏好模块限定。
- 模式、窄区与成果页签切换通过 `hidden/CSS` 保留原 Assist、Review、Run 控制和工具子树，不复制或卸载命令 Owner。草稿、组合输入、未决原命令及恢复核对规则沿用既有入口；跨任务/会话仍走原草稿保护。
- 消息先显示正文；Skill 和提议先显示摘要、状态与「查看提议与接受操作」，比较、来源和摘要值可展开。新待确认提议有状态提示，接受仍由原提案组件核对基线、执行权及允许操作。来源检索与消息发送使用独立表单，不能互相触发提交。
- 输入器固定在对话底部，选源、意图和发送规则保留。消息、展开内容或分栏改变尺寸时，仅在读者原本跟随最新且面板可见时自动跟随；用户上翻后保留阅读意图。回到最新按钮浮在消息区域内，隐藏再显示不重置意图。
- 成果工具栏集中显示名称、确切版本、版本/比较与编辑入口。普通判断保留对象、条件、影响和决定，完整依据及补充说明按需展开；动作批准保持完整动作、风险和身份，长审批或展开依据由成果整层自然滚动。手动阅读其他版本时，明确提示判断仍绑定哪一版，并提供返回绑定版本入口；阅读切换不改变 Review 目标。
- 版本与会话选项浮层支持 Escape 收起并回到 summary，忽略 IME/229/修饰键。工具输出和 Trace 分组先显示摘要，展开保留全部原 Operation、Invocation、Effect、来源及完整追溯入口；UNKNOWN 提醒在分组之外常驻。
- 普通页沿同一标题/间距层级覆盖第 17.2 节七类页面，保留现有分页、多会话、旧深链与恢复行为。不新增消息队列、运行中引导、交互终端或 Git 浏览协议。

本轮空间验收基准为同一 1280×720 合成场景、默认分栏、普通判断且详情收起：聊天记录与成果正文各至少 240 CSS px，同时可达输入、版本及判断入口。长异常/短窄窗采用可滚达回退，不将上述数字硬套到所有状态。定向回归覆盖分栏/存储、阅读跟随、IME 事件、版本差异、多会话、草稿与原命令、失权/冲突、判断失效和停止中。实现、自检、浏览器、确切目录包与真实 Windows 的实际结果只维护[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

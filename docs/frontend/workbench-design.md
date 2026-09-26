# 工作台与前端交互设计

> 2026-09-24：既有页面已迁入 React，保留原路由/query、视觉与人工业务交互；逐页覆盖和自检见 [M02 开发记录](../development/m02-react-migration.md)。本文件的业务交互规范不因框架迁移改变；真实 Windows 窗口仍须单独验收。

更新：2026-09-24。状态：交互规范含 Proposed 细节，React 工作台前端子包待独立验收。本文维护交互规范；32张静态页面效果图及原始参考为视觉输入，已有实现与验收范围由当前状态和开发记录说明。保留原聊天 General、Thesis、Development 三套内置工作台。

角色：页面结构与业务交互主文档。视觉/组件规则见[设计系统](design-system.md)，数值见 [tokens](design-tokens.json)；技术依赖见[技术选型](../architecture/technology-selection.md)。视觉组件不得反向改变本文的业务权限与状态语义。

## 1. 前端与分发推荐

工具链、状态/查询库及组件依赖按[技术选型](../architecture/technology-selection.md)选择，不在本文重复版本表。UI 状态只包含当前选择、面板展开、编辑草稿；服务端查询缓存不成为一套可独立修改的 Task 状态。精确版本及本轮采用证据见 M01/M02 开发记录。

用户已确认 Windows 可安装应用、独立窗口和启动入口。目标 React 页面在桌面壳中加载随包静态资源，业务经已鉴权 loopback HTTP 调用本机 API；来源配置与开发 Vite 分开，不能假定生产同源。框架与生命周期见 [ADR-007](../decisions/ADR-007-windows-desktop.md)及[部署设计](../deployment/local-deployment.md)，仍为 Proposed。选择依据本项目需求与验证，不继承 Manga 的技术栈。

若已有正式前端工程，编码 Agent 先检查兼容性，不为遵循草案机械重写；记录决策差异。同一查询缓存只保留一个 Owner，失效/重取遵守 revision，旧响应不得覆盖新状态。组件库默认样式必须映射本项目语义 token；长列表是否虚拟化按实际需要决定。

## 2. 信息架构与路由

全局一级导航遵循 Master Spec 第 86 节：Today、Projects、Tasks、Knowledge、Activity；Connections 与 Settings 放底部。Inbox 和 Review 提供快捷入口，不替代上述页面。Goal、Artifact、Chat 不增加一级导航。

| 路由 | 主内容 | 持久事实 |
|---|---|---|
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

Ctrl+K 提供搜索、新建任务/项目、打开项目、收件箱快捷入口、委托当前任务和打开 Activity；操作复用 GUI 的准入条件。原总纲的 Start Focus 与后置完整 Focus Mode 有歧义，暂不据此实现计时/Work Session，待确认项见设计审计。

2026-09-26 M05 全局入口开发切片：`Ctrl+K` / `⌘K` 与顶栏按钮打开同一命令面板，Esc 关闭、Tab 保持焦点在面板内并在关闭后返回触发控件。搜索只调用当前 `/search` 支持的 Knowledge/Memory/Decision/Rule，按 Workspace 或确切当前 Project 作用域读取，每页最多 20 条并提供游标续页；结果显示类型、版本、摘要、来源引用和作用域，点选后通过资料页查询确切条目。Project/Task 没有全局搜索端点，面板不伪造其结果；输入明确 Project ID 时先 `GET /projects/:id` 核对再打开。新建项目/任务只导航到原真实表单，不由面板写入。当前 Task 由单读和 `allowed_actions` 提示决定是否展示可用 Delegate 导航，点击只进入 Task 的委托确认区；当前 Run 与 OPEN Review 通过现有查询定位并打开原页，不由面板直接委托或审批。当时 Activity/Today 尚无 API，随后 P13/P15 切片已按下段接入。fixture 不调用真实搜索，关闭或切换范围后旧搜索结果不能覆盖新范围。这些是组件开发自检范围，不是独立业务或桌面验收。

2026-09-26 M05 P13 Today 前端开发切片：live `/today` 使用 `GET /today?date&timezone` 的服务端投影，按返回顺序分别展示 `eligible_items`、`blocked_pinned_items` 和其余 `waiting_items`；受阻置顶是等待组子集，页面不重复计数为额外候选。每项展示 `reason_codes`、`evidence_refs`、`allowed_actions`、Task revision、优先级和截止本地日期/时区。只有 eligible 且服务端允许 `START` 的任务显示开始入口，该入口仍打开 Task 详情供用户确认。Pin、Later、Focus 只使用对应选择命令；Focus 同时显示选择原时区与查询时区，跨时区 `active_in_query=false` 时不暗示该 Focus 正在影响排序。Task 优先级/截止编辑使用 Task revision；选择命令使用 Today 全局 selection revision。409 冲突保留表单和原 command_id，重读版本后由用户明确重新提交；响应不明保留原 ID/载荷，先查命令回执，404 后才允许同 ID 重试。切日期/时区重查，旧查询结果不覆盖新范围。fixture 明示无真实 Today 投影，不生成假排序。该切片仅为前端开发自检，尚非真实桌面或 M05 独立验收。

同日 M05 P15 Activity 前端开发切片：live `/activity` 和 `/activities` 读取 `/activities` 的服务端业务事件，按 Project/Task/Run UUID 与本机输入后转为 UTC 的 `[from,to)` 时间区间筛选，按服务端游标继续读取，不据单页数量推断历史总量。仅显示服务端安全摘要、actor kind、事件类型、时间和原命令 ID；不直接展示 actor_ref 或原始 fact_refs。typed entity_refs 只在当前已有页面且服务端已核实同 Workspace 可见时提供 Project/Task/Run/Review/Artifact Version/Completion 链接，目标页面仍重新鉴权；其他类型明确没有直达页，不拼猜 URL。筛选、刷新、权限失效或路由变化会清空旧结果并隔离迟到响应。fixture 不生成 Activity。此处为前端开发自检，不等于完整审计或桌面验收。

同日 M05 P15 Run Trace 与 Artifact Lineage 前端切片：live Run 页按需读取 `/runs/:run_id/trace`，分别列出服务端 Step/Attempt、模型调用元数据、Context Manifest 与可见来源、验证会话和检查、Review 决定、Gateway Operation/Invocation、Run Effect。`result_available` 仅表示有结果引用，不代表成功；Review 的 APPROVE 不代表外部动作已执行，Effect UNKNOWN 仍需按原动作核对。Manifest 来源不可用时不展示来源 ID、版本或 hash，也不展示模型隐藏思考或原始调用正文。Task 产物版本、Activity 的 Artifact Version 引用及 Trace 验证目标可进入 `/artifact-versions/:id/lineage`；该页只呈现服务端确切 typed direct_parents 关系与可读父版本，不由标题、时间或版本号推断因果。不可用父来源不展示 ID；可读的 CompletionRecord 父来源链接确切详情，其他没有确切页面的父类型保持文本；历史正文仍由原内容接口单独鉴权读取，不能以最新版替代。刷新、目标切换及 403/404 会清空旧证据并隔离迟到响应；fixture 明示没有真实 Trace/Lineage。该切片经前端定向开发自检，独立业务和桌面验收仍后置。

同日 M05 P15 CompletionRecord 前端切片：live `/completion-records/:id` 只读服务端确切历史完成凭据，区分当前指针与重开后的旧凭据，列出当时验收版本的目标、输出约束、条件与来源，人工接受或自动验证事实，以及当时关联的产物版本/sha256。可从 Task 当前完成指针、项目恢复页和 General 工作台的 State `completed_highlight_refs`、Activity 的 Completion 引用进入；旧凭据重开后仍从 Activity 进入，不依赖 Task 当前指针。来源 Run 和确切产物版本分别链接原 Run 与 Lineage 页并重新鉴权。任一历史引用 `UNAVAILABLE` 时只显示不可用，不显示该项 ID、正文或 hash，不拿当前最新版补齐；403/404、刷新和切换范围清旧证据并隔离迟到响应。fixture 不制造真实凭据。这是组件开发自检，独立业务与 Windows 验收后置。

首次使用只收集项目名、目标、可选导入。无模型连接时仍能创建项目并手工录入状态；连接模型后提供 Initial State、轻量 Milestone、Next Action、Workbench 建议，用户查看并 Apply 后才写入对应事实。建议过期需重读，不自动应用，不把模型配置作为创建项目前置条件。

当前真实 CreateProject 命令仅持久化名称和 Project Type。`/projects?view=create` 的 live 引导允许填写可选项目目标与选择本地 `.md/.txt`；目标按 API 地址、Workspace 和新 Project ID 暂存为待预览的人工蓝图意图，刷新后可在该项目蓝图页恢复，直到用户明确生成服务端 `USER_DRAFT` 候选；它不是已确认 Goal，也不自动请求模型或应用蓝图。可选资料只接受非空 UTF-8 文本，最多 256 KiB；创建项目成功后，单独以 `MANAGED_TEXT` Knowledge 命令登记，失败不回滚 Project。文件名、媒体类型、文本及 SHA-256 与确切 Project ID、command_id 一起冻结；响应不明先查原回执，未找到才允许同 ID、同载荷重试。成功登记、明确取消或结束本次引导并新建其他项目时清除当前创建草稿中的资料正文；原资料命令待核对时不能丢弃该草稿。会话存储不可用时阻止可能丢草稿的创建。fixture 仍为示例预览。以上是 2026-09-26 的前端实现边界，资料不会在此流程自动发送给 Assist 或模型。

2026-09-20 蓝图交互补充（Proposed）：首个 [Relay Skill](../architecture/relay-skills.md) 将此流程命名为“从目标创建项目蓝图”。先创建最小项目，再生成建议；拒绝建议保留项目。预览只使用同一内置组件注册表和只读投影；Diff 展示状态、Goal 关联、新任务与导航变化。Rules、Workflow 与验证配置单列“后续配置建议”，按钮打开各自确认入口，不能被“应用蓝图”顺带生效。

生成中、校验失败、待预览、提交中、回执核对中、冲突/过期、拒绝、已应用必须可区分。修改内容或选中项形成新候选后重新预览；接受绑定项目、候选 hash 和基线版本。超时查询原回执；冲突保留用户草稿并显示当前差异，不自动覆盖。切页后的结果始终回到原目标。基础导航、Review/恢复入口不允许被隐藏；模型建议不能生成任意新路由。Goal 修改或 Skill 升级只提示新提案，不自动重排导航。

2026-09-26 0025 live 蓝图切片：`/projects/:id?skill=blueprint` 同页提供人工草稿与第一方 Skill 生成两条入口，fixture 仍是示例。人工草稿明确标记 `USER_DRAFT`；用户可指定现有 ACTIVE Goal、项目类型允许的 phase、最多 5 个新 HUMAN/INBOX Task、下一步和默认 View kind，并可选择 Pack 的确切版本作来源。草稿意图不会自动成为 Goal，Pack 选择不授予权限。提交后读取服务端不可变候选及候选 SHA-256、Project/State/View 基线、Diff、固定模板页面顺序；编辑已保存候选通过 `supersedes_proposal_id` 创建新候选。只有候选仍待确认、正文可读且服务端未判失效时，显式 Apply/Reject 才发送命令；Apply 结果单列真实 Goal 关联、Task ID、State 和 View 修订，Rules/Workflow 后续建议不随之应用。Skill 来源不可用时服务端返回 `content_availability=SOURCE_UNAVAILABLE` 与空的 candidate/baseline/diff；页面清除旧表单和预览，只显示候选状态与 hash，禁用确认。冲突与响应不明冻结原 command_id/载荷，优先查原回执；无回执才允许原样重试或在冲突后明确重新确认。Skill 入口先创建 PROJECT Assist 会话，再以 `goal-to-project-blueprint@1.0.0` 发送 `desired_outcome/goal_id/pack_ref`，202 仅表示消息排队。页面按 assistant message ID 读取完成/失败状态与 `error_code`，只选择 `origin=SKILL` 且 `skill_message_id` 精确相同的服务端提案；模型 `draft` 是只读建议，不由前端改写为人工候选。当前前端定向测试与构建是开发自检，真实 Provider、桌面交互和 M05 独立验收仍后置。

内置 Pack 在现有引导/配置入口作为可选领域组合展示，不增设安装市场。区分“本次选择”“已应用配置”和“当前工具权限”；显示成员版本、缺失能力及用户修改冲突，不能仅显示“Pack 已安装”暗示全部生效。Proposal Diff 基于真实影响说明哪些规则/执行配置需要另行确认、哪些活动执行可能失效；多个命令分别反馈结果。旧配置恢复使用“恢复配置建议”，明确需要新修订，不能承诺撤销外部效果。

Run Detail/Assist 增加轻量 Sources View：展示实际 Manifest 引用、版本、允许查看的片段与排除/裁剪原因。只读接口重新鉴权，禁止显示无权对象的名称/ID/数量；来源缺失与未选中分开，不冒充完整 Inspector 或展示模型思考。Projection Profile 仅控制已授权事实的呈现，不改变 Today 的业务排序、必需 Review 可见性和 Context 规则。完整比较/搜索 Inspector 按后续路线实现。

## 3. 三套工作台

| 工作台 | 默认主区 | 辅区 | 首要操作 |
|---|---|---|---|
| General | 下一步、任务、产物 | State、决定、近期活动 | 开始/继续、保存结果、完成 |
| Thesis | 资料与草稿版本、验收项 | 引用证据、研究阶段、Decision | 选资料、请求草稿、核对引用、人工接受 |
| Development | 受管根/隔离副本、变化集、检查结果 | Git 状态、Run/审批与权限 | 审查 diff、受控测试、接受变更、批准特定 Git 动作 |

配置是代码内注册的组件组合，不生成任意路由或执行脚本。缺少相应 capability 显示“未连接/未启用”并引导到设置，不能显示假测试或假 diff。浏览其他 kind 只更换本地展示路由；只有显式保存默认视图才修改 ViewConfiguration，Run contract hash 必须不变。

Project Type 决定 phase 词汇，例：GENERAL 的 PLANNING/EXECUTING/REVIEW；THESIS 的 TOPIC/LITERATURE/METHOD/EXPERIMENT/WRITING/REVIEW；DEVELOPMENT 的 DISCOVERY/DESIGN/IMPLEMENTATION/VALIDATION/RELEASE。这是推荐内置词汇，可版本化配置；用户显式设置阶段，系统不按 Task 完成数量自动跳阶段。

2026-09-26 M05 P14 前端开发切片：`/projects/:id/workbench/:kind` 提供 `general/thesis/development` 三种代码内注册的事实视图，从原项目页和项目内导航进入，右侧保留返回原项目页、任务与资料的入口。切换路由只更换浏览组合；Project Type 与 phase 始终读取同一 Project/State，页面不提交 Task、Run 或执行配置命令。live 模式的 General 读取 State 指定的下一步（若不在任务首分页则按 ID 单读）、任务分页及 State 当前选用的产物版本；任务列表明确已读条数与 `next_cursor`，可继续加载，不将首 50 条称作全量。Thesis 读取项目范围 Knowledge 及前 6 项当前版本的 `source_refs`，草稿区只读取 State 下一步和已加载任务中的前 6 个进行中/待审 Task 的产物版本，并明确未覆盖其余任务。Development 读取当前 Connection 的状态/能力声明、已加载 Task 关联的 Run 及本项目 OPEN Review；Connection 能力不代表 Permission 或真实工具可执行。未接通的 Git diff、受控测试和 Coding CLI 明示不可用，不制造结果。fixture 仍标明示例来源，项目范围与旧路由语义不变。项目级产物总列表尚无 API，该切片早于上述 Today 投影接入，因此其区域仍只展示确切可读范围；本切片的组件、类型和构建自检不代表真实桌面或 M05 独立验收。

同日 M05 P14 live 收件箱增量：`/tasks?tab=inbox` 只调用 `GET /tasks?inbox=true`，按服务端 `next_cursor` 继续加载未归属 Project 的人工任务。状态、执行模式与标题筛选只作用于已加载页；页面分别显示已加载项数、当前筛选可见项数和后续页状态，不把首 50 项或当前筛选结果称为全空间总数。刷新、读取错误或失权时清除旧条目；切到其他范围或 Workspace 后，旧请求不能覆盖新范围。fixture 与真实结果不混用。该收件箱切片先于下述全空间列表接线，仅为组件开发自检，独立验收后置。

`/inbox` 是上述收件箱的替代路由，直接跳转到 `/tasks?tab=inbox`；顶栏图标和 Ctrl+K 提供辅助快捷入口，不新增侧栏一级项。fixture 同样走原收件箱示例，live 模式由原真实查询负责；命令面板的 Activity 入口按当前已接入的只读 API 描述。

同日 M05 P14 live 列表增量：`/projects` 分别以 `status=active|archived` 读取进行中与已归档项目，`/tasks` 以 `scope=all` 读取项目内及未归属任务；两处均按服务端游标续页，刷新、失权、切范围或 Workspace 时清除旧数据并忽略迟到响应。名称、项目、状态、模式与标题筛选只作用于已加载项，显示已加载数、当前可见数与后续页，不把它们称作全量。Project 列表没有 Goal/摘要/待审数；下一步只展示服务端 `next_action_task_id`，未单读 Task 时不推断标题。已归档范围保留 Project 历史入口；归档按钮的真实命令接线见下段，旧 fixture 列表继续保持示例交互。本段是前端开发自检，独立业务和桌面验收后置。

同日 P14 ArchiveProject live 增量：仅进行中列表里当前确切为 ACTIVE 的项目可发起归档；按按钮先单读 Project 的归档状态与修订，弹窗显示目标/修订并要求再次确认。提交严格冻结 `{command_id,expected_revision}` 与 Project ID；浏览器会话只按 base URL、Workspace 保存这些最小未决字段。网络、5xx 或回执格式不明时先查原命令回执；只有 `COMMAND_NOT_FOUND` 才开放同 ID/同目标/同修订重试。换 Project、归档 tab、Workspace 或重载后不能用新作用域重放旧命令；返回原 Workspace 时可继续核对。`PROJECT_ARCHIVE_BLOCKED` 按服务端固定代码显示处理方向，尤其 UNKNOWN Effect 与资源占用必须核对原事实，租约过期不视为安全；修订冲突清原命令并重读列表，再次归档必须重新确认；已归档冲突引向历史范围。成功后重读当前列表，切入已归档范围会重新查询，历史 Project 仍可打开。fixture 归档仍是原演示语义；组件开发自检不等于真实桌面或独立验收。

同日 CreateTask live 增量：`/tasks?view=create` 按用户操作读取 `status=active` 的真实 Project 列表并按服务端游标续页，点击某项才关联，绝不自动选择首项。名称搜索和数量只覆盖已加载页；项目页路由预填、已知 ID 手动输入与未归属项目的 Inbox Task 继续可用。读取失败、失权或切换 Workspace 时清除旧列表与跨空间 Project 选择，迟到响应不能回写。提交 CreateTask 时冻结目标 Project、完整载荷和 command ID；响应不明先查原回执，仅明确 `COMMAND_NOT_FOUND` 后才允许原 ID、原载荷重试。切换 Workspace 不重挂这张未决表单，以便切回原连接后核对；fixture 仍用原示例选项。本段仅为组件开发自检，独立验收后置。

同日 P14 归档项目首批前端门槛：蓝图及其 Skill 生成、项目连接与权限设置、工作台默认 View、项目任务页的新建/开始入口、Project Assist 均以当前已读取的 `Project.archived_at` 控制新的业务写入。已归档、Project 事实加载中或读取失败时显示原因并禁新命令；工作台和蓝图仍可浏览已获授权的历史投影。蓝图 Project 查询失权时清除旧候选正文。Project Assist 的新取消命令同样禁用；已发命令仍可按原 ID 查询回执，并在原入口允许原 ID、原载荷恢复。项目任务的开始命令在当前浏览器会话按 base URL、Workspace、Project 保存最小原命令字段；切换作用域立即清旧任务快照并隔离迟到响应，回到原作用域才能核对回执，不能拿新 Workspace 的客户端重放旧命令。Task Assist、Run 停止、Review 拒绝、Today 清 Focus 及其他 Task/Knowledge 独立页不属于这批 UI 接线；ArchiveProject 按钮在上文另一增量接入，不据此宣称全部写入口都已禁用。fixture 行为不变；组件自检不代表桌面与独立验收。

同日 P14 归档项目直达页第二批前端门槛：Task 详情、Definition/Verification 只读页与 Task Assist 从确切 Task 归属单读 Project；Definition/Verification 本身不发写命令，仍可查看已接受事实及历史 Trace。Task 详情的 Delegate、Artifact 新建/续写、选为当前项目版本、人工完成/重开，以及 Task Assist 的新会话、消息、取消和提案接受，在项目已归档或 Project 事实尚未确认/失权时禁用新命令；无项目的 Inbox Task 不受项目归档误禁。Run 控制与 Review 决定也核对其 Task→Project 归属和当前 `archived_at`，历史记录可读，归档后不再发新的 Stop、Reject 等控制或决定。切 Task/Run/Review/Workspace 清除旧归档判断并隔离迟到结果；既有未决命令仍可查询原回执。创建任务从进行中列表显式选择项目，项目页预填和手填 ID 在原 CreateTask 命令生成之前再单读确认为 ACTIVE；读取失败或已归档时保留草稿且零提交，留空创建 Inbox 任务不需要 Project 核对。Knowledge、Today 与 Web Import 独立入口尚未接这批归档状态门槛；服务端归档写栅栏才是最终约束。fixture 行为不变；定向组件自检不代表独立或 Windows 验收。

同日 P14 归档项目第三批前端门槛：live Knowledge、Memory、Decision、Rule 的项目关联新建、版本、归档、停用或替代操作，依据记录的实际 Project 或 Rule 的 Task→Project 归属核对当前 `archived_at`；状态加载中、失权或已归档时禁新写，提交前再单读，失败不产生命令。Workspace 级资料和规则仍可写；列表、搜索或详情读取失权时清除旧内容。项目 `WEB_FETCH` 导入同样在提交前重读 Project，归档后仍可按 Job ID 读历史并核对原命令回执；仅明确 `COMMAND_NOT_FOUND` 后才开放原 ID/载荷重试，项目状态及可用连接重读会隔离迟到结果。Today 的 Project Task Pin/Later/Focus/计划在新命令前核对当前 Task 归属与 Project 状态，旧候选在归档后不再可用于提交并重读 Today；无项目的 Inbox Task 不因其他 Project 归档而禁用。`target_kind:null,target_id:null` 清除 Focus 是 Workspace 选择，不关联旧 Project，仍可按原 selection revision 提交。已发送而响应不明的命令保留原 ID 与原载荷核对；最终仍由服务端归档写栅栏裁决并发变化。fixture 不调用这些真实写接口；组件自检不代表独立或 Windows 验收。

同日 0024 ViewConfiguration 前端增量：项目工作台入口 `/projects/:id/workbench` 在 live 模式先读取该项目服务端保存的默认 kind，再进入相应只读事实视图；查询失败时留在错误页并可重试，不猜测默认值。项目设置“连接与权限”页和工作台页都显示独立 View 修订、服务端解析的默认模板版本/SHA-256、`pages` 实际顺序与可见标记。工作台的三个 tab 只供临时浏览；只有设置页明确选择并提交、或在工作台明确“设为默认”，才 POST `{command_id,expected_revision,kind}`。不提供逐页编辑，保存不改变 Project Type/State、Task/Run 或执行配置。响应不明时在当前浏览器会话冻结原 ID/修订/kind，查原回执；未找到才允许原样重试。409 冲突也核对原回执和最新配置，保留用户选择，用户明确重新确认后才用新修订、新 ID 提交。fixture 入口沿用通用示例且不写真实配置；组件与路由自检不代表真实桌面或独立验收。

同日 Connections 设置增量：`/projects/:id/connections` 从项目导航进入，读取本项目 Connection 状态、capability、WEB_FETCH `allowed_host`、ManagedResource 根与独立 PermissionPolicy 当前/历史版本；全局 `/connections` 和 `/settings/connections` 当前仍只提供 Project ID 入口，尚未接入新项目列表投影作选择器。三个配置列表和每项策略的版本列表最多读服务端前 100 条且无游标，页面明确显示这一范围；Connection/ManagedResource 的创建与停用另按详情读取核对，不把截断列表当全量。FILE_READ 连接根目录不在读取 DTO 中，详情明确“连接目录未由此接口公开”，受管资源另列且不推断同根；不展示完整 config、secret 或凭据。用户可创建 WEB_FETCH/FILE_READ（或已有 Fake 能力）连接、停用连接，登记/停用受管资源，并明确新建、修订、撤销策略。策略默认选择 DENY；WEB_FETCH 策略提交明确 host 与空 resource_id，FILE_READ/FAKE_WRITE 明确选择 ACTIVE 受管资源 ID，连接创建不自动创建策略或视为授权。策略显示 AUTO/ASK 仅为版本事实，仍须有效连接及目标匹配，主机不同不宣称准入。命令携原 `command_id` 与版本前提，冲突保留输入和原 ID，响应不明冻结其余变更、查询原回执，确认未找到后仅以原 ID/原载荷重试。成功还以服务端最新查询确认状态；停用/撤销后保留历史可见。不调用连接 `/test`，fixture 无真实设置。该组件自检不代表真实 Windows、Provider 或 M05 独立验收。

## 4. 任务与版本交互

闭环 Skill 入口按[首批设计](../architecture/relay-skills.md#7-首批闭环能力与后续目录)接入：任务页提供“完善任务定义/生成验收方案”，项目页提供“继续这个项目”，创建引导保留蓝图预览。委托前展示并确认任务与验收版本；组合“确认并委托”须区分提案已应用与 Delegate 成功，失败后不能显示已开始。恢复摘要标注来源及时间，过期后重新读取；没有比较基线不显示虚构的上次变化。Repair 显示失败证据、新版本及复验状态；交接包区分等待安全点与已接手，仅需判断的场景留在 Review。这些交互不新增一级导航或要求八个独立页面。

2026-09-26 M05 项目恢复页前端增量：fixture 的原“继续项目”演示保持原样；live `/projects/:id?skill=resume` 改为只读当前事实速览，分别查询 Project、State、项目任务首分页、State 指定下一步的 Task 单读、OPEN Review、项目 Decision 和 State 当前选用的 ArtifactVersion（按 Artifact 详情核对）。页面明确已加载的任务/Review/Decision 范围，不把首分页或前 5 条称作完整历史；产物详情不可读取时保留 State 版本引用并标记不可用，不用最新版替代。没有上次查看基线，不显示进度推断、变化比较或模型建议；刷新不改变 Task/Run，也不宣称 Skill 注册已交付。跨项目旧响应不覆盖当前页面；组件自检不是独立桌面验收。

同日 M04/P12 任务 Skill 页面前端准备：fixture 的“完善任务定义/生成验收方案”交互预览保持原样；live `/tasks/:id?skill=definition` 与 `?skill=verification` 只读 `GET /tasks/:id` 的当前 Task 与验收目标、来源、版本、条件及方法。有确切 `executor.run_id` 时读取该 Run 的 Trace，展示实际 Verification Session、验收版本、CheckPlan hash、检查结果与目标产物版本，并链接原 Run/版本来源；这段历史不自动证明当前检查仍有效或任务已完成。无 Run 指针、来源不可读、刷新失权各有明确说明，旧响应不能覆盖新任务。当前 Task 的验收 DTO 含 `expected_outputs`，前端读取其已声明的 `kind`；Task 单读仍未提供输入资料绑定。原普通 Assist 的 Task 目标可讨论或提 Markdown 候选，Project 目标的 `TASK_DEFINITION` 是新任务提案，不是修改现有 Task 的 Skill 提案。两页把可确认的 Task Skill 合并提案引向原任务 Assist；验收页读取当前 CheckPlan 准入预览，确认入口仅在真实服务端提案上显示。首批 Skill 的只读调用接线见下文；Blueprint 应用见上文 0025 live 切片；Task 验收变更只能通过真实 Assist 提案接受命令，CheckPlan 预览没有独立应用命令，不能把 fixture 建议视为已生成或已应用。这是组件开发自检，不是独立验收。

同日 M04/P12 第一方 Skill/Pack 接线：live 项目/任务 `?skill=assist` 读取工作空间 `/skill-definitions`，普通 Assist 仍为默认；仅展示与已单读目标匹配的 Skill。用户显式选择注册表中目标匹配且 `call_supported=true` 的精确 Skill 版本后，界面展示注册表版本/摘要、依赖、只读或仅建议状态及缺失能力；发送 `skill_ref` 与该定义允许的 `skill_input`，不同时发送普通 `intent`。`command_id`、来源版本与完整载荷在响应不明时冻结，原回执核对和同 ID 重试沿用 Assist。服务端消息的 `skill_output` 只读呈现任务定义建议、项目速览、验收方案建议及项目蓝图建议；蓝图模型输出不直接提供应用按钮，应用依据是单独保存的服务端蓝图候选。展示输出目标/基线/时间、事实与输出摘要，来源链接只依据服务端返回的可用引用；`UNAVAILABLE` 来源不展示原 ID 或正文。旧普通消息三字段为 null，继续照常阅读；202/失败/取消不会被当成建议完成。Task Skill 在服务端另生成可审查的合并提案时，才提供明确确认入口。任务/项目事实页仍显示已接受的当前事实，不把输出标为已应用。无额外 Connector 能力要求不等于模型 Provider 可用。live 创建项目引导与 `/settings` 只读显示服务端 Pack 固定成员、版本、摘要、可调用状态与缺能力；`AVAILABLE` 表示当前 Pack，`HISTORICAL_ONLY` 仅保留旧版读取，查看清单不授权、不启用规则或启动 Run。fixture 不读取真实注册表。此为组件开发自测范围，非真实 Provider/桌面或独立验收。

后端冻结定义兼容补充：Assist 历史行的 `definition_availability=HISTORICAL_ONLY` 表示当前注册表不再提供此版本、但持久冻结的定义与依赖仍自洽；消息保留原 ID、版本、摘要，明确标为“仅可查阅，不能新调用或接受”，不得把冻结身份中的 `availability=CALLABLE_*` 解释为当前可调用。选择框始终只从当前 `/skill-definitions` 生成，不用新版替代历史来源。`output_availability` 独立表示 `PENDING`、`HISTORICAL_SNAPSHOT`、`NO_OUTPUT`、`UNAVAILABLE`；仅服务端仍判定目标与来源可读的已完成历史输出才显示类型化内容。冻结损坏或来源/目标失效时不推测历史正文；普通旧消息仍按无 Skill 来源展示。

同日 Task Definition 只读预览补充：Assist 中该类型输出先核对 `target_id` 与当前任务会话，再核对基线 `task_id/project_id/task_revision/acceptance_revision`，随后单读当前 `GET /tasks/:id`。当前目标、预期产物 `kind`、条件字段和任务模式与模型建议分列；条件只按文字/必需性/方法完全相同计数，不从未重复项推断将删除旧条件或最终新增建议条件。Task/验收 revision 与输出基线不同时标记过期；重新读取遇到 404/失权会清除旧 Task 事实和建议内容。当前验收 `expected_outputs.kind` 可由真实 Task DTO 读取，未声明时显示未声明；最终合并效果与接受资格以后端 Task Owner 提案及命令为准；原模型字段对照仍不提供 Apply。Verification Plan 区分历史 `checks` 与当前 `additional_checks` 模型输出；当前 `check-plan-preview` 显示 Task/验收/规则/Workflow 来源、原因代码与派生条件，但它不是 Run 冻结计划或执行结果，也不拿历史 Run Trace 充当当前准入。Project Resume 的 `next_steps` 明确为模型文字，不视为 Today 合格 Task，也不提供启动动作。

2026-09-26 M04/P12 0023 Task 接受接线：live Assist 的 `TASK_CONTRACT_CHANGE` 与 `VERIFICATION_PLAN_CHANGE` 提案只展示服务端 `payload_available=true` 的最终合并 payload，逐项标出 `PRESERVED/SUGGESTED`、保留/新增条件 ID、目标与结果契约；模型的建议模式不随接受命令生效。读取确切 Task 核对 `base_revision/base_acceptance_revision` 后，用户二次确认才以 `command_id`、两个 expected revision 和 `payload_hash` 调用 Accept。回执不明保留同一 ID 与载荷，先查询回执或原样重试；409 保留提案与合并内容并提示重生成，不覆盖当前验收。失权时隐藏 payload 并禁用确认。旧普通 Assist 的候选产物和新任务提案沿原接受请求，不附 Task CAS 字段。`verification-plan` 旧定义标为历史不可新调用；注册表 `call_supported/accept_supported` 而非前端写死版本决定当前候选；同一 Skill 的新版本优先排列。`task-to-execution-contract@1.1.0` 的 `expected_outputs.description` 与 Task 当前结果说明同列比较，最终生效说明读取服务端合并 `required_output_spec`。Pack 旧版本只读，当前 `1.3.0` 优先排列；成员有接受能力也不表示浏览 Pack 就已接受。当前 `/tasks/:id/check-plan-preview` 只读 Task 验收、规则与固定 Workflow 的准入派生，`admission_available` 与原因由服务端给，始终不是冻结 Run 计划、已执行验证或 PASS。此处为组件开发自测，不是独立或桌面验收。

2026-09-26 M04 普通 Assist 生成中草稿前端增量：live 项目/任务 Assist 只对当前会话中 `intent=DISCUSS`、无 Skill、未请求取消且状态为 `PENDING/RUNNING` 的 ASSISTANT 消息，以约 400 毫秒的有界间隔读取其原 `session_id/message_id` 的 `/live-preview`。有首片段时用纯文本显示明确标记的“生成中草稿”和预览修订；它不是完整回复、结构化提案或已接受产物，截断也单独标明。首片段前保持等待状态。终态、取消或失败时清除草稿并从原消息列表读取最终状态；`preview_available=false`、预览 404/失权、会话或目标及 Workspace 切换立即清除旧草稿并隔离迟到响应，消息列表失权也清除旧消息与提案。重新连接后按同一会话和消息 ID 重读，不把旧草稿移入新会话；Skill 和结构化提案消息不请求 raw 预览。原写命令回执和归档禁写流程不由该只读入口改变。延迟片段组件模拟只验证界面状态，不作为真实 Provider 首字延迟或 Windows 交互证据。

任务顶栏分别显示工作状态、执行模式、当前执行者。Me/Assist/Delegate 是交互意图，不用一个彩色状态覆盖三者；Delegate 前展示 Project、验收版本、工作配置与作用域。

人工路径：录入 → 整理为 Ready → 开始 → Markdown 编辑/保存版本 → 选择要接受的版本 → 检查 required 项 → 完成。未保存草稿离开页面提供保留/放弃选择；草稿只是客户端输入，不显示成已发布 Artifact。

保存版本命令发出时固定 command_id、目标 Artifact、所依据的 revision 和原正文。网络超时、5xx 或响应无法核对时保留这份原请求，编辑器可继续写新草稿，但在原命令结果确定前禁用再次保存；查询回执必须匹配原命令类型与 Task/Artifact 目标，不能换 ID 盲重试。原回执确认保存 A 后，后来编辑的 B 仍是未保存草稿；服务端列表与 revision 更新后，保存 B 才使用新 command_id。明确的校验/修订冲突拒绝可释放原 ID；409 显示自己草稿和服务器版本差异，不自动丢稿或覆盖。

产物版本列表突出“当前选用”“本轮接受”“最新”三个不同标记。完成后编辑按钮引导重开，不悄悄改旧版本。Markdown 默认禁用原始 HTML/危险链接，预览只渲染安全内容，不执行资料中的脚本。

2026-09-24 M03 Task 产物增量：真实「产物」页签从受权 `GET /tasks/:id/artifacts` 恢复该 Task 的全部 Artifact/不可变版本，刷新后仍按服务端确认的人工 Artifact 与其 revision 续写；列表加载中或失败时保留本地草稿，禁止把未知列表当空列表创建/完成，可重新读取。版本行以 `artifact_version_id` 唯一标识，即使多个 Artifact 都有 v1 也不会混同。“最新”取各 Artifact 自身最新版本，“当前选用”取 Project State，“本轮接受”只取 Task 当前 CompletionRecord；刷新后不会自动选中最新版作为待接受版本。同页重开直接成功或原回执确认后，都清空本轮待接受选版与条件勾选，历史版本仍可手动重选；其他客户端造成的验收 revision 变化也清空旧轮选择。重开清空服务端当前接受指针而不删除历史。浏览器全刷新需要重新建立内存 Bearer 连接，本片没有把凭据持久化。定向真实 PG/浏览器结果见 [开发自检](../../apps/workbench/results/m03-task-artifacts-evidence.txt)；后续组件修复见本片自检，未重建冻结 Windows 包，桌面端与 M03 总验收待独立复跑。

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

2026-09-23 P08 开发增量：真实任务详情仅在 `executor.run_id` 非空时给出 `/runs/:id` 入口；示例模式不构造 Run。Run 页读取步骤、最近尝试、未决 Review、待处理控制请求与未决动作 ID，UNKNOWN 只提示核对，不提供强制改成功的按钮。PAUSE/CANCEL/HANDOFF/CANCEL_TASK 使用 Task 与 Run 双版本提交；202 回执只表示 `PENDING`，安全点可能随后处理，以服务端查询为准；PAUSED 可提交 Resume。命令响应丢失或成功响应无法核对时保留原 `command_id`，仅查询回执；回执须匹配命令类型、Run 和控制类型后才解除未决状态，不产生新控制请求。当前页面只列未决动作 ID，完整动作核对详情仍需后续接口与交互；组件自检不等于桌面验收。

2026-09-26 M04 Run DRAFT 草稿预览前端增量：live Run 仅在当前 Task 仍由该 Run 执行、Run 与当前 DRAFT Step 都为 `RUNNING`、且没有待处理控制请求时，约每 400 毫秒串行读取 `/runs/:run_id/draft-preview` 的持久化 Markdown 前缀；SSE `run_hint` 仍只促使重读权威 Run 事实。首片段前不制造正文；有正文时按纯文本显示“生成中草稿”、预览修订及截断标记，并明确尚非受管 Artifact、Verification PASS 或 Task 完成。预览以 `step_attempt_id`、`attempt_claim_epoch`、`model_call_id` 为轮次身份，身份变化先清旧片段，新轮次再显示；旧请求迟到不能覆盖新身份。`preview_available=false`、控制或取消、终态、失权/404、切 Run/Task/Workspace 立即清预览；终态回到原 Run/Artifact 查询事实。该只读预览不改变控制命令、原回执恢复或归档禁写；fixture 不生成预览。延迟首片组件测试不是实际 Provider 首字延迟、Windows 或独立验收证据。

2026-09-24 M03 G03 查询片：Run 页的“执行结果未知或待核对”现合并展示 P08 未结清效果与该 Run 的 Gateway UNKNOWN 原 `operation_id`。文案要求先核对目标与效果证据，证据不足时保留待核对；不提供盲重试、换 ID、恢复写入或直接标记成功入口。字段没有逐项状态，页面不能把所有条目都称为已执行或已失败。Gateway UNKNOWN 变化目前没有专属 Run SSE 事件；手动刷新、重开页面或约 15 秒周期重读可获取最新查询投影。完整动作核对详情仍需后续接口与交互。

2026-09-24 M03 Mock 动作 UI 开发增量：Task「执行记录」页签仍默认提交普通固定 Markdown Delegate。用户主动勾选文件动作时，页面只读取当前 Project 已生效的 `FAKE_WRITE` Connection 和受管目录，由用户填写目录内完整目标路径与内容；缺少配置或必填项时不提交。可选 `mock_gateway_action` 随原 Delegate `command_id` 一起发送，202 之后按既有回执规则处理，响应不明不改 ID 重试。Connection、目录和策略的创建/变更仍由 P09 HTTP 入口负责，页面选择不授予权限，Gateway 在效果前继续核对。Run 页新增按需读取的动作历史，显示原 operation_id、目标、Operation/Invocation 状态；它是当前查询结果，不把批准当作写入成功，也不提供 UNKNOWN 直接结清按钮。此处是前端接线与定向自检，完整桌面业务链仍按 M03 状态记录。

2026-09-24 M03 React 首片：真实 Task 的「执行记录」页签对有 Project、READY/HUMAN 且服务端 `allowed_actions` 提示可开始的任务提供单独 Delegate；创建 Task 的模式选择不创建 Run。真实创建成功结果中的任务 ID 可点击，直接进入该任务详情；原返回任务入口与示例模式保持不变。提交绑定 Task revision 与新 `command_id`，202 回执核对 Task/Run 身份后进入实际 Run；响应不明时保留原 ID，只查询匹配 `DelegateTask`、Task ID 和结果的回执。Review 决定的即时响应与原命令回执也核对 `ResolveReview`、Review ID、决定及版本，匹配失败维持未决。此处是前端组件接线与回执保护，独立 Worker/SSE、真实 PG 联动与桌面运行仍由 M03 分片验收。

2026-09-24 M03 事件客户端准备片：真实 Run 首读服务端 Run/Task/Reviews 后，用内存 Bearer 的 `fetch` 订阅该 Run 的 SSE；`after` 只记录完整、连续的十进制事件序号。事件正文只作重新查询提示，不能直接改写任务、运行或审批事实；重复事件忽略，缺号或截断后保留旧游标补历史，较大的正文不进入页面状态。短时间密集事件合并读取 Run/Task/Reviews，周期读取和手动刷新仍校正来源 Manifest；断流显示重连，鉴权失效停止旧凭据订阅并重新查询，离页只 Abort 订阅而不发取消命令。该准备片先由受控流组件与浏览器自检验证；后续受控服务端断流实测见下段，其他网络故障仍须单独核对。

同日的 M03 组合开发自检使用冻结 Windows release、WebView2、隔离 PostgreSQL 18.6、真实 API 与 Mock Worker：Run 页从历史事件启动并在 Worker 提交后重读权威快照；页面离开未提交控制命令；受控 WebView `fetch` 中断后按原序号补读；阻断 SSE 时服务端快照校正页面；宿主强杀后四个进程停止，重启页面从持久历史重读，原命令保持一份。无 Bearer、错误 Origin/Host 和跨 Workspace SSE 均被拒绝，测试核对 URL、浏览器存储和宿主日志无令牌。可复跑输入、精确包哈希、原始日志及未验证边界见 [M03 SSE 桌面自检](../../apps/desktop/results/m03-sse-webview-evidence.txt)。该次 CDP 离线仿真未切断已经建立的 loopback SSE，故未证明产品同页自动重连。随后在**同一冻结 release** 上的[独立同页断流反例](../../apps/desktop/results/m03-sse-same-page-evidence.txt)以隔离 PG 表锁唯一定位正在轮询的 SSE 会话，精确终止该会话；旧 WebView 请求关闭后，未离页的 RunView 自行携已消费的 `after=1` 重连。测试仅延迟这条已发出的请求，让真实 Mock Worker 提交 seq 2–31，再放行历史补读；页面随后重读权威 Run 快照并显示修订 v6，宿主与 API 原进程仍运行。该有界片已独立复跑通过，但只覆盖这一种受控服务端断流；其他网络故障、完整 M03/G01–G08 和 Windows 安装交付仍未验收。

2026-09-23 P10 开发增量：`/knowledge` 与 `/projects/:id/knowledge` 共用真实资料页；项目页按项目参数读取，服务端可同时返回适用的 Workspace 事实。四类页签分别读取 Knowledge 的不可变版本、Memory 的确认修订、Decision 的替代指向、Rule 的版本及作用域/强度/检查路径；新建、追加版本、归档或停用携带独立 `command_id` 与变更时的 `expected_revision`。Memory 新建和修订均须由用户勾选明确确认；Decision 替代保留旧决定可查；Rule 表单区分 HARD/PREFERENCE 和 PRE_ACTION/POST_CHECK/SEMANTIC/HUMAN，冲突或检查路径不可用时保留输入并展示服务端拒绝原因。搜索使用服务端有界字面接口（每页 20 条、游标续页），支持中文短词并忽略迟到响应。命令响应丢失或回执无法核对时保留原 ID，仅查同一命令回执；切换资料类型期间禁用再次写入。示例模式只说明未接入，不伪造资料；人工新建仍限受管文本、笔记及产物版本引用。此处记录开发实现与组件自检，不代表真实桌面验收。

2026-09-26 P17 前端开发增量：项目 Knowledge 页的真实 API 模式可从本项目 ACTIVE 且含 `WEB_FETCH` 能力的 Connection 中选择一个，提交无用户信息、无片段的 http(s) URL。选择器展示连接 ID 与服务端返回的 `allowed_host`；该值为 null 时只显示 ID，不推断主机。URL 是否匹配连接主机仍以服务端准备期判断为准。201 回执只显示 QUEUED，后续按 Job ID 读取 QUEUED/RUNNING/SUCCEEDED/FAILED、失败原因和原 Gateway Operation/Invocation 状态；`WAITING_APPROVAL` 时优先链接目标同时匹配 `operation_id` 与 `import_job_id` 的 OPEN Review，未查到时指向现有待审入口，不在此处自行批准。成功时按返回的 `knowledge_version_id` 精确核对项目 Knowledge 的不可变 `WEB_PAGE` 版本，再显示正文摘录与详情入口；同 URL 的其他版本不充当结果。响应不确定时保留原 `command_id` 和冻结的 URL/Connection，只查询原回执或以相同 ID/载荷重试；切换项目或连接后隔离旧异步响应。当前 API 没有 Job 列表或按版本 ID 直查 Knowledge 的端点，故页面展示 Job ID 并提供按 ID 恢复查询；资料列表尚未投影对应版本时保留版本 ID 和刷新提示。Workspace Knowledge 页与 fixture 不展示导入表单，PDF/向量导入、Connection 管理和跨 Workspace 写入不属于此切片。组件测试与构建不构成真实 Provider、Windows 或 M04 独立验收。

2026-09-23 P11 开发增量：真实 `/runs/:id` 的步骤附近提供只读“本次输入来源”，从该 Run 的 Manifest 列表与详情查询读取构建状态、版本摘要、预算、实际可读片段及合法排除。BUILD_CONTEXT 尚未开始、进行中、失败（必需来源缺失或超预算）和已完成但无 Manifest 分别显示；历史 Manifest 无预算时标明未记录。相关来源区分标题字面命中与同范围最近资料补位，片段正文始终按纯文本展示。详情由服务端按当前权限重新过滤；重新读取、切换 Run 或连接时先清除旧正文，迟到的旧请求不能覆盖当前视图。若预算用量因隐藏来源被置空，只显示权限过滤提示，不据此推断无权来源的数量；无权来源及其排除项不显示 ID、名称、正文或条数。示例模式不生成来源，页面不提供完整 Inspector 或模型隐藏思考。当前组件自检不代表真实桌面验收；已打开页面上的权限变化需要重新读取来源才能反映。

批量 Review 不属于 V1；一个请求一个明确决定。拒绝操作不显示为“执行失败”，请求修改需展示原契约与修正预算。

## 6. AI Panel 与可追溯性

Panel 顶部显示当前 Project/Task、只读 Assist 或 Delegate 模式、采用的来源版本。切页时旧响应留在原会话；发送按钮冻结请求目标，迟到响应不能注入新 Task。

输出分为建议、候选产物、可接受提案。接受前展示差异和目标；Task 被 AI 占有时“保存编辑”改为接手入口，不绕过执行权。隐藏模型私有推理；可查看输入来源、步骤结果与验证证据。

2026-09-26 M04 前端开发自检范围：沿原有项目/任务路由的 `?skill=assist` 子页提供可达的会话入口，不新增一级路由。仅 live 连接读取真实目标、会话、消息与类型化提案；fixture 明确不提供模型回复。新建会话和发送消息均使用 `command_id`，发送时把当前显式选中的 `{kind, root_id, version}` 随本次消息冻结，项目/任务切换后旧异步结果不进入新目标。页面区分排队、运行、失败、取消中与取消终态；202 只表示排队，状态来自后续查询；未知模型用量显示“未知”，不伪装成 0。新建会话、消息、取消与提案接受响应不确定时保留原命令 ID 查询回执，重试只复用原 ID 和载荷。提案展示具体目标、基准修订、完整候选内容及服务端状态；接受只调用受控 Accept 命令，由服务端按提案基准修订校验，409 保留冲突说明并重读 EXPIRED。Task 委托入口也可显式选择同作用域不可变来源版本，随 Delegate 命令冻结。该前端切片的组件/类型/构建自检不代表真实 Provider、桌面窗口或 M04 独立验收。

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

## 8. 前端验收

组件测试覆盖版本冲突、待决请求、审批过期、空列表和不可用 capability；桌面 E2E 覆盖人工完成/重开、窗口重载/重连、切工作台不变 Run、AI Panel 迟到响应、Later 持久化。并发冲突由桌面 UI 与受控测试客户端竞争验证，不据此增加产品多窗口。开发浏览器组件测试可辅助，不能代替真实壳内 E2E。前端模拟数据仅用于开发，发布必须连真实 API。

视觉验收按[设计系统第 8 节](design-system.md#8-验证与交付边界)执行，文档/token 静态检查与真实页面验收分别报告。

## 9. 静态页面效果图

2026-09-19 按用户提供的[论文验收页参考图](../../exec-e4781944-a9b1-4906-8cd8-994841a0c21f.png)延展其他页面：暖白底色、墨绿强调色、宋体标题、细分隔线与宽留白，保留一致的左侧导航和右侧上下文区域。该轮只形成视觉概念，不新增功能承诺，也不将 Proposed 决策标为 Accepted。

| 页面 | 效果图 | 主要呈现 |
|---|---|---|
| 今日工作台 | [today.png](mockups/2026-09-19/today.png) | 人工置顶焦点、可开始任务、待审入口与推荐依据 |
| 项目总览 | [project-overview.png](mockups/2026-09-19/project-overview.png) | 已确认状态、待明确问题、版本化产物与下一步 |
| 开发工作台 | [development-workbench.png](mockups/2026-09-19/development-workbench.png) | 隔离变化集、差异、检查证据与人工接受；接受不等于写回或 Git 提交/推送 |

截至2026-09-20，已延展为32张生成图与1张原始参考，覆盖基础页面、关键流程状态及首批四项 Skill 交互；上表保留首批3张入口。完整清单、基础批次5张修正版及已知偏差见[效果图目录](mockups/2026-09-19/README.md)，实施输入见[33个逐页开发提示词](page-development-prompts.md)。

图片通过内置 Image Gen 生成，[首批提示词](mockups/2026-09-19/prompts.md)及效果图目录中的后续记录保留生成依据。图片中的项目状态、代码片段、版本及检查结果都是示例，不能作为真实运行或测试证据；图像偏差按目录及开发提示词修正，不覆盖业务规范。字体、尺寸与可访问性仍需在后续实现中验证。

## 10. 成果共创与变化守护探索

2026-09-25，Proposed，未因本文补充而实现或验收。产品责任边界见 [Master Spec](../../Personal_Workflow_OS_Master_Spec.md#02-协作形态补充2026-09-25proposed)，实施范围见[协作形态探索补充](../requirements/v1-scope.md#协作形态探索补充)。本节描述候选交互，不新增一级导航或变更当前路由；自动监控不前移到 V1。

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

以上是尚未执行的场景判据，具体通知阈值、锁定粒度、关系维护方式及评价基线待确认；不作为当前模块已通过的测试证据。

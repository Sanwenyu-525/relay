# 工作台交互规范：分册 01

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../workbench-design.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 1. 前端与分发推荐

工具链、状态/查询库及组件依赖按[技术选型](../../architecture/技术选型.md)选择，不在本文重复版本表。UI 状态只包含当前选择、面板展开、编辑草稿；服务端查询缓存不成为一套可独立修改的 Task 状态。精确版本及本轮采用证据见 M01/M02 开发记录。

用户已确认 Windows 可安装应用、独立窗口和启动入口。目标 React 页面在桌面壳中加载随包静态资源，业务经已鉴权 loopback HTTP 调用本机 API；来源配置与开发 Vite 分开，不能假定生产同源。框架与生命周期见 [ADR-007](../../decisions/ADR-007-windows-desktop.md)及[部署设计](../../deployment/本机部署.md)，仍为 Proposed。选择依据本项目需求与验证，不继承 Manga 的技术栈。

若已有正式前端工程，编码 Agent 先检查兼容性，不为遵循草案机械重写；记录决策差异。同一查询缓存只保留一个 Owner，失效/重取遵守 revision，旧响应不得覆盖新状态。组件库默认样式必须映射本项目语义 token；长列表是否虚拟化按实际需要决定。

维护准入的 `MAINTENANCE_DRAINING/MAINTENANCE_UNAVAILABLE` 按服务端 code 显示固定中文说明，不直接呈现底层配置明细；提示新操作暂不可用及仍可读取/请求取消，不能据此把在途工作显示为已停止。响应丢失仍按原命令回执核对规则处理，不归因为维护拒绝。首片没有维护状态页或 UI 开关，操作入口与边界见[部署说明](../../deployment/本机部署.md#draining-新工作准入门)，实际前端/桌面验证只看功能验收表。

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

2026-09-28 标题栏接续：[完整窗口 v2](../mockups/2026-09-28/README.md)左侧不显示 `Relay Agent`，使用后退、前进、搜索和新建任务。后退/前进只遍历本次应用内已观察到的路由历史，无可用历史时禁用；不根据浏览器总历史长度猜测可返回页面。搜索复用同一 Ctrl+K 面板和作用域；新建任务只打开既有创建流程，在当前项目路由下预填项目 ID，并由原表单允许核对、更改及提交前验证，不自动提交。导航继续经过未保存草稿离开保护与原准入约束，不建立第二套业务命令。代码已接入，真实 Windows 操作仍以确切产物验证为准。

中间空白支持拖动和双击最大化/还原，业务按钮区域排除拖动；右侧窗口按钮调用宿主操作。关闭仍按原草稿和运行安全退出流程，不直接销毁绕过生命周期；失败就地显示错误。页面切换、连接中和服务失败不应让窗口控制消失。后续验收覆盖无历史禁用、搜索/创建复用、草稿保护、键盘操作、缩放不遮挡及真实 Windows 拖动/双击/最小化/还原/关闭；本轮静态图未执行这些运行时验收。

2026-10-05 标题栏左侧复位：用户指出后退、前进、搜索、新建任务原本在标题栏左边，此前一轮被移到了下一层应用顶栏，导致标题栏左侧空出一段而常用操作与窗口控制分处两行。现将这四个按钮移回标题带最左侧、拖动区之前（`DesktopTitleBar` 渲染 `WorkbenchActions`，`AppShell` 不再重复承载）。行为与准入不变：仍只遍历本次应用内已观察到的路由历史、仍复用同一 Ctrl+K 命令面板、仍只打开既有新建任务流程，连接中与服务失败页不渲染（没有可用的应用内路由与命令面板）。副作用是工作台页这类无面包屑页面的应用顶栏会整行空出，因此在宽屏按无面包屑收起该行；窄屏仍保留导航抽屉入口。浏览器仍显示这四个业务入口，只有窗口控制由桌面宿主提供。

2026-10-04 标题栏收口：日期与星期、任务收件箱、数据来源与通知入口从应用顶栏移入共享标题带，位于拖动区右侧、最小化按钮左侧。理由是这两行原本连续占用首屏高度，且日期/收件箱/通知与窗口控制同属常驻外壳。移出后应用顶栏只剩面包屑与窄屏导航按钮；宽屏无面包屑时整行收起，不留空白带，窄屏仍保留导航抽屉入口。连接中与服务失败页没有可核对的数据来源和通知事实，该组入口不显示，只保留真实窗口控制。应用顶栏原有的第二个搜索按钮同时移除，搜索仍只有标题栏一个入口并复用 Ctrl+K。

窄于或等于 600px 的窗口收紧标题栏操作间距和按钮宽度，日期与星期仅保留辅助技术可读内容，确保常用入口与窗口控制不被裁切；不改变关闭时的草稿与待核对命令保护。

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

2026-09-20 蓝图交互补充（Proposed）：首个 [Relay Skill](../../architecture/relay-skills.md) 将此流程命名为“从目标创建项目蓝图”。先创建最小项目，再生成建议；拒绝建议保留项目。预览只使用同一内置组件注册表和只读投影；Diff 展示状态、Goal 关联、新任务与导航变化。Rules、Workflow 与验证配置单列“后续配置建议”，按钮打开各自确认入口，不能被“应用蓝图”顺带生效。

生成中、校验失败、待预览、提交中、回执核对中、冲突/过期、拒绝、已应用必须可区分。修改内容或选中项形成新候选后重新预览；接受绑定项目、候选 hash 和基线版本。超时查询原回执；冲突保留用户草稿并显示当前差异，不自动覆盖。切页后的结果始终回到原目标。基础导航、Review/恢复入口不允许被隐藏；模型建议不能生成任意新路由。Goal 修改或 Skill 升级只提示新提案，不自动重排导航。

2026-09-26 0025 live 蓝图切片：`/projects/:id?skill=blueprint` 同页提供人工草稿与第一方 Skill 生成两条入口，fixture 仍是示例。人工草稿明确标记 `USER_DRAFT`；用户可指定现有 ACTIVE Goal、项目类型允许的 phase、最多 5 个新 HUMAN/INBOX Task、下一步和默认 View kind，并可选择 Pack 的确切版本作来源。草稿意图不会自动成为 Goal，Pack 选择不授予权限。提交后读取服务端不可变候选及候选 SHA-256、Project/State/View 基线、Diff、固定模板页面顺序；编辑已保存候选通过 `supersedes_proposal_id` 创建新候选。只有候选仍待确认、正文可读且服务端未判失效时，显式 Apply/Reject 才发送命令；Apply 结果单列真实 Goal 关联、Task ID、State 和 View 修订，Rules/Workflow 后续建议不随之应用。Skill 来源不可用时服务端返回 `content_availability=SOURCE_UNAVAILABLE` 与空的 candidate/baseline/diff；页面清除旧表单和预览，只显示候选状态与 hash，禁用确认。冲突与响应不明冻结原 command_id/载荷，优先查原回执；无回执才允许原样重试或在冲突后明确重新确认。Skill 入口先创建 PROJECT Assist 会话，再以 `goal-to-project-blueprint@1.0.0` 发送 `desired_outcome/goal_id/pack_ref`，202 仅表示消息排队。页面按 assistant message ID 读取完成/失败状态与 `error_code`，只选择 `origin=SKILL` 且 `skill_message_id` 精确相同的服务端提案；模型 `draft` 是只读建议，不由前端改写为人工候选。当前前端定向测试与构建是开发自检，真实 Provider、桌面交互和 M05 独立验收仍后置。

内置 Pack 在现有引导/配置入口作为可选领域组合展示，不增设安装市场。区分“本次选择”“已应用配置”和“当前工具权限”；显示成员版本、缺失能力及用户修改冲突，不能仅显示“Pack 已安装”暗示全部生效。Proposal Diff 基于真实影响说明哪些规则/执行配置需要另行确认、哪些活动执行可能失效；多个命令分别反馈结果。旧配置恢复使用“恢复配置建议”，明确需要新修订，不能承诺撤销外部效果。

Run Detail/Assist 增加轻量 Sources View：展示实际 Manifest 引用、版本、允许查看的片段与排除/裁剪原因。只读接口重新鉴权，禁止显示无权对象的名称/ID/数量；来源缺失与未选中分开，不冒充完整 Inspector 或展示模型思考。Projection Profile 仅控制已授权事实的呈现，不改变 Today 的业务排序、必需 Review 可见性和 Context 规则。完整比较/搜索 Inspector 按后续路线实现。

2026-10-16 动态呈现接续：按确切已知事件增加执行、检查、产物、决策、完成、项目与任务、其他类别，与执行方组合筛选；两者均只覆盖已加载项，不改服务端范围与游标，切换本地筛选清除原事件选中。已知事件采用中文名称，服务端摘要为「业务事件」时由该事件名称补足；原始代码、原摘要和完整引用身份保留在依据中，列表保留来源链接。未知类型显示「未识别的事件」，不推断成功；`VERIFICATION_FINALIZED` 只称「检查已结算」，`REVIEW_REQUESTED` 只称「请求人工判断」，运行结束、批准、检查与任务完成保持独立语义。依据中的长名称及身份允许自然换行。

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

2026-10-11 项目页重设计（呈现层）：`/projects` 范围从两个扩展为三个——`/projects` 不带参数即「全部项目」（默认，服务端 `status=all`），进行中 `?scope=active`、已归档 `?scope=archived`，历史深链接 `?archived=1` 继续解析为已归档。live 一次仍只加载一个范围，页签计数只显示已加载的那个范围，不造数；范围校验只在单范围请求时执行，「全部」范围允许两种归档状态混合返回。项目详情从常驻右栏改为「查看项目」打开的抽屉，打开项目与归档入口随之迁移；归档阻断原因、待核对原命令、成功回执与失权错误仍留在主列就地显示，不随抽屉关闭消失。归档流程与命令身份规则完全不变（本段上方规则继续有效），列表重读期间抽屉按 Project ID 重新对齐，只有列表已到末页且该项目确实不在范围内时才自动关闭。视觉与布局规则归[设计系统 §9.7](../design-system/part-03.md#97-项目列表页结构2026-10-11)，取舍与验证出口归[项目页重设计 spec](../../superpowers/specs/2026-10-11-projects-page-redesign-design.md)。

同日 CreateTask live 增量：`/tasks?view=create` 按用户操作读取 `status=active` 的真实 Project 列表并按服务端游标续页，点击某项才关联，绝不自动选择首项。名称搜索和数量只覆盖已加载页；项目页路由预填、已知 ID 手动输入与未归属项目的 Inbox Task 继续可用。读取失败、失权或切换 Workspace 时清除旧列表与跨空间 Project 选择，迟到响应不能回写。提交 CreateTask 时冻结目标 Project、完整载荷和 command ID；响应不明先查原回执，仅明确 `COMMAND_NOT_FOUND` 后才允许原 ID、原载荷重试。切换 Workspace 不重挂这张未决表单，以便切回原连接后核对；fixture 仍用原示例选项。本段仅为组件开发自检，独立验收后置。

同日 P14 归档项目首批前端门槛：蓝图及其 Skill 生成、项目连接与权限设置、工作台默认 View、项目任务页的新建/开始入口、Project Assist 均以当前已读取的 `Project.archived_at` 控制新的业务写入。已归档、Project 事实加载中或读取失败时显示原因并禁新命令；工作台和蓝图仍可浏览已获授权的历史投影。蓝图 Project 查询失权时清除旧候选正文。Project Assist 的新取消命令同样禁用；已发命令仍可按原 ID 查询回执，并在原入口允许原 ID、原载荷恢复。项目任务的开始命令在当前浏览器会话按 base URL、Workspace、Project 保存最小原命令字段；切换作用域立即清旧任务快照并隔离迟到响应，回到原作用域才能核对回执，不能拿新 Workspace 的客户端重放旧命令。Task Assist、Run 停止、Review 拒绝、Today 清 Focus 及其他 Task/Knowledge 独立页不属于这批 UI 接线；ArchiveProject 按钮在上文另一增量接入，不据此宣称全部写入口都已禁用。fixture 行为不变；组件自检不代表桌面与独立验收。

同日 P14 归档项目直达页第二批前端门槛：Task 详情、Definition/Verification 只读页与 Task Assist 从确切 Task 归属单读 Project；Definition/Verification 本身不发写命令，仍可查看已接受事实及历史 Trace。Task 详情的 Delegate、Artifact 新建/续写、选为当前项目版本、人工完成/重开，以及 Task Assist 的新会话、消息、取消和提案接受，在项目已归档或 Project 事实尚未确认/失权时禁用新命令；无项目的 Inbox Task 不受项目归档误禁。Run 控制与 Review 决定也核对其 Task→Project 归属和当前 `archived_at`，历史记录可读，归档后不再发新的 Stop、Reject 等控制或决定。切 Task/Run/Review/Workspace 清除旧归档判断并隔离迟到结果；既有未决命令仍可查询原回执。创建任务从进行中列表显式选择项目，项目页预填和手填 ID 在原 CreateTask 命令生成之前再单读确认为 ACTIVE；读取失败或已归档时保留草稿且零提交，留空创建 Inbox 任务不需要 Project 核对。Knowledge、Today 与 Web Import 独立入口尚未接这批归档状态门槛；服务端归档写栅栏才是最终约束。fixture 行为不变；定向组件自检不代表独立或 Windows 验收。

同日 P14 归档项目第三批前端门槛：live Knowledge、Memory、Decision、Rule 的项目关联新建、版本、归档、停用或替代操作，依据记录的实际 Project 或 Rule 的 Task→Project 归属核对当前 `archived_at`；状态加载中、失权或已归档时禁新写，提交前再单读，失败不产生命令。Workspace 级资料和规则仍可写；列表、搜索或详情读取失权时清除旧内容。项目 `WEB_FETCH` 导入同样在提交前重读 Project，归档后仍可按 Job ID 读历史并核对原命令回执；仅明确 `COMMAND_NOT_FOUND` 后才开放原 ID/载荷重试，项目状态及可用连接重读会隔离迟到结果。Today 的 Project Task Pin/Later/Focus/计划在新命令前核对当前 Task 归属与 Project 状态，旧候选在归档后不再可用于提交并重读 Today；无项目的 Inbox Task 不因其他 Project 归档而禁用。`target_kind:null,target_id:null` 清除 Focus 是 Workspace 选择，不关联旧 Project，仍可按原 selection revision 提交。已发送而响应不明的命令保留原 ID 与原载荷核对；最终仍由服务端归档写栅栏裁决并发变化。fixture 不调用这些真实写接口；组件自检不代表独立或 Windows 验收。

0024 ViewConfiguration 当前入口规则（2026-09-30）：项目工作台入口 `/projects/:id/workbench` 在 live 模式先读取该项目服务端 ViewConfiguration；查询失败时留在错误页并可重试，不猜测默认值。项目已保存的 View `revision>0` 优先；尚未保存、`revision=0` 时使用本设备显式保存的默认工作台偏好，没有该偏好则沿服务端按 Project Type 解析的初始 kind。显式 `/projects/:id/workbench/:kind` 路由不受默认偏好替换。项目设置“连接与权限”页和工作台页都显示独立 View 修订、服务端解析的默认模板版本/SHA-256、`pages` 实际顺序与可见标记。工作台的三个 tab 只供临时浏览；只有项目设置明确选择并提交、或在工作台明确“设为默认”，才 POST `{command_id,expected_revision,kind}`。不提供逐页编辑，保存不改变 Project Type/State、Task/Run 或执行配置。响应不明时在当前浏览器会话冻结原 ID/修订/kind，查原回执；未找到才允许原样重试。409 冲突也核对原回执和最新配置，保留用户选择，用户明确重新确认后才用新修订、新 ID 提交。fixture 入口使用本设备偏好，未保存时沿用通用示例，不写真实配置；组件与路由自检不代表真实桌面或独立验收。

同日 Connections 设置增量：`/projects/:id/connections` 从项目导航进入，读取本项目 Connection 状态、capability、WEB_FETCH `allowed_host`、ManagedResource 根与独立 PermissionPolicy 当前/历史版本；全局 `/connections` 和 `/settings/connections` 当前仍只提供 Project ID 入口，尚未接入新项目列表投影作选择器。三个配置列表和每项策略的版本列表最多读服务端前 100 条且无游标，页面明确显示这一范围；Connection/ManagedResource 的创建与停用另按详情读取核对，不把截断列表当全量。FILE_READ 连接根目录不在读取 DTO 中，详情明确“连接目录未由此接口公开”，受管资源另列且不推断同根；不展示完整 config、secret 或凭据。用户可创建 WEB_FETCH/FILE_READ（或已有 Fake 能力）连接、停用连接，登记/停用受管资源，并明确新建、修订、撤销策略。策略默认选择 DENY；WEB_FETCH 策略提交明确 host 与空 resource_id，FILE_READ/FAKE_WRITE 明确选择 ACTIVE 受管资源 ID，连接创建不自动创建策略或视为授权。策略显示 AUTO/ASK 仅为版本事实，仍须有效连接及目标匹配，主机不同不宣称准入。命令携原 `command_id` 与版本前提，冲突保留输入和原 ID，响应不明冻结其余变更、查询原回执，确认未找到后仅以原 ID/原载荷重试。成功还以服务端最新查询确认状态；停用/撤销后保留历史可见。不调用连接 `/test`，fixture 无真实设置。该组件自检不代表真实 Windows、Provider 或 M05 独立验收。

2026-09-28 Windows 文件写入根身份提示：项目 Connections 的受管资源列表读取服务端 `file_write_identity_bound`，逐项显示“已绑定”或“未绑定”。未绑定时说明若要在 Windows 使用 `FILE_WRITE`，须在 Windows 停用并重新登记目录；这只是登记身份状态，不宣称 Connection、Permission、Task 绑定或动作批准已齐备。字段缺失的旧服务端响应按未绑定显示。定向组件 9/9 通过；确切桌面包的 WebView2 自动化已核对已绑定资源的真实显示并留图，人工操作仍待验。

2026-10-02 root-bound 能力配置入口补齐：连接与策略的 capability 选择器此前只列 `WEB_FETCH`/`FILE_READ`/`FAKE_WRITE`/`FAKE_PUBLIC_READ`，用户因此**无法**为本项目创建 `FILE_WRITE`、`GIT_READ`、`GIT_WRITE` 或 `CLI_RUN` 连接——而 2026-10-01 的文件夹入口对话执行在缺 `FILE_WRITE`/`CLI_RUN` 连接时按服务端 409 拒绝该目录。现按服务端 `rootBoundCaps`（`FILE_READ`/`FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN`）展示全部 8 项：这 5 项在创建连接时必填「连接目录」并只提交 `root_path`，`WEB_FETCH` 只提交 `allowed_host`，两项 Fake 能力不提交任何边界；策略侧除 `WEB_FETCH`/`FAKE_PUBLIC_READ` 外都必须显式选择 ACTIVE 受管资源，不出现主机字段。真实连接只绑定一个边界：同时提交 `root_path` 与 `allowed_host`、或把文件系统能力与 `WEB_FETCH` 混在一个连接，由服务端按 422 拒绝，页面原样展示服务端校验而不自行改写。**这只闭合配置入口**：Git/CLI 的动作触发协议（HTTP 路由与协作页 Git 面板）仍按 §14.9 标记为未接入，工具面板的「Git 变更」「交互终端」页签继续只声明限制、不提供可点按钮。定向组件 13/13 与全前端 78 文件 597/597、类型检查通过；未做真实 Windows 与 M06 独立验收。

## 4. 任务与版本交互

闭环 Skill 入口按[首批设计](../../architecture/relay-skills.md#7-首批闭环能力与后续目录)接入：任务页提供“完善任务定义/生成验收方案”，项目页提供“继续这个项目”，创建引导保留蓝图预览。委托前展示并确认任务与验收版本；组合“确认并委托”须区分提案已应用与 Delegate 成功，失败后不能显示已开始。恢复摘要标注来源及时间，过期后重新读取；没有比较基线不显示虚构的上次变化。Repair 显示失败证据、新版本及复验状态；交接包区分等待安全点与已接手，仅需判断的场景留在 Review。这些交互不新增一级导航或要求八个独立页面。

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

2026-10-25 项目任务分页接续：项目任务选择入口使用显式游标分页，首屏与每次续页最多读 20 项；仅用户点击“加载更多”才取下一页。续页暂态失败保留已读任务和原游标，可按同一游标重试；401/403/404 清除受保护项目任务，项目/API 作用域变化时忽略迟到响应。列表必须显示已读数量及是否还有后续页，未读完不称为完整清单。`ComposerTargetPicker`、新建任务、知识入口、项目资料指南、项目计划和任务链共享同一分页 Hook；协议继续使用现有 `/tasks?project_id=&cursor=&limit=` 读取。

人工路径：录入 → 整理为 Ready → 开始 → Markdown 编辑/保存版本 → 选择要接受的版本 → 检查 required 项 → 完成。未保存草稿离开页面提供保留/放弃选择；草稿只是客户端输入，不显示成已发布 Artifact。

保存版本命令发出时固定 command_id、目标 Artifact、所依据的 revision 和原正文。网络超时、5xx 或响应无法核对时保留这份原请求，编辑器可继续写新草稿，但在原命令结果确定前禁用再次保存；查询回执必须匹配原命令类型与 Task/Artifact 目标，不能换 ID 盲重试。原回执确认保存 A 后，后来编辑的 B 仍是未保存草稿；服务端列表与 revision 更新后，保存 B 才使用新 command_id。明确的校验/修订冲突拒绝可释放原 ID；409 显示自己草稿和服务器版本差异，不自动丢稿或覆盖。

产物页呈现与失败补充（2026-09-30）：主区按确切版本读取已保存正文，并提供本地编辑/安全预览；正文失败可显式重试，不换为最新版。Task 上下文可展开，页签与刷新错误/重读入口常显；保存、当前选用和完成保持原组件的单实例操作区，窄窗移到主区之后。409 或已核实的基线变化在同页对照本地草稿与当前确切正文，只有显式确认才调整草稿基线。Task 单读或产物列表 403/404 后隐藏旧服务端事实、正文、名称和版本身份，同时保留用户未保存输入与原命令；随后 503 不恢复失权内容，成功读取或更换目标后才清除失权状态。普通 Task 刷新失败保留页面与原 Owner 并禁新写，不能把旧显示内容当作已刷新成功。

产物版本列表突出“当前选用”“本轮接受”“最新”三个不同标记。完成后编辑按钮引导重开，不悄悄改旧版本。Markdown 默认禁用原始 HTML/危险链接，预览只渲染安全内容，不执行资料中的脚本。

完成/重开结果不明时，面板在请求前冻结原 `command_id` 与完整载荷，并按 API、Workspace、Task 作用域写入版本化 `sessionStorage`；重挂载、同标签页重载、切换 Task 后返回均先恢复原命令并核对回执，不换 ID 或复用到其他 Task。存储不可用时保留当前页内命令状态、提示用户留在本页，并由 `DraftGuard` 阻止离开。旧完成回执若绑定旧 acceptance revision，只说明历史周期已完成，不把当前重开的 Task 标为 DONE。

2026-09-24 M03 Task 产物增量：真实「产物」页签从受权 `GET /tasks/:id/artifacts` 恢复该 Task 的全部 Artifact/不可变版本，刷新后仍按服务端确认的人工 Artifact 与其 revision 续写；列表加载中或失败时保留本地草稿，禁止把未知列表当空列表创建/完成，可重新读取。版本行以 `artifact_version_id` 唯一标识，即使多个 Artifact 都有 v1 也不会混同。“最新”取各 Artifact 自身最新版本，“当前选用”取 Project State，“本轮接受”只取 Task 当前 CompletionRecord；刷新后不会自动选中最新版作为待接受版本。同页重开直接成功或原回执确认后，都清空本轮待接受选版与条件勾选，历史版本仍可手动重选；其他客户端造成的验收 revision 变化也清空旧轮选择。重开清空服务端当前接受指针而不删除历史。浏览器全刷新需要重新建立内存 Bearer 连接，本片没有把凭据持久化。定向真实 PG/浏览器结果见 [开发自检](../../../apps/workbench/results/m03-task-artifacts-evidence.txt)；后续组件修复见本片自检，未重建冻结 Windows 包，桌面端与 M03 总验收待独立复跑。

2026-09-30 M04 真实读取委托接线：任务详情与协作页共用 `TaskDelegatePanel`，默认不附加读取；用户可显式选择一次受管文件读取或网页读取，与附加 Mock 文件动作互斥，切换时清除旧选择及输入。配置仅在选择读取后加载，只列本项目 ACTIVE 且含对应能力的连接、ACTIVE 受管目录；文件连接与目录是否匹配由服务端准入核对，前端不推断未公开的连接根目录。文件目标为目录内相对路径，网页为无用户信息/片段的 http(s) URL；网页主机、重定向及网络准入仍由服务端决定。加载、失败、缺配置或无效目标禁用委托，提供显式重读；切 Task/Project、读取种类、连接或目录后不复用旧输入，迟到响应不能污染新目标。提交将 `file_read_action` 或 `web_fetch_action` 随原 Delegate 固定，结果不明时配置冻结且只查原 `command_id` 回执。该入口表达用户已选的读取意图，运行仍经 Gateway 和原审批/完成 Owner；模型原生工具输出当前仍主动拒绝。


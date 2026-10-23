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

2026-10-05 标题栏左侧复位：用户指出后退、前进、搜索、新建任务原本在标题栏左边，此前一轮被移到了下一层应用顶栏，导致标题栏左侧空出一段而常用操作与窗口控制分处两行。现将这四个按钮移回标题带最左侧、拖动区之前（`DesktopTitleBar` 渲染 `WorkbenchActions`，`AppShell` 不再重复承载）。行为与准入不变：仍只遍历本次应用内已观察到的路由历史、仍复用同一 Ctrl+K 命令面板、仍只打开既有新建任务流程，连接中与服务失败页不渲染（没有可用的应用内路由与命令面板）。副作用是工作台页这类无面包屑页面的应用顶栏会整行空出，因此在宽屏按无面包屑收起该行；窄屏仍保留导航抽屉入口。浏览器仍显示这四个业务入口，只有窗口控制由桌面宿主提供。

2026-10-04 标题栏收口：日期与星期、任务收件箱、数据来源与通知入口从应用顶栏移入共享标题带，位于拖动区右侧、最小化按钮左侧。理由是这两行原本连续占用首屏高度，且日期/收件箱/通知与窗口控制同属常驻外壳。移出后应用顶栏只剩面包屑与窄屏导航按钮；宽屏无面包屑时整行收起，不留空白带，窄屏仍保留导航抽屉入口。连接中与服务失败页没有可核对的数据来源和通知事实，该组入口不显示，只保留真实窗口控制。应用顶栏原有的第二个搜索按钮同时移除，搜索仍只有标题栏一个入口并复用 Ctrl+K。

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

2026-10-11 项目页重设计（呈现层）：`/projects` 范围从两个扩展为三个——`/projects` 不带参数即「全部项目」（默认，服务端 `status=all`），进行中 `?scope=active`、已归档 `?scope=archived`，历史深链接 `?archived=1` 继续解析为已归档。live 一次仍只加载一个范围，页签计数只显示已加载的那个范围，不造数；范围校验只在单范围请求时执行，「全部」范围允许两种归档状态混合返回。项目详情从常驻右栏改为「查看项目」打开的抽屉，打开项目与归档入口随之迁移；归档阻断原因、待核对原命令、成功回执与失权错误仍留在主列就地显示，不随抽屉关闭消失。归档流程与命令身份规则完全不变（本段上方规则继续有效），列表重读期间抽屉按 Project ID 重新对齐，只有列表已到末页且该项目确实不在范围内时才自动关闭。视觉与布局规则归[设计系统 §9.7](design-system.md#97-项目列表页结构2026-10-11)，取舍与验证出口归[项目页重设计 spec](../superpowers/specs/2026-10-11-projects-page-redesign-design.md)。

同日 CreateTask live 增量：`/tasks?view=create` 按用户操作读取 `status=active` 的真实 Project 列表并按服务端游标续页，点击某项才关联，绝不自动选择首项。名称搜索和数量只覆盖已加载页；项目页路由预填、已知 ID 手动输入与未归属项目的 Inbox Task 继续可用。读取失败、失权或切换 Workspace 时清除旧列表与跨空间 Project 选择，迟到响应不能回写。提交 CreateTask 时冻结目标 Project、完整载荷和 command ID；响应不明先查原回执，仅明确 `COMMAND_NOT_FOUND` 后才允许原 ID、原载荷重试。切换 Workspace 不重挂这张未决表单，以便切回原连接后核对；fixture 仍用原示例选项。本段仅为组件开发自检，独立验收后置。

同日 P14 归档项目首批前端门槛：蓝图及其 Skill 生成、项目连接与权限设置、工作台默认 View、项目任务页的新建/开始入口、Project Assist 均以当前已读取的 `Project.archived_at` 控制新的业务写入。已归档、Project 事实加载中或读取失败时显示原因并禁新命令；工作台和蓝图仍可浏览已获授权的历史投影。蓝图 Project 查询失权时清除旧候选正文。Project Assist 的新取消命令同样禁用；已发命令仍可按原 ID 查询回执，并在原入口允许原 ID、原载荷恢复。项目任务的开始命令在当前浏览器会话按 base URL、Workspace、Project 保存最小原命令字段；切换作用域立即清旧任务快照并隔离迟到响应，回到原作用域才能核对回执，不能拿新 Workspace 的客户端重放旧命令。Task Assist、Run 停止、Review 拒绝、Today 清 Focus 及其他 Task/Knowledge 独立页不属于这批 UI 接线；ArchiveProject 按钮在上文另一增量接入，不据此宣称全部写入口都已禁用。fixture 行为不变；组件自检不代表桌面与独立验收。

同日 P14 归档项目直达页第二批前端门槛：Task 详情、Definition/Verification 只读页与 Task Assist 从确切 Task 归属单读 Project；Definition/Verification 本身不发写命令，仍可查看已接受事实及历史 Trace。Task 详情的 Delegate、Artifact 新建/续写、选为当前项目版本、人工完成/重开，以及 Task Assist 的新会话、消息、取消和提案接受，在项目已归档或 Project 事实尚未确认/失权时禁用新命令；无项目的 Inbox Task 不受项目归档误禁。Run 控制与 Review 决定也核对其 Task→Project 归属和当前 `archived_at`，历史记录可读，归档后不再发新的 Stop、Reject 等控制或决定。切 Task/Run/Review/Workspace 清除旧归档判断并隔离迟到结果；既有未决命令仍可查询原回执。创建任务从进行中列表显式选择项目，项目页预填和手填 ID 在原 CreateTask 命令生成之前再单读确认为 ACTIVE；读取失败或已归档时保留草稿且零提交，留空创建 Inbox 任务不需要 Project 核对。Knowledge、Today 与 Web Import 独立入口尚未接这批归档状态门槛；服务端归档写栅栏才是最终约束。fixture 行为不变；定向组件自检不代表独立或 Windows 验收。

同日 P14 归档项目第三批前端门槛：live Knowledge、Memory、Decision、Rule 的项目关联新建、版本、归档、停用或替代操作，依据记录的实际 Project 或 Rule 的 Task→Project 归属核对当前 `archived_at`；状态加载中、失权或已归档时禁新写，提交前再单读，失败不产生命令。Workspace 级资料和规则仍可写；列表、搜索或详情读取失权时清除旧内容。项目 `WEB_FETCH` 导入同样在提交前重读 Project，归档后仍可按 Job ID 读历史并核对原命令回执；仅明确 `COMMAND_NOT_FOUND` 后才开放原 ID/载荷重试，项目状态及可用连接重读会隔离迟到结果。Today 的 Project Task Pin/Later/Focus/计划在新命令前核对当前 Task 归属与 Project 状态，旧候选在归档后不再可用于提交并重读 Today；无项目的 Inbox Task 不因其他 Project 归档而禁用。`target_kind:null,target_id:null` 清除 Focus 是 Workspace 选择，不关联旧 Project，仍可按原 selection revision 提交。已发送而响应不明的命令保留原 ID 与原载荷核对；最终仍由服务端归档写栅栏裁决并发变化。fixture 不调用这些真实写接口；组件自检不代表独立或 Windows 验收。

0024 ViewConfiguration 当前入口规则（2026-09-30）：项目工作台入口 `/projects/:id/workbench` 在 live 模式先读取该项目服务端 ViewConfiguration；查询失败时留在错误页并可重试，不猜测默认值。项目已保存的 View `revision>0` 优先；尚未保存、`revision=0` 时使用本设备显式保存的默认工作台偏好，没有该偏好则沿服务端按 Project Type 解析的初始 kind。显式 `/projects/:id/workbench/:kind` 路由不受默认偏好替换。项目设置“连接与权限”页和工作台页都显示独立 View 修订、服务端解析的默认模板版本/SHA-256、`pages` 实际顺序与可见标记。工作台的三个 tab 只供临时浏览；只有项目设置明确选择并提交、或在工作台明确“设为默认”，才 POST `{command_id,expected_revision,kind}`。不提供逐页编辑，保存不改变 Project Type/State、Task/Run 或执行配置。响应不明时在当前浏览器会话冻结原 ID/修订/kind，查原回执；未找到才允许原样重试。409 冲突也核对原回执和最新配置，保留用户选择，用户明确重新确认后才用新修订、新 ID 提交。fixture 入口使用本设备偏好，未保存时沿用通用示例，不写真实配置；组件与路由自检不代表真实桌面或独立验收。

同日 Connections 设置增量：`/projects/:id/connections` 从项目导航进入，读取本项目 Connection 状态、capability、WEB_FETCH `allowed_host`、ManagedResource 根与独立 PermissionPolicy 当前/历史版本；全局 `/connections` 和 `/settings/connections` 当前仍只提供 Project ID 入口，尚未接入新项目列表投影作选择器。三个配置列表和每项策略的版本列表最多读服务端前 100 条且无游标，页面明确显示这一范围；Connection/ManagedResource 的创建与停用另按详情读取核对，不把截断列表当全量。FILE_READ 连接根目录不在读取 DTO 中，详情明确“连接目录未由此接口公开”，受管资源另列且不推断同根；不展示完整 config、secret 或凭据。用户可创建 WEB_FETCH/FILE_READ（或已有 Fake 能力）连接、停用连接，登记/停用受管资源，并明确新建、修订、撤销策略。策略默认选择 DENY；WEB_FETCH 策略提交明确 host 与空 resource_id，FILE_READ/FAKE_WRITE 明确选择 ACTIVE 受管资源 ID，连接创建不自动创建策略或视为授权。策略显示 AUTO/ASK 仅为版本事实，仍须有效连接及目标匹配，主机不同不宣称准入。命令携原 `command_id` 与版本前提，冲突保留输入和原 ID，响应不明冻结其余变更、查询原回执，确认未找到后仅以原 ID/原载荷重试。成功还以服务端最新查询确认状态；停用/撤销后保留历史可见。不调用连接 `/test`，fixture 无真实设置。该组件自检不代表真实 Windows、Provider 或 M05 独立验收。

2026-09-28 Windows 文件写入根身份提示：项目 Connections 的受管资源列表读取服务端 `file_write_identity_bound`，逐项显示“已绑定”或“未绑定”。未绑定时说明若要在 Windows 使用 `FILE_WRITE`，须在 Windows 停用并重新登记目录；这只是登记身份状态，不宣称 Connection、Permission、Task 绑定或动作批准已齐备。字段缺失的旧服务端响应按未绑定显示。定向组件 9/9 通过；确切桌面包的 WebView2 自动化已核对已绑定资源的真实显示并留图，人工操作仍待验。

2026-10-02 root-bound 能力配置入口补齐：连接与策略的 capability 选择器此前只列 `WEB_FETCH`/`FILE_READ`/`FAKE_WRITE`/`FAKE_PUBLIC_READ`，用户因此**无法**为本项目创建 `FILE_WRITE`、`GIT_READ`、`GIT_WRITE` 或 `CLI_RUN` 连接——而 2026-10-01 的文件夹入口对话执行在缺 `FILE_WRITE`/`CLI_RUN` 连接时按服务端 409 拒绝该目录。现按服务端 `rootBoundCaps`（`FILE_READ`/`FILE_WRITE`/`GIT_READ`/`GIT_WRITE`/`CLI_RUN`）展示全部 8 项：这 5 项在创建连接时必填「连接目录」并只提交 `root_path`，`WEB_FETCH` 只提交 `allowed_host`，两项 Fake 能力不提交任何边界；策略侧除 `WEB_FETCH`/`FAKE_PUBLIC_READ` 外都必须显式选择 ACTIVE 受管资源，不出现主机字段。真实连接只绑定一个边界：同时提交 `root_path` 与 `allowed_host`、或把文件系统能力与 `WEB_FETCH` 混在一个连接，由服务端按 422 拒绝，页面原样展示服务端校验而不自行改写。**这只闭合配置入口**：Git/CLI 的动作触发协议（HTTP 路由与协作页 Git 面板）仍按 §14.9 标记为未接入，工具面板的「Git 变更」「交互终端」页签继续只声明限制、不提供可点按钮。定向组件 13/13 与全前端 78 文件 597/597、类型检查通过；未做真实 Windows 与 M06 独立验收。

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

输入区外侧柔和流光作为当前运行的辅助提示，配合上方一行真实阶段说明、“查看进度”和适用的控制入口。它不表示完成百分比，也不能替代状态文字。此节记录设计要求，不代表已实现或通过桌面验收；视觉及动效规则见[设计系统](design-system.md#71-输入区运行光点2026-10-05-选定局部光点)。

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

Assist 对话的停止入口在输入栏主按钮，不在消息体内：位置与配色不变，有在途回复时把字形换成圆角方块并支持 `Esc Esc`。`PENDING` 表示「已提交、Worker 尚未领取」而非排队位置，只有存在 `RUNNING` 时其余 `PENDING` 才渲染成队列面板；空闲时发出的那一条不标状态词，也不显示成等待队列（2026-10-21 用户指令删除「等待生成」字样）——否则空闲发送会被误读成被其他任务挡住；它的在途呈现是正文前的三点、meta 行的耗时与输入栏停止键。队列项的逐条取消留在队列面板，且队列面板在 `?skill=assist` 嵌入形态下同样渲染。上游 deepseek-harness 的 Queue / Steer（运行中把发送变成排队或插话）不引入，本项目没有对应能力，不展示这类承诺。呈现细节见[设计系统](design-system.md)。

**提交窗口的配色与焦点不跟随瞬时 disabled（DEV-0110，2026-10-22）。** 点发送到 202 回执落地之间，正文 textarea 仍按既有规则 disabled，但发送键与输入卡边框停在实际动作的主色档：键与卡都用 `data-busy="true"` 保持 `--relay-color-action-primary`，不经过全局禁用灰档的快过渡；发送键与停止键按字形使用不同元素身份，状态切换不从一档键色渐变到另一档。回执到达后，若焦点仍落在 body 或输入卡内，接回正文，避免卡边框停在未聚焦灰档。队列面板属于同一输入列，底色取 `--relay-color-selection-bg`／`--relay-color-selection-hover` 两档与既有间距、字号、控件高 token，与白底输入卡分层但不另立色板。

实现验收应覆盖：工具阶段无文本时仍正确反馈；切换 Task/Run 后旧事件不污染输入区；等待审批停止流动；停止请求与最终结果分开；断线重连与 UNKNOWN 核对；生成完成但待验收；动效关闭及系统减少动态效果时状态仍可读；键盘焦点和草稿编辑不受影响。上述场景尚未因本文补充而执行。

## 7. 视觉与可访问性基线

依据原始参考及延展图采用暖纸色浅色基线、墨绿操作和宋体标题，深色主题未定义。颜色、字号、间距、圆角、布局断点及组件状态统一见[设计系统](design-system.md)和 [tokens](design-tokens.json)；此处不另定数值。表格允许局部横向滚动，详情不靠悬浮才能看见，不单靠颜色传达状态。

表单有可见 label、字段错误、焦点回落；弹窗具备焦点管理和 Esc 行为；危险/外部动作按钮含具体动词与目标。Loading 有范围：读取、提交中、核对中、后台运行分开。无数据给出下一步；不可用功能说明缺哪个配置，不产生无效点击。

2026-09-28 UI 联通精修增量（见[开发记录](../development/ui-live-integration-2026-09-28.md)）：今日页采用日期眉线 + 中文 display 主标题（「把今天留给重要的事」）+ 焦点卡，查询日期/时区与刷新降为紧凑工具行；任务行的延后与计划表单收进「延后与计划」details，排序依据、证据与允许操作维持既有 details；状态与修订等资格信息保留原文案语义。动态页行显示服务端摘要、本地时间与可导航引用，事件类型有中文映射（未知类型回退原代码），Activity ID / 原 command_id 收进「追溯详情」details，不再挤占标题与引用。任务详情侧栏「三个独立事实」标题改为「当前状态」，三字段仍分列显示；验收依据面板预期产物以条目 chips 呈现，CheckPlan 摘要用等宽 hash 样式（`hash-code`），长 ID 允许换行。顶栏数据来源按钮增加状态圆点，live 为墨绿点、示例为灰点；文字标签仍是主要指示，不单靠颜色。以上均只消费既有 token。

设置页当前实现（2026-09-30）：`/settings` 的基本设置提供本设备时区与默认工作台显示偏好，明确保存到 `localStorage`，不写 Project、ViewConfiguration 或服务配置。未保存的默认工作台继续按第 3 节入口规则解析；已保存项目 View 优先，显式 kind 路由不变。时区目前只影响本设备展示（顶栏日期、消息时间、完成凭据提交时间、Review 请求时间、资料保存时间与 Run 步骤起止时间），不改变 Today 查询时区、稍后处理日期或业务时间事实。外观仅浅色，未实现的主题选择禁用并说明原因；存储失败就地反馈，不能显示已保存。

模型端口卡仍只读 `GET /model-port`：Mock 端口 / 真实 Provider / 配置残缺三种状态用文字表达，Mock 状态明确说明“这是当前阶段既定门槛，不是故障”；页面只显示模型名与端点地址，**不读取、不显示、不修改任何 API 密钥**，模型配置仍归服务实例环境变量，不提供服务配置写命令。原有 Pack 固定清单（`pack-catalog`）与“打开连接设置”入口保留；示例模式显示“没有真实服务实例状态”并保留 Pack 清单预览，读取失败就地显示并可重读。分组导航定位当前区域或打开原连接入口；该页不引入新 token 与授权能力。

同日今日页截图专项整改（用户看过运行截图后反馈"粗糙"，按[专项提示词](../../prompts/ui-live-integration-polish.md)第 4 节执行，前后截图见[今日页专项证据](../testing/evidence/ui-live-integration-2026-09-28/today-polish/)）：今日主标题改用 `compactPage`（角色规则同步 design-system 第 4 节）；眉线只保留查询日期与星期，选择版本收进「安排说明」；服务端判定长句改为一句用户语言加「安排说明」details；查询工具条组成日期（统一控件样式）· 当前时区 · 调整时区（展开为独立编辑行，错误贴近字段，取消不改已生效时区）· 刷新，首次加载显示读取中且不显示"0 个任务"。任务行：项目列显示真实项目标题（按 Project 单读，读取失败回退"所属项目"），状态/优先级/截止/置顶/延后收纳为一行元信息（未设置项不显示），资格文案按真实状态区分「可开始 / 可继续 / 待处理」，动作文案改为置顶/取消置顶、设为今日焦点、取消延后、打开任务；原始 reason_codes/证据/允许操作保留在「排序依据与允许操作」details。今日焦点改为紧凑单列：未选显示一句提示（有候选引导从任务中选择），已选以任务名为视觉中心并显示可核实的项目与状态，焦点不在当前查询时如实说明且不显示可执行绿勾，时区与生效细节收进「焦点详情」。全空改为单一空态（当前日期下没有可安排的任务 + 新建任务/查看全部任务真实入口），零数量分组收为一行提示，不再重复铺满整页。live 模式移除底部"已连接本机 API · 写入真实 PostgreSQL"重复提示（连接详情保留该说明），示例模式的底部示例标识保留。共享层：文本输入/下拉继承 UI 字体并统一最低几何（高度/边框/圆角），`html` 增加 scroll-padding-top 供锚点/焦点滚动避开 sticky 顶栏（桌面含标题栏）。文案仅调整展示语言，API 字段、命令与状态枚举不变。

2026-09-29 今日页右判断栏接续（对照 [2026-09-28 完整窗口图](mockups/2026-09-28/README.md) 与 today.png 内容原图实现；live 截图见 [今日页证据](../testing/evidence/ui-live-integration-2026-09-28/page-prompts/)）：视口 ≥80rem 时主列右侧常驻右判断栏（80–90rem 窄栏 20rem，≥90rem 标准栏 25.5rem，细分隔线分组，断点按 design-system 第 5 节），内容为「等待你的判断」——live 模式查询 `GET /reviews?status=OPEN` 显示真实待审条数与类型中文标签，读取失败或零请求如实说明，不伪造计数——加「推荐依据」三条机制说明与「稍后处理的任务仍保留在任务列表」注记；窄于 80rem 时右栏不常驻，保留既有「待审与人工判断」横幅入口（≥80rem 隐藏，入口文案与计数边界不变）。今日焦点卡升级：标题行并列「已置顶」徽标（仅焦点任务真实置顶时显示），焦点任务名为宋体 compactPage 视觉中心，元信息改细线分隔（状态/优先级/截止，未设置项不显示），焦点任务在可开始组时主操作为「开始任务 / 继续任务」（按任务状态措辞）链至任务详情，否则保留「打开任务」文字链接；「清除今日焦点」命令不变。任务行资格文案改用 status-chip（success/neutral）并右置，与「打开任务」同一簇；置顶/设为今日焦点/取消延后命令按钮保留在原动作行且首个按钮顺序不变。眉线日期改为中文长格式。「延后与计划」「排序依据与允许操作」「安排说明」等展开入口由动作绿改为次要文字色、hover 下划线。Review 类型中文标签收进 `lib/labels.ts`（`reviewKindLabels`）供待审中心与今日页共用。命令、API 字段与分组语义不变。

**2026-10-21 眉线日期按所选日历日期显示（DEV-0097，源码与组件回归已完成，未做真实桌面复验）。** 眉线的中文长日期与星期直接由查询参数里的 `YYYY-MM-DD` 按 UTC 锚定格式化，不再先拼成设备本地正午再换算到查询时区。此前设备在上海、查询时区为洛杉矶时，10 月 21 日会显示成 10 月 20 日星期二；现在页头始终等于所选日历日期，切日期、切时区和刷新后一致。服务端查询参数、返回事实与任务分组不变。


2026-09-29 效果图一比一对照接续（全页 fixture 截图见 [对照证据](../testing/evidence/replica-2026-09-29/)）：项目列表页按 projects.png 对齐——右栏增加「项目摘要」栏标题与宋体项目名（原 h2 拆分为栏标题 + 名称两级），「当前项目」kicker 移除；进行中/已归档页签与搜索框合并为同一行（分隔线由行承载，窄窗换行）；列表行尾增加「›」打开指示（仅交互行，表头不显示）；「新建项目」主按钮按图改为纯文字。侧栏待审计数徽标改为墨绿底白字（对照导航徽标）。任务详情、三工作台、知识与动态的空态为 fixture 模式如实规则（不生成虚构资料/记录），live 结构已在此前验收中覆盖；效果图右栏中的任务标签、计划完成等字段当前契约未定义，不虚构实现。逐页剩余偏差以真实契约字段与 token 数值为准，示例文案与示例日期不复制为产品事实。

同日 live 状态页对照接续（真实命令构造状态，截图见 [live 对照证据](../testing/evidence/replica-2026-09-29/live/)）：运行详情页改为「主列 + 右栏」结构——新增「运行信息」栏（运行编号/运行状态/任务状态/当前执行者/等待原因，均引用既有字段），「控制请求」与「资源与租约」面板移入右栏，主列保留暂停摘要、Gateway 动作历史、步骤时间线与 Trace；纯布局移动，控制命令与文案不变。完成凭据页同样拆为「主列 + 提交事实右栏」。产物保存的版本冲突提示由红色 action-error 改为琥珀 warning-callout（保留服务端版本/提交基线的确切数字与"草稿不会被覆盖"语义），并附「查看版本历史与差异」入口。live 对照路径：知识登记→阅读器（UI-15）、委托→运行控制→真实暂停（UI-18/19）、开始→逐项勾选验收→完成→完成凭据（UI-27）、UI 保存 v1→并发写手推进两版→UI 保存吃 409（UI-26）。执行结果未确认（UI-20）与 Git 动作批准（UI-22）无法在自然业务流程中构造（分别需 debug 进程强杀与 Gateway Git 审批配置），按不造假原则不在本轮截图比对；两者界面实现在 M03–M06 模块验收中覆盖。工作区另存在并行会话的未提交 Agent 聊天切片（未跟踪文件），本轮未触碰。

同日侧栏拖拽调宽接续：视口 ≥64rem 时侧栏右缘分隔条可拖拽调整宽度（10–20rem，双击复位），也支持键盘左右方向键按 1rem 步进并带 `role="separator"` 值语义；宽度为纯展示偏好，仅保存在 `localStorage`（`relay.workbench.sidebarWidthPx`），不承载业务事实。用户宽度经 `--relay-sidebar-user-width` 只注入 `.app-frame` 基础列宽，≤63.9375rem 断点仍用固定 compactWidth 显式列宽，收起/抽屉行为不变；分隔条在窄断点隐藏。拖拽用指针捕获，不改变导航焦点序（Tab 顺序为导航 → 内容 → 分隔条）。

拖拽条外观抽为全局 `.drag-separator`，侧栏手柄与协作页对话/成果分隔条共用，样式规则见[设计系统第 6 节](design-system.md#6-可复用组件规则)。此前协作分隔条用 `selection.bg` 填充、hover 时整块变色，现与侧栏一致改为中轴细线、hover/focus/dragging 才显形；拖拽行为、键盘步进、双击复位和 `role="separator"` 值语义均未变，未新增 token。2026-10-17 接续：线条整体调浅为 `border.control` 55% 混合色，拖拽期间保持与悬停同色同宽（即使指针移出命中区），详见[设计系统 §6.3](design-system.md#63-全局滚动条与拖拽分隔条2026-10-17)。

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

### 10.2 跨成果候选组与组合检查单（N02 首片，2026-10-02 开发自检）

入口挂在既有产物来源页的手动检查面板内，不新增路由，也不改动第 10.1 节的锁定与影响规则。契约见 [HTTP 契约第 10.52 节](../api/http-command-contract.md#1052-n02-跨成果候选组与组合检查单2026-10-02开发自检)。

- **候选组只登记范围**：用户在已完成（或仍在分析）的检查结果里勾选若干条**已登记直接引用**目标后保存成组。建组不调用模型、不产生候选正文、不推进任何 revision；未登记范围不能靠勾选混入。AI 推测项可以进组并带 `speculative` 标记，但**进组不等于可生成候选**：确认门槛仍在第 10.1 节要求的那一步，由候选生成命令强制，未确认的推测项在那里被拒绝。
- **组不承诺原子完成**：面板逐项显示「已应用 / 有候选 / 尚无候选 / 候选已失效 / 来源当时不可用」与总数。部分成功按项如实呈现，不显示整组成功或失败；一项被拒时提示其它项仍可独立处理。
- **逐项应用仍是原命令**：每项的应用继续走既有 `ApplyArtifactImpactCandidate`，组只旁读回执。组本身不产生业务写，因此保存组后 Task 与 Artifact 修订不变。
- **失效可见**：来源成果修订变化或变化后版本不再最新时，组标为「只能作为历史范围查看」，且同一检查不能再建新组；目标出现新版本的单项显示「目标已出现新版本」，该项的旧候选不能应用。
- **组合检查单不是整体结论**：用户可对「来源 after 版本 ＋ 已应用项的确切版本」保存一张覆盖快照。快照逐项记录当时的正文可读性、是否为当前版本、以及该确切版本在当前验收修订下的**单项**验证会话，并列出缺口。整体结论恒为「无」，页面固定显示这不是整体验收结论；单项 PASS 不相加，跨 Task 的版本集合不能保存。后续任何验收变化只会让快照标记为过期，不改写历史记录。
- **范围缺口不隐藏**：组的「未分析范围」沿用检查本身的范围声明（未登记引用、间接下游、超上限或截断的正文），不能因为成组而显得检查已完整。

本片未覆盖：候选间依赖联动与不完整选择的拒绝、组级回滚、外部格式来源、真实 Windows 人工差异审阅与 PV08 体验记录。组件自检与真实 PG/HTTP 集成属开发自检，不等于独立验收或 Windows 验收。

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

**任务栏角标（2026-10-19 已实现，真机未验收）**：Windows 任务栏应用图标叠加显示当前需人工介入数量，与顶栏铃铛读同一份事项，不另建第二套计数事实源。数量随每次轮询结果变化；轮询停止（切回示例数据、退出应用）时撤掉角标，不留一个过期数字。超过 99 项统一显示 `99+`。角标只是第 2 条「应用内始终保留未解决事项」在任务栏上的副本，不新增提醒语义：出现不代表来了新事项，消失也不代表事项已处理，第 3 条「同一事项只提醒一次」与第 5 条「通知不等于审批或处理完成」同样适用于它。角标不进入待处理列表的事实源，也不改变任何处理入口；宿主外观见[设计系统第 1 节](design-system.md#1-视觉依据与提取边界)。

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

### 12.4 项目知识导读：N03 形态（2026-10-02，规划已确认，前后端均已接入）

用户确认 N03 首轮采用项目知识导读，按架构约定、重要决定、使用说明和参考资料组织来源入口。本节为规划增量，后端与前端均已接入；真实 Windows 阅读体验仍未验证。

先提供人工编排的集合与来源导航，每项链接既有对象和可核对版本，不复制第二份正文或当前项目状态。历史固定引用与跟随当前版本的导航须可辨认；用于 AI 输入时重新落到确切授权版本。空分组或失权/缺失来源如实显示，不生成虚构说明。

用户主动请求时可提出整理/归类候选，逐项接受仍走原知识与确认命令；相似内容只提示，不自动合并删除。源正文更新提示不自动覆盖已整理知识、Rule 或 Decision。开发经验卡、新文件格式与自动沉淀不因首形态确认一并进入实施范围。

2026-10-02 后端首片与前端接入均已实现（[HTTP 契约第 10.53 节](../api/http-command-contract.md#1053-n03-项目知识导读编排与整理候选2026-10-02开发自检)、[物理设计第 58 节](../database/physical-design-postgresql.md#58-00520053-n03-项目知识导读与整理候选2026-10-02)）。前端落在两处，交互规则按下述执行：

- **导读编排是替换式保存**：编辑后整份清单按 `revision` CAS 提交，不是逐条追加。旧修订 409，用户须重新确认后按新修订提交。
- **`PINNED` 与 `CURRENT` 必须让人能分辨**：固定引用读作「仍按钉住的那一版阅读」，跟随当前读作「已解析到当前版本」。固定版本不存在时显示不可用，**不静默换成当前版本**。
- **逐项给出可用性而非统一结论**：已归档、已被替代、已出现新版本、来源失权或缺失各自单独表达，不合并成一句「部分不可用」。
- **整理候选只提示**：相似条目附理由列出，是否归入既有条目或新建由用户逐项决定；页面不得提供「一键合并」「自动去重」。
- **接受候选产生的是新知识版本**，仍需按原验证与验收流程处理；页面不得把它显示成已验收或已完成。
- 候选失效（来源成果已变化、已接受、已拒绝）时禁用接受入口并说明原因，不提供换身份重试。

本片未覆盖：导读的多集合形态、按分类自动归位、相似内容的语义判定（当前只按标题字面，且前缀阈值是启发式而非相似度结论）、真实 Windows 阅读验证。

2026-10-02 前端接入实况：

- **旧版客户端聚合导读已被替换**。原 M06 的 `ProjectKnowledgeGuide` 在客户端拼接项目目标、决定、规则与资料并自行推导顺序，与服务端编排同名且重复；本轮按确认结论整体替换为服务端编排视图，不再有第二套「导读」状态。项目目标因此不再出现在导读内（N03 四类引用目标中没有 GOAL），流程说明占位文案一并移除。
- **位置**：导读在知识页 `项目知识导读` 开关内（`projects/:id/knowledge`）；整理候选在成果版本谱系页（`artifact-versions/:id/lineage`）底部，用户正拿着该成果版本时才发起，符合「只由用户主动请求产生」。
- **条目**：按服务端顺序渲染，每项显示引用类型、人工说明（`label`）与被引用对象标题、解析到的版本号。`PINNED` 标「已钉住」，`CURRENT` 不加标记；`STALE`/`ARCHIVED`/`SUPERSEDED`/`CROSS_SCOPE`/`MISSING` 各自单独提示，**不合并成一句「部分不可用」**，也不静默换成当前版本。
- **编辑**：人工说明、上移下移、移除、`PINNED` 勾选与添加/全部加入都只改本地草稿，**不自动写入**；整份替换式保存按 `revision` CAS 提交，409 时明确提示「本次未保存」并重新读取，不假装成功。未保存时显示提示，不注册离开拦截。
- **`PINNED` 只在条目已解析出版本时出现**：新建条目先以 `CURRENT` 保存一次，之后才能钉住确切版本——因为客户端只有版本号摘要，没有版本 ID。
- **候选**：只提供「接受为知识」与「拒绝」，没有一键合并或自动去重；相似条目附理由列出；来源成果已变化、已接受、已拒绝时不再提供接受入口并说明原因；接受后按新知识处理，**不显示成已验收或已完成**。任务未关联项目时说明原因且不发请求。
- **可达性缺口**：`ARTIFACT_VERSION` 条目可从成果版本选择器加入，但候选流程本身不产出导读条目——接受候选只创建知识。

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

### 13.1 反馈通道的四类划分（2026-10-17）

用户指令：「像这些 toast 不要影响页面布局」——临时反馈不得改变页面几何。按「会不会改写业务事实、需不需要用户处理、有没有动作、停留多久」把反馈分成四类，同一条事实只走其中一类。视觉与实现规则见[设计系统 §6.4](design-system.md#64-浮层反馈toastsnackbarnotice2026-10-17)。

| 类别 | 触发 | 停留 | 动作 | 承载 |
|---|---|---|---|---|
| Toast | 一次操作已确认完成的短回执（已保存、已撤回、已复制） | 自动消失（`motion.duration.toast`） | 无 | 视口顶部浮层栈，不进文档流 |
| Snackbar | 可反悔或可重试的一次结果（撤销、重新读取、查看） | 自动消失且更长（`motion.duration.snackbar`）；悬停与键盘聚焦期间暂停计时 | 恰好一个 | 同上 |
| Tooltip | 名称、快捷键、目标预览这类补充说明 | 悬停或聚焦期间 | 无 | 触发点旁；必要原因不得只藏在这里（§6.1） |
| Notification | 需要用户处理才能继续的事实 | 停留到处理，不因计时器消失 | 指向处理入口 | 两种承载：当前窗口内的停留卡片，与跨页、重开仍在的人工待处理列表＋Windows 通知（§11.5） |

划分判据，逐条按顺序问：

1. **这条反馈会不会改写业务事实。** 会——保存结果、验收冲突、UNKNOWN 回执——不进浮层，按 §6.1「失败/冲突」在原对象附近持续表达，浮层最多作为指向它的入口。对话页的「命令结果待核对」（带原 command_id 与查询、原命令重试两个动作）因此留在正文：它是未决命令，不是提示。**唯一的例外写在 [§13.2](#132-危险操作的两条通道2026-10-18)**：已成功落库且有反向命令的单对象危险操作，浮层承载的不是结果而是反悔入口。
2. **需不需要用户处理才能继续。** 需要——Notification；不需要——按「有没有动作」分 Snackbar 与 Toast。
3. **只是解释已有内容** ——Tooltip，不新增信息、不承载判断。
4. **辅助读取失败**（模型调用状态、清单、正文预览读不到）不改写业务事实，走 Snackbar 并保留原重读入口；不把它写成任务失败，不因此停止执行，也不静默改用旧快照继续显示。

浮层栈不承担历史：刷新、切页或计时结束即消失，需要留存的判断归 Review，需要跨页处理的归人工待处理列表。Esc 不用于关闭浮层条目——该键已归「连按两次停止生成」与对话框关闭，条目由计时器或卡片上的关闭按钮收走。浮层不遮挡输入：栈只在卡片上收指针事件；位置按同日第二轮用户指令「提示要在屏幕的正上方」取**屏幕顶部居中**，并落在桌面标题带之下——标题带上的空白是窗口拖动命中区，右缘还有最小化/最大化/关闭，浮层压上去等于在 4–8 秒里吃掉宿主操作；底部两角则分别是输入卡发送键与近期工作栏的行。

本轮迁移范围＝对话页输入卡外的三条（模型调用状态读取失败、命令回执、动作失败）；其余页面的 `receipt-message`／`action-error` 就地文案仍按原规则保留，逐页迁移时按上面四问归类，不整体替换。同日按 §13.2 追加第四条：会话归档成功的反悔入口。

### 13.2 危险操作的两条通道（2026-10-18）

用户指令：「危险操作像是会话归档删除，都要有一个 toast 可以让用户撤销动作」，随后两轮澄清裁定四条——撤销条**替代**确认框，不叠加二次拦截；范围覆盖会话、项目、连接停用、资料归档等全部危险操作；会话新增**物理删除**且不可撤销；不可逆族「一个提示框就可以，删除后不可撤销」。

判据只有一问：**这个操作有没有反向命令。**

| | 有反向命令 | 没有反向命令 |
|---|---|---|
| 触发 | 单击即发、立即落库，**不再弹确认框** | `AppDialog` 事前确认，初始焦点压到「取消」 |
| 反馈 | Snackbar「已×·撤销」，停留 `motion.duration.snackbar`，悬停与键盘聚焦暂停计时 | 结果按 §6.1 就地表达，浮层**不给撤销条** |
| 文案义务 | 说清改写了什么，不说「已永久删除」这类做不到的话 | 逐字写明不可恢复与连带销毁物 |

四条硬约束：

1. **撤销一律是前向补偿命令**，绑定**新的** `command_id`，`expected_revision` 取正向命令回执里推进后的那个修订，不读左栏那份可能还没刷新的行；这不是数据库回滚，沿用[领域模型](../architecture/domain-model.md)「撤回绑定原请求，不使用数据库或全项目快照回滚」的口径。
2. **回执不明绝不提供撤销。** 正向命令抛 `RelayTransportError` 时动作是否生效都未确定，按[恢复与提交](../../contracts/04-recovery-and-commit.md)不能承诺撤回已产生的副作用，因此那种情况下不给撤销条，保持就地「无法核对」。
3. **撤销自身失败要留着说，不能悄悄消失。** 撞 `REVISION_CONFLICT` 或网络错误时，同一条浮层升级为停留到关闭的 Notice，文案指向仍然可用的永久入口（会话即「已归档」分区里的「重开这段讨论」），不写成「错过即不可逆」。
4. **撤销不完全的地方必须写明。** 补偿命令只回滚它自己那一列：归档/停用类会把状态列改回去，但正向操作顺带产生的前向事实（如资料归档写入的待核对候选、只增不减的规则与上下文修订）不随之收回。

**当前落地范围**：会话归档已按本规则接撤销条——近期工作栏会话行的「归档」单击即发，撤销再发一条已有的「重开这段讨论」命令；反向命令四层早已齐全，本切片只补了 UI 入口。项目归档已接撤销条并**去掉原有确认框**：抽屉里的「归档项目」单击即发，浮层给「已归档这个项目 · 撤销」，撤销发 `UnarchiveProject` 把 `archived_at` 写回 NULL；撤销失败升级为 Notice 并指向「已归档」范围。会话物理删除已按本规则落地（[ADR-027](../decisions/ADR-027-session-physical-delete.md)）：它不是有反向命令的操作，因此走「没有反向命令」那一列——确认框、无撤销条、不可恢复。**目标取消（2026-10-23，禅道 #153）**同样走「没有反向命令」那一列：服务端 `CANCELLED` 属于 `TERMINAL`，没有反向命令，目标卡的「取消目标…」先弹 `AppDialog`（标题「取消这个目标？」，正文写明不再继续推进、已发生的修改与外部操作不会回滚且无法恢复，并把「暂停」作为可恢复替代；初始焦点压「再想想」，确认键用 danger），确认后才发原 `controlGoal(cancel)`，不给撤销条。资料归档与记忆/规则停用已于 2026-10-19 接上后端反向命令（[HTTP §10.97](../api/http-command-contract.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现)）并在资料页接线：详情里的「归档资料 / 停用记忆 / 停用规则」单击即发，成功回执核对通过后弹「已归档资料 / 已停用记忆 / 已停用规则 · 撤销」；撤销用新 `command_id` 与正向回执修订，回执不明时不给撤销条、只留就地原命令核对。**永久恢复入口不依赖浮层**：资料、记忆、规则三类列表本来就返回非活动项，选中的对象详情在阅读区末尾给出「恢复这条资料 / 记忆 / 规则」，用**当次读回**的对象修订发同一条反向命令，冲突先重读事实再让人重新决定；归档 Project 下沿用同一写入守卫（按钮禁用并给出原因）。三处文案都写明补偿只回滚状态列：正文版本与确认记录、Memory 有效期、归档产生的待核对候选、已发生的规则/上下文修订与旧 Run 效果都不随撤销回退。连接与资源停用的反向命令，以及不可逆族（权限策略撤销、清空学习记录、请求取消任务）的统一确认框，仍是**规则已定、代码未落地**。权限策略撤销按[验证与批准](../../contracts/03-verification-and-approval.md)「批准不能覆盖已撤销的权限」明确**不开放撤销**，即使它的落库形状看起来是可逆的 UPDATE。

### 13.3 长期记忆状态与筛选（2026-10-19，已确认、前端已接）

用户选择本轮先完善长期记忆状态与筛选，继续保留人工明确确认，不自动从聊天生成记忆。后端契约归 [HTTP §10.98](../api/http-command-contract.md#1098-长期记忆有效状态与筛选2026-10-19-后端接续)，责任归[信息与计划 §1.3](../architecture/information-planning.md#13-长期记忆的有效状态2026-10-19)。

现有资料页 Memory 页签增加「全部 / 有效 / 已过期 / 已停用」筛选，默认全部，与现有 Workspace/Project 范围组合，由服务端查询裁决。列表与详情用 effective_status 展示：ACTIVE 为「有效」、EXPIRED 为「已过期」、RETIRED 为「已停用」。保留原 status 决定停用/恢复操作，不把派生 EXPIRED 当成新的可写状态；已停用且到期的记忆归「已停用」，恢复后若仍到期则展示「已过期」。

明确显示原确认信息与有效期。续期/取消到期走既有修订与明确确认流程，产生新版本；不能把恢复按钮当成续期。历史版本保留当时内容，不附加伪造的当前状态。「有效」仅描述生命周期和有效期，不能声称一定供 Agent 使用；权限、范围和 Context 选择仍独立核对。

切换筛选、Project、Workspace 时丢弃迟到响应，加载/错误/无匹配与首次空态分开表达；GET 和筛选不写命令、不改用户数据。旧服务端缺 effective_status 时显示「状态待核对」并保留原状态/有效期，不用浏览器时钟或 status=ACTIVE 推断有效。

前端接线（2026-10-19）：Memory DTO/解析器增加只读 `effectiveStatus`，已知枚举严格解析，缺字段落为 null 且显式 null/未知枚举按契约错误失败；`getMemories` 增加可选有效状态参数，默认 ALL 不发送查询参数以保持旧请求与旧服务端兼容。筛选控件放在记忆列表内（共享 `.segmented` 四档），由真实 GET 取得结果，切换时清空旧行与选中项、由读取版本号丢弃迟到响应。**2026-10-21（DEV-0093）**：左列在 1162×782 只有 208px，列表内边距后实宽 158px，四枚 `flex:1` 按钮各约 40px，「已过期」「已停用」被拆成三行并越出固定高度。只在 `.knowledge-memory-filter` 内把同一组按钮改为网格：默认 2×2，容器内宽达到 18rem 后转为 4 列；标签 `white-space: nowrap`、按钮恢复独立圆角并留 4px 节距，选中态、字符尺寸、四项顺序与键盘切换不变，其它 `.segmented` 用法不受影响。列表与详情按 effectiveStatus 显示「有效 / 已过期 / 已停用 / 状态待核对」，同时保留原确认信息、有效期与持久状态；已停用且到期仍显示「已停用」。命令成功后按当前筛选定向重读，对象不再匹配时从列表移除并把详情落到剩余项；恢复回执只说「已恢复持久状态」，是否仍到期由重读后的有效状态决定。过期但未停用的记忆仍可修订与停用，续期/取消到期从详情进入既有修订流程并明确确认，不静默延长。真实浏览器与 Windows 窗口验证尚未执行，成绩只归统一验收表。

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

2026-10-02 配置入口补齐（不改协议）：上表「Git 变更」「交互终端」仍未接入的结论不变，但此前用户**无法**为本项目创建 `GIT_READ`/`GIT_WRITE`/`CLI_RUN`/`FILE_WRITE` 连接，因此连「先配好能力、等协议接入」的准备工作也做不到。连接与权限页现按服务端 `rootBoundCaps` 展示全部 8 项 capability，5 项 root-bound 能力必填「连接目录」，策略侧除 `WEB_FETCH`/`FAKE_PUBLIC_READ` 外必须选 ACTIVE 受管资源。Git 动作本身必须经 Gateway `prepareGatewayAction`，而当时该入口只接受 `RUN` 与 `USER_IMPORT` 两种来源且对非 RUN 只放行 `FAKE_PUBLIC_READ`/`WEB_FETCH`，因此**人工触发的 Git 只读查询需要新增一种 Gateway 来源与相应 migration**，不是加一个按钮或一条 SELECT 路由。

2026-10-05 服务端来源已补齐：`POST /projects/{project_id}/managed-resources/{resource_id}/git-read`（`action_type` 取 `GIT_STATUS` / `GIT_DIFF`）经 `prepareGatewayAction` 的 `USER_ACTION` origin，只接受已登记 `ACTIVE` 受管根、`realpath` 归一后的目录与匹配的 `GIT_READ` Permission，契约见[命令契约 §10.57](../api/http-command-contract.md#1057-人工触发的受管-git-只读2026-10-05-源码实现)。权限侧新增**可选** `action_type`，缺省仍按 capability 默认动作——因此读 diff 需要在策略里显式放行 `GIT_DIFF`，只配了 `GIT_STATUS` 的项目调 diff 端点会 409（正确的失败关闭，不是缺陷）。

**「Git 变更」页签的占位文案本轮仍保留**：服务端入口已可用，但客户端接入不在 2026-10-05 那一轮范围内。替换占位前必须让面板消费真实端点，并区分三态——「已读到且干净」「读取失败（含非 Git 目录，结算为 `FAILED` 且 `failure_kind='GIT_REPOSITORY_UNAVAILABLE'`，响应不含 `staged`/`unstaged`/`untracked` 任何一项）」「结果被截断」。读取失败不得显示为干净，不得用静态假数据完成面板。人工触发的目录浏览（`FILE_QUERY`）服务端同样未开放。

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

### 15.1 隔日打开目录的事实接续卡（2026-10-02，已确认规划）

2026-10-09 接续：本节以下保留 2026-10-02 的接续点比较切片。日常返回卡的默认基线与获授权轻量核对由[§18.9](#189-自然语言状态维护与接续摘要)接续：默认相对上次实际查看摘要的状态比较，仍可主动选择手动接续点。新规则尚未实施，不扩大第 15 节已实现的捕获集合或提升其成绩；下述“不调用模型/不重设基线”继续限定原只读比较入口与手动接续点，不能解释为新日常核对必须保持纯只读。

用户确认后续接续体验采用：重新打开同一开发目录后，在原对话顶部自动显示紧凑的事实接续卡，再继续原对话。本节是已确认的呈现增量，尚未实施或验收，不改写第 15 节既有首片成绩。

- 默认使用最近一次明确保存、当前有权读取的项目接续点，可切换其他有效基线；显示基线名称与捕获时点、原记录阶段与下一步、此后可核对的变化、当前未决事项及相关入口。只消费现有事实与比较结果，不生成模型解读。
- 每项变化能查到确切对象/版本来源。现有接续点未纳入 Decision/Rule/Knowledge/Memory，本卡不将这些对象包装为已比较范围，也不将任务或成果差异冒充代码文件全量差异。
- 没有有效基线时显示当前事实和保存接续点入口，不虚构“上次以来”的变化；局部读取失败、失权、缺失来源和比较范围缺口在对应内容中说明，不能推断为没有变化。
- 打开目录、显示卡片或继续输入不自动重设基线、创建 Task、调用模型、批准动作或恢复执行。原草稿、会话、未决命令与审批/控制入口继续沿用既有 Owner。

文件夹与会话关联继续遵守[第 18 节](#18-文件夹入口与对话直接执行)；本增量在后续获授权切片中复用已有 N01 保存/查看/比较入口，不重做首片或引入第二套项目状态。

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
- 对话与成果默认同时查看，可拖动分隔条、左右方向键调整和双击复位（外观用全局 `.drag-separator`，见[第 7 节](#7-视觉与可访问性基线)）；另有专注对话/成果模式。`CollaborationLayoutPreferences` 只保存展示模式和对话比例，独立本设备键 `relay.workbench.collaborationLayoutPreferences`、格式版本 1。无效、不可读或不可写存储回退默认；不保存任务、权限、连接或命令身份。默认比例消费唯一 token，交互范围由展示偏好模块限定。
- 模式、窄区与成果页签切换通过 `hidden/CSS` 保留原 Assist、Review、Run 控制和工具子树，不复制或卸载命令 Owner。草稿、组合输入、未决原命令及恢复核对规则沿用既有入口；跨任务/会话仍走原草稿保护。
- 消息先显示正文；正文之后紧跟「已读取 N 份资料 · 生成候选完成」来源条与文档候选卡，让同一条回复按「说了什么 → 读了什么 → 产出什么」的阅读顺序自答。来源条与候选卡只呈现服务端已有事实：候选正文不可读时只显示身份与状态，不用本地缓存或推断补出内容；候选卡只是指引，**不含接受入口**，正文与接受操作仍在提案区核对。Skill 和提议先显示摘要、状态与「查看提议与接受操作」，比较、来源和摘要值可展开。新待确认提议有状态提示，接受仍由原提案组件核对基线、执行权及允许操作。来源检索与消息发送使用独立表单，不能互相触发提交。
- 判断条（`JudgmentBar`）是文档纸面**之外**的一张独立圆角卡：`radius.control` 四角圆角、整圈 `separator` 边框，warning 变体把边框整体换成 `status.warning.text`。它不能贴在纸面内层——那会盖住正文最后一行，读起来像纸面的延伸而不是一块可操作区域。
- 需要圆角的独立块各自声明圆角。右栏内容区 `.collab-side-body` 用 `bg.canvas`，与页面同色且无边框，在它上面加 `border-radius` 不产生任何可见边界，因此不加；圆角只给真正有边界的块（判断条、文档纸面、输入器卡）。
- 输入器固定在对话底部，选源、意图和发送规则保留。底栏（资料 N、选项、缓存命中率、上下文占用圆环、发送键）全部在圆角卡内，卡内不再套第二个输入框。发送键只留图标，可访问名称与 `title` 保留原动作动词（讨论/请求文档候选/请求任务提案），不再以四字标签占宽度。「Enter 发送，Shift+Enter 换行」提示由命中率与圆环取代，键盘规则不变。命中率取最近一次 AI 回复的 `cache_read_tokens / input_tokens`；圆环取同一次回复的 `input_tokens` 与 `/model-port` 的 `max_call_tokens` 之比，占用 ≥80% 改用 warning 色。四种状态必须可区分：尚无模型调用、Provider 未上报（命中率文字整格不渲染，既不写「缓存未采集」也不把 `null` 画成 `0%`，只保留右侧占用圆环）、有真实读数、读不到上限（显示「占用不可算」，圆环不画弧）。两个百分比都不把未满的比例四舍五入成 `100%`：整数位进位到 100 而实际未满时追加小数位（`996/1000` 显示 `99.6%`），最多两位；`value ≥ limit` 才显示 `100`，即满命中或满占用；Provider 上报超出分母时钳到 `100%`，不显示分母之外的比率。分母是 `input_tokens`，因为 OpenAI 兼容语义下它已包含 cached 部分（见[契约 §10.30](../api/http-command-contract.md)）；deepseek-harness 的三桶求和公式建立在 cache 与 input 互斥的原生 API 上，不适用。数值口径与已知边界见[契约 §10.30](../api/http-command-contract.md)。消息、展开内容或分栏改变尺寸时，仅在读者原本跟随最新且面板可见时自动跟随；用户上翻后保留阅读意图。回到最新按钮浮在消息区域内，隐藏再显示不重置意图。
- 成果工具栏集中显示名称、确切版本、版本/比较与编辑入口。普通判断保留对象、条件、影响和决定，完整依据及补充说明按需展开；动作批准保持完整动作、风险和身份，长审批或展开依据由成果整层自然滚动。手动阅读其他版本时，明确提示判断仍绑定哪一版，并提供返回绑定版本入口；阅读切换不改变 Review 目标。
- 版本与会话选项浮层支持 Escape 收起并回到 summary，忽略 IME/229/修饰键。工具输出和 Trace 分组先显示摘要，展开保留全部原 Operation、Invocation、Effect、来源及完整追溯入口；UNKNOWN 提醒在分组之外常驻。
- 普通页沿同一标题/间距层级覆盖第 17.2 节七类页面，保留现有分页、多会话、旧深链与恢复行为。不新增消息队列、运行中引导、交互终端或 Git 浏览协议。

本轮空间验收基准为同一 1280×720 合成场景、默认分栏、普通判断且详情收起：聊天记录与成果正文各至少 240 CSS px，同时可达输入、版本及判断入口。长异常/短窄窗采用可滚达回退，不将上述数字硬套到所有状态。定向回归覆盖分栏/存储、阅读跟随、IME 事件、版本差异、多会话、草稿与原命令、失权/冲突、判断失效和停止中。实现、自检、浏览器、确切目录包与真实 Windows 的实际结果只维护[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

## 18. 文件夹入口与对话直接执行

2026-10-01，产品规则已确认，具体工程接口待设计，尚未实现/验收。用户反馈建任务、开对话步骤过多，并选择「打开文件夹后直接对话；明确要求修改或执行就进入执行」。本轮只更新文档并提供提示词。产品定义归 Master Spec §0.5，取舍归[ADR-016](../decisions/ADR-016-folder-first-conversation.md)，应用责任归[领域模型 §12](../architecture/domain-model.md#12-文件夹入口与对话执行的应用边界)。本节拥有新默认流程；第 14/16/17 节的草稿、版本、控制、人工判断和恢复规则继续有效，旧「聊天意图一律不能触发 Delegate」改为下述用户明确请求入口。

### 18.1 打开文件夹与返回工作

目标、任务与对话的关系保持：Goal/Project State 定义长期方向与当前事实，Task 承载具体执行、验收及完成，对话承载用户意图、讨论与工作接续。新的入口只允许先讨论、在明确执行时准备真实 Task；正式任务须可查看、修订、追溯，不能隐藏成聊天内部不可见状态，也不能用会话摘要代替 Project State。目标→项目→任务的既有关联与继承规则继续生效，未关联 Goal 的工作仍按原契约允许，不为打开目录虚构一个 Goal。

2026-10-05 用户进一步选择「新对话直接看到输入框，文件夹按需选择」。默认新对话先提供输入区，「打开文件夹」「近期文件夹」在同页按需展开，不再要求先选目录。这里的文件夹是当前工作目录，界面用文件夹名和路径表达；数据库 Workspace 仍是应用作用域，不能每开一个文件夹就创建新 Workspace 或重配 API。

| 情况 | 期望行为 |
|---|---|
| 首次打开有效目录 | Windows 原生选择目录后直接到可输入的对话页，不跳任务表单；后台建立最小项目/目录关联，不要求项目目标、蓝图或验收标准 |
| 再次打开同一目录 | 复用已核对的关联和会话列表；首次进入可用空白对话，再次进入恢复该目录最近使用的可访问会话，并始终提供新对话 |
| 当前目录点击新对话 | 立即展示空白输入区，沿用当前目录及有效配置；首条发送时再持久化会话，无额外「创建会话」步骤 |
| 没选目录 | 配了默认工作目录时新会话落在默认目录并可读取（标注「默认目录（来自设置）」，规则见 §18.1.5，**后端已实施，设置入口与来源标注已接入**）；未配置时可以普通讨论，需要项目资源的请求在同页选择目录或已有项目后继续，保留原输入 |
| 已有项目已有目录 | 直接复用；一个项目多目录时明确当前目录，不能猜测哪个根可写 |
| 同一目录关联多个项目 | 展示已有项目供一次选择，记住有效关联；不任选项目、不重复建项目 |
| 取消选择、无效/失效目录、关联归档项目 | 保留当前页面与草稿，给出具体状态；归档项目不自动解档，也不靠新建项目绕过其限制 |

项目/目录登记失败时可以在明确显示「目录尚未就绪」的状态下保留输入，但不得继续项目工具执行或展示成功绑定。绑定请求结果未明时使用原命令核对，不能换身份重复登记。打开目录不自动读取全树、收录知识、外发内容、执行命令或导入蓝图；文件上下文按实际请求与权限读取并记录来源。

复用已有 Project 时保留其 Goal、State、Rules、Task 和知识来源，不因文件夹名或新会话重置项目。首次建立最小 Project 只登记必要事实，目标与长期计划可在后续工作中明确；目录名不是项目目标，聊天标题也不能自动成为 Task 的目标对齐关系。

目录关联与访问设置在同页表达。现有有效配置可复用，不能强迫用户先去连接、资源、权限三个管理页面。2026-10-17 已确认：主动选择目录时按 §18.1.4 提示范围并配置基础只读准入，写入由本目录权限档位表达；这不开放目录外访问、任意 Shell 或远程动作，也不把连接健康或历史批准当作当前权限。仅恢复旧目录绑定不重新授予已撤销权限。

**2026-10-20（[ADR-031](../decisions/ADR-031-session-direct-write.md)）**：档位现在同时决定**会话轮次能不能看到写工具**。`只读` 档下 AI 在对话里只能读，要改文件仍走「执行候选 → 委托 Run」；其余三档 `apply_changeset` 进入本轮词表，AI 可以直接改本目录文件——此时它不再声明执行候选，写入结果以工具回执为准，不产生 Task、不走验收。`修改前确认` 档在会话里是**同步提示去审批入口**（会话没有排队等批准的通道），不会假装已排队。

### 18.1.1 新对话直接起步（2026-10-05 接续实施）

- 全局「新对话」使用每次不同的 `/agent?new=...` 入口意图，明确打开空白输入，不恢复最近会话、不创建空会话，也不停止其他 Task/Run。普通 `/agent` 仍可恢复最近的可访问讨论；任务深链维持原语义。
- 空白页只呈现单列输入主区；目录作用域是输入卡上方的常驻细条，「接续已有任务」收进左栏（2026-10-10 重塑；2026-10-16 栏底就地展开面板删除后即左栏任务行，见 §28.1）。新建与已有对话共享底部输入器的布局与阅读宽度，欢迎语位于空白消息区。首条发送才持久化会话；会话内「新建会话」在该入口同样延迟创建。
- **欢迎块只有一个 Owner，按归属只改说明句**（2026-10-16）：图标 + 「有什么想一起完成的？」+ 说明句 + 同一组快捷卡由首条输入区与会话面板的零消息态共用，因此从全局「新对话」和任务/项目入口点「新建会话」看到的首屏一致；差异只在说明句（未关联目标 / 当前任务 / 当前项目）与快捷卡的去向（首条输入区草稿 / 会话内草稿）。会话内「新建会话」仍立即建会话，不改成延迟创建。首条正在创建、在途或结果待核对时不渲染欢迎块，保留「还没有消息」与按原 `command_id` 核对的入口，避免欢迎语与在途回执同屏。此片只收敛展示，命令身份、持久化与归属语义不变。
- **快捷卡补前缀图标**（2026-10-18，按 V5.11 原型方向，两轮迭代）：11 张快捷卡各加一个前缀图标，按每个快捷语的功能单独选型、11 个不重样（Lightbulb/ListChecks/Compass/ListTree/Code/FlaskConical/FileSearch/Wrench/Bug/NotebookPen/History），纯装饰、不承担语义，可访问名仍由卡片文字提供；图标 16px 取 `font.size.body` 而非 `control.icon.size`。第一轮照原型恒取 `action.primary`，用户反馈「一眼看上去颜色一样没有区别度」，第二轮改为按功能族分色（`data-tone`，均为既有 token）：plan＝构思与规划（想法/需求/设计/拆解）取 `status.warning.text`，build＝实施与质量（实现/测试/审查/重构）取 `action.primary`，fix＝问题排查取 `status.danger.text`，doc＝文档与接续取 `text.muted`；原型只给三枚卡上紫色强调、其余全绿，本项目色板无紫 token，不建第二套色系，改用整族上色保证扫描时可分簇。hover 仍只改文字与边框，图标颜色不随 hover 变。卡片名与两个入口的共用关系不变。
- **快捷卡收两行、预填改即拿即用提示词**（2026-10-18 用户指令「快捷语改成两行」「内容改一下…即拿即用」）：① 11 张卡由三行摊成两行 6+5——整簇宽度交给聊天列 `--chat-measure`（不再自设 30rem），卡片左右内边距从 `space.4` 收到 `space.2`（上下不变，卡高与图标不受影响）。宽度是量出来的：真实 Chromium 里 6 张卡实宽 708px、列宽 744px、余量 36px；试过「左右 12px + 图标与文字 4px」同样两行但只剩 12px 余量，字体度量稍变就掉回 5+5+1，故取当前档。窄于聊天列时按 100% 收缩、自动多行。行数由 `tests/browser/emptyConversationWelcome.spec.ts` 锁住（只锁每行卡数，不锁像素）。② 预填文案从「现象：／总目标：」这类要用户自己填的空表格，改为一条完整提示词：把对象交给助手自己取（当前目录、项目状态、未提交改动），缺信息时由助手反问，用户点完即可发送。③ 功能族之间立分隔板（2026-10-18 用户先问「每个快捷语中间加顺序箭头」，看完对比后定「分隔板」；1px 首版按用户指令「加粗 1px」改到 2px）：只在 tone 族边界（规划→实施→排查→文档接续）落 3 道竖线。逐卡加箭头会把并列入口读成必须走完的链，且 10 枚箭头的宽度让两行掉回三行。分隔板 `flex:none`、`align-self:center`、宽 2px、高 1.25rem（短于卡片，落在卡缝里不抢眼），取 `border.control` 而非 `palette.lineStrong`——同宽度下 lineStrong 那档在两行里读不出边界，也不取 `border.separator`，与卡片描边同色会让这根线读成「另一张卡的边」。**宽度用负 margin 收回卡片原有的缝里**（`margin-inline: calc(space.2 / -2 - 1px)`）：分隔板本身是一个 flex 子项，会多占一道 gap，不收回时实测跨缝间距 18px、首行占到 731px（余量 13px，比当初否掉的 12px 档还紧）；收回后跨缝间距仍是 8px、竖线左右各留 3px，首行占宽回到无分隔板基线 708px／列宽 744px（整簇居中，右缘读数＝(列宽＋占用)/2），两行 6+5 零宽度代价。道数由同一条浏览器检查用 `toHaveCount(3)` 锁住。
- **固定快捷语提示词优化**（2026-10-19 用户确认推荐方案，源码已更新）：保留 11 个固定入口、名称、图标与布局，仍只预填可编辑草稿，发送才提交。覆盖前条 2026-10-18 中「把对象交给助手自己取」的泛化规则：需求、方案与实现优先围绕用户明确目标，缺目标先澄清；测试与重构未指定模块时仅从当前改动收敛，不默认扫描全仓。方案只讨论，实现与测试提示词分别要求完成最小实现或补测并验证；重构先确认范围；排查先确认现象与复现条件再验证原因、修复和回归；审查仅报告有依据的问题；文档优先更新已有资料；接续以可读取记录为依据，不猜测历史。提示词不改变权限、执行模式、领域命令或 Task/Run 状态。暂不扩展自定义模板、分类或自动推荐；正文唯一维护在 `AssistView.tsx` 的 `emptyWorkSuggestions`。
- 首条工具栏显示资料、普通讨论和未知用量状态。**首条也能先选资料（DEV-0100，2026-10-21 源码与组件/视图回归已完成，未做真实桌面复验）**：普通档且目标已有项目归属时，「资料」chip 点开既有资料选择器，「＋ → 选择文件与资料」一级也可展开并直接勾选项目启用资料与最近引用（首条没有会话级检索浮层，故二级不再展示点不动的「检索项目资料」）；选中项只是本次候选，发送时与图片同一时刻冻结进建会话载荷的 `sourceRefs`，服务端仍按权限与版本复核，发送后由新会话的资料选择器清空本次选择。没有项目归属、助手档与学习档仍保留禁用说明（分别提示先选项目/目录、切到普通档后可选）。普通讨论面板说明发送与目录使用方式，不提前提供候选请求或执行权限。
- 未选择目录可连续普通讨论。工作空间级会话必须同时满足 `project_id = null` 与 `task_id = null`，不能混入无项目 Task 的专属会话。不虚构 Project/Task 目标，不提供目标 Skill、提案接受或文件执行权限。**2026-10-18 补充（§18.1.5；2026-10-19 后端与前端均已实施）**：Workspace 配置了默认工作目录时，新会话在创建事务内继承该作用域，因而它本来就带有 Project，不属于工作空间级会话；未配置默认目录时本条语义逐字不变。默认目录来自用户在设置里的显式配置，仍不是对目录的猜测。
- 首条消息确认送达后清除原未决状态并让原消息面板重读；空列表先到、发送结果后到时也能显示原文与回复。未送达确认前，保留创建/发送原命令、原载荷和回执核对入口。
- 新对话、切会话与换目录沿用未保存/未决命令守卫。已核对回执后到达的原响应不得再清空新草稿或重复解释；执行候选必须匹配当前会话，解释结果同时核对原消息、资源及命令过程。
- **新对话草稿按内容作用域保存（DEV-0092，2026-10-21 源码与组件回归已完成，未做真实桌面复验）。** 首条输入器的草稿写入与恢复都绑定「草稿内容所属的 `?new=` 键」：路由切换只在内容键确实变化时恢复该键已存草稿，因此返回同一个新对话地址会保留刚输入的正文；切到另一个新键仍是空白，A 键正文不会在恢复前被写进 B 键。未引入第二套会话事实，也不改变「会话文本可自动保存、不再弹离页框」的既有决定。
- **本片范围**：支持首条前选择目录，也支持完全不选目录的普通讨论。普通讨论开始后把同一会话归入所选目录项目的服务端绑定命令已有，但前端未接；目前选择目录会切换目标，不能声称同一讨论的上下文已连续带入项目。
- **无会话任务/项目切聊天视图直接给首条输入（V43-06，2026-10-16）**：目标存在但尚无会话时，聊天视图不再停留在「目标已选。可以新建会话…」的三选一停顿页——空态直接渲染与全局新对话同构的首条输入卡，发送时才经既有会话创建 Owner 建会话；只读打开页面不创建任何会话/Task/Run。「当前会话」下拉与「新建会话」保留为次要入口（返回已有讨论是既有能力），主入口唯一。空态文案如实说明目标上下文，不虚构「下一步」。

视觉布局归设计系统，数值继续复用现有 token；场景归[测试计划 §17.1](../testing/verification-plan.md#171-新对话直接起步2026-10-05)，实际成绩及真实窗口限制只归功能验收表。

### 18.1.2 同会话目录项目归属（2026-10-07）

用户在普通讨论中选定目录后，把**同一会话**归入该目录所属项目。归属**不等于授权**：绑定成功不授予任何工具、权限或执行权，执行仍按原准入判定。

- **绑定前后是同一会话**：绑定不重建会话，历史消息逐字保留、顺序不变；绑定前未归属会话不得冒充已归属，界面也不提供「进入执行」这类依赖归属的入口。
- **归属被拒时原历史不能消失**：服务端拒绝绑定（如 409/403/404）后，会话仍在、未归属历史仍可读、会话面板与草稿都保留；服务端事实（如 `project_id`）不因界面跳转而改变，新项目下也不应出现该会话。
- **响应中断按原身份核对**：绑定请求的响应丢失或结果未知时，原 `command_id` 与冻结载荷必须保留，只能用同一 ID 查询回执，**不得换 ID 或重组载荷重发**；核对结论出来之前界面停留在「结果未知」，不冒充成功。
- **未确认归属期间闸门保持锁住**：结果未知时不发起第二次绑定提交；恢复路径是人工重读页面后按服务端事实继续，不靠自动重试。
- **切换工作区/会话/目录清空旧结果并隔离迟到响应**，旧 pending/draft 不进入新目标。

场景归[测试计划 §17.1.1](../testing/verification-plan.md#1711-同会话目录项目归属2026-10-07)；真实 API/PG 闭环范围与桌面限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 18.1.3 输入器的本目录写入档位（2026-10-17）

对话页两处输入器（首条与会话内）都在「+」右侧常驻一颗紧凑芯片，点开是档位菜单——服务端四档，菜单里给三行（「只读」按 2026-10-22 第三轮用户指令从菜单移除，见本节末三条）。它是**本目录写入档位**，不是全局开关，也不改变既有准入语义；档位只对应 `FILE_WRITE × APPLY_CHANGESET × 当前目录` 这一条策略。

**当前实现与新目标的边界（2026-10-17，档位集合于 2026-10-18 再次接续）**：本节下表和命令说明记录既有实现；新确认的产品目标由 §18.1.4 接续，档位文案先调整为「只读／修改前确认／本次任务自动」，2026-10-18 用户按通用 Agent 口径实机指认后再改为下表的四档，并由应用补齐本目录文件连接及策略。旧芯片只改写策略、缺连接就跳管理页的行为需要替换，不能当作新目标已实现。

| 档位 | 图标 | 写入行为 | 服务端事实 |
|---|---|---|---|
| 只读（新目录默认，**2026-10-22 起不在菜单里**） | 眼睛（仍用于芯片） | 本目录只读；要写入必须重新选择下面三档 | 策略条目为 `DENY`（本入口自己管理的条目） |
| 请求批准 | 手掌 | 每次应用改动都单独产生绑定确切目标的动作审批 | 策略条目为 `ASK` |
| 自动批准 | 圆勾 | 本次任务内普通编辑与已配置检查连续执行；删除、Git 提交/推送与超出本目录仍逐次确认 | 策略条目为 `AUTO`，且只覆盖既有范围授权动作 |
| 完全访问 | 危险三角（整行红色） | 本目录内的新建、修改与**删除**不再逐次确认；Git、CLI、浏览器、电脑与目录外动作仍按原准入逐次确认 | 目录档位为 `FULL`，策略条目仍是同一条 `AUTO` |

**「完全访问」只放宽本目录的文件写入**（2026-10-18 接续，取代此前「没有完全访问档」的口径）。它落下的策略条目与「自动批准」逐字相同，差别只在目录档位这一列，因此实际准入必须按 `resource_id` 回读该列，prepare 与 dispatch 各读一次同一个函数，界面不参与传递。豁免只并入「范围已覆盖」这一个条件：`DENY` 条目、命中上层受管根的更严格条目、目录根外的目标以及没有 FILE_WRITE 连接的目录都走不进这条豁免；动作、调用与账本记录一条不少。删除永远不在 Run 范围授权里这一条保持不变——那是范围授权的边界，不是目录档位的边界。

- **档位互斥的可见性**：图标按「这一档允许我做什么」选——只能看（眼睛）、伸手问（手掌）、自动放行（圆勾），完全访问这一档按用户 2026-10-19 第二轮实机指令换成危险符号（危险三角），因为它免掉的是删除确认，是四档里唯一不可逆的一档。四者轮廓互异，不再全用盾牌族，否则「看着一样」的问题没有解决。同日第一轮指认「闪电／火焰／锁」表达的是快与范围而非权限，故只读、请求批准、自动批准三档换成上面三个符号（只读原先也用锁，反义关系改由眼睛／危险三角承担）。红色只标「完全访问」这一档，取现有 `--relay-color-status-danger-text`，不新立 token；芯片与菜单行都用同一色，禁用态不染色。
- **显式拒绝不由本入口解除**：生效条目为 `DENY` 且不是本入口自己管理的只读条目时，芯片只显示「已拒绝写入」，四档全部禁用并说明「已有拒绝规则仍然生效；目录档位不会覆盖它」，指向「连接与权限」，不提供解除。
- **只改本目录自己的条目**：投影同时返回生效条目的 `policy_target_prefix`；只有它等于当前目录时才允许改档。命中上层受管根时只读显示并说明去「连接与权限」处理，避免一个目录的入口改写另一个目录的档位。
- **档位只来自服务端投影**：最严格优先的排序（`DENY` > `ASK` > `AUTO`，再按前缀长度与 ID）与准入共用同一个函数，界面不自行排策略；芯片读的只读查询与打开目录的回执共用同一个投影函数。`AUTO` 与 `FULL` 在策略上不可区分，投影必须同时返回 `write_tier`，界面按那一列显示档位名。
- **缺前置条件就说清**：缺写入连接、目录未绑定 Windows 写身份、目录停用/项目归档或正被占用时四档禁用，并给出「连接与权限」入口；不把「无法写入」显示成「已打开」。2026-10-19 第二轮起，这些说明与「这一档属于哪个目录」一起只写在芯片的悬停说明（`title`）里——菜单里不占行。2026-10-21 用户实机指认「下拉框选项是禁用状态」后按载体分工收口：**四档因这类状态禁用时，原因与下一步必须在菜单内可见**（`write-permission-reason` 一行，文案直接引用服务端 `detail`，不另写一套说法），「这一档属于哪个目录」仍只在悬停里。判据一行没改——用户口径是「不放宽闸门，只说清为什么禁用＋下一步」；禁用而不解释仍是缺陷。**这一条只管已绑定的目录**：没有目录那一档从 2026-10-22 起不再是禁用态，见下条（DEV-0115）。
- **未绑定也常驻，且四档照选**（2026-10-17 用户实机截图后补，2026-10-18 芯片文案接续，2026-10-19 载体接续，2026-10-21 措辞接续，2026-10-22 DEV-0115 接续）：缺目录／缺项目归属／缺受管资源时芯片一律读作权限「不可写入」，入口不消失——隐藏会被读成功能不存在。缺的哪一步原先写在菜单首行与提示行，按 2026-10-19 用户指令（「删除尚未选择工作目录…选择目录并归入项目这几个」）整行去掉，改由芯片悬停说明承担同一句话；2026-10-21 那句重新回到菜单里，但只在四档禁用时占一行。**2026-10-22 用户指认「未选择目录时这个权限选择不了，我需要什么时候都能选择」（DEV-0115）后，没有目录时四档不再禁用**：这一处发的是工作区默认档位命令（`SetWorkspaceDefaultWriteTier`，带 `expected_revision`），服务端只在**新建**该目录的管理指针时套用它，见[HTTP 契约 §10.110](../api/http-command-contract.md)，因此它不改任何一个已绑定目录。三条口径同时成立：行内说明一律带「新开的目录」前缀，不假装此刻作用在某个目录上；芯片只读档位名（2026-10-22 同日第二轮用户指令「不要加默认两个字」，去掉了原先的「默认 · 」前缀），「这一档说的是以后新开的目录」改由悬停说明与无障碍名前缀「默认写入档位」＋行内说明主语承担，`data-tier` 仍是 `unbound`，输入卡上方状态行同刻继续如实读「未就绪（未绑定目录）」；默认档位为 `FULL` 时芯片沿用危险色（`data-default-tier`）。这一态读的是 `GET /default-working-directory` 一条投影，不查目录档位；目录绑定后反过来，默认投影不再进界面。旧版 API 没有这条查询时四档回到禁用，并说清「当前 API 未更新，默认档位暂不可设；刷新 API 后重试」。
- **「不可写入」不是第五档权限**（2026-10-21 用户指认「未开发写入这个权限是从哪来的」）：服务端可存的档位只有四档——契约枚举 `LocalDirectoryWriteTier = 'READ_ONLY' | 'ASK' | 'AUTO' | 'FULL'`（`apps/api/src/infrastructure/database-schema.ts:407`，`gateway-api.ts` 与 `working-directory-api.ts` 的 TypeBox 字面量、`SetLocalDirectoryWriteTier` 命令取值同它一致），前端镜像同一份（`apps/workbench/src/api/dtos/gateway.ts` 的 `RelayWriteTier`），菜单里可选的是其中三行（「只读」2026-10-22 第三轮起不再出现在菜单里，见本节末）。芯片上另外读得到的词都不是档位、也不会进任何请求：「写入档位待核对」＝本机还没读到服务端投影，「已拒绝写入」＝另有 `DENY` 策略行压着档位，「不可写入」＝这一处作用域此刻写不了（读到的前置条件不满足，或还没有目录可写——后者从 2026-10-22 起仍可以选，但选的是以后新开的目录按哪一档起步，不是此刻的权限）。原先那句写作「未开放写入」，用户在实机读成「未开发」＝功能没做，因此改成「不可写入」；措辞改了，判据与投影没变。
- **改档沿既有命令**：创建、追加版本（带 `expected_revision` 乐观锁）与撤销三种既有 Gateway 命令。回执后必须重新读服务端投影，不把自己刚发的命令当作已生效；响应丢失时保留原 `command_id`，可查询原回执或按原命令重试，不换 ID。菜单头的重新核对按钮同轮按用户指令删除，未恢复：读投影的触发点是挂载／换作用域、查询原回执、提交后重读，加上 2026-10-21 补在禁用原因行里的那一颗「重新核对」（只在服务端已答但状态不属于可调整那一类时出现）。三者都只重读投影，待核对载荷仍是冻住的那一份请求对象，不因重读而换 `expected_revision`。**没有目录时同一套纪律搬到工作区默认档位上**（2026-10-22，DEV-0115）：发 `SetWorkspaceDefaultWriteTier`、回执后重读 `GET /default-working-directory` 才把芯片换成那一档、丢响应先由程序核对一次原回执、查不到才请人决定重新核对或重试，重试发的仍是冻住的那一份载荷；诊断区里读出的命令名就是 `SetWorkspaceDefaultWriteTier`，与目录档位那条命令一眼可分。
- **菜单是操作面，不是说明文档**（2026-10-17 用户实机反馈「一大堆字」）：每档只留一行短说明，规则全文不再铺进菜单。2026-10-19 用户截图指令「删除底部的文字，减小菜单宽度」后，菜单底部那行「完全访问仅本目录文件写入 · Git 与 CLI 仍逐次确认」脚注整条去掉——它与「完全访问」行内说明复读，Git／CLI／浏览器／电脑与目录外动作的边界只归本节上文与 §18.1.4；同轮把「自动批准」「完全访问」两档压回一行（此前在 22rem 上限下折成两行），菜单宽度由跟随内容改成定档。同日第二轮指令「删除尚未选择工作目录，刷新按钮、选择目录并归入项目这几个……菜单宽度在减小一点」后，**四档可选时**菜单里除四档外不再有整行文字：首行、提示行与刷新按钮删除（见上两条），宽度定档再降到 `min(18rem, 100vw − space.6)`（真实 Chromium 静态预览页量得 288×234，上一档 304×295），「自动批准」的说明随之压成「任务内普通编辑自动，删除仍确认」以保住一行——15 个汉字在 14px 下需要 210px，18rem 的正文列宽 226px 刚好容得下，17rem 只剩 0px 余量、换字体或 DPI 就会折行，因此 18rem 是本条与「每档一行」同时成立的下限；再窄必须再砍掉「任务内」这类作用域限定词，本轮不做。2026-10-21 用户再次指认「权限图标高度要居中，然后菜单宽度再减小一点」（DEV-0101）：图标由贴标题行改回整行居中（`align-items: center`，去掉顶部微移），宽度按上一句预告降到 `min(17rem, 100vw − space.6)`，两档说明同步砍掉作用域限定词——「自动批准」改「任务内编辑自动，删除仍确认」（13 字 = 182px），「完全访问」改「本目录新建、修改与删除免确认」（14 字 = 196px），在 17rem 的 210px 正文列宽内各留 28px／14px 余量，每档仍是一行；真机 Chromium 探针量得 272×236、四行图标中心与行中心偏差 0px，文案与其余规则不变。2026-10-21 唯一的例外：四档禁用时补一行原因＋下一步，因为「全灰且无解释」被实机读成控件坏了。旧版 API 缺只读查询时仍只显示一行可行动说明（「当前 API 未更新，档位暂不可改；刷新 API 后重试」——档位未知时四档按设计保持禁用），不把原始 404 正文摊给用户。**2026-10-22 同日第二轮指令「选择权限后菜单底部不要出现文字」**：改档成功后不再回显一句「已生效：xx（仅对本目录）」／「已保存：xx（以后新开的目录按这一档起步）」——芯片上那次重读回来的档位名就是这条确认，第二句只是复读。菜单底部因此只留三种文字：禁用原因（`write-permission-reason`）、待核对区块（`write-permission-pending`）、错误行（`write-permission-error`），外加**投影与点的那一行不一致时**那一句「已提交，但当前档位是「xx」」——它说的是失败，不是成功回执，不在此删。
- **菜单只给三行：「只读」这一档移出菜单**（2026-10-22 第三轮用户指令「删除只读权限」）：菜单里现在只有请求批准／自动批准／完全访问三行，两种作用域（本目录与工作区默认）都是三行。服务端那一档没有删——`LocalDirectoryWriteTier` 仍是四档，`SetLocalDirectoryWriteTier` 与 `SetWorkspaceDefaultWriteTier` 仍接受 `READ_ONLY`，新目录仍按只读起步（§18.1.4）。读侧照旧如实投影：目录为 `READ_ONLY` 时芯片仍读「只读」（`data-tier="none"`、眼睛图标），只是菜单里三行都不高亮（`data-current` 全为 `false`），不假装某一档指向这一处。**这是一次能力收窄，不是纯呈现调整**：工作台里从此没有把已绑定目录调回只读的入口，收紧写权限只能靠撤销／停用底层策略那条高级路径，而该路径当前也没有面向这一档的界面。命令与契约都保留，恢复入口不需要动服务端。
- **在途 ≠ 结果不明**（2026-10-22 第三轮用户指认「切换权限的时候会闪一下」）：请求发出的那一刻原先就 `setPending(...)`，而待核对区块的渲染条件是「有 pending」，于是普通改档也会弹出整块「保存结果还没确认／重新核对／诊断信息」并把三行一起压成禁用配色，约 500ms 后随回执塌回——真实 Chromium 逐帧量得未绑定目录那一处菜单 278→426px、顶边上跳 148px、三行 opacity 1→0.85。这既是视觉闪烁，也是把成功路径误报成「结果不明」的语义缺陷（与 §协作页发送键 2026-10-19 那条同源）。现在拆成两个状态：`pending` 仍表示「有命令在途、载荷冻住」，新增的 `uncertain` 只在响应丢失进入核对时才置位，**待核对区块只认后者**。在途窗口内菜单高度不变、不多出一行文字（`defaultHint` 不再把在途当阻塞），三行仍 `disabled` 防重复提交，但由 `data-busy="true"` 覆盖禁用配色（`[data-busy] .agent-chat-permission-row:disabled` 保持主色，同特异度靠顺序覆盖共享基座），只有刚点那一行按 `data-pending="true"` 降到 0.55。服务端状态造成的禁用（`write-permission-reason`）与 2026-10-21「禁用必须可读」那条不变。
- **菜单不从芯片居中**（同日同轮指令「菜单以下拉框居中」先实施、随后按用户指令「回滚居中的改动」撤销）：弹层仍从芯片左缘起排（`left: 0`，无 `transform`），宽度仍是 `min(17rem, 100vw − space.6)`。居中一度做到芯片中线与菜单中线重合（真实 Chromium 量得同为 x=511），已由用户否掉，不再重提。
- 本入口只管写入档位；读、Git、CLI 与其他能力的权限仍在「连接与权限」页逐条管理。

场景归[测试计划 §17.1.3](../testing/verification-plan.md#1713-本目录写入档位2026-10-17)，指令与服务面归[HTTP 契约 §10.86](../api/http-command-contract.md#1086-目录写入档位投影与只读查询2026-10-17-源码实现)；实际成绩与未验范围只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 18.1.4 本地目录权限设置（2026-10-18，已确认、已实施）

**确认依据与实现状态**：用户指出本地文件需要连接与策略配置属于过度设计，并要求修改产品文档及生成新提示词。本节拥有新规则，替代 §18.1.3 中“芯片只改写策略、缺连接跳管理页”及 §18.4.1 中“不自动创建本地文件连接”的默认流程。应用已在用户主动打开目录时建立或复用该根的只读访问配置，并提供本地档位更新入口；真实运行证据及尚未覆盖的场景只归统一功能验收表，不由本节宣称完整桌面验收。

日常路径固定为 **选目录 → 查看或选择本目录权限档位 → 发消息**。用户不需要理解能力键、连接、策略、动作词表或先进入高级管理页。实际目录选择入口明确说明：「新目录打开后可读取本目录文件，默认只读；已配置目录恢复原档位。不会自动读取整棵树或外发内容。」选择器取消不登记权限。主动选择唯一有效目录后，应用按原 Owner 建立/复用精确目录关联与 FILE_QUERY/FILE_READ 所需准入；用户随后请求读取时才按需调用工具。无目录普通讨论仍可用。

| 档位 | 用户获得的行为 | 应用必须落实的边界 |
|---|---|---|
| 只读（新目录默认） | 可以列目录、检索和读取；不执行新建、修改或删除 | 基础读配置可用，文件写动作不准入；不能只撤销一条写策略后露出另一条 AUTO |
| 请求批准 | 明确写请求可进入原 Task/Run；确切改动在原动作审批后落盘 | 自动补齐本目录必要文件连接和 ASK 写策略；用户不再手工配置基础文件权限 |
| 自动批准 | 本次明确请求内的普通新建/修改可连续推进；删除仍单独确认 | 自动补齐配置，但实际 AUTO 同时需要原 Run 的有效范围授权；任务结束、撤销、超期或根变化后不沿用旧授权 |
| 完全访问 | 本目录内的新建、修改与删除不再逐次确认；Git、CLI 与目录外动作仍逐次确认 | 档位写 `FULL`、策略条目仍是 `AUTO`；准入按 `resource_id` 回读目录档位，只对 FILE_WRITE 能力族生效，目录根边界与显式 DENY 优先。图标、红色与四档全集归 §18.1.3 |

保存的档位偏好不是一份永久 Run 授权。后续明确写请求仍由原应用入口确定本次范围、准备独立 Run 并签发相应授权，不因记住档位自动启动后续工作；只读档下收到写请求时，在输入器旁给出切换写档位的直接入口，不送去逐条建连接。没有确切批准时不宣称已写，非完全访问目录的删除审批不得退化为泛化的目录写确认。「完全访问」免掉的是本目录文件写入的单动作 Review，不是范围授权——范围授权永远不含删除，这一条不因档位改变（详见 §18.1.3）。

**应用管理与兼容规则**：

- 通过既有连接/策略 Owner 管理基础文件事实，优先复用该项目内与当前 canonical root 匹配的 ACTIVE 配置。不能只检查同项目有能力，也不能任取第一个连接；目录 A 的配置不让目录 B 显示可用或获得执行能力。
- 配置必须有可追溯的目录/命令来源，能识别本入口管理的条目；不要求为三类文件能力各建一条连接，不重复造根、Project 或策略。具体持久化与内部调用方式实施前按当前代码核定，不创建第二套权限事实或用前端连发多个不受协调的命令冒充一次设置。
- 同根重复/并发选择、改档、丢响应与重启按原 command_id/回执/revision 核对；待核对命令冻结首次 command_id 和完整请求（包括 expected_revision），重读较新投影不改写原请求。回执中的历史 revision 与当前投影分开展示；切换客户端、项目、资源或目录根后，不把待核对命令发送到新作用域。GET 查询、路由恢复、重开旧会话和模型工具请求不会自动补授权。已有生效档位优先恢复，新目录才使用默认只读。
- 补默认读取配置前，按 Workspace、Project、能力、动作及根覆盖范围核对既有策略版本历史。若匹配历史存在但没有当前活动授权，不创建新的 AUTO；告知用户明确重新授权后再继续。活动的后续明确授权可以复用，不相关目录不受阻。
- 显式 DENY、用户手工停用/撤销、上层受管根限制、归档、根身份不完整与资源 UNKNOWN/占用继续约束；不能通过新建连接/策略、换 ID 或重选目录绕过。识别到历史撤销而无当前配置时，明确说明限制，不静默恢复。
- 旧手工连接/策略及在途 Operation/Review/Run 保留，不批量回填宽权限或重绑历史动作。旧「不开放写入」映射为只读目标；改档仅调整本入口有权管理的条目。收紧写权限后阻止后续尚未准入动作，已在途/UNKNOWN 沿原停止与核对流程处理，不假称副作用已经停止。
- 本次自动配置仅覆盖基础本地文件查询/读取/新建/修改/删除的既有准入链。Git、CLI、浏览器、电脑与外部服务不因选目录或改写档位获得权限；「完全访问」也不例外地只落在 FILE_WRITE 这一族；不扩大 ASSISTANT/LEARNING 的身份能力。

**高级入口**：连接与策略页保留用于外部服务地址/凭据、特殊能力、排错和历史/限制管理；本地基础配置以应用管理状态与依据展示，不能成为日常必经步骤。「+」菜单中的连接器能力状态也必须读真实投影，应用管理的文件配置不应被包装成需要用户逐一安装/连接的外部插件。本轮不改全站导航或重做外部连接器。

**验收出口**：全新合成目录和空配置下，只通过普通目录入口即可读取；只读拒绝写入，切换写档位后新建/修改以及删除批准/拒绝走通；全过程无需访问高级页或测试预灌连接/策略，原会话与磁盘结果一致。还须覆盖同项目双根、旧拒绝/撤销、并发/丢响应/重开及 UNKNOWN。规格归[测试计划 §17.1.4](../testing/verification-plan.md#1714-本地目录免手工配置2026-10-18已确认已实施)，实现与未验范围见统一功能验收表。

### 18.1.5 未选目录时的默认工作目录（2026-10-18，已确认、未实施）

**确认依据**：用户下达「新会话未选择目录的时候应该在默认目录工作，这个默认目录是可以用户配置的，上游中应该有」，随后按推荐选项选定「本轮先落文档与任务书」与「默认目录未配置档位时按只读兜底」。上游五个 Agent 的机制对照与证据缺口归[研究 §1.8](../research/p00-source-study.md#18-未选目录时的默认工作目录机制对照2026-10-18)：五家都保证 Agent 有一个确切 cwd，其中只有 DeepSeek Harness 把它做成可配置项（`sandbox.workspaceRoot`）并与写边界闭合；没有一家落「没目录就拒掉工具、对话照常」这一状态。不变量归[契约 01 §5](../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)，责任与持久化归[运行架构 §2.8](../architecture/runtime-context.md#28-新会话的默认工作目录作用域2026-10-18已确认待实施)，实施切片与停点归[任务书](../../prompts/default-working-directory.md)。

**2026-10-19 状态：后端配置、创建继承与来源投影已实施，前端设置入口、创建后作用域读回与来源标签也已接入。** 日常流程现在可以走通「设置 › 基本设置 › 默认工作目录 → 选择真实目录 → 保存 → 新普通会话 → 服务端继承 → 细条与顶栏标出来源」；自动化证据见[测试计划 §17.1.5](../testing/verification-plan.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)，真实 Windows/WebView2、安装态与真实 Provider 仍未取证。实现与验收成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

日常路径不变（§18.1.4：选目录 → 看档位 → 发消息）。默认目录只补一条空缺：首次打开一个目录时自动登记（或事后在设置里选一次），之后没主动选过目录的新会话都能读该目录内的文件，不必每段讨论先点一次「选择目录」。

- **配置入口**：设置 › 基本设置新增一行「默认工作目录」。值是当前默认目录名与完整路径，未设置显示「未设置」并提供选择按钮；「更换」与「清除」在同一行。选择走与目录细条同一个原生选择器和同一条 `OpenWorkingDirectory` 命令，因此默认目录必然是一个已登记的受管目录（连带其 Project 与档位），而不是手输的裸路径；非桌面宿主沿用手输路径回退，但手输同样要过该命令。
- **未就绪不写入**：同一目录关联多个项目、落在别的已受管根之内，或其他 NOT_READY 原因时**不写入默认值**，原样显示服务端给出的原因并保留原值；不为「让默认目录可用」新建第二个项目或第二个写 Owner，也不静默改用另一个根。
- **默认目录不自带写能力**：新目录按 §18.1.4 只读，档位仍由 §18.1.3 的四档表达；用户在该目录上显式调过档，继承其作用域的会话就沿用该档位。设置里的默认目录一行不提供「自动批准」，也不提供「完全访问」；删除、Git、CLI、浏览器、电脑与外部服务一律不因默认目录获得权限。
- **只显示目录名**：目录细条与顶栏只呈现目录名本身，不再追加「默认目录（来自设置）」这类来源后缀（2026-10-20 用户指令「目录名」）。理由：默认目录会自动登记，来源已不等于「来自设置」，后缀既占位又可能失真；而目录名正是用户要核对的事实。来源仍保留在 `context.working_directory.source` 投影与顶栏 `data-source` 上供核对与排查，不参与可见文案与可访问名称；缺字段（历史未知）不得被读成用户的选择。**完整路径放在更换目录浮层顶部**（2026-10-20 用户确认「需要」）：同名目录或被省略的目录名无法区分，浮层里以次要前景色完整显示、长路径换行不截断（`overflow-wrap: anywhere`，Windows 反斜杠无天然断点），仍不加图标、不做成按钮。**「最近使用」每一行同样给完整路径**（2026-10-20 桌面端截图指认省略号截断）：目录名独占第一行，路径折到第二行、允许任意断行，左边缘对齐目录名；行数多时浮层内部滚动，上限从 `52vh/26rem` 放宽到 `64vh/30rem`，不把最后一行裁成半截。**目录名本身在悬停或聚焦时浮出绝对路径**（2026-10-20 用户要求）：`lib/pathTooltip.tsx` 的 `usePathTooltip` 返回 handlers 与 portal 节点，handlers 挂在原按钮/原顶栏项上（不新增包裹层、不改 flex 布局），浮层 `position: fixed` 挂 body 避免被细条与滚动容器裁掉；Esc、失焦、滚动、改窗宽即收起，`pointer-events: none` 不挡底下的目录名。
- **空态文案随之收敛**：未设置默认目录时保留「不需要先创建项目、任务」，但**不再承诺「不需要目录也能读文件」**——说明句改为「要读取文件时再选择工作目录」（2026-10-19 已落地）。设置默认目录后，空态与首条「普通讨论」面板如实说明新会话会使用它；默认目录失效时说明「当前不可用、新会话不会使用它」，不显示成已有可读目录。任何一档都不把默认目录写成新的必选步骤。
- **默认目录从哪来**：两条路径，都是用户的显式动作——① 设置 › 基本设置里的「默认工作目录」；② **首次**打开一个目录且回执为 `READY` 时，若工作区还没有默认目录就顺手登记它（2026-10-19 用户要求「基础能力不该让开发者自己配置，应该所有会话都有」）。已有默认目录后，打开别的目录**不覆盖**它；应用仍不在会话中猜目录、不在读取失败时换根、不为每段讨论新建项目；工作空间级会话（`project_id = null`）的定义不因本节改变——继承了默认作用域的会话本就有 Project。
- **失效处理**：默认目录被停用、其项目归档或资源不再可用时，新会话回落为「没有默认目录」的行为并说明原因；已在途与历史会话保持原绑定，不自动改作用域，也不靠重设默认目录恢复已撤销的权限。
- **不做**：不做进程工作目录兜底（API/Worker 的进程目录是安装目录，不是用户内容，显示出来会误导）；不把默认目录写进本机 localStorage（现有「近期目录」只是展示偏好，不构成授权，见 §18.1 与领域模型相应口径）；不新增第二套权限事实或第二张目录表。

**前端实现口径（2026-10-19）**：设置页那一行与目录细条共用同一条 `OpenWorkingDirectory`，只有回执 `READY` 且带 `association.resource_id` 才发设置命令——不看 `write_readiness`，因此只读目录也能成为默认。设置/清除严格使用最近一次 `GET` 读到的修订；`409` 只重读并说明冲突，不自动覆盖，也不换修订重发。传输结果不明时保留原 `command_id`、原载荷与原基准修订，界面停在「结果未知」并按该 ID 查回执，不把命令成功当成事实已刷新。换 API/Workspace 立即丢弃旧投影与在途命令，迟到响应按版本闸忽略；挂载、重读与切回本页只发 `GET`。建会话成功后按回执 `session_id` 读一次带上下文的会话：服务端若已继承默认目录，该会话本就有 Project，不属于工作空间级会话，宿主据此切到那个项目作用域并标出来源，前端不补第二次目录绑定；读不回来就退回回执本身的事实，不按最近目录或配置投影猜。来源标记只认 `context.working_directory.source`：`WORKSPACE_DEFAULT` 才写「默认目录（来自设置）」，`USER_PICKED` 不写，缺字段（历史未知）同样不写（**2026-10-20 起该后缀已按用户指令移除，见上一条；解析与 `data-source` 保留**）。

### 18.2 从对话进入执行

| 原始用户消息 | 行为 |
|---|---|
| 「先看一下这个问题，和我讨论解决方法」 | 讨论/按授权读取，不创建正式 Task，不产生写执行 |
| 「帮我修改这个功能」「修复这个报错并验证」 | 范围足够明确且能力/权限满足时，直接准备并启动原 Task/Run 链；不再统一要求点击开始执行 |
| 「这个功能能不能改」「以后也许加一下」或缺失关键对象 | 讨论或一个聚焦澄清；不能靠关键词把建议解释成执行授权 |
| 「只更新文档」「先不要改代码」 | 固定本次范围并沿用后续约束；文档或读取权限不能升级为代码写入 |
| 已有明确执行请求命中动作审批、失效权限或目录冲突 | 在原对话给出可行动处理，原审批/控制链生效；不以再次确认所有任务代替具体原因 |

「可以开始」只有在同一会话中已确定确切目标、范围和有效基线时才可继续原准备；孤立的「开始」不能驱动陌生任务。模型生成的计划、提案、文件中的文字和网页指令不属于用户授权来源。

系统从原请求整理任务标题、目标、输出要求及可判断的验收条件，在对话内用紧凑摘要显示「本次要做什么、当前目录、准备中/执行中/等待处理」。用户可展开查看、修订或停止；展示摘要不是固定确认门。充分明确的请求自动继续；无法可靠得出关键结果或验收要求时只询问缺失信息。不用「已完成」「模型说成功」等占位条件凑齐 Task。

纯讨论可以先不绑定 Task。同一会话可从讨论走到执行，也可先后推进多项任务；历史消息、提案、Run、Review 与产物绑定其实际来源任务/版本，不能将整段会话追溯性地改绑到新 Task。任务管理页展示真实执行任务，普通聊天不制造任务列表噪声。

### 18.3 在途请求、故障与兼容

新输入不会静默改写活动 Run 的执行契约。用户要求变更在途范围时，在同页解释是下一项工作还是需先停止/重新委托；未获安全处理前不授予冲突执行权。新对话、换目录、关页面只改变展示，不自动停止、重启或迁移运行；实际停止走原持久化控制入口。

首条发送、任务准备、委托与目录登记各阶段保留原命令及部分成功事实。断线/重启先恢复原会话、任务、Run 和回执，不重复创建或重新支付模型整理成本；UNKNOWN 沿原 operation 核对。错误留在原输入/目标旁，消息不会被假装发送，阶段显示准确，不将 Task READY/Run CREATED 显示为正在写文件。

2026-10-13 基础接续已接线：候选可用且尚无关联 Run 的 `TASK_PREPARED` / `FAILED` 摘要保留「继续原请求执行」，仍提交同一 `request_id`。应用失败后读回该会话的原请求阶段，保留本次已展示的目标和范围，显示已建立 Task 与具体错误；不因部分成功自动跳任务页。若读回确认 `DELEGATED` 且有原 Run，解除未知错误，可沿「查看任务」接续；核对读取也失败时明确提示阶段尚未核对。刷新后无候选标题的只读投影显示「原执行目标已保存」，不补造目标。正常成功只有确认委托后才自动切到原 Task；动作审批按已有权限及本次范围授权处理，不宣称每次动作必定另弹批准。

没有已接通的真实读取/写入/命令能力时，界面必须说明具体缺口；不能把 Markdown 草稿、Mock、旧 DRAFT 或「正在执行」动画包装成项目文件修改。直接执行的工程出口包括真实受控动作和结果核对，详见[验收规格 §17](../testing/verification-plan.md#17-文件夹与对话直接执行验收规格)。

保留旧项目/任务/会话深链、正式任务表单、GUI 委托、判断与完成入口。现有工作主线风格与 tokens 继续使用，不借入口调整再重做全套 UI。API/数据库变化在实施前按实际契约明确 Breaking Change 与兼容策略；本轮没有发布接口或 migration。

### 18.4 当前实现的交互出口（2026-10-02）

2026-10-02 起本节进入实现。交互规则仍是本节唯一 Owner；应用责任归[领域模型 §12](../architecture/domain-model.md#12-文件夹入口与对话执行的应用边界)，取舍归[ADR-016](../decisions/ADR-016-folder-first-conversation.md)，接口契约归[HTTP 命令契约 §10.53](../api/http-command-contract.md#1053-文件夹入口与对话执行请求2026-10-02源码实现)。**Breaking Change：No**（新增路由内视图与两个新命令，既有 Task/Session 深链与正式任务表单不变）。

未打开目录时，输入卡上方的目录细条给出「更换目录」入口，其中含「打开文件夹」「新对话」与一个手动绝对目录输入（非桌面宿主没有原生选择器时使用）；「选择要推进的任务」自 2026-10-10 起改由左栏承担，2026-10-16 栏底就地展开面板删除后即左栏任务行（见 §28.1）。目录就绪后主区直接是可输入的对话，首条发送才建立会话并保存这条消息，不额外点「创建会话」。页面读取不发任何写命令。

页面元素：`folder-scope-strip`（输入卡上方的常驻细条：目录名、归属与告警）、`folder-scope-change`（目录名本身即「更换目录」入口，2026-10-18 两行合并后原 `folder-scope-options` 目录名 testid 并入这一颗键）、`folder-scope-association`（已归入项目 / 未归入项目）、`folder-scope-change`（打开 `folder-scope-pop` 浮层：非模态 `role="dialog"`，aria-label「更换工作目录」，内容即 `folder-scope` 选择面）、`folder-write-readiness`（只读投影的缺什么）、`folder-ambiguous` 与 `collab-folder-candidate-{project_id}`（多项目显式选择）、`folder-not-ready`（稳定原因说明）、`collab-recent-folder`（本机近期目录，展示偏好）、`assist-first-draft` / `assist-first-send`（首条输入）、`execution-summary` 及其 `data-decision` / `data-status` / `execution-summary-stage` / `execution-summary-title` / `execution-clarify` / `execution-start` / `execution-open-task`。

阶段显示必须区分「正在整理这次请求 / 需要你补充一点信息 / 候选已就绪 / 任务已建立 / 已进入执行」；**Task READY 或 Run CREATED 都不会被显示成正在写文件**。截至 2026-10-17，服务端将 READY 且由原用户明确请求的 PREPARE 候选标记 `auto_start=true`，Workbench 沿原 `request_id` 自动应用；讨论与缺信息仍不自动推进，写入仍由 Gateway/本次任务范围准入，DELETE 保留确切动作确认。是否自动应用还受本设备「计划执行方式」偏好约束（§18.4.2）。Apply 读回同时刷新挂在原用户消息下的 Run 轨迹投影，不要求切到任务页才能看到结果。行为规格见[§18.10](#1810-普通-agent-的连续工具主流程)。

当前实现建立真实任务后协作页切到那个 Task：执行摘要、Run 控制、成果阅读与判断入口仍是原来的 Owner。目标交互按 §18.10 保留原会话中的进度与结果，不再强制切任务才能看到唯一结果；原任务视图继续作为详情入口。实际 Windows 原生选择、取消、重启、中文 IME 与 DPI 取证尚未完成，范围只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)记录。

### 18.4.1 文件改动由执行时的真实读取决定（2026-10-04，方案 B）

用户选定：解释阶段只产出**目标与范围**，文件正文由 Run 内的模型在真正读过文件之后决定。这改变了「按这个执行」这一次确认的对象，必须如实改文案，不能让用户以为自己在确认具体内容。此处保留 2026-10-04 的实现说明；2026-10-15 接续的 §18.10 不再固定要求独立解释调用或二次开始确认，写前真实读取及范围约束继续成立。

- 候选摘要展示的是**目标、验收条件、要动哪些路径（CREATE/MODIFY/DELETE）、要不要跑一次检查**。不展示、也不暗示已有确定的新正文。
- `execution-summary` 的确认文案从「按这个执行」这类含内容暗示的说法改为说明「按这个目标执行，文件内容会在执行时读取后决定」。具体文案归设计系统，本节只固定语义。
- 2026-10-04 实现曾在缺连接时报告第一项缺失能力、指向同页手工配置且不自动创建。该默认流程由 §18.1.4 的应用管理本地文件配置替代；内部准备失败应在原目录入口说明真实原因并按原命令恢复，不能让用户逐条补 FILE_QUERY/FILE_READ/FILE_WRITE。非本地文件能力仍遵守各自配置边界。
- 确认之后，协作页回到既有 Owner：执行摘要、Run 控制与成果阅读。**工具调用的进度、参数与结果呈现已于 2026-10-05 接入**：聊天区在产生执行请求的 user 消息下一行摘要，右栏工具面板「轨迹」页签逐轮展开（规则见 [§18.8](#188-工具轨迹的呈现2026-10-04c-片设计)）。摘要与轨迹都只算已结算的调用，未结算不虚报。

2026-10-18 实现接续：`execution-summary` 从服务端候选读取 `file_changes`，在确认前逐项显示「新建 / 修改 / 删除 · 相对路径」；含 DELETE 时补「删除会在 Run 内按现有审批规则处理，需要确认时会在批准前停住」。旧投影没有该字段时显示为空，不据此推断「本次不改文件」；正文与基线仍由 Run 内的真实读取决定。

工程契约归[HTTP 命令契约 §10.53](../api/http-command-contract.md#1053-文件夹入口与对话执行请求2026-10-02源码实现)，授权语义归[工具适配器 §2](../architecture/tool-adapters.md#2-files)，运行规则归[运行架构 §2.3](../architecture/runtime-context.md#23-内部工具循环的对象身份与恢复2026-10-03-实施设计)。**Breaking Change：Yes（语义）**——同一端点冻结的信封由固定动作链改为工具循环信封，解释候选的 `file_changes` 不再接受 `content`；路由、命令 Owner、权限与审批栅栏不变。

### 18.4.2 计划执行方式：生成计划后自动执行还是人工确认（2026-10-18，已实施）

用户下达「给 relay 的计划模式增加一个设置，可以选择是生成计划后自动执行还是需要人工确认」。设置为**本设备偏好**，存放于 `localStorage`（键 `relay.workbench.planExecution`），入口在设置页「执行策略」分组的 `plan-execution` 卡片（`settings-plan-execution-mode` 选择框、`settings-plan-execution-save` 保存）；保存口径与显示偏好一致：草稿不立即生效、成功后仅在本设备生效，无效或不可读的本地值回落「自动执行」，存储不可写时保留旧值并说明。

两档语义以**不改变任何权限与准入**为前提：

- **自动执行（默认）**：维持 §18.4 既有行为——服务端标记 `auto_start=true` 的就绪候选沿原 `request_id` 自动进入 Task/READY/Delegate；刷新或重挂载后读回同一条 READY 投影同样补上启动。
- **人工确认**：摘要始终保留「按这个目标执行 / 继续原请求执行」按钮（`execution-start`），点击后才提交同一 `request_id`；讨论、澄清与缺信息照旧不自动推进。成功后按 §18.4 既有口径自动切到原 Task。

无论选哪一档：写入仍由 Run 内 Gateway 准入与本次任务范围授权决定，DELETE 保留确切动作确认，授权来源始终是最初那条用户消息；本设置不写服务端、不改 `auto_start` 契约、不影响其他设备。服务端投影继续只回答「候选就绪且可进入原应用入口」，是否自动启动由服务端标记与本设备偏好共同决定，界面不自行判断只读/写意图。

### 18.5 首条消息的未决命令与版本错配（2026-10-03；2026-10-04 补首条过程 Owner）

本节只补首条消息链与阅读错配的交互规则，不改 §18.4 的目录入口、建会话时机与既有 Owner；**Breaking Change：No**，路由、命令 Owner、HTTP 契约、数据库与权限不变。2026-10-04 依[验收表 §10.9.1](../testing/overall-acceptance-2026-09-28.md#1091-四类缺口的修复与复验2026-10-04)把「未决事实」扩为「首条过程的全部事实」，并补上原资源绑定、只解释一次、换目录守卫与创建恢复交接四条规则；这四条是对本节既有约束的收紧，不新增交互入口。

**首条消息发送后的全部过程事实由协作页持有。** 文件夹入口的 `AssistView` 以会话为 key，建会话成功后必然重新挂载；若未决命令只存在组件本地，重挂载会连同 `command_id`、原载荷与恢复入口一起消失，用户既无法核对也无法重试。因此首条过程（草稿原文、未决命令身份与原载荷、发送时绑定的 `resource_id`、在途阶段、已完成解释的 `command_id`、解释结果）由 `CollaborationView` 作为一个 Owner 持有，并对组件提供同步 `read()`；只在组件本地保留其中一部分，迟到回调就会读到过期阶段并重复推进。

- 建会话与发消息是两个命令。首条消息的响应丢失只说明传输结果未知，**不能**被推断为业务失败，也**不能**宣称已送达；界面同时给出真实传输原因与「核对前这条消息不算已送达」，并提供两个出口：「查询首条回执」与「按原命令重试」。
- 首条发送与同 ID 重试共用同一条发送路径，命令 ID 与载荷在发送前固定。**不得**重建会话、更换消息命令 ID 或混入用户此后改写的文本；回执未确定前不猜 `source_message_id`。
- 防止双击重建或重发的同步闸与「在途」标记都在 Owner 上，**不能**用组件本地 ref 或 `setCreating`——同一 tick 内状态尚未生效，且重挂载后的新实例读不到旧实例的 ref。连接已换时不猜结果：保留未决命令与原因，等核对或重试。
- 回执核对只按原 `command_id` 读取，并校验 `command_type` 与 `session_id`；回执与原命令不匹配时必须停在未决状态，不得当作已送达。
- **同一原消息只解释一次。** 解释前先在 Owner 上按 `command_id` 声明；已声明的命令不再发起解释，因此「先核对回执、再收到原响应」不会产生第二个解释命令。迟到的失败只在未决仍指向同一命令时才写回，**不得**复活已被核对清空的状态。
- **解释绑定命令产生时的资源。** `resource_id` 在命令产生时固定，核对与迟到回调都只用这个值；**不得**在解释时从当前目录作用域重新取值，否则换目录后会把原消息解释到别的资源上。
- **换目录与选会话共用同一条守卫。** 未发送草稿要先明确保留或放弃，未决消息在核对前不得换目录；守卫必须先于 `OpenWorkingDirectory`，不能先登记新作用域再询问。仅选择或取消不吞掉原文。
- 未决期间离页必须被既有守卫拦下。该未决命令并入同一份 `dirty`/`discard` 投影，不新增第二套对话框；上层 `discard()` 在存在未决命令时本就拒绝放弃，因此首条消息未决命令期间不提供「放弃」出口。

**创建回执恢复必须交接首条载荷。** 创建与发送是同一首条过程的两个命令；创建响应丢失后按原 `CreateAssistSession` 回执恢复确切会话时，要一并交接该命令携带的首条原文与资源并续发，否则用户只看到空白会话，原载荷就此丢失。解释结果交接给会话面板既有 Owner 时，面板须能接手**在自身挂载之后**到达的结果（按 `request_id` 判断是新结果而非自己的），不能在旧实例留唯一事实。

**首条草稿与已选资料共用同一份离页保护。** `firstDraft` 非空即视为脏，未发送的首条草稿离开前弹确认；选择保留后原文仍在，只有用户显式放弃才清空。

**首条明确执行输入与普通发送走同一条解释链。** 首条发送成功后按真实回执的 `user_message_id` 与确切目录 `resource_id` 请求执行解释；前端不做关键词判断，纯讨论不显示「按这个执行」，也不自动建立 Task。摘要与确认动作仍由会话面板的既有 Owner 承载，首条输入不新增第二套摘要或确认门。

**待审页阅读其他版本必须显式提示错配。** 提醒是单一节点，compact 纸面与完整 `/reviews` 页的非紧凑正文两种形态都渲染，内容包含正在阅读版本、判断绑定版本与「返回判断版本」。切换阅读版本不修改 Review、审批目标或命令载荷；返回入口只重读确切绑定版本，不为显示提示改变页面布局。

回归与真实点击成绩只归[功能验收表 §10.8](../testing/overall-acceptance-2026-09-28.md#108-四项整改的实现自检与复验2026-10-03)；文件夹入口首条会话链未在真实 API/PG 单跑端到端，同 ID 重试的服务端幂等重放只有夹具与浏览器证据，Windows 原生路径与 IME/DPI 仍未验。
### 17.7 页头与成果区结构对齐（2026-10-01，接续 §17.6）

用户以附件反馈「前端实现跟效果图差很多」。本轮只重组展示，不新增业务状态、执行权限、模型调用策略或写入 Owner；**Breaking Change：No**，路由、`allowed_actions`、HTTP 契约与数据库不变。组件与布局规则归[设计系统 §9.2](design-system.md#92-共享页级原语2026-10-01)。

- **协作页头从 12 个常驻控件收敛为 1 个按钮加一个「更多操作」浮层。** 常驻的是名称、状态、项目、目标、当前需要，以及 `查看待处理 N` 与委托执行；双栏/对话/成果模式、文件与运行工具、模型端口状态、Run 控制与任务与执行详情进浮层。浮层展开不改变页头高度，Escape 在 IME 组词期不触发。
- **UNKNOWN、控制请求与执行失败不折叠。** 这三类出现时 Run 控制移回页头常驻，判断区同时提示；判断条、审批目标与待核对命令仍完整可读。
- **事实条是按需细节。** `任务与执行详情` 默认收起，展开后提供当前执行状态、任务/验收版本与检查记录入口。等待判断、执行状态与运行标识继续在页头以单行 `collab-current-need` 常驻，不因此丢失。
- **成果区恢复文档层级。** 文档名使用区域标题字号，版本、保存状态与编辑入口同排；保存时间与体积进入版本说明。判断条改为共享 `JudgmentBar`：标题行常驻「等待你的判断：{条件}」并与执行权边界同行，下一行是验收版本与条件文字、影响说明，末行是依据、补充说明与决定动作。截断的产物版本 ID 不再出现在首屏，改由「查看依据与绑定对象」提供完整字段与来源深链。
- **阅读与判断互不挤占。** 成果纸面内阅读区保留 `layout.workspace.centerMin` 下限，判断条贴底；短窗口改为整层自然高度滚动。判断条与正文都按内容高度排列，不靠像素调优维持。
- **侧栏去掉三块冗余 chrome。** 已加载范围说明与标题同排、不再另占一行；与主导航「工作台」同路由的「开始一项工作」按钮删除；今日、全部任务、动态、收件箱 4 条旧路由在图标栏内常驻显示，只用一条细分隔线与主导航分组，不再折叠（2026-10-04 按用户要求取消折叠：侧栏高度足够，收起反而多一次点击）。十条入口与底部设置、连接与同步在常见窗口高度下不滚动即可到达，更矮窗口由整条导航承担滚动。
- **输入器恢复单卡结构。** 卡内正文不再自带边框（此前被后注入的 `.field textarea` 覆盖），底部一行是「资料 N」「普通讨论」两枚 chip、缓存状态与发送键；中栏变窄时快捷键提示先收起，它不承载操作。

旧 class 与 `data-testid` 一律保留（`app-frame`/`app-topbar`/`recent-work-*`/`.breadcrumbs`/`collab-*`/`review-*`），测试不因视觉重组而改写断言。本轮不覆盖 §17.6 的分栏、专注模式、草稿保护与恢复规则，也不改 `/projects`、`/tasks`、三工作台、`/knowledge`、`/reviews`、`/settings` 的现有页头——推广到这六类页面属于下一批，规则仍是第 9.2 节的三个原语。

### 17.8 聊天优先效果图与全站适配范围（2026-10-02）

状态：用户已选方案 2，并明确当前只生成其他页面的静态效果图、不改代码。视觉目标归[设计系统 §9.3](design-system.md#93-聊天页方案-2-与共享壳适配2026-10-02效果图)。全站适配仍是设计提案，不改变 API、数据库、权限、任务/会话关系或完成用例；Breaking Change：No。

| 页型 | 相应适配 | 必须保留的出口 |
|---|---|---|
| 全站共享壳 | 图标导航、近期工作栏、紧凑上下文；保留搜索、通知、连接与旧入口 | 主入口工作台/项目/待处理/资料；展开今日/全部任务/动态/收件箱；设置/连接与同步；近期工作续页、深链及短窗口侧栏底部 |
| 聊天与 Assist | 紧凑对象头、独立消息滚动与底部输入、按需任务详情 | Task 与会话身份分离；取消/无 Run 的真实状态；普通讨论与资料数；原草稿、未决命令与历史阅读位置 |
| 项目、任务、今日与动态列表 | 同一页壳；标题、主操作与筛选按页组织 | 分页、有效范围、空态与读失败；不把列表改成会话 |
| 对象详情、规划与三工作台 | 同一对象头；目标、验收、目录、正文和各页签为主体 | 归档只读、基线差异、确切版本、同任务 AI 与旧深链 |
| 资料、成果、来源与完成凭据 | 名称、版本和编辑同排，正文优先，辅助来源按需查看 | 阅读版本与判断版本区分、读取失败、比较、冲突草稿与来源 |
| 待处理 / Review | 紧凑列表、确切正文与判断区 | 对象、条件、影响与决定；动作审批的实际目标和风险；接受不等于完成 |
| Run | 紧凑状态头、合法控制与步骤，诊断按需展开 | UNKNOWN、停止待安全点、失败与断线；历史只读；原回执身份 |
| 设置、连接与创建表单 | 同一页壳与紧凑页头；保留自然长表单、分组和页签 | 连接/能力/权限区分、字段错误、原草稿、冲突与回执待核对 |

UNKNOWN、PARTIAL、控制请求待安全点、执行失败、权限/归档写入阻断、事实读取失败、审批风险、冲突及未决命令不能统一折叠到「更多」。近期工作继续按真实 Project/Task 组织，参考 Codex 不引入第二套全局会话事实。

本轮按当前路由、生产组件及 API-backed 分支核对功能后生成 37 张页面/状态图，清单和逐页生成依据归[本轮效果图目录](mockups/2026-10-02/README.md)。补齐旧清单未单列的人工待处理汇总、项目连接与权限、产物来源追溯及项目 Assist。收件箱是未归属项目的人工任务；全局连接入口先选择项目，没有独立同步动作；资料保留资料/记忆/决定/规则。开发工作台不能把尚未接入的 Git diff、受控测试和 Coding CLI 画成成功结果。图中示例内容与按钮布局仍需后续实施校准，不成为第二套功能事实源。

后续实施的布局出口为：长任务名不推高上下文或挤掉状态；完整名称有键盘可达入口；消息首段和输入底栏完整可见；普通桌面消息区至少满足 §17.6 的阅读空间要求；短窄窗口内容与操作可滚达；上翻后新消息不抢位置。详情与菜单关闭后还焦点，中文组词期间 Enter/Escape 不误触。本轮图片只能表达布局与状态，不能验证这些交互；真实 Windows、DPI、IME、业务写入与恢复留待生产接入后验证。

### 17.9 列表页型首个生产试点：/projects（2026-10-02）

用户选择先做项目页试点，再决定是否推广其余页型。`ProjectsView.tsx` 的 fixture 与 live 两个视图改用 `PageHeader`，标题落 `font.size.compactPage`、目标句落 `font.size.meta`，范围切换与搜索收进一行紧凑工具栏；`data-testid`、路由、业务文案、分页、归档命令与右侧摘要栏一律不变。**Breaking Change：No**，未新增 FactBar——范围计数已在页签内，再加一条事实条就是第二套范围事实。实跑范围与同轮协作事实条修复见[验收表 §7](../testing/overall-acceptance-2026-09-28.md#7-项目列表页头试点与协作事实条修复2026-10-02)。

结论只覆盖"共享页头原语在列表页可用"。其余页型（`/tasks`、三工作台、`/knowledge`、`/reviews`、`/settings`、`/connections`、对象详情、Run）仍是 §17.7 列出的旧页头；推广前需先确定列表、阅读与待处理三类代表页，且每类都要保住 §17.8 表中的必须可见出口。

### 17.10 聊天页任务头接续选定稿（2026-10-02）

`/agent` 协作页的任务头按 §17.8「长任务名不推高上下文或挤掉状态」与「完整名称有键盘可达入口」收敛。`CollaborationView.css` 把 `.collab-goal` 的 h1 落到 `font.size.compactPage`，单行省略、状态芯片不换行（6rem 是本地可读下限，窄窗整块换行而不是把标题压成一条线）；`PageHeader` 的标题统一带 `title` 属性，完整任务名在悬停与辅助技术中仍可读。项目归属不再单独占 `meta` 一行，与「当前需要什么」合并进 `collab-current-need`（`data-testid` 不变）。实测 1487×1058 下页头高度 105px，与任务名长短无关。**Breaking Change：No**，未动 API、路由、命令 Owner、草稿保护与恢复规则。实跑范围见[验收表 §7](../testing/overall-acceptance-2026-09-28.md#7-项目列表页头试点与协作事实条修复2026-10-02)。

本轮**不做**的一项，需单独一轮：

**左侧壳分离。** 选定稿是 100px 图标栏 + 340px 近期任务栏两列；现状是导航与近期任务合并在一个侧栏。这属于 §17.8「全站共享壳」，改一次影响所有路由，不能混进单页迁移。

### 17.11 委托执行按选定稿收进「更多操作」（2026-10-02）

用户裁定以选定稿为准，§17.7「委托执行是页头常驻动作」由本节取代：`/agent` 的委托面板从 `PageHeader` 的 `actions` 移到 `more`，`actions` 只留「查看待处理 N」一个决策区主操作。**折叠不是隐藏**——准入被拒的原因由 `TaskDelegatePanel` 导出的 `delegateBlockedReasonFor` 统一判定，同一份结果既控制面板内按钮的 `disabled`，也渲染成页头常驻的 `collab-delegate-blocked`；两侧不会各算一套而出现「按钮说不可用、页头说可用」。原 §17.7 其余条目（UNKNOWN／控制请求／执行失败不折叠、事实条常驻、判断条与成果区结构）继续有效。

实测：`collab-goal` 高度 105px（可委托、无禁用原因时）与 138px（禁用原因常驻），展开「更多操作」前后高度不变。`delegate-task.spec.ts`、`commandPalette.spec.ts`、`collaborationWorkspace.spec.ts` 等 5 文件 123/123 通过。

任务详情页的委托入口不受本节影响，仍是页面主操作。

### 17.12 方案 2 全站生产接入（2026-10-02）

用户把 [ui-option-2-pages 提示词](../../prompts/ui-option-2-pages.md) 作为开发指令下发，要求从现有实现接续，完成共享壳、聊天区和 37 个页面/状态单元。本节拥有本轮的交互出口与页型分工；组件与布局规则归[设计系统 §9.3.1](design-system.md#931-方案-2-生产接入2026-10-02)，数值只归唯一 tokens。**Breaking Change：No**：路由、查询语义、`data-testid`、命令 Owner、HTTP 契约、数据库、权限与模型策略均未改动，也没有新增业务状态。

#### 17.12.1 交互规则

- **共享壳两列。** 图标导航只承担定位，近期工作单独成栏，各有各的滚动 Owner 与宽度。近期工作继续消费真实 Project/Task、原游标与范围，不创建第二套全局会话事实；选中态、深链恢复、续页、加载/错误与失权清缓存全部保留。**2026-10-15 折叠点由 `width < 64rem` 下移到 `width < 48rem`**（见[设计系统 §6 断点收敛](design-system.md)）：768px 以下两栏才整体收起、导航与近期工作由 ☰ 抽屉承担；48rem–64rem 保留三列，该区间侧栏用 `layout.shell.sidebarWidth` 默认宽度、不采用户拖拽宽度，拖拽手柄仍从 64rem 起关闭。
- **项目列表、待处理与动态收纳近期工作栏（2026-10-16）。** `/projects`、`/reviews`、`/activity` 与别名 `/activities` 将空间交给业务内容，隐藏近期工作栏及调宽把手，不空占折叠把手列。返回工作台恢复原折叠与宽度偏好；窄窗导航抽屉沿用原入口。本轮不将该规则推广到项目详情等其余路由。
- **新对话只有一个 Owner。** 近期工作栏头部的「新对话」只是回到 `/agent` 那条既有路径；会话草稿、文件夹入口与首条发送仍由协作页持有。
- **跳转链接由窗口框架持有。** 「跳到主要内容」排在桌面标题栏之前，因此它是第一个 Tab 站位（WCAG 2.4.1）。它是 `position: fixed`，归属从页面壳上移到窗口框架只改 Tab 顺序，不改视觉位置。窄窗抽屉、页面内跳转链接与各页 `PageHeader` 的焦点规则不受影响。
- **栏位拆分的宽度偏好兼容。** `relay.workbench.sidebarWidthPx` 沿用同一键与 160–320px 同一钳制区间，归属从组合侧栏改为近期工作栏；旧值对新单栏仍然成立，不迁移、不清空、不因此破坏拖动与键盘调整。
- **完整名称的键盘入口。** 页头标题是指向确切对象页的链接（`PageHeader` 的 `titleHref`）。`title` 属性只服务悬停，不算键盘入口。聊天页用它进入 `/tasks/:id`。
- **页头只留首屏事实。** 名称、真实状态、当前需要与本页首屏主操作常驻；验收目标、任务/执行详情、模式与普通工具按需展开，展开不推高页头。UNKNOWN、控制请求等待安全点、执行失败、权限/归档写阻断、读取失败、审批风险、冲突与原未决命令继续不折叠（§17.7 硬约束 2 不变）。
- **三类页型分工。** 列表页型＝标题、范围/筛选、列表与分页；阅读页型＝名称、确切版本、正文与来源；待处理页型＝对象、正文、条件、影响与判断。设置与创建页保留自然长表单。没有为统一外观给每个页面强加 `FactBar`。
- **待处理请求与阅读分层（2026-10-16 替代三列并排）。** `/reviews` 的请求列表占满首行；每条卡片先给事项与状态，类型、项目、时间和请求修订在下一行自然换行，不在窄列内再套五列表格。有确切产物版本时，`width >= 80rem` 在请求下方并排正文与判断详情，更窄时按列表 → 正文 → 判断顺序单列排列；无正文时不留空列。此前 `:has(> .review-reading)` 的高特异性双列规则压过 `<64rem` 的单列覆盖，产生隐式空轨，本轮改为默认单列、只在宽窗增加两列。阅读版本切换仍不改变判断绑定；决定集合、归档/过期/读取失败阻断与原命令核对沿原 Owner。
- **本轮明确不做。** 图中侧栏「搜索项目或任务」没有全量检索接口，不造可提交入口；Pack 仍是只读目录，不加选择/启用/编辑；连接不代表授权，不新增同步按钮；图中示例计数、日期与按钮位置不写入代码。

#### 17.12.2 覆盖与边界

37 项页面/状态单元与选定聊天页全部落在生产组件上（路由与 `data-testid` 不变），分五批推进：共享壳与聊天 → 三类样板（`/projects`、`KnowledgeReader`、`/reviews`）→ 其余列表与创建表单 → 项目/任务详情、三工作台、编辑/来源/完成凭据、知识、Skill/Assist、设置/连接 → Run 与关键状态。每批自检后由协调方在当前产物上独立核验，修复复验通过再继续。

本轮实际验证覆盖类型检查、生产构建、组件回归、浏览器只读取样与键盘路径；**真实业务写入、真实 Provider、恢复路径与 Windows 窗口/IME/DPI/安装验收未做**，相关出口保持未验收。实际成绩、环境与限制只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 17.13 首装空态：说清「没有」并给出入口（2026-10-06）

用户反馈「没数据的时候好空」。新增共享组件 `components/EmptyState.tsx`（`regular` / `compact` 两形态），替换 `/projects` 的 fixture 与 live 两个视图与左栏「近期的任务」。组件形态与视觉归[设计系统 §6 EmptyState](../frontend/design-system.md#emptystate2026-10-06)；本节只记交互语义。

- **范围区分是硬要求**：「首装为空」「搜索无匹配」「归档范围为空」是三件事，不能合并成同一句话。搜索无匹配不得暗示整个工作空间为空；归档范围为空不得提供「新建项目」这类无效入口。
- **读取中、读取失败与空列表三种状态文案不同**，不互相冒充；成功读取时默认选中首条，但不因此把「非空未选中」说成首装为空。
- **左栏只给文字动作**，不出现 primary；空态动作与页头常驻「新建项目」可以同屏并存，页头入口始终可发现、不因此隐藏，也不产生布局跳变。
- **不借本节名义改写其余页面**：未替换的空态与未验项只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 17.13.1 窄窗与短窗的全局「新对话」入口（2026-10-08）

全局「新对话」**只有一个 URL 入口意图**：每次不同的 `/agent?new=<key>`。协作页按这个键打开空白输入——不恢复最近会话、不沿用当前目录或任务；会话草稿、目录作用域与首条发送仍然只有协作页一个 Owner。

- **两个宿主共用同一条 href，不各写一遍逻辑**：宽窗放在近期工作栏头部，窄窗与短窗（该栏隐藏时）放在导航抽屉顶部。这样「语义等价」由构造保证，而不是靠两处实现对齐；也**不复用会话列表里的「新建会话」**——那个入口可能保留当前目标与目录。
- **抽屉里的入口是动作，不是导航目的地**：它不带 `aria-current`，视觉与语义都与同屏导航行分开（动作名用 `color.action.text`），点击区域与导航行同高。数值一律消费既有 token，不为它新建第二套尺寸或色值。
- **抽屉交互**：打开时背景与键盘交互正常；点击入口先关闭抽屉再直接进入空白讨论，不叠加第二层浮层；Escape 可关闭并把焦点还给打开按钮。抽屉关闭后焦点返回、滚动后入口不被 sticky 顶栏遮挡。
- **草稿随会话留在本机**：存在未发送内容时也直接进入空白讨论；原会话的正文按作用域保存在本机，回到原会话时恢复（见 §17.13.2）。入口层不新建第二套业务状态。
- **可发现性是本节的目的**：原先窄窗下全局入口随左栏一起消失，唯一替代路径藏在「选择文件夹（可选）」折叠区内——那是**入口不明显**，不是「新对话不可用」。

### 17.13.2 未发送草稿按作用域保留，切换不再确认（2026-10-19）

2026-10-19 用户指令：「更换工作区的时候会弹出这个弹窗，删除这个弹窗，没有用，直接切换工作区就好了，保存输入框里面的消息」。据此取代 2026-10-08 的「保留并继续编辑 / 丢弃并继续」弹层与其焦点恢复状态机。

- **切换直接生效**：换目录、换会话、切档、切任务、左栏换工作与路由离开都不再弹「未发送的内容」或「保留未保存的修改」。唯一仍拦下切换的是「原命令结果待核对」——它不是本机草稿，必须留在原作用域核对回执，不能靠切走绕过。
- **草稿按作用域留在本机**：会话输入器按 `session:<sessionId>`、首条输入器按 `first:<workId|workspace>` 把正文写入 `localStorage`（`src/lib/composerDrafts.ts`），回到原作用域时原样恢复；发送成功、执行清空或明确丢弃后删除，不留空记录。
- **只存正文**：已选资料、技能与判断说明仍是「本次请求的候选输入」，发送时由服务端按获准范围与原版本复核，不能被本机草稿说成已确认。草稿不参与准入、不自动发送、不改变会话归属，新作用域也不会继承上一处的正文。
- **在途不等于待核对**：首条消息的 `pending` 在命令发出前就已登记。在途时只渲染一行安静状态「正在发送首条消息…」加行内文字键「查询回执」（2026-10-20 用户截图指认：在途整块渲染 command_id 与核对按钮，读作出错，出现消失之间把界面顶得一闪）；建会话这一拍的状态行只给辅助技术（2026-10-22，DEV-0110），消息提交在途的可见行与「查询回执」不变；command_id、失败原因与「查询首条回执」「按原命令重试」两个出口的完整核对块，只在发送真的停下且命令仍未决时出现（2026-10-19 用户反馈「发完消息会出现这个」）。悬住的请求没有超时，在途文字键是唯一的人工恢复出口，不可去掉。
- **跨设备与跨 workspace 不串**：键按 `workspaceId` 与作用域分隔；本机存储不可写时只影响「跨作用域保留」，输入本身照常。

### 17.13.3 切换工作区不闪（2026-10-19）

用户指认「切换工作区界面会闪烁一下」。根因是切换时整页按路由 key 重挂载，首帧先渲染上一个状态的空壳（会话输入器、加载文案、禁用原因），数据到达后再整块换成任务视图。

- **首帧与目标同构**：`?work=` 已给出但任务事实还没读到时（`awaitingWork`），不再渲染会话视图，改为「左对话列＋右成果列」的双列骨架（`data-loading="work"`，文案「正在打开这项工作…」）。列宽与 `data-layout-mode` 与任务视图一致，避免「单列 → 双列」的整块替换。
- **未读到不等于读取失败**：`projectArchivedAt === undefined` 表示「项目事实还没读到」，不再写成「Project 事实正在核对或读取失败」；只有 `projectReadError` 非空才说明失败。协作页、任务详情与 Run 页同一口径——此前切换工作区会先闪一句红字再消失。
- **加载提示延迟出现**：新增 `lib/useDelayedVisible`（默认 200ms），用于会话消息、任务视图成果、工作详情抽屉成果、右侧版本面板与协作页的重读提示。读取通常几十毫秒完成，立即渲染提示再换成内容会被读成闪一下；真的读得慢时提示照常出现，等待不被藏掉。错误、阻塞原因与命令回执不延迟。
- **不改变事实来源**：骨架只是首帧占位，不缓存上一个工作区的任何内容；数据仍按原作用域读取，读取失败仍显示原有错误态。



### 17.14 任务详情精修样板与全站视觉收口（2026-10-07）

视觉规则归[设计系统 §9.5](../frontend/design-system.md#95-任务详情样板与全站枚举呈现2026-10-07)；本节只记业务交互出口。旧 class 与 `data-testid` 一律保留，路由语义、业务文案与命令 Owner 不变。

- **阅读顺序**：任务目标 → 验收条件 → 验收依据 → 前置依赖 → 基本信息。主区为纸面阅读流（区块间「标题＋内容＋分隔线」），不逐块套卡片；右栏为紧凑事实列，标题「当前状态」。
- **标题行**：主标题与状态 chip 同行，长中文标题自然换行（不用负字距、极小字号或截断）；页头主操作按状态切换——默认「进入协作工作区」，AI 持有执行权时为「前往运行页请求接手」。
- **页签行**：左侧页签，右侧「完善定义 / 验收方案 / AI 讨论」等辅助文字入口，窄窗自然换行。验收条件区块跨页签常驻（隐藏），保证补充条件草稿与未决命令 Owner 在切页签后仍然保留。
- **验收依据四种事实分开呈现**：检查是否运行、证据是否关联、版本是否匹配、当前结果是否适用。「尚未加载」「确认没有」「字段缺失」三种状态文案不同、不互相冒充；未运行、未确认、UNKNOWN 与失效结果不得使用成功色或勾选样式。
- **受验对象按三态呈现**：字段缺失、已提供但为空（空对象）、已提供具体内容（折叠技术 JSON）；不直接输出 `JSON.stringify` 结果。
- **同名条件行按结构区分**：有编号的「验收条件」用「编号列＋正文列」；无编号的「验收依据」用单列、正文占满阅读宽度。差异由结构表达，不按子节点数量隐式推断。
- **页头技术信息降级**：完整任务 ID 降为 `code` 小字缩略，完整值由同页头内默认收起的 `<details>` 给出（可展开、可选中复制）；项目名与修订等元信息分组换行，「标签＋数字」组内不断行。信息不隐藏。
- **技术字段按需展开**：计划摘要、验证会话与完成凭据收进 `details`，展开不推高页头；长期 UUID/hash 保持可核对但不占首屏。
- **40px 标题是既定 token**，不是可随手调整的缺陷；不因本轮改动重写全站字体体系。

### 17.15 控件交互基线与响应式收敛（2026-10-08）

控件与断点规则归[设计系统 §9.6](../frontend/design-system.md#96-控件基座与响应式收敛2026-10-08)；本节只记任务详情与运行页在控件层的行为要求。

- **同屏只有一个主操作**：一个决策区只在页头 `actions` 放一个 primary；次级与诊断动作收进「更多操作」，折叠不是隐藏（准入被拒的原因在面板打开时可见）。
- **按钮变亮只说明没有被本地拦住的理由**：不代表服务端已确认安全，也不等于获得新授权。
- **未确认的 Run 控制命令身份必须跨页面重读保留（2026-10-08 补充）**：结果未知的控制命令留下的是原 `command_id`、冻结的请求类型与「核对原命令回执」入口，这是恢复身份的唯一凭据。Run 的事实修订（`revision` 变化）、事件刷新与**整页重读**都不能清掉它——组件内存状态在刷新后就没有了。因此该身份按 `(连接, 工作空间, Run)` 分键存入 `sessionStorage`，与文件写处置面板、协作页未决命令同一既有做法：同 Run 的刷新与重读都取回同一条命令身份，换 Run 或换连接各读各的，不把上一 Run 的 `command_id` 带过去。命令结算或被服务端明确拒绝时同步收口并解除提交锁。`sessionStorage` 只是**本机恢复线索、不是业务事实**：核对结论仍以服务端按原 `command_id` 给出的回执为准，界面不得把它升级成「已受理即已生效」。
- **三种状态固定分开呈现**：本地提交记录（尚未被服务端记录覆盖）、在途窗口（「正在处理／Run 尚未暂停」，不改写 Run 事实）、服务端记录（唯一事实来源）。终态另附停机边界说明：Run 进入终态只说明 Run 与任务事实，**不等于全部 Windows 进程已停止，也不等于工作目录已释放**。
- **响应式断点收敛为三档语义**（`<48rem` 折行/降级、`<64rem` 大屏增强、`<80rem` 右栏出现）。窄窗下「查看运行信息与控制」抽屉入口必须仍可达，暂停/停止/交接/取消入口保持真实状态；不为测试误操作用户正在执行的 Run。
- **断点档位与顶栏 token 的收敛回写（2026-10-10）**：宽度断点只允许四档语义值 `breakpoint.medium/large/rail/wide`（48/64/80/90rem），守卫见 `tests/responsiveTiers.spec.ts`，边界几何见 `tests/browser/responsiveFoldGeometry.spec.ts`。`layout.header.height` 自本节起专指 `.app-topbar` 实际高度（`control.height.comfort` + `border.width`）；桌面上方的固定区总高 = 原生标题栏 `control.nav.height` + 该 token，锚点滚动预留按此计算。`views/AssistView.css` 的一处旧式 `max-width: 64rem` 写法因该文件属其他在途任务暂缓归一，档位本身合规。
- **UI 检查覆盖 Loading、错误、人工处理、暂停中/已暂停、冲突与恢复后的真实状态**，不只检查静态排版。

## 19. 下一段工作计划（N04，已确认规划）

本节记录二轮规划的呈现与用户操作边界，尚未实施或验收；产品取舍只在[后续路线 N04](../requirements/post-v1-roadmap.md#n04-周期计划与重排建议)维护，不继承 Today、Task 提案或旧页面的成绩。

- 发起时显示用户选定的项目/目标、来源范围和本段时间窗口。窗口的起止时点可辨认，重新读取或核对原请求不自动重置；它不是执行授权。可用时长不从点击行为、Today 置顶或模型判断推导。
- 候选先说明本段主线、必要前置、可做部分和延后原因。每项列输出/检查依据、已登记依赖、估时来源及未知项；预计执行/等待/审阅时间与人工投入分列，重叠时间不重复相加。缺少估时不显示为零，未设置优先级不冒充用户确认的 NORMAL，INFORMS 不冒充 BLOCKS。
- 关键任务估时未知时展示有时间边界和明确输出的诊断候选，后续任务保持未知。诊断达到预算仍未定位时，阶段成果明确写未定位，提供证据、排除项与下一步入口；不自动延长或将原修复任务显示为完成。
- 用户逐项接受仍经原 Task/提案入口，未接受的候选不成为正式任务。计划中的诊断目标与原修复目标可区分，任何完成结论绑定自己的条件和确切成果；接受计划不自动 Delegate 或批准工具。
- 来源变化、读取失败或部分应用时保留已提交事实、草稿与原命令核对入口；活动任务不静默改写。没有额外执行授权时只呈现计划，后续明确执行仍复用原应用用例和 N06 授权边界。

## 20. 一次性继续项目提醒（N05，已确认规划）

本节保留规划呈现；2026-10-14 已接基础数据/生命周期扫描、客户端与原通知轮询功能，协议归 HTTP 契约 §10.76，实际成绩归统一验收表。没有新增设置/待处理页面或修改布局，完整 UI 与 Windows 原生投递仍未验证；首轮范围与触发规则归[后续路线 N05](../requirements/post-v1-roadmap.md#n05-有限触发与提醒控制)。

- 设置时明确项目、一次性的日期/钟点及时区，显示所确认的实际触发时刻。保留原设置时区；设备/显示时区改变后显示对应当地时间，不能把相同当地钟点当成原提醒或自动修改配置。改时间需显式编辑，失败/回执不明保留原配置和核对入口。
- 触发只形成提醒/待处理，不调用模型。点击进入原计划入口，由用户填写本段时间并主动发起；旧通知点击时重读当前项目与事项事实，不代答审批或恢复执行。
- 退出不运行；重开对错过的有效提醒最多形成同一条待处理，重复刷新/重开不重复补。显示设置、关闭通知或投递失败不抹掉原事项；禁用未来触发与处置已形成事项分别表达，不把改时间包装成已处理。
- 应用内保留事项及处理入口，Windows 投递复用原宿主能力和权限边界。本节不改变 V1 必须介入提醒规则，不增加后台常驻、固定周期或定时生成模型计划。

## 21. 有限任务链的授权与接续（N06，已确认规划）

2026-10-14 基础后端/客户端接续归 HTTP §10.77，当前只接固定 Markdown 链、明确累计额度和原控制/完成引用，没有本节新 UI；真实 Windows、外部工具和完整接续交互尚未验证。ACTIVE 是授权有效，PAUSING 是请求尚未安全应用，实际 Run 状态和业务完成沿原事实呈现。

本节为规划呈现，尚未实现或验收；任务链范围、预算与到期规则归[后续路线 N06](../requirements/post-v1-roadmap.md#n06-有限连续委托)，工程协议仍见 [ADR-013](../decisions/ADR-013-bounded-project-continuation.md) 的 Proposed 边界。

- 执行前展示选定任务、固定依赖、来源/工具/资源范围、任务数和调用数上限、授权有效期及停止条件。计划接受与执行请求分别表达，N04 的计划窗口不能默认充当授权期限。
- 到期时显示停止新准入及原任务的持久暂停请求。安全点尚未确认时显示“暂停中”，核实后才显示“已暂停”；已完成任务保留完成事实，UNKNOWN 与未决外部效果继续展示原核对入口，不能用倒计时归零宣称已停。
- 阶段进度引用原 Task、验证、人工判断与完成事实；未知用量保留预留并说明为何停止后续准入，金额缺依据时保留未知，不显示零消耗或保证封顶。
- 重开先显示原任务、累计预算、未决动作与控制状态，用户明确继续后仍核验授权及当前资格；旧授权有效不自动开始下一项。读取失败或旧请求待核对时保留原身份和草稿，不换身份重试或自动恢复已撤销权限。

## 22. 会话内可折叠执行计划（推荐设计）

2026-10-03，仅补充文档与提示词，尚未实现/验收。产品范围归[总纲 §0.7](../../Personal_Workflow_OS_Master_Spec.md#07-会话内可折叠执行计划2026-10-03推荐设计)，事实归属及更新归[运行架构 §2.4](../architecture/runtime-context.md#24-会话执行计划的归属与持久更新推荐设计)，反例归[测试计划 §19](../testing/verification-plan.md#19-会话执行计划验收规格)。计划展示沿用当前对话工作区，不复制执行摘要、Run 控制、Trace 或成果 Owner。

### 22.1 入口、折叠与进度

- 首片只在会话通过原执行请求关联到确切 Run、且该 Run 已有持久计划时显示。纯讨论与无计划的一步操作保持自然对话；加载失败不以聊天 Markdown、固定五步 RunStep 或模型自由文本补造清单。
- 输入区附近默认显示紧凑摘要，点击展开列表。摘要包括“已完成 X 项 / 当前有效 Y 项”、当前步骤和真实 Run 状态；cancelled 项另列数量并可查看历史，不计入有效分母。该计数不是工作量百分比或剩余时间预测。
- 当前步骤优先显示 in_progress，否则显示下一 pending 项；全部标记完成时明确这是计划步骤状态，正式完成及所需下一动作按原 Run/验证事实显示。暂停中、已暂停、取消、失败、等待审批及 UNKNOWN 的真实状态优先，不被计划中的 in_progress 遮盖。
- 折叠是本设备的展示偏好，展开和查看历史不发业务命令、不调用模型；状态更新不反复展开列表或抢走输入焦点、阅读位置。沿用共享组件与 design tokens，不建立第二套数值、设置页或全局待办页。
- 复选框只读，步骤状态由已持久记录投影。用户改目标、范围或要求时沿原消息/执行请求及安全停止机制处理，不通过勾选或改清单隐式修改在途执行契约。

### 22.2 完成声明、依据与故障

| 所见内容 | 解释与操作边界 |
|---|---|
| 步骤状态与修改原因 | 读取当前计划 revision；Agent 的 completed 标记可见，但不是 Verification PASS。改标题、重排保留同项身份，取消或替换可查原因与历史 |
| 依据入口 | 展开该步骤关联的确切工具结果、文件变化、Artifact 版本或检查记录，复用原阅读/Trace 组件；显示实际成功、失败、未知、未运行与适用性，不能把失败回执显示成“已验证” |
| 没有可核对依据 | 明示“Agent 标记，暂无执行依据”；分析步骤可保留声明，不凭空补测试、时间或产物，也不强制每项都生成 Artifact |
| 条件或版本变化 | 已有关系能判断的依据标为历史/过期；关系不足显示待核对。查看旧依据不恢复权限或自动重试；首片不提供自动影响传播或重新排程 |
| 首次读取、错误或断线 | Loading/错误/重试可达；同对象的旧快照若保留必须标明读取时点，切换会话或 Run 后不沿用旧清单。首次/重连的读取与订阅窗口按架构规则闭合，不把 SSE hint 当新业务事实 |
| 重开或恢复 | 展示持久计划、原已结算结果和未决状态；仅恢复阅读，不自动 Resume/Delegate、重建项或重发外部动作 |

同一会话可关联多个执行请求或 Run，清单按确切关系呈现，不能无条件把最新一条挂到当前目标。请求与页面绑定会话、Run、连接 epoch 和 plan revision，旧响应晚到被忽略；查询失权时不展示计划正文、引用名称或历史数量。长列表可读，短窗口与窄窗口保留输入和原控制入口，键盘展开/折叠、焦点归还、中文 IME 与 DPI 分别验证。
### 18.6 页面原型结构对齐（2026-10-03）

用户以页面原型与实际截图提出结构差异并要求对齐。**原型是静态图，只定结构与层级，不定距离**：所有宽度用 rem token，跟随根字号与用户缩放，不从截图抄像素。回归断言相对关系（卡片上限 > 消息列上限、上限单位是 rem），不锁绝对值。**Breaking Change：No**。

- **消息列与输入器同宽。** 两者共用 `layout.reading.maxWidth`（72rem）：宽度必须一致，否则滚动条会贴着其中一侧。同日按用户要求把它们**合并成一个 token**，原先单独的 `layout.composer.maxWidth` 已删除。消息流本身铺满中栏（滚动容器 full-bleed），真正的阅读 measure 由居中的 `.agent-message-list` 收窄——滚动条因此贴着中栏右缘，不再压在消息列旁边（deepseek-harness `ChatView.module.css:54-63` 同一做法）。
  - **同宽不等于同轴（2026-10-19 用户截图指认「左边跟输入框的左边对齐就好了」）。** 消息列在滚动容器里居中，而 `.agent-chat-transcript` 的 `scrollbar-gutter: stable` 把自绘滚动条（12px）算在 padding box 的 inline-end：content box 右边少 12px，消息列因此整体左偏 6px；输入器不在滚动容器里，没有这 12px。修法是把**一整个滚动条宽度补在起边**（`padding-inline: calc(gutter + var(--chat-scrollbar-width)) gutter`），content box 恢复对称，消息列、目录细条、输入卡与队列卡才回到同一根中线。滚动条厚度记成 `--chat-scrollbar-width`，与 `::-webkit-scrollbar` 同一处维护——CSS 读不到滚动条的真实宽度，只能靠这一个常量。
  - **证据**：真实 Chromium 1440 宽，改前消息列 `495.19`、输入卡 `501.19`；改后两处同为 `501.19`（左右缘都 ≤0.01px）。420/700/780/820/900 宽的窄档本来就 flush 对齐，读数不变。常驻断言在 `tests/browser/chatReadingColumn.spec.ts`：宽档要求中线与左右缘都 ≤1px，窄档要求左缘 ≤1px（宽度差属于「卡按 measure 居中」那条规则，不在本断言范围）。`uiOption2FirstSession.spec.ts` 原有的「同宽」用例只比 `max-width` 字符串，看不出这 6px——该套件当前被并行会话的发送链改动拖红（夹具在 `assist-copy-a-0` 超时），故断言另立一处，不在那条红用例里加。
  - **已知残余**：阅读列落在 768–832px 那一段时，消息列被满宽撑开、输入卡按 measure（744px）居中，卡比列宽 16px（左右各 8px 对称外伸），左缘因此仍差 8px。这属于「卡宽于列」的另一条规则（本轮未改，改前是 4px 的非对称偏差）。
- **工作台页不显示面包屑。** 项目/任务归属由页头 `collab-current-need` 那行承载，标题的 `titleHref` 是返回确切任务的入口；面包屑在该页重复且每次进页多两次无用读取，已连带删除。其他路由的面包屑不变。
- **委托准入被拒的原因不再常驻页头。** 原因由「更多操作」内的委托面板就地显示：不再横贯页头，但也没有把原因藏起来——面板打开即见。
- **命令回执留在输入器这一列内。** 「消息已排队」「受托已受理」「原命令被拒绝」共用同一机制，不横贯工作区成底栏；不因为版式对齐而删掉反馈。**2026-10-16：回执照同样渲染在输入卡之外**——与档位说明、错误、待核对一起排在卡片下方的这一列里。卡内恒定只有正文、工具行与发送键，卡片因此不随「有没有回执」长高变矮（规则与实测归[§25.1](#251-控件层级)）。
- **左栏搜索只筛已加载范围。** 复用全局 `.search-field` 原语；命中数与「已加载 N 项」必须同时可读，无匹配时明说只覆盖已加载范围，不假装是全量搜索。
- **左栏搜索的输入点必须好读（2026-10-18 两轮用户截图指认：先「光标太小、离搜索太近」，再「光标往左一点，放大镜右侧那块放不了内容的区域该调小」）。** ① 光标不是字号或控件高度决定的，而是**行盒**决定的：本栏 input 此前沿用 1.5 行高（21px 行盒），Chromium 画出的光标只有 11px、宽度恒为 1 设备像素（平台绘制，CSS 无属性可加粗），在 32px 胶囊里读成一根小短线；现取 `control.height.compact − space.1`（28px）写回**容器**（`font: inherit` 会压掉内层声明）→ 光标 18–19px。② 图标右侧那块「不能放内容」的区域就是 flex `gap`：第一轮误判成间距过小、曾提到 `space.3`(12px)，光标修大后那 12px 读成死区，**本轮调回全局默认 `space.2`(8px)**；放大镜同时收到 `font.size.body`(16px)。净结果是 160px 拖拽档 input 96→100px、placeholder 余量 12→16px。搜索范围、命令与 `data-testid` 未动，零新增 token；数值与机制归[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)，回归由 `recentWorkRailDensity.spec.ts` 的计算值 + 像素实测双断锁住（gap 断言已随之改成 `space.2`）。
- **复制是纯客户端动作。** 挂在每条已完成 AI 回复上，走剪贴板、不发命令、不落库。「未读资料」与「赞/跌」在生产代码里没有领域状态与写路径，按用户决定推迟，不用假入口顶替。**复制键排在用量左侧**（2026-10-16 用户指令）：它是这一排的第一项，左缘因此与正文左缘——也就是原「用量：…」的起点——对齐，用量跟在键后面占满剩余宽度；两者仍只占一行，不新增第二行。这里的「未读资料」指消息／资料级的读态；2026-10-17 起左栏会话行的「标记为未读」是另一件事——它有服务端 `unread_at` 与 CAS 命令，见 §28.1。

- **AI 消息头显示任务耗时（2026-10-18 用户截图指令）。** 在「AI + 时间」之后增加耗时：PENDING/RUNNING 从消息提交时刻 `created_at` 起算、每秒刷新，写作「已用 X 秒」；终态改用服务端结算时刻 `updated_at` 冻结，写作「耗时 X 秒」，刷新页面后读数不变。在途消息的 `updated_at` 是心跳，不能当起点或终点；缺 `created_at`/`updated_at` 或用户消息不显示，不用「0 秒」冒充未记录。纯展示层：不改命令、存储与既有 `data-testid`，该读数不是 Run 账本或验收证据。

- **输入区内部结构（2026-10-03 二次调整，按参考图）**
  - **去掉输入框与正文之间的横线**：卡片边框已经分开两者，横线只是噪声。同时**去掉 textarea 的拖拽改高**（`resize: none`），高度只随内容增长，避免拖出与消息区不一致的任意尺寸。
  - **发送键是正圆，圆心与卡片圆角圆心重合**：键的直径正好等于 `2 × radius.composer`，因此与卡片下边、右边**同时内切**，正好穿过圆角弧的两个端点——「圆心重合」在这里是精确相切而不是近似。形状参考 Codex 的圆形发送键，配色与版式仍用本项目 token。
  - **键、卡片圆角与底栏左侧行高由同一个 token 推导**：`radius.composer = 1rem` 同时决定三者（键直径与行高都是 `2 × radius.composer` = 32px）。不再各写一个数字。
  - **底栏底边与发送键底边同在卡片内缘**：键 `bottom: 0` 相对卡片 padding box，底栏若仍压在卡内 `padding-bottom` 与自身 `padding-bottom` 里，两行会差出一段距离。底栏因此 `margin-bottom` 抵消卡内下边距、`padding-bottom` 归零；两者同为 `2 × radius.composer` 高，竖直中心随之重合。断言看的是竖直中心偏差 ≤1px，不是某个写死的像素。
  - **可点击目标由 painted 尺寸直接满足**：32px 已高于 `control.target.minimum`（24px），不再依赖 `::after` 扩展命中区。
  - **消息行没有左右头像**：角色只由「我 / AI」标签与气泡位置区分。头像曾是重复占位，还把正文列挤窄。
  - **发送后不再提示「消息已排队」**：那条 notice 只复述已提交的 202 回执，不携带新事实；消息的 PENDING/RUNNING 状态已在消息行说明。取消意图、提案接受回执、原命令回执这三类 notice **保留**，它们各自说明不同结果，仍渲染在输入器列内而不是整宽底栏。
  - **资料/讨论是无边框 chip + 右侧 chevron**，两枚 chip 之间一条竖分隔线（`deepseek-harness` `InputBar.module.css` 同为无边框 + 右侧 chevron，但它用 `gap: 12px` 而非分隔线；分隔线按参考图保留）。chip 的展开态由 chevron 旋转表示，不再用 `+ / −` 前缀符号。
  - **回到最新只有图标**：去掉可见文字，可读名称与状态放在 `aria-label` / `title`；背景透明、无边框、不带浮层阴影，水平居中浮在消息列底缘。它移出文档流不占布局高度。
  - **该行其余元素的垂直位移与发送键不同**：圆角圆心恒在卡片外框内 `radius.composer` 处；任何高于 `2 × radius.composer`（32px）的行内元素若以它为竖直中心必然越过卡片底边。底栏左侧 chip 已取到与键相同的 32px，此时整行以同一中心对齐；若再整体下移到圆角圆心，32px 的行会跨过底边。因此保留 `align-items: center` 的同行居中，未强行位移。这是几何硬约束，不是遗漏。
  - **消息流是铺满中栏的滚动容器**：滚动条贴着中栏右缘，不再压在居中的消息列旁边；阅读 measure 由居中的 `.agent-message-list` 收窄。居中基准是滚动容器的**内容盒**（`clientWidth`），`scrollbar-gutter: stable` 会让内容盒比边框盒窄。

对话区的纵向滚动 Owner 只有一个（消息流本身），已固化为回归。目录范围条是消息区上方的上下文入口，用户主动展开时由它自己滚动（`max-height: 40%`），不计入对话区的滚动 Owner 断言。成绩与冲突记录归[验收表 §10.9](../testing/overall-acceptance-2026-09-28.md#109-页面原型结构对齐2026-10-03)；本节覆盖 §17.7 关于「面包屑承载上下文」与「委托阻塞原因必须留在首屏」两条旧规则，其余分栏、专注模式、草稿保护与恢复规则不变。

### 18.6.0 消息区高度：不再被同列区块挤没（2026-10-05）

**现象**：输入框上方与消息区之间出现一条读不到文字的空白带，最新回复看不全。看起来像输入器盖住了消息，实际是**消息区被同列其他区块挤到只剩十几像素**——720px 窗口下转录区实测只有 16px（正好一行文字高），最新一条 995px 高的回复只有 8px 落在滚动窗口内。

**根因**：中栏是固定高度的 flex 列（`.collab-center`，`overflow: hidden`），只有消息区可伸缩，但同列其余区块都用 `flex: none`（即 `0 0 auto`），加上两个具体来源：

- `.agent-assist` 写成 `flex: 1`（`flex-basis: 0`）时**不按内容参与收缩**，目录范围条实测占 424–478px 也不肯让出高度，整列只剩 174px；
- 等待队列空态用一块 `min-height: 4.5rem` 的**不可见占位**「防跳」，于是每一条会话都在输入器上方永久留出一条 72px 空白带；执行摘要同样因 `min-height: auto` 拒绝压缩。

**规则**：

- **消息区先拿高度。** `.agent-chat-transcript-shell` 用 `flex: 1 1 auto` 并保留阅读下限，`.collab-center > .agent-assist` 的 basis 改为 `auto`。溢出内容仍由消息流自己滚动，不隐藏任何已渲染内容。
- **空队列不预留高度。** 队列出现时压缩的是滚动窗口大小，不是已渲染内容——这正是原注释想避免的「跳动」，因此 `.assist-queue[data-empty="true"]` 不再占位。
- **同列其他区块先让位。** 执行摘要 `min-height: 0`，高度不足时先压缩自己，且不新增滚动容器（对话区仍只有一个滚动 Owner）。

**Breaking Change：No**（纯展示层，不改路由、命令 Owner、HTTP 契约、数据库与权限）。回归见 `uiOption2FirstSession.spec.ts` 的「空队列占位不占高度，消息区不被输入器上方的空白挤掉」；验证记录归[验收表 §10.15](../testing/overall-acceptance-2026-09-28.md#1015-转录容器-16px-视口缺陷已修2026-10-05)。

### 18.6.1 用户消息的「我 / 时间」贴整行右缘（2026-10-04）

用户消息是 `row-reverse` 的右对齐气泡，meta 行（「我」+ 时间）原本是气泡的第一个子元素、落在气泡内侧。消息一短，那几个字就停在离右缘很远的位置，读起来像挂在半空。**气泡宽度、正文列宽度与右对齐都不变，只改 meta 自己的横向位置**。**Breaking Change：No**（纯展示层，不改路由、命令 Owner、HTTP 契约、数据库、权限与 `data-testid`）。

- **meta 保持在文档流内，靠横向溢出贴边，不得用绝对定位。** 绝对定位让 meta 脱离文档流，正文随即上移填补空位，实测「我 / 时间」与第一行正文**重叠 13px**。改用 `::before` 按 `line-height` 补高同样不可靠——它依赖「`line-height` 等于 meta 盒高」这个并不成立的假设。
- **负外边距只减不加回。** `margin-right` 一路吃满气泡的横向 padding，把 meta 的右边界推出气泡；同时必须给 meta `max-width: none`，否则 `.agent-message-body > *` 的 `max-width: 100%` 会把负外边距抵消。若再补一个等量 `padding-right`，盒子贴住了边、文字却仍差一个内边距。
- **右对齐用首个 flex 子项的 `margin-left: auto`，不能只写 `justify-content: flex-end`。** meta 是 `flex-wrap` 容器，`justify-content` 只在换行后的多行之间生效，单行时仍按 `flex-start` 排。
- **「贴右缘」指 meta 里最后一个可见子元素**（通常是时间，其次是状态标签），不是「我」那一个字。断言也不得绑死在 `<time>` 上——夹具消息可能没有 `created_at`。

**几何断言全部走实测，不靠推断**：右缘偏差依次量到 **32px → 16px → 16px → 0**，每次都定位到一个被忽略的约束（`row-reverse` 下负外边距方向相反、`right` 的内边距、`justify-content` 对单行无效、`max-width: 100%` 抵消）。最终断言「meta 最后一个子元素右缘、行右缘、消息列右缘三者相差均 ≤1px」且「正文起点不低于 meta 盒底」。

### 18.6.2 三点是「这条还在跑」的持续信号（2026-10-04）

三点此前只在**首字未到**时出现（渲染条件含 `content === null` 且排除「preview 可读」）。preview 一到达条件就为假，于是**流式输出期间唯一的活体信号整段消失**，只剩一行静态草稿文字、看着像卡住——这不是动效被禁用，是元素根本没渲染。

- 改为 `RUNNING`/`PENDING` 期间**一直显示**，与有没有正文、预览无关。
- `cancelRequested` 时不显示：meta 行已经写明「正在取消」，两者并读反而矛盾。
- 可访问名称同步改为「正在生成」/「已提交，等待处理，正在生成」。

### 18.6.3 已回退：用户消息吸顶（2026-10-04 实施，同日回退）

曾实现「视野里没有用户消息时，最新那条吸顶在转录区上沿」，**同日按用户要求整体回退**：删除 `lib/assistTranscriptPin.ts`、`AssistView` 的 `pinnedUserMessageId` state 与 `syncPinnedUserMessage`、`AssistView.css` 的 `.agent-message-slot[data-pinned="true"]` sticky 规则，以及配套的纯函数 spec、组件回归与两条浏览器用例。**未回退**的是同日单独提出并确认的 §18.6.1「我 / 时间」贴右缘与 §18.6.2 三点常显。

**回退原因（供后续同类设计参考）**：该功能在实现期连续暴露三个真实缺陷——长用户消息被遮挡、候选未到上沿被拽到半空、sticky 生效后被钉行自身「永远可见」导致吸顶/取消来回抖动；修完仍引入了 `setState` 自我触发的无限循环（`Maximum update depth exceeded`），需改用 ref 绕开。同时它的浏览器几何验证长期被既有布局缺陷阻塞（转录容器视口被压到 16px），只能靠人工观察确认。**教训**：在同一条滚动路径上叠加「测量 + 状态 + CSS 定位」三层时，判定条件会互相污染；这类需求应先确认是否有不引入新状态的呈现方式（例如不透明底色 + 现有滚动能力），再决定是否值得引入测量逻辑。

成绩、阻塞与未覆盖出口只见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 18.7 目标与任务的轻量起步

2026-10-04，用户确认产品原则；**本节新增的轻量 Goal 创建入口已于同日实施并复验**（成绩归[验收表 §当前功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)的「目标/任务轻量起步与状态接续」行），完整状态接续出口与 Task 轻量化仍待实施/复验，已有文件夹入口与 Task 创建链不重做。产品核心归[总纲 §0.8](../../Personal_Workflow_OS_Master_Spec.md#08-状态驱动与轻量起步)。本节补充 §18.1–18.3；§17 中创建页的「自然长表单」只约束保留的详细编辑页，不能解释为每次创建都必须先填写完整表单。

**轻量 Goal 创建入口的已实现边界（2026-10-04）**

- 入口在 `/projects?view=goal`，由项目页页头「记录目标」进入。它是 Workspace 级事实的入口，**不要求先建项目**。
- 用户先表达想达到的结果；**标题由输入首行确定性派生并可就地改写**，改写后不再被输入覆盖；说明保存用户原话。入口**不调用模型**编造期限、完成条件或授权。
- 保存走既有 `CreateGoal` 用例（Goal 的唯一 Owner），**不新增端点、命令、migration 或第二套事实**。
- **创建 Goal 不隐式关联任何 Project**：关联是独立的 `LinkProjectGoal` 命令。入口只登记作用域事实，并如实告知「还没有关联任何项目」。
- 入口**不建立 Task、不改 Task 准入、不触碰权限或动作审批**，也不靠自动开放工具权限省步骤。
- 响应丢失按原 `command_id` 查回执；只有服务端明确 `COMMAND_NOT_FOUND` 才开放**同 ID 同载荷**重试。传输失败不推断为业务失败。
- 示例模式如实说明「不能保存目标」，不生成假 Goal 冒充已保存事实。

**Goal↔Project 关联入口的已实现边界（2026-10-04）**

- 关联面板位于**创建成功页**：Goal 建好后用户就在这里决定是否、以及关联到哪个项目，不必另找入口。
- 关联是**独立命令** `LinkProjectGoal`，需要用户明确选定项目才发起；创建 Goal 本身仍不隐式关联任何 Project。
- 只列**进行中**项目；已归档项目不在此关联。
- `expected_revision` 取项目列表里那份 Project 修订，由服务端做 CAS。**修订冲突时重新读取项目并要求用户再次确认**，不用新修订自动重发，也不覆盖他人的关联变更。
- 项目列表读取失败时**不提供关联入口**，也不据此推断项目范围；显式重新读取成功后才恢复。
- 重复关联由服务端以 `INVALID_TRANSITION` 拒绝；这是**明确拒绝**，按拒绝如实呈现，不进入「结果不明」的回执核对路径。
- 关联载荷只有 `command_id`/`expected_revision`/`goal_id`：**不建 Task、不改 Project State、不替你决定下一步、不触碰权限或动作审批**。
- 响应丢失按原 `command_id` 查回执；只有服务端明确 `COMMAND_NOT_FOUND` 才开放**同 ID、同 Project、同修订**重试。

**Task 轻量起步的已实现边界（2026-10-04）**

- 入口是任务页的「轻量起步」，与「新建任务」**并列**（`?view=create&light=1`）。完整表单保留为详细编辑入口；两者共用同一套提交、回执核对与原 ID 重试机器，**不是两套实现**。
- 一句表达即可保存：标题由首个非空行**确定性派生**且可就地改写（改写后不再被输入覆盖），预期结果保存用户原话；不要求先填项目、验收、执行方式或依赖。
- **这一步固定以「暂存待整理」提交**：不带验收条件，也**不尝试**转为「可开始」。创建按钮的文案就是「保存为待整理」，界面明说缺完成条件时系统不会把它变成可开始、也不会启动任何执行。
- 这不是靠放宽验收栅栏换来的：服务端对「没有必需 criterion」的 Task 另有 READY 栅栏（`task-readiness` 的 `REQUIRED_CRITERION_MISSING`），已由真实 PostgreSQL 集成固定（`task-lightweight-fence`）。
- 轻量入口**不代填项目**、不设执行方式、不触碰权限或动作审批；沿用既有草稿保护。
- **已知约束**：当前没有公开入口在创建后补验收条件，唯一会推进 `acceptance_revision` 的是对话提案接受命令。因此轻量 Task 要变成「可开始」，需要先在会话里接受一条补齐完成条件的提案——这是下一步要补的产品出口，不是本轮已交付的能力。
- **与本节的已知差距**：轻量入口目前是**并列入口而非默认**。§18.7 要求「不先要求填写整套字段」，把默认切到轻量需要重指向既有正式回归（10 个 spec、56 处断言），本轮未做。

- **先表达结果。** 普通起步提供自然语言输入，用户可说想达到的长期结果或本次要完成的工作。标题、已知项目关联、输出和完成条件由系统从原请求及可追溯事实整理为紧凑摘要，允许就地修订；不先要求填写名称、预期结果、验收、执行方式、Pack、优先级和依赖等整套字段。没有本地目录的讨论/人工事项不强制打开文件夹。
- **目标与任务不混淆。** 明确要求创建或记录 Goal 时，通过原 Goal Owner 保存并处理作用域/项目关联，不让用户找 UUID 或先建项目再重复抄目标。只是讨论或模型归纳的目标保留为建议/原意图，不能冒充正式 Goal。Project 的目标描述、蓝图意图和正式 Goal 分别显示；未关联 Goal 不阻断契约原本允许的工作。
- **先读已有答案。** 整理请求前复用当前 Goal、Project State、实际 Task、必要对话来源和有效约束。仅问影响下一步的实质缺项，不把已经回答的问题再问一轮，不用抽取单条消息冒充上下文理解。缺来源、失权、过期和冲突如实显示；推测的期限、标准或授权不写成确认事实。
- **创建与执行的门槛分开。** 表达/保留意图不要求一开始就完成全部执行准备；正式 Task、READY、Delegate 和完成仍走各自领域入口。必要验收条件可以由原请求和项目规则整理，不必让用户手写，但不能用「模型认为成功」凑齐。充分明确且已准入的执行请求不附加统一开始确认；仅有模型建议或实质歧义时处理相应决定，具体动作审批不变。
- **摘要服务于工作。** 默认展示「要达到什么结果、当前范围、如何判断完成、目前状态/下一步」，技术字段与详细编辑按需展开，不显示一个要求逐项确认的假表单。已有 Task 的补充问题/继续请求保持确切 Task、Run、目录与原消息关联；改变活动执行范围走原控制与重新委托协议，不静默新建任务或清空作用域。
- **返回后从状态继续。** 重开显示持久事实中的已完成、在途、阻塞、待判断和下一步理由，保留原任务、产物版本、未决命令及权限。完成更新仍由验证/人工接受和业务提交协调；旧聊天、旧摘要不复活过期权限。当前任务完成后是否自动进入下一任务，仍按 §0.6 与 N06 的有效授权处理。

正式表单、无模型人工路径、旧路由与错误/草稿保护保留。轻量入口不能靠自动开放工具权限、隐藏审批或把缺条件任务提前变为 READY 来省步骤。验收与必要澄清/重复输入/操作次数的记录归[测试计划 §17.1](../testing/verification-plan.md#171-轻量创建与状态接续)，不在本文维护当前成绩。

### 18.8 工具轨迹的呈现（2026-10-04，C 片设计）

2026-10-13 基础结果展示接续：`SETTLED` 工具回执的 `outcome: FAILED` 或原 `reason` 均呈现为失败，检查失败即使没有原因文本也不能隐藏。聊天摘要保留失败次数，检查次数包含已落账的失败检查；只有有结果且未报失败的写入调用计作完成写入，缺失结果单列「结果未提供」。读取/检索、写入按调用次数展示，不能推为文件数量；任何在途调用均可见，不能因为已有读取或写入结果而省略。在后续修正/复检成功时保留原失败历史，不据工具轨迹补 PASS 或 Task 完成。

2026-10-18 实现接续：聊天摘要的「N 项等待你批准」带审批入口，按等待行的 `operation_id` 匹配 `OPEN` 的 `ACTION_APPROVAL`，直达 `/reviews?id=<id>`；没有精确匹配或审批读取失败时回退到 `ACTION_APPROVAL` 过滤页，读取失败不得显示为「没有审批」。决定仍由原 Review 入口做出，摘要不复制审批面板。

本节规定协作页如何呈现「模型这一轮实际对磁盘做了什么」。上游依据见[研究 §1.6](../research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)，端点归[HTTP 契约 §10.56](../api/http-command-contract.md)，物理设计归[第 60 节](../database/physical-design-postgresql.md)，验收规格归[测试计划 §20.4](../testing/verification-plan.md)。本节只写规则，不含本轮成绩。

- **两层，不把工具细节洗进对话。** 聊天区只挂**一行摘要**；逐轮轨迹、可展开的参数与结果、文件差异与检查输出收在右栏工具面板的「轨迹」页签。摘要挂在**产生该执行请求的那条 user 消息**下：`RelayConversationExecution.sourceMessageId` 是唯一确定的身份，而 `RelayAssistMessage` 没有任何指向执行请求的字段，改挂 assistant 消息就只能在重试与多次解释时猜挂哪一条。Run 身份取既有 `RelayConversationExecution.runId`，不新增消息字段。没有 Run 的消息不挂摘要行。
- **摘要只算已结算的。** `REQUESTED` / `PREPARED` 不进计数，只有 `SETTLED` 才计入「读了 N 个文件 / 改了 N 个」；`REJECTED` 与 `ABANDONED` 单独标记，不混入成功计数。这对应 DeepSeek「`preparing` 块在轮次关闭后不渲染」的语义（研究 §1.6）：**未结算不算发生过**。
- **按类别聚合，失败数单列。** 读类聚合成一行（Codex 的 `Read a, b, c` 形态），失败数跟在后面而不是逐条罗列；写与检查各自成项。
- **折叠态必须给出可量化的省略。** 折叠行 = 状态 + 目标 + head/tail 预览 + 「省略 N 行」可展开按钮；展开 = 参数全文 + 结果全文 + 退出码 + 耗时。折叠预算按**屏幕行**而非逻辑行计算，避免一条超长路径撑破布局。被截断的结果必须有显式 `truncated` / `omitted_bytes` 标记，**不得呈现为完整**。
- **结果原样展示，不做正则脱敏。** `result_ref` 本就已持久化，界面展示不新增暴露面；工具参数只有受管根内相对路径。命令自身打印的 stdout/stderr 可能含宿主绝对路径，与既有「执行输出」抽屉同口径如实展示。
- **改动清单从既有账本派生。** 文件变化集与差异取自 `logical_operations`、变化集账本与既有 `file-write-diff` 端点，**不引入轮次级 diff 概念**——Codex 的轮次 diff 有 100ms 预算且会退化为粗粒度，DeepSeek 的 changed-files 摘要只在 Host 内存、重启即丢（研究 §1.6）。这些端点是 API 路径而**不是前端路由**：轨迹里不生成指向它们的链接，只显示动作身份并说明去哪核对，避免落到「入口尚未接入」的兜底页。
- **审批按动作身份挂接，四个状态不合并。** 轨迹行按 `operation_id` 指向既有 `ACTION_APPROVAL` Review（`GET /runs/{run_id}/reviews` 按该字段返回），不重渲染第二份参数（DeepSeek 刻意只传 `callId` 的同一意图）；等待批准 / 已批准 / 被拒 / 审批过期分显，不粗化成「已结束」。审批候选只由服务端下发，默认拒绝。
- **刷新靠 Run 事件提示，不轮询。** `run_tool_calls` 的状态推进产生 Run 刷新事件，前端按提示重读只读投影；断线按已收到的最大 `seq` 续读，不从 0 重播整段历史；同一批提示合并成一次读取。事件流不可用时降级为按 Run revision 重读，并**如实显示「上次读取」时间**，不假装实时。聊天区摘要与右栏轨迹页签共用同一个读取入口，避免同一 Run 出现两条可能不同步的事实来源。
- **状态矩阵逐项显式。** Loading、读取失败、长输出截断、失权（连接撤销）、无结果、预算耗尽（`wait_reason`）、删除待批准、断线重读各有各的文案。断线重读后不复活已清除的旧行。
- **既有「未接入」占位本轮保留。** 右栏工具面板的 FILES / GIT 页签仍声明目录浏览与人工 Git 入口未接入：轨迹里的 Git 结果是**模型本次调用的结果**，不是用户可点的入口，卡片上须标注来源。人工 Git 只读的服务端入口已于 2026-10-05 可用（§14.9），但**客户端接入不在那一轮范围**；替换占位前必须让面板消费真实端点，并区分「已读到且干净」「读取失败（含非 Git 目录）」「结果被截断」三态，不得以静态假数据完成面板，读取失败不得显示为干净。
- **聊天区不混入接入控制。** 轨迹是只读呈现，不提供批准、暂停、取消、重试或补发按钮；控制意图仍走既有 Run 控制路径。

§18.4.1 的确认文案遗留（「按这个执行」的语义改写）在本轮实施时一并清账，规则仍以 §18.4.1 为准，本节不重复规定。

### 18.9 自然语言状态维护与接续摘要

2026-10-09，**产品设计已确认；确认当轮仅文档，后续对话回执和日常卡等有限切片已接入，当前成绩与未覆盖范围只归统一功能验收表**。产品规则归[总纲 §0.8.1](../../Personal_Workflow_OS_Master_Spec.md#081-自然语言维护项目状态)，应用边界归[领域模型 §12.5](../architecture/domain-model.md#125-自然语言状态维护的应用边界)，规格归[测试计划 §24](../testing/verification-plan.md#24-自然语言状态维护与自动接续验收规格)。沿用 §18.7 的轻量起步和原页面/路由；以下是完整目标交互，不由卡片或按钮存在推定所有业务/恢复能力已具备。

**对话维护。** 在项目工作会话里，自然语言是目标、需求、任务、计划、进度、阻塞、决策和知识的统一维护入口。先读取当前对象、用户已表达的信息和有效约束，必要时只问影响本次变更的具体缺项。足够明确的用户修改或收录指令表示该项确认，经原业务入口成功后回显；普通讨论和自动整理保留为候选。读取、接受、保存、执行和完成分别呈现，排队或请求已发送不显示为已生效。权限配置和动作审批仍走对应入口，助手档继续只读。

**连带影响与外部进展。** “导出下周再做”只直接调整明确要求的内容；本周发布若依赖导出，直接显示影响及“是否调整本周发布范围”的具体决定，不擅自改变另一承诺。用户说“搜索已在其他工具做好，同步一下”后，沿已有权限核对确切成果、检查依据及完成条件，足够时沿原完成用例推进；未找到分支、证据过期或仍需人工体验时只显示对应缺口，不要求重填任务表。

**摘要与明细。** 指令的实际变化回执在原对话紧跟回复；默认显示业务对象、调整结果和下一步，可展开变化前后、来源、依据及影响范围。需要用户决定的问题、失败、冲突、重要影响、未决/未知结果直接可见，不依赖展开才能发现。成果提供确切版本的阅读或审阅入口，测试通过与业务完成分开显示；多项命令的部分成功按实际回执表达。

**日常返回卡。** 返回项目时在项目顶部更新可展开的接续卡，显示当前事实、相对上次实际查看摘要时的变化、已完成/在途/阻塞/待验收事项与有依据的下一步。日常“已查看”只记录阅读进度，不等于接受候选、接手或业务完成；未解决事项一直保留。手动命名接续点仍可选择作显式比较基线，日常查看不重设它。首次或没有可用基线只显示当前事实，不能凭聊天摘要或时间推测期间变化。**项目总览的两条接续动作（V43-04，2026-10-16）**：「继续工作」只做导航——State 有下一步任务时回该任务详情、没有时回项目工作台，不委托、不建 Task/Run/会话、不虚构下一步；「查看动态」跳 `/activity?project_id=<id>` 保留项目过滤。归档项目「继续工作」禁用并说明只能阅读历史，恢复不在页面内自动发生；旧专业入口（蓝图/继续项目/Assist/工作台）保留可达。

**轻量核对。** 卡片说明核对中、核对时点、比较范围和缺口；优先读取相关差异及有效证据，自动运行已有授权、可信配置和预算内的相关轻量检查。无变化且证据仍适用时复用结果；全量/耗时检查另行提出，失权、范围不明、预算或来源不足时说明必要处理。核对失败、结果不明或局部读取失败不显示为“没有变化/已通过”，也不覆盖有效的上次查看基线。返回不自动恢复旧 Run、修复代码、创建新任务执行或启动持续监控；需要这些动作时沿原授权处理。

**纠正与撤回。** 用户可在原对话纠正：“只是今天不做，仍要本周完成”。“撤回本次调整”默认针对该指令实际生效的整组可撤回状态变化，不先要求逐项勾选；部分纠正仍可用自然语言。撤回先做只读预检：整组里有不可撤回项（无撤销入口、任务已开始、本组生效后又被修改）时**一项都不执行**，直接展示逐条原因与影响，由用户勾选**具体范围**再提交——通用的“确认整组撤回”不授权后来缩小的方案；预检之后事实又变时按“方案已过期”重新取一份再确认。与后续修改冲突的条目单独按“冲突”表达（当前事实已保留、需要重新确认），绝不显示成“全部生效/全部撤回”；已存在、本次没有新效果的条目显示为“已存在”，撤回也不会删除原关系。恢复和重试沿原命令及回执核对，撤回形成可追溯的新变更，历史保留；原批准、验证和执行权不因撤回自动恢复。

**决定与续答。** 待决承诺显示影响、那句具体问题与涉及对象，并提供一句话回答入口（“按这个决定继续”/“不调整”）；回答绑定你看到答案时的版本，事实变了会先指出冲突。被决定挡住的条目保持等待，独立且明确的修改照常生效；回答落库后自动继续原请求，不再要求重新填一遍。选“不调整”后受该决定约束的条目按**“按你的决定未执行”**结算（没有写入、当前事实保持原样），绝不显示“全部生效/已存在”；回答的命令身份按展示版本复用，响应丢失后重试沿同一 `command_id`，读到已决定的事实后即停止重发。

**摘要与明细（2026-10-10 补）。** 逐条明细里区分结果：已生效、已存在（无新效果）、按你的决定未执行（`DECLINED`）、失败、与后续修改冲突；冲突与失败在折叠态直接可见，技术身份（请求/命令/修订）留在展开详情。外部成果核对逐条给出分类结论（已按完成记录完成 / 验证通过仍适用 / 旧 PASS 不适用 / 检查未通过 / 仍需人工验收 / 缺少证据 / 等待明确完成指令），纯核对组摘要说“外部成果已核对”，不并入“已全部生效”；完成条目说明“已沿原完成用例提交，完成凭据与人工接受已写入”，自然语言撤回条目给出“原调整已整组撤回”等原用例状态。只读核对与自然语言撤回的回执不提供“撤回本次调整”入口（与服务端补偿计划同源）。

**完整示例（目标交互，非运行结果）。** 用户返回后说“导出下周再做；搜索已在另一个工具做好，你核对一下”。顶部卡更新本次接续结果；对话回执显示“导出已移到下周；搜索相关检查通过，交互体验仍待验收”，附“查看具体变化”“查看搜索成果”和可用的整组撤回入口。若本周发布依赖导出，则直接询问“本周发布是否先不包含导出？”。没有真实检查结果时不得显示示例中的“通过”。

**2026-10-10 已核定：** 上次实际查看的确认/捕获时点（服务端每次读取签发展示序号，序号严格增大且 State revision 不倒退才推进）、版本引用集合（State 版本 + 按标题解析出的目标身份 + 知识版本）、指令与变更组的持久关系、撤回前置条件（只读预检 → 决定范围 → `undo_scope` 持久化）与补偿边界已按 §18.9 实施；2026-10-10 独立复验后追加核定并实施：拒绝终态与事务内版本核对、解释基线在调用模型前冻结、展示签发记录逐项核对、外部成果核对/完成指令/自然语言撤回三个新候选、以及返回轻量核对行（接续卡在读取成功后按事实指纹触发 `return-reviews`，展示“轻量核对：未见变化，既有证据仍适用 / 发现变化维度 + 未启动修复、新任务或外部调用”，未完成时如实显示失败且不冒充“无变化”），见 [HTTP 契约 §10.61–§10.64](../api/http-command-contract.md)。**仍待核定：** 执行型检查（FrozenCheck 真实外呼）在返回路径的范围授权、检查配置、预算与停止/重启协议；缺失的需求/计划领域写入口与 API/数据库兼容；run 侧验证会话错误分支在对话内的呈现。本文不预定字段、时长上限或跨命令原子性，视觉数值继续归唯一 tokens。

### 18.10 普通 Agent 的连续工具主流程

2026-10-15 产品规则已确认。**读取、执行候选、READY 明确请求沿原 `request_id` 自动应用及原用户消息 Run 摘要回填已实施（阶段 A/B/C 第一段）；状态维护接进主流程与旧解释入口迁移（阶段 D）未实现**：协作页仍会在发送后发起旧执行解释与状态维护解释命令，执行解释会命中主流程已保存的判定并直接重放，因此不会产生第二次模型判定，但前端调用本身与对应规格反例仍在。自动应用不改变 Gateway/范围准入或 DELETE 确切动作确认；组件证据和未验边界归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。产品定义归[总纲 §0.5.1](../../Personal_Workflow_OS_Master_Spec.md#051-普通-agent-的连续工具主流程2026-10-15已确认待重构)，应用责任归[领域模型 §12.6](../architecture/domain-model.md#126-普通-agent-主流程的应用边界)，取舍归[ADR-022](../decisions/ADR-022-agent-conversation-main-loop.md)。本节接续 §18.2/18.9，不把已有普通聊天、解释卡或工具轨迹当作新主流程全部实现。

| 用户场景 | 目标交互 |
|---|---|
| 已绑定唯一有效目录，说“看一下这个目录下面的文件” | 直接开始只读列目录，默认直接子项；原会话展示实际列表及必要的截断/不可读说明，不追问要维护什么项目状态 |
| “读取 README.md”“看看 src 里有什么”“解释一下这个文件” | 按当前目录与确切文件上下文请求读取，取到真实结果后继续回答；没有唯一文件目标时只问缺失对象 |
| 纯讨论或“先不要改代码” | 可回答或按问题进行必要只读查看，不创建占位 Task/Run、不扩大为文件修改 |
| 明确修改/修复/运行检查 | 同一主流程沿原 Task/Run 推进，紧凑摘要显示真实阶段，不固定再点开始；原有必要权限审批或冲突处理继续显示 |
| 明确维护项目状态 | 通过原应用入口核对目标与基线后执行，原会话回显实际变更和必要决定；普通文件查看不产生状态维护澄清卡 |
| 无目录、多个合理目标、连接缺失、DENY 或审批等待 | 说明确切缺项/拒绝/等待及处理入口；已知目录不再重复问，不能统一回复“系统没有文件能力” |

**一条请求的呈现。** 原消息下展示读取中、执行中、等待批准、取消处理中、失败或未知等实际阶段，最终回复由同一逻辑主流程取得真实结果后生成。可以流式解释下一步，但未取得回执不能声称已读取/已修改；不并行插入相反的独立聊天结论。列表、内容与解释可从原会话阅读，任务/Run/轨迹只作为可展开来源与详情，不复制另一套业务状态。只读结果不出现 Task 已完成、验证通过或人工已接受的暗示。

**过程折叠面板（2026-10-21 已实施）。** 用户指认「ai 的思考过程看不到」：上面这条要求此前没有承载物——每轮工具调用只写 `session_tool_calls`，没有 HTTP 读入口，屏幕上因此只有一个「正在生成」和三点动画。现在 AI 消息的 meta 行下方常驻 `session-round-trace`（`SessionRoundTrace.tsx`，视觉沿用 `.tech-details`），标题「这一轮做了什么 · N 步」，展开后按轮列出 `第 N 轮 · 工具名 · 目标 · 状态`，数据只来自 CD §10.109 那条只读投影。四条口径不可让步：

- **只摆已落账的轮次。** 一行一次调用，顺序信任服务端的 `(round, ordinal)`，客户端不重排、不按位置猜归属。`REQUESTED` 说「已请求，尚未结算」，`UNKNOWN` 说「结果未知，需核对」，都不写成执行过；被拒与放弃的行原样回显服务端 `rejection_reason`/`rejection_detail`。
- **它不是第二套状态，也不是控制入口。** 面板不提供批准、重试、取消或停止，控制仍走输入栏与 Run 控制的既有入口；也没有模型私有推理（该表无此列，AGENTS §1 规则 9 的可见性口径不变）。
- **读取分两段。** 在途（`PENDING`/`RUNNING`）立即读并每 2 秒轮询、默认展开——那时它是唯一的活体过程信号；进入终态补读一次后停止，刷新后已结束的回复等首次展开才读，避免整段历史为每条消息各发一次请求。代价如实写明：刷新后的终态轮次要点开才有步数。
- **缺口要可读。** 没有轮次说「这条回复没有调用任何工具，正文由模型直接生成」，不显示成失败；读取失败在面板内给出确切原因与「重新读取」，并说明正文与最终回复不受影响（暂存 API 包落后于前端时这条 GET 会 404，那是可见状态，不是「系统没有文件能力」）。空数据且未展开时不制造点开是空的壳。

**连续性。** 首条发送、已有会话后续发送、刷新/重启后读回使用同一套语义。执行转入 Run 后原会话继续展示该 Run 的真实结果，不因强制导航丢失上下文；切换目录/会话不重解释旧消息、不把迟到结果投递到新目标，也不自动停止旧 Run。停止入口将意图交给当前会话或 Run 的实际执行责任方，安全收敛前保持处理中。旧请求的接续、批准与撤回保留原身份，新主流程不重复推进。

**目录绑定的呈现（阶段 D 已做的那部分）。** 打开目录后会向当前会话发一条独立的绑定命令，按钮区出现 `collab-directory-binding` 区域给出 PENDING / CONFIRMED / UNKNOWN / FAILED 四态与原 `command_id`。三条口径不可让步：目录是**作用域不是权限**，文案不得暗示已获读取或写入；结果未知时保留原命令等核对，不换 ID 重试，且**不显示成已绑定**（读取按未绑定目录处理）；服务端拒绝时如实呈现并说明对话仍可继续。已绑到同一资源时不再发第二条命令。

本次只更新行为与状态要求，不重做布局、配色、tokens 或全部 UI；ASSISTANT/LEARNING 仍按各自模式显示已有能力和限制。验收规格归[§17.2](../testing/verification-plan.md#172-普通-agent-连续工具主流程)，不得用设计示例填充真实工具结果。

## 23. 主子会话与有界协作

2026-10-05，接续 2026-10-04 用户已确认规则；本轮仅维护文档，**尚未实现/验收**。产品范围归[总纲 §0.9](../../Personal_Workflow_OS_Master_Spec.md#09-有界多-agent-与自动会话)，工程及消息来源归[运行架构 §2.5](../architecture/runtime-context.md#25-有界子-agent-的委派与会话关联)，未运行场景归[测试计划 §21](../testing/verification-plan.md#21-有界多-agent-与自动会话验收规格)。沿用现有视觉、组件和唯一 tokens，不为本增量另生成全站风格。

### 23.1 创建、嵌套与定位

明确的独立新需求创建主会话，同一需求的补充继续原会话；有歧义时在当前对话澄清，回答后按原消息身份推进。主 Agent 的有效委派自动创建关联子会话。创建回执未确定时显示正在创建/待核对并保留原命令，不用空白记录或新 ID 重建；建会话成功不显示为已开始改代码。

项目下以主会话为入口，子会话嵌套并默认收起。主行汇总真实进行中和待人工处理事项，展开后显示子任务标题、调查/审查角色及状态；折叠不得隐藏需要用户处理的风险。标题仅帮助阅读，导航与恢复使用确切会话身份。

当前近期栏是 Task 投影。本增量须增加服务端持久关系的会话投影，保留原 Task 管理、任务导航、旧 `/agent?work=` 和既有 Assist 深链；不把历史 Task 条目重解释成主会话，也不把多个 Assist 会话自动猜成父子。新查询/URL 参数在实施时核定，不预定新增路由或把聊天列表当任务事实。

### 23.2 查看子工作与直接补充

主会话显示当前需求、实际委派进展、已收到反馈、汇总和需要用户决定的缺口；点击来源可返回确切子会话。子会话保留本次输入范围、必要来源、独立消息历史及结果，结束后仍可回看。审查意见显示所适用的改动基线；基线变化、意见冲突和缺少必要依据要可见，不展示成已验证通过。

用户可直接向子会话补充或纠正。发送过程区分待发送、排队/待消费、已消费与失败；主会话一次同步原来源，并可定位这条补充。补充在安全点进入后续子尝试，在途调用不冒充已读到新消息；完成后的会话可继续沟通，但重新执行仍须有效父执行与原授权，不能因消息发送成功自动复活旧 Run。

超出原委派范围时显示由主 Agent 处理及待决定范围，不把文本转发伪装成新的用户执行授权。必要审查收到影响基线或条件的补充后，原反馈标为待复核；主 Agent 根据真实范围重派，子任务始终保持只读。

### 23.3 失败、控制与恢复

| 情况 | 用户可见行为 |
|---|---|
| 调查失败 | 显示原失败及一次修正尝试；仍失败时主 Agent 接续调查，保留缺口及来源 |
| 必要审查仍失败 | 显示交付等待审查、缺少哪些依据和需用户决定什么；不以主自审或其他子任务成功冲掉阻塞 |
| 预算不足 | 说明当前工作因总预算停止推进，展示原有新预算/接手/停止出口；不自动加额度 |
| 主暂停/取消/交接 | 请求持久化后展示正在停止，停止新委派；在途子任务到安全点并核对后才展示已停止/接手完成 |
| 单个子任务取消 | 只表达该子任务取消；主会话根据其必要性显示继续或待处理，不误报整个需求取消 |
| 断线、重开及 UNKNOWN | 读取原会话/委派/调用与投递事实，保留原身份核对入口；查看历史、展开或重新连接不自动执行 |

复用现有 Run 控制入口，不在子聊天里创建第二个父控制 Owner。Loading、创建/投递失败、独立审查阻塞、预算耗尽、暂停中/已暂停、取消、失权及未知结果各有准确反馈。

保留 §18 的草稿、目录绑定、首条未决命令和离开守卫；切会话/项目/连接后的迟到读取按确切身份和 epoch/revision 丢弃。首次快照与订阅、断线重连按原 SSE 规则闭合窗口并重读持久事实，事件文案不作为状态源；失权清除正文、名称和数量。长子列表按服务端分页，键盘展开/收起、焦点归还、中文 IME、短/窄窗与 Windows DPI 分别验证，不能因默认折叠挤走输入和控制。

## 24. 需求驱动的软件协作

2026-10-06，**产品选择已确认，工程协议待核定；仅未来交互设计，本轮未实施、未验收**。产品定义统一归[总纲 §0.10](../../Personal_Workflow_OS_Master_Spec.md#010-需求驱动的软件协作)，路线衔接归[后续路线 §7](../requirements/post-v1-roadmap.md#7-已确认的未来软件协作能力)。本节只维护操作流程与界面语义，不另设产品范围或排期表。

### 24.1 从对话进入需求与完整文档

- 用户在项目中自然表达要达到的结果；从零开发和已有功能迭代都可以先讨论，不要求先建齐任务或填写完整表单。需要项目来源时复用已有文档、当前需求和有效约束，仅澄清影响下一步的缺项。
- 2026-10-09 接续：明确修改有效需求的指令可依[§18.9](#189-自然语言状态维护与接续摘要)表达用户确认；对话总结、仓库变化和未定想法继续形成候选，不能借统一入口自动接受。
- 需求清单按用户可使用的功能拆分，提供页面、模块和版本分组；需求项可展开查看说明、讨论来源、已接受条件及关联工作，不把代码文件划分直接当成功能划分。
- 需求项视图和完整文档视图表达同一份有效需求。查看、搜索、分组和切换视图不形成第二份正文，不把聊天总结自动升级为已接受要求。
- 未定想法留在同一清单并标为“待讨论”，可继续补充和关联来源；它们不混入当前有效要求，也不默认成为本轮计划中的实现工作。
- 导出仓库需求文档前显示项目、确切有效版本与本次导出内容。仓库文档可追溯到该版本；新的有效需求不静默改写已经导出的旧版，导出也不代替需求接受或执行授权。

| 所见内容 | 阅读与操作含义 |
|---|---|
| 当前有效 | 已经接受、目前适用的要求；与实际完成和验证情况分别显示 |
| 待讨论 / 待确认 | 前者尚未形成决定，后者有明确候选等待审阅；均不冒充有效要求 |
| 已拒绝 | 保留理由与当时依据，不通过刷新重新变成待确认 |
| 过期 / 历史 | 明示所适用的旧基线或失效原因，能追溯但不能当作当前依据直接接受 |

上述名称说明界面语义，不预定新的持久化状态枚举。

### 24.2 仓库变化与影响检查

- 自动发现仓库需求文档修改后，在所属项目呈现原导出版本、发现的修改、来源与差异，并准备更新候选；用户选择哪些修改成为有效需求，不能将文件变化直接当成已接受决定。
- 无法确定文档归属、比较基线或完整内容时显示缺口，保留用户输入与当前有效要求，不猜测“文档未变化”或自行覆盖另一来源。
- 影响检查既展示已登记关系，也调查代码、接口和测试的潜在关联。结果分为有依据的确定影响、需要复核的推测关联、尚未检查的范围，每项说明依据与所需下一动作。
- “没有找到关联”与“没有影响”分别表达；调查结论不冒充代码正确性证明，影响建议也不直接改写任务、验收条件或产物。
- 本节的未来自动发现和候选准备沿用已确认的锁定、手动影响检查与人工介入规则；不将第 10.1 节的首轮手动动作改成每次编辑后自动分析。

### 24.3 按使用流程验证原型想法

- 交互复杂或存在分歧的需求按需提供可操作原型，入口关联具体需求及所讨论版本；简单需求不强制先做原型。
- 用户按具体使用流程讨论并确认，同时保留对页面整体的评价。界面标明本次已讨论路径、尚未讨论路径与未解决分歧，不以“一页看过”代替全部流程确认。
- 反馈附原需求和具体路径，形成关联的需求候选；新产品点子继续标为待讨论，不能借原型修改自动扩大有效范围。
- 原型确认保留所确认的内容与依据；它不等于正式功能验收，不替代确切实现、产物和真实验证证据。需求变化后，原型显示其旧基线及待复核部分。

### 24.4 当前计划草案与明确执行

- 重要项目事实变化时自动准备下一步计划候选，说明变化是什么、为何需要这些工作、对应哪些有效需求及已知前置；只补实现有效需求所缺的工作，扩展产品点子留在待讨论清单。
- 每项目维护一份当前计划草案，相关变化合并并保留各自依据。已经进入审阅的版本保持固定，新变化提示有更新可查看，不在用户审阅时换掉正文。
- 用户可对照当前工作、已完成事实和候选理由分阶段接受。计划接受仍走原提案与任务入口；接受计划不是 Delegate，新任务候选不自动进入旧连续授权集合。
- 明确的计划调整指令和另一既定承诺的连带确认沿 §18.9 处理；自动准备的计划仍是候选，不因自动核对或显示卡片取得执行权。
- 后续明确执行复用原请求、任务、Run 和工具准入。已有活动工作须按原安全控制处理必要调整，不能因计划更新自动修改冻结契约、重启执行或迁移目录。

### 24.5 围绕同一需求审阅与处理分歧

- 按同一需求汇集需求、计划与知识建议，展开可辨认各自来源、基线、修改内容与接受后果；类别用于定位，不把有关联的判断分散成互不相干的清单。
- 分阶段确认时显示必要前置、已接受部分、尚待决定部分及受影响工作；未完成必要调整前，不按已经过时的要求继续推进，也不把部分接受显示为全部问题已解决。
- 语义冲突并列呈现原要求、各来源的修改、具体分歧、受影响工作和处理方案，由用户决定保留或修订方向；不能凭来源时间较新或模型推荐静默裁决。
- 已接受、拒绝、被替代和已过期的内容保留区别。候选所依赖的条件变化后重新核对适用性，不以此前的接受继承新版本的验证或批准。
- 拒绝理由在项目内保留。同一依据和条件未变化时不反复重提；发生实质变化才说明新依据再提出。用户可明确持续排除该建议，直到主动解除；新依据不自动解除持续排除。
- 读取、调查或候选准备失败时显示对应阶段与具体缺口；在途、未决命令和结果不明继续沿原身份核对，不生成假差异、假候选或假保存结果。

### 24.6 有复用价值的经验与适用性复核

- 工作完成后，结合实际成果与证据自动提出有复用价值的新经验候选，附来源、适用条件及未知项；普通工作日志不因此逐条生成知识条目。
- 相关候选合并供用户审阅，保留各条依据与可分别判断的内容。确认后进入既有知识导读，已有有效知识与新候选清楚分开，不自动合并删除原知识。
- 用户明确要求“把这个经验收进项目知识”时，按 §18.9 核对对象、来源和范围后沿原收录入口处理，无需普遍再填写表单或接受点击；自动提炼仍保留候选与必要适用性判断。
- 项目做法改变时主动提出知识适用性复核候选，说明改变的事实、受影响内容和仍不确定的部分；引用入口显示复核状态，不能继续无提示地把待复核经验作为确定依据。
- 用户选择保留、修订或转为历史。保留说明当前适用判断，修订沿原新版本规则，历史内容仍可追溯；新的知识判断不独立改变 Task 完成、Rule 或 Decision。

### 24.7 示例：增加 Word 导出功能

以下是未来流程示例，图表、路径与处理方案用于说明交互，不代表现有项目已具备该功能或已确定这些细项：

1. 用户在项目对话提出“增加 Word 导出”。系统先复用现有需求文档和有效约束，整理本次功能候选；输出内容、格式和完成条件存在实质缺项时就近澄清。
2. 需求同时可在功能清单和完整文档中阅读；未确定的导出增强项标为待讨论，不混入当前有效范围。用户接受后可导出带明确版本的仓库需求文档。
3. 若导出交互复杂或有分歧，提供“选择内容 → 查看预览 → 生成文件”等候选流程的可操作原型。逐条关联反馈，保留页面评价及未讨论路径；原型确认独立于正式验收。
4. 计划草案补齐当前有效导出需求所缺工作。用户接受计划后，明确要求“按这个范围实现并验证”，才沿原应用用例准备执行；已有授权是否覆盖这些任务仍须核对。
5. 仓库文档出现“只导出正文”，而原有效要求包含图表时，自动准备差异与需求更新候选，展示语义冲突；影响检查列明已有关系、对实现和测试的潜在关联及未检查范围。
6. 用户先决定导出范围，再审阅相关计划和知识建议，可分阶段接受。必要要求与活动工作调整完成前保持相应待处理；拒绝的增强建议按理由保留，不循环重提。
7. 实现成果经原 Verification、Human Acceptance 与业务完成流程核对；有可复用依据的导出经验才进入知识候选，用户确认后进入原知识导读，未验证做法不包装成成功经验。
8. 隔日回来，使用有效接续基线查看原目标、当前需求、确切成果、已完成及未决事项，再继续原对话；无基线只显示当前事实。待确认、已拒绝与过期内容不混入当前有效内容，重开不自动恢复执行。

### 24.8 反馈目标与原有边界

首先检查人工转述、分派、工作衔接和催进度是否减少，同时检查需求误解造成的返工与隔日恢复理解的成本。本节只记录体验目标，不填写未运行成绩，不以候选数量或生成速度证明收益。

沿用原事实、版本、权限、验证、人工接受、业务完成与安全控制；N01 接续、N03 知识导读及 N04/N05/N06 首轮规则继续有效。本设计不改变 M/N 状态或已确认首轮范围。

自动发现与准备候选不等于后台常驻、无限 AI 调用或新的执行权限。具体生成预算、检测来源、节流、重启和文档同步协议待工程核定；本节不预定 schema/API、不证明代码实现，不承诺应用退出后仍持续推进。

## 25. 会话模式单选框与人设助手

2026-10-05 用户要求在协作页聊天框加一个切换模式的单选框。交互取舍见 [ADR-018](../decisions/ADR-018-assistant-conversations.md)，后端契约归[命令契约 §10.60](../api/http-command-contract.md)。**本节是已确认的设计；界面已实现（2026-10-06 首版，2026-10-16 助手配置改弹窗；2026-10-18 三档收成一个下拉框；2026-10-19 该下拉的浮层与选中态收进设计系统；2026-10-22 该浮层改由应用自绘，见 §25.1 末条），真实业务路径仍未验收**，成绩以[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)的「会话模式与人设助手」行为准。下面的呈现要求是验收依据。

### 25.1 控件层级

单选框放在**底部工具行最左侧**（与「资料 N」「发送选项」同一行），模式盒本身不新增一行。理由：这个输入框的阅读宽度与底栏对齐刚完成三轮返工校准，多插一行会再动它；控件集中一行与现状一致。助手档只多出一句常驻边界说明，配置全部收进弹窗。

**2026-10-18 用户指令「普通 agent，人设助手，学习合并到一个下拉框中」：三档从三枚常驻 radio 收成工具行里的一个原生 `<select>`**（`.agent-chat-mode-select`，testid `conversation-mode-select`，summary 即当前档名）。理由不只是省宽度：三枚 radio 在窄卡里会换行把工具行撑成两行（与「执行中底栏散架」同源），而「当前是哪一档」本来只有一个事实。控件仍是原生 select——读屏与禁用语义走平台实现，外观只借 chip 的字号与高度（首版为 `appearance:none` + 原生箭头，2026-10-19 起见下条），不新增第二套配色。在途时整颗禁用，锁定原因挂在模式盒 `title` 上、并保持 `conversation-mode-locked` 的视觉隐藏行。**标签文案不得写「可派发子 Agent」**，ADR-017 的子 Agent 至今零代码；§25 定稿时写的「人设 Bot」界面统一叫「人设助手」，本节以界面为准。控件沿用既有 token，不新增数值。

**2026-10-19 用户指令「优化这个下拉框，还有这个下拉按钮的选中态」：浮层改由设计系统绘制，选中态收到 chip 上。**（本条的浮层载体已被 2026-10-22 自绘浮层取代，见下条；本条的**实测数值与取舍理由仍然有效**，宽度、间距、选中态配色按原样继承。）原先只有 `option { color; background }` 一行定制，实测浮层仍是系统绘制的那条硬灰带（无圆角、无阴影、脱离 tokens）。现与顶栏会话下拉共用同一段 `appearance: base-select` 定义（`.agent-chat-mode-select` 一起收进 `AssistView.css` 那个浮层块，两条下拉的浮层规则只写一处），不复制第二套浮层。四条事实：

- **浮层**：`bg.surface` + `border.control` + `radius.control` + `shadow.floating`，当前档为 `selection.bg` 底 + `selection.hover` 悬停 + 平台自带勾选标记；输入器贴窗口底沿时平台自动向上翻。零新增 token。
- **选中态与焦点环归 label**：`::picker-icon` 隐藏，箭头仍由 `.agent-chat-chip-chevron` 承担；hover / `:open` / `:focus-visible` 三档写在包裹的 `.agent-chat-mode-select-field` 上（`:has()`），因此焦点环包住「档名 + 箭头」整颗 chip，不再像原生那样只框住文字、把箭头留在环外。展开时箭头转 180°，与同排 `.agent-chat-options > summary` 的反馈一致。
- **chip 不再换档时变宽，且文字不再被挤**：宽度下限压在**文字盒**（`.agent-chat-mode-select`，`min-width: 5rem`）上，不压在整枚 chip 上。首版把 `6rem` 压在 label 上，箭头与内边距先吃掉 26px，最宽那档「普通 Agent」（实测文字 69.86px）只剩 0.14px 余量，用户截图指认「agent 这个文字被挤了」。现 label 按内容长＝80 + 内边距 8 + 间距 4 + 箭头 14 ≈ **108px**，三档同宽、切档不推动同排右侧 chip，文字留 10px 余量；chip 内文字与箭头的间距取 `space.1`(4px)，与同排 `.agent-chat-tool` 同一档（此前用 2px，比邻居高一档更紧）。短标签（学习）因此与箭头之间留白较多——这与仓内所有定宽 select 一样：值靠左、箭头钉在右缘。
- **键序变了**（这是本次唯一的行为变化，代价按用户选定范围接受）：`base-select` 下方向键先开浮层、在浮层里移高亮，**Enter 才提交**，Escape 收起且不提交；原先「一次方向键就换档」和首字母跳转都不成立。换档等于切到另一会话，本就不该被一次误按换掉，所以保留新语义、不写 JS 键盘垫片。浏览器用例 `uiOption2FirstSession.spec.ts` 的键序断言已按此更新。

**2026-10-22 DEV-0116（用户工单「优化一下下拉框ui」＋截图；方案由用户在两轮澄清中选定「换成应用自绘浮层」）：这一档不再是 `<select>`，而是与同排 chip 同一套语言的自绘浮层。** 上一轮把浮层交给 `appearance: base-select` 之后，剩下的毛病全是**几何**的，而这类毛病改不掉：平台把浮层锚定在 select 的**内容盒**上，于是它比 chip 宽、左缘也不与 chip 左缘对齐，还会压住输入框上面那一行字（用户截图正是这一条）。`base-select` 能定制颜色、圆角、阴影，定制不了锚定与宽度——这是本轮换载体的决定性事实，不是审美偏好。

- **结构**：`<details class="agent-chat-mode-select-field agent-chat-mode-menu">` ＋ `<summary class="agent-chat-mode-chip">`（图例「会话模式」视觉隐藏 + 当前档名 + `.agent-chat-chip-chevron`）＋ `.agent-chat-mode-options`（`role="group"`）里的三枚 `<button data-mode-row>`。开合、点外即收、Esc 收起并把焦点还给芯片、同时只开一个浮层，全部走既有 `useDetailsMenu`，与「+」附件、`发送选项`、`资料`、模型下拉同一套行为，不写第二套浮层 JS。浮层几何 `bottom: calc(100% + space.2)` / `left: 0` / `zIndex.popover` / `radius.panel` / `shadow.floating` / `border.separator`，**零新增 token**。
- **testid 语义**：`conversation-mode-select` 仍在「当前档那颗芯片」上（原来是 select），`conversation-mode-menu` 落在 details 上，新增 `conversation-mode-option-<MODE>` 三行。`selectOption(...)` 这类原生写法不再适用，一律改成「点芯片 → 点那一行」（`capture-agent-projects.spec.ts`、`uiOption2FirstSession.spec.ts` 已同步）。
- **键序与 10-19 那轮一致，但这次是自己实现的**：芯片上一次方向键把焦点**落在目标档那一行**（Down 从当前档往下、Up 往上、Home/End 到端点），浮层内 Up/Down 端点回绕、Home/End 跳端点，Enter/Space 由按钮本身提交，Esc 只收起不换档；点当前档不发任何命令。宽度沿用 10-19 的实测结论：文字盒 `min-width: 5rem`、`max-width: 9rem`，三档同宽、切档不推动同排 chip。
- **禁用语义换了载体，规则没换**：`<details>` 没有 `disabled`，在途锁定改用 `aria-disabled="true"`（芯片与三行同时带上）＋ 阻止默认开合与早退，因此「在途时浮层打不开、点行也不换档」，§25.2 的「切档不是停止」原样成立；锁定原因仍挂 `title` 与 `conversation-mode-locked` 视觉隐藏行。
- **竖直重心**：原生 select 在 Chromium/WebView2 里把内部文字按内容盒贴顶排，盒高撑满 chip 时文字整体上浮 7-8px（2026-10-20 用户截图「竖直重心没有在一个高度」）。自绘后文字与 chip 同盒，这条不变式改压在「档名文字盒中心与 chip 中心差 ≤1px」上，由 `composerSourcePanel.spec.ts` 3d 在三种视口下量真实几何。
- **验证**（真实 Chromium + 页面内路由夹具，不连数据库、不写真实事实）：`tests/browser/conversationModeMenu.spec.ts` 3/3——收起时芯片只读当前档、展开后浮层左缘与芯片左缘同线（≤1px）、宽度不小于芯片、底边在芯片之上不压任何一行、当前档只标一行、点行即换档并收起、键盘一次到目标档且 Enter 才提交；`tests/assistantModeSwitch.spec.ts` 新增键盘与在途两例，50 例中 48 绿，2 条红属并发未收口的其他切片（附件资料 `title`、`folder-scope-change`），与本档无关；`composerSourcePanel.spec.ts` 5/5。前后截图：`output/ledger-DEV-0116.png`（用户工单原图）与 `output/dev-0116-screenshots/`。**未验**：真实业务路径（切档确实导航到另一条会话）仍未验收，见验收表同一行。**Breaking Change：No**（无 API/命令变更，仅界面载体与用例写法）。

两档各自的工具行：

- 普通档：照旧——`资料 N` + `发送选项`（讨论 / 提案 / Skill）+ 上下文计量。**2026-10-19 深夜顺序重排**：计量环与模型下拉移到本行左端，两枚浮层 chip 仍在行内，见[§32.13](#3213-工具行左端两枚事实与浮层只浮出内容2026-10-19-深夜接续)。
- 助手档：一枚 `助手 · <名字>` chip + 一句常驻固定边界说明「只读：不改文件、不建任务、不派子 Agent，也不能申请任何写操作审批」。`发送选项` **隐藏**：intent 在这一档没有意义。

chip 打开 `AppDialog`，弹窗内才是助手选择、清单状态与重读、「不记住」勾选和新建助手表单。**边界说明是弹窗的例外，常驻输入框**：这档最容易被误当成「什么都能干的另一个聊天窗口」，而弹窗只有点开才看得到。chip 没有可用身份时按状态改口（正在读取 / 读取失败 / 选择助手），所以收进弹窗不等于看不出缺什么。

**就地新建入口是第二个例外**（2026-10-16）：清单确认一个可用助手都没有（或读取失败）时，「新建助手」文字入口直接摆在 chip 旁边同一行（几何走 `.text-button`，24px 最小高度不把 32px 的工具行顶高）；点开是同一个弹窗，只是表单已展开、焦点落在名字上。一个可用助手都没有时新建是这一档唯一的出路，收进弹窗等于把首次路径堵在「发不出去又不知道下一步点哪」；清单还在读取时无从判断「没有」，该入口不出现，有可用助手后随之消失。

2026-10-16 返工：这些配置原先内联摊在底栏，选中助手档后输入框从 1 行涨到约 6 行，正文输入区被挤到底部。边界说明写成工具行的整宽子项而不是模式盒的子元素——放进模式盒会按文字最大宽度把模式盒顶宽，连带把「资料」与计量 chip 挤到别的行上。

**2026-10-16 布局回归（用户报「执行任务时输入框布局整个乱掉」）**：上面那条规则当时只落在助手档说明上，另外两条线漏了——在途锁定原因「正在生成，停止后才能切换会话模式。」与学习档「对项目只读」说明都还写在模式盒里。模式盒是自动宽度 + `flex-wrap` 的内联 flex 容器，塞进长文本后会按可用宽度撑开（真实 Chromium 实测 **241px → 483px**、两行），把资料 / 润色 / 普通讨论 / 计量 chip 挤到后面两行：在途底栏散成三行，第一个 chip（「+」）与说明文字错行，右侧 chip 与发停键各自落在不同横带上。

**同日第二轮（用户截图指认「这些都导致输入框变化了」）**：把这三条线只挪出模式盒还不够——它们仍在**输入卡内部**（工具行里），卡片于是随状态长高变矮：执行中多一行、收到命令回执（「消息已由服务端确认取消。」）再高一块，用户正在打字的光标与工具行跟着跳。最终契约收敛为一句：**输入卡内恒定只有正文、工具行与发送键**；档位锁定原因、学习档说明、助手档只读说明与命令回执全部渲染在卡片下方这一列里（新组件 `ConversationModeHints` + 既有 `.receipt-message`，与错误、待核对同区，间距由 `.agent-assist` 的列 `gap` 给）。实测（卡片上限 744px、工具行 678px，仓外 Chromium）：AGENT 档空闲 / 执行中 / 收到回执三种状态卡片均为 **744×118**、工具行 1 行、发送键相对卡顶同为 73px，卡内子项恒为 `[spark, form, actions]`；此前执行中是 118 → 155、回执是 118 → 190。首条输入器的档位阻塞原因（`assist-first-blocked`）同规则搬到卡外。**已知未收口**：学习档 / 助手档的工具行因模式盒更宽（多一枚配置 chip 或「本条消息不记录」）会让计量 chip 落到第二行，卡片为 744×154，与本档无关——切档本身是导航到另一条会话，用户不会在同一次输入里看到它变。**Breaking Change：No**，零新增 token；几何对照截图 `apps/workbench/results/composer-inflight-bar-before-fix.png`（修复前）与 `composer-card-invariant.png`（修复后），结构不变式与「卡内子项恒定」由 `tests/assistantModeSwitch.spec.ts` 的四条用例锁住。

**2026-10-17 第三轮（用户实机截图指认「agent 执行任务的时候不要弹出这个东西，整个布局都被他打乱了；发送消息的时候输入框多了一个阴影」）**：卡内不变式守住后，还剩两个随状态在输入区周围出现/消失的东西。①卡下方说明列里的**在途锁定原因**（「正在生成，停止后才能切换会话模式。」）随生成开始凭空多出一行、结束又消失；同一列的**模型调用信息**（本条首选/实际/记录 + 「模型尝试与用量」折叠块）随每条 AI 回复常驻。两者叠加时输入区周围多出两三行，布局被打乱。处理：模型调用信息移入**最近一条 AI 回复的消息行**（它本来就是那一条回复的调用事实；转录区自己滚动，出现、消失与每秒轮询都不再推动输入卡）；锁定原因转为**视觉隐藏**（`conversation-mode-locked` 仍在 DOM、读屏仍按文档序读到，`data-testid` 用例仍可定位），原文同时挂在禁用模式盒的 `title` 上供悬停查看——在途时整组禁用已经表达了「此刻不能切」，不再需要一行占位文字。②输入卡 `:focus-within` 原本在卡投影之外再加一圈 3px 淡色光晕（`0 0 0 0.1875rem` focus-ring 14%），打字聚焦与点发送键时随焦点出现，读成「输入框多了一个阴影」——现已去掉，焦点强调只剩边框加深，卡投影与空闲态一致。结构不变式追加两条并由 `tests/assistantModeSwitch.spec.ts` 锁住：锁定原因带 `visually-hidden`；fieldset `title` 承载原因原文。**Breaking Change：No**。

发送键、圆形键几何、底栏对齐不动。

**2026-10-19 第四轮（用户截图指认「不需要展示红框里面的部分」，随后明确「不是隐藏是删除」）**：上一轮把模型调用信息移进消息行后，AI 回复下方仍常驻一块「本条首选 / 最近实际调用 / 调用记录 N 次」与折叠的「模型尝试与用量」（候选顺序、每次调用的 token）。用户要求连这块一起删掉。处理：删除 `components/AssistModelRuntime.tsx` 及其单测，`AssistView` 不再在消息行渲染它，也不再有 `latestModelMessage` 这个取最近一条 AI 回复的中间量；前端不再请求 `GET .../model-runtime`。保留不变：后端 `readAssistModelRuntime` 投影与路由（真实 PG / HTTP 用例仍覆盖调用事实）、`relayClient.getAssistModelRuntime` 客户端方法；调用与切换事实继续由消息用量、执行轨迹与验收日志承载，页面上不再重复披露。`tests/browser/free-model-real-api.spec.ts` 原四条 UI 断言改为断言该块不存在（同一用例仍核对 HTTP 投影的候选顺序、两次调用与切换记录）。**Breaking Change：No**（仅移除只读披露，无 API 变更）。

### 25.2 切换等于换会话

单选框切档不改变当前会话的权限，而是导航到另一条会话：

- 切到普通档 → 该目录的普通会话（没有就建空会话，**不自动建 Task**）。
- 切到助手档 → 所选助手在该目录的会话（没有就建）。

未发送的草稿留在原会话，走既有离页守卫。**在途时禁用切换**并说明「正在生成，停止后才能切换」——不允许用切档隐式取消，因为助手档与普通档的停止语义并不相同。

### 25.3 最小助手配置入口

助手下拉带一个「+ 新建助手」，在 §25.1 那个配置弹窗内展开小表单（名字 / 角色描述 / 口吻 / 可选只读目录范围）直接存服务端。不做独立管理页、删除（只归档）、复制、头像上传。提交失败时错误就地显示，不清空用户已填内容；成功才清草稿并关掉弹窗。

2026-10-16 起表单落在弹窗里，不再内联挂在输入框下方（撑高问题见 §25.1）。弹窗由 chip 或就地「新建助手」入口（见 §25.1 第二个例外）的点击打开，**切档时不自动弹**：协作页给会话视图的 key 里带 sessionId，从「还没有会话」切到助手档会让整棵子树重挂载，组件内记不住「刚点过」。代价是「不记住」与重读清单变成一步点击之后，按用户选定范围执行。新建成功即选中并收起弹窗；清单里有了可用助手，就地入口随之消失。

### 25.4 导航与深链

会话面板按模式分「普通」/「助手」两组，助手组显示 `助手名 · 目录`。跨项目或失权时助手与会话一起清投影，沿用现有规则。

**目标身份不进 URL，这是实现时的实测结论。** 2026-10-06 首次实现把模式与助手写进查询串，结果协作页的工作目录被清空：`App.tsx` 给路由出口的 key 是 `pathname + search`，任何查询串变化都会整条重挂载，而工作目录是协作页的组件状态。查询串承载身份与承载目录放不到一起，因此身份改由协作页持有（`conversationTarget`），AssistView 只接收与上报。

由此产生的限制：**没有 `?mode=` 深链**。要支持深链，得先把工作目录也搬进 URL，那是路由层改造，不在本片范围。旧的（无参数的）入口一律按普通档解析，不虚构助手关系。

### 25.5 三处必须显式处理，否则像坏了

1. 助手档消息行的角色标签显示 `助手名 · 人设 v修订`，不用「AI」。
2. 助手档**不渲染执行摘要**（那里是「按这个执行」，助手档没有 Task），换成固定只读说明；工具调用沿用现有折叠卡片但标注「只读」，**不出现审批四态**——这一档没有审批这回事。
3. **没有任何可用助手身份**时（清单为空、只剩已归档、或所选 ID 已不在当前清单），在输入框内直接说明原因并禁用发送，**不建会话也不发消息**；chip 标签同步改成「选择助手」，新建入口就地摆在 chip 旁（点开仍是弹窗，表单已展开、焦点在名字），重读入口收在弹窗里。留一个空白下拉会被读成「你没有助手」，而真实原因可能是清单没读到。

### 25.6 暂停与接管的呈现差异

助手档没有可移交的执行权，因此**不渲染**暂停与人工接管入口，而不是渲染成禁用加解释。停止沿用既有消息取消通道：输入器在有在途回复时切成停止形态，与普通档同一套控件，不新增助手专属停止入口。

助手档不排队，因此界面不得显示任何队列序；提示写成「本会话正在回答上一条」。

### 25.7 撤销后的呈现

助手归档后既有会话冻结发消息：输入区仍可读历史，但发送被服务端拒绝并带「换一个助手」的指引，界面据此呈现而不静默禁用。连接被删导致词表收窄时，模型收到的是类型化原因，界面按该原因显示，不显示成「没有可读内容」。

## 26. 学习模式

2026-10-10，**产品方案已确认；仅未来交互设计，未实施、未验收**。产品规则归[总纲 §0.12](../../Personal_Workflow_OS_Master_Spec.md#012-学习模式)，本节拥有人的操作与反馈，记录及权限责任归[领域模型 §13](../architecture/domain-model.md#13-学习模式的状态与权限边界)。普通助手仍沿用 §25；学习模式的专门记录能力不由现有人设配置获得，具体会话类型和入口控件待工程设计。

### 26.1 主动进入与简短路线

用户可用一句话表达学习意图，例如“结合这个项目，带我理解接口幂等性”或“我想学架构”。项目带学优先复用当前合法来源；自由学习不要求先选目录、建项目或正式 Task。Agent 可建议某项取舍值得了解，由用户决定是否展开，不自动开课或把每次技术讨论都变成教学。

宽泛主题先给少量主题和当前推荐，说明与用户目标的关系；用户可以改目标、跳主题或只问一个问题。路线是当前学习建议，不是项目计划或必须完成的课程，不以列出路线启动执行或强制测试。

### 26.2 讲解与可选理解检查

默认先给短解释和具体案例，按需展开原理、方案比较、图示或更多材料。可以邀请用户复述、比较方案或指出遗漏，并针对具体表现反馈；跳过检查仍可继续，不能记成不懂或失败。

项目案例链接实际采用的代码/资料版本与决定；通用解释、模型建议和假设例子分别标明。涉及版本、技术选型或其他不确定结论时，按需核对权威来源；缺资料如实说明，不通过编造项目行为让案例显得完整。

示例路径：用户问“超时后重试为什么可能重复创建？” → 结合获准材料解释响应丢失和幂等 → 可选比较两种重试方案 → 反馈其具体判断 → 形成明确的开发要求和可检查场景。示例不代表当前项目存在此 Bug，也不因教学完成表示功能通过。

### 26.3 状态变化与轻量查看

对话只在有实际学习记录变化时显示简短结果，例如“幂等性：已有解释表现；重试场景存在具体误解，待复核”。展开查看知识点、场景、来源性质、必要依据与时间、具体缺口和路线；保留一个轻量查看入口，不要求进入独立学习面板才能理解当前变化。

记录按主题定位实际接触的知识点，不预建空知识树。接触、自述与实际回答表现可同时存在；未观察到不等于不会，待复核不是全面降级。不显示掌握百分比、无依据的精确分数或把阅读次数包装成能力。来源失效、矛盾依据和用户纠正清楚可见。

展示直接读取应用保存的同一记录，不请求模型重新生成进度总结。保存中、保存失败、冲突/待核对与已保存分别呈现；模型提出增量或返回回答不显示为保存成功。状态保存失败时保留可读回答与必要恢复入口，不伪造掌握更新。

### 26.4 接续、纠正与清除

再次进入时先简短说明上次学到哪里、当前缺口和推荐继续内容，旧解释/依据按需读，不重讲整个历史。时间过去只说明多久没有新表现，不自动降低水平；必要时建议可跳过的复核，不强制先考试才能继续。

用户可在对话或轻量记录入口纠正，例如“上次其实没懂，先按接触过记录”。回显实际修正和自述性质，保留必要依据；新旧表现矛盾时指出具体误解并标待复核，不凭一次口误覆盖全部能力。

支持删除单项、全部清空和本次不记录。操作说明范围与实际结果，清除学习记录不声称删除原聊天；清除后不从旧聊天自动补回，后续新交互才重新积累。将“本次不记录”与 §25 的助手“不记住”区分呈现，不暗示同时完成聊天删除、禁止外发或其他未定义效果；具体开关适用和在途竞态在协议确定后落实。

### 26.5 从学习转入执行

用户明确说“按这个方案实现”时，转到普通执行会话，携带目标、选定方案、约束、未决项和必要来源，不让用户手工复制整段对话。已有明确指令沿原执行流程处理，实质歧义、范围/权限缺项或动作审批仍按原入口处理；教学认可不能代替执行请求。

转入遵循原会话身份、在途停止、草稿守卫和目录/项目归属约束，不通过切换静默取消回答或让学习身份原地升权。对话明确显示学习与执行的衔接；无法转入时说明未开始执行并保留必要背景。执行时重新核对项目事实，学习记录不继承验证、批准或任务完成结论。

### 26.6 成本、首版与待核定项

当前相关的简短学习状态与资料按需进入本轮 Context，历史依据按需展开；常规评估增量随教学交互形成，应用保存和界面阅读不另起评分/复盘模型调用。用户要求深入或练习、必要查证的消耗按实际调用计量，不能只展示最终回复长度作为低 token 证明。

首版覆盖以上路径，复用既有知识阅读、反馈与视觉系统，不新增课程平台、大型知识图谱、自动题库或后台复习提醒。具体控件、查看入口/路由、状态版本/依据形态、停止与删除后的迟到结果处理、恢复与成本上限仍按[实施前置](../requirements/post-v1-roadmap.md#8-学习模式的范围与实施前置)核定；视觉数值沿用唯一 tokens，本节不另定数值或接口。

验收场景见[测试计划 §25](../testing/verification-plan.md#25-学习模式验收规格)，包含学习接续、来源/评估、用户控制、保存失败与明确转执行。学习效果、token 成本和真实 Windows 体验分别验证，不以界面、规格或一次回答宣称通过。

### 26.7 基础入口实现（2026-10-13）

按用户本轮「最基础功能，不需要压力测试」的范围，协作页会话模式增加「学习」单选框，切换沿原会话导航与草稿保护；在途或命令未核对时不切换。自由学习可不选目录或项目直接发首条消息。学习消息不带执行意图或 Skill，不调用项目状态维护和执行解释；回答标「学习搭档」，保留原消息/停止/用量展示。

输入器上方的「学习记录与接续」默认轻量折叠，读取当前学习目标、最近依据、具体待复核项及跨项目个人记录，不另起模型总结。展开按接触、自述、具体表现和缺口显示场景、处置状态、时间与来源会话。保存失败、读取失败和命令结果待核对会展开反馈；刷新读取失败时撤掉旧投影，不把旧缓存当当前记录。

「本条消息不记录」冻结在原发送载荷，只控制这条消息；「后续记录」开关读取持久会话控制，重开页面后仍按服务端值显示。纠正需要具体场景与说明，以明确 UI 命令保存为自述，不冒充答题验证；单项删除绑定当前概念代次；全清先说明工作空间学习记录范围，用户确认后执行，原聊天和项目事实保留。响应丢失时保留原命令/载荷，通过原回执核对或原身份重试，不显示保存成功。

「转入普通执行会话」预填最近已完成回答作为可编辑背景，用户给出明确执行要求后新建 AGENT 会话，带目标、学习会话引用及必要来源版本。来源与权限在新发送及后续执行时重查；学习认可不继承为批准或验收。消息/纠正尚有草稿或正在生成时转入按钮不放行，原输入保留。创建失败保留衔接内容并沿原创建/首条消息回执恢复，不原地改变学习身份。当前基础入口**不自动转发**学习对话中的自然语言执行请求。

视觉沿现有 tokens 和协作页样式，记录展开区有界滚动。上述为源码实现说明；组件、真实 PG 与未验的浏览器/Windows/Provider 出口分别归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)，本轮不启动成本实验或效果评价。

## 27. 内置 Skill 与聊天命令

2026-10-11，用户已逐项确认并授权制作文档；后续基础输入与菜单的实际接入边界见下文，定制、模型选择、压缩与完整文件恢复仍后置。产品入口见[总纲 §0.13](../../Personal_Workflow_OS_Master_Spec.md#013-内置工作方法与会话控制)，Skill 定义/范围归[扩展专题第 9 节](../architecture/relay-skills.md#9-内置工作方法与可定制-skill)，压缩与文件恢复责任归[运行架构第 8 节](../architecture/runtime-context.md#8-会话压缩与消息文件恢复)。聊天命令菜单、既有 Skill 下拉与 Ctrl+K 搜索是三个不同入口。

### 27.1 输入、菜单与方法提示

输入 `/` 打开命令菜单，兼容固定英文名与中文别名，显示名称、用途和本次作用范围；两种名字解析到同一行为。菜单既包含方法 Skill，也包含系统操作。**选中只插入输入框，用户补充内容并发送后才运行**；选择、浏览和退出菜单均不创建执行、业务变化或模型调用。保留草稿、中文输入法组词、键盘焦点和 Enter/Shift+Enter 的原规则。

**当前基础菜单（2026-10-13）**：首条与已有会话输入器共用菜单，聚焦输入框并输入行首 `/` 后，按需读取已有 `GET /chat-commands` 登记清单，按英文名、中文标题和别名过滤，不在前端复制方法定义。浮层在输入框上方展开并限制列表高度，避免把窄窗口输入框挤出视野；↑↓ 选择、Enter 仅插入规范命令与空格、Esc 关闭并保留草稿，Shift+Enter 沿原换行规则。参数、路径、正文里的 `/` 不展开，中文组词与 229 不选中或发送。清单读取失败保留输入并可重试，不猜默认清单；离焦或命令在途导致输入禁用时关闭菜单。选择方法时取消本地显式 Skill/提案类型选择，保留补充输入，防止旧选择覆盖本次方法；实际方法解析、范围扩大、权限和发送仍归原后端入口。

普通档显示登记方法与系统命令，学习/人设助手档只显示系统命令。菜单范围说明是默认范围，参数中的“全项目”仍由服务端解析；菜单不授予能力。`/model`、`/compact` 标为“待接入”，尚无会话的系统命令标为“需已有会话”；`/undo` 提示具体业务调整的撤回入口。选择这些条目仍只插入，发送时沿 §27.2 的实际接入边界反馈。真实 Windows/IME/DPI 仍待核验，实际成绩只归统一验收表。

普通自然语言可以自动选择合适的方法，回复简短显示“本次采用代码审查/故障诊断/文档维护”及必要范围；讨论方法不触发执行。当前任务和改动是默认范围，明确“全项目”才扩大；目标不明先问实际缺项。诊断默认定位与报告，明确“修好”才修改；明确的修复或文档维护指令可沿原执行链继续，无须因选择方法再问一次同范围确认。

首批方法见扩展专题，建议短命令为 `/review`（审查）、`/diagnose`（诊断）、`/docs`（文档）；除已讨论的诊断例子外，具体短名与中文别名在登记时冻结。既有四项项目 Skill 保留原行为，命令只是新增入口。项目/任务类系统操作按实际已存在的应用用例登记；缺少 Owner 或写协议的操作不先包装成“可用命令”。

### 27.2 会话控制与业务状态撤回

基础显示接续（2026-10-13）：当已加载会话同名时，选择项显示设备时区下的更新时间，并标明当前会话；原标题、身份和历史不改。新建或切换工作区级会话后，近期工作按协作页发布的确切会话 ID 读回并更新该行、高亮当前会话，不要求用户手动刷新，也不清空已经加载的任务分页。读取失败保留旧列表并提示重读，不用本地臆造行冒充事实。

**当前基础输入（2026-10-13）**：已有会话直接输入 `/clear`、`/new` 或其登记中文别名，经原命令端点创建并读回空会话后切换，保留当前身份、绑定与原历史。回执未知时输入保持原文并阻止离页，用户可查原回执或按原 ID/载荷重试；未发资料、补充输入、学习记录草稿或在途调整须先处理。尚无会话时系统命令仅说明需已有会话，不发首条模型消息。`/undo` 显示具体调整回执的撤回指引，仍沿 §18.9 选择与确认；`/model`、`/compact` 提示尚未接通。下表为已确认的完整目标语义；基础菜单已按 §27.1 接入，压缩/模型切换仍待实施；Windows 只取得统一验收表所列基础输入路径，新增菜单尚未取得窗口证据。

| 命令 | 已确认语义 | 反馈与边界 |
|---|---|---|
| `/compact` / 压缩 | 手动整理当前工作上下文，与自动压缩共存 | 显示正在整理、已建立接续检查点或失败；历史仍可读，不能显示成业务状态更新 |
| `/clear` / 清空，`/new` 为同义入口 | 新建空会话，保留当前项目/目录绑定，原会话留在历史 | 菜单说明“新会话，保留项目和目录”；不是删除历史、回滚文件或取消 Run |
| `/model` / 模型 | 仅修改当前会话后续新发起请求的模型；应用默认模型在设置修改 | 显示当前选择及生效范围；已开始的 Run，包括其后续调用，继续使用冻结契约 |
| `/undo` / 撤回状态 | 撤回可撤回的业务调整，如阶段、任务计划或下一步 | 复用 §18.9 的原撤回入口、目标判定、预检、冲突与回执；不回退文件或所有聊天效果 |

系统命令不为完成操作而调用模型 Skill。`/undo` 目标有歧义时沿原用例说明缺项，不能猜一个历史变更；若预检发现不可整组撤回，仍按 §18.9 要求具体范围决定，不以命令名绕过。`/clear` 在途时遵守原会话导航/草稿守卫，不能隐式停止执行；`/compact` 等待安全边界，`/model` 不改写在途输入。

命令不能改变会话身份。只读助手继续显示其合法能力，写方法和项目业务操作不可因命令获得准入；必要的转入普通执行会话沿现有入口，不原地升权。未绑定目录时可普通讨论和会话控制，涉及文件的请求明确说明未具备执行范围。

### 27.3 用户消息下的文件撤回按钮

用户消息下提供“撤回”按钮，含义是**恢复到这条消息发送前的文件状态**：撤回该消息及其后续本会话关联的文件修改。按钮文案/辅助说明表达此范围，不另要求输入文件回退命令。示例：第一条消息改 A，第二条改 B，点击第一条下的撤回恢复 A 与 B 的对应基线。原聊天、动作记录和历史产物版本保留，消息标明相关文件结果已撤回，不声称整条聊天或外部效果被删除。

一次点击表达上述完整意图。运行中可点击，按“正在停止 → 正在恢复 → 已恢复”展示真实持久状态；在停止、未决动作核对和排除旧 Writer 前不能恢复。重复点击、刷新或断线重开沿同一恢复请求读取实际进展，不重复发起一组写入；恢复期间新的冲突执行不能启动。

人工或其他任务的后续修改显示冲突并保留当前内容，基线缺失显示该消息不可恢复；不默默缩小范围后声称已恢复。权限拒绝、未停止、UNKNOWN、恢复失败及部分结果在摘要中直接可见，展开显示具体文件、原动作和实际恢复项。需要选择不同范围时明确展示新范围并取得具体决定；正常可恢复路径不额外增加例行确认弹窗。

若恢复撤销已完成任务的当前完成成果，复用原重开入口，进入新验收周期；只处理确实受影响的任务，不自动再执行。显示文件恢复和任务重开各自结果，保留历史完成/验证，不能继承旧 PASS。文件恢复成功而任务重开失败时，摘要说明实际部分结果和待核对事项，不显示全部完成。

该按钮与 §18.9“撤回本次调整”分别表达文件恢复和业务补偿。文件恢复不会顺带撤回无关阶段/计划，业务撤回也不操作文件；受影响成果的必要任务重开是文件恢复用例的协调步骤。

### 27.4 定制与上下文反馈

定制使用可外部编辑的 `SKILL.md` 目录，界面读取应用登记的同一版本事实，显示官方/个人/项目来源、当前版本、草稿差异和校验/Eval 结果。编辑文件、登记版本、启用版本和本次实际采用版本可区分；失败保留草稿，执行中继续展示原冻结版本。首版不要求通用可视化编辑器、脚本安装器或插件市场。

上下文圆环和缓存提示继续使用真实计量：Provider 未上报时命中率那一格不渲染（既不写「未采集」也不画 `0%`，口径见 §17.6），读不到上限则明确显示不可计算。当前占用以 `max_call_tokens` 为分母的口径保留为应用预算展示，不冒充模型物理窗口或压缩阈值。接入新预算与压缩检查点后分别说明工作窗口、已压缩范围和本轮真实用量；自动压缩给简短状态，失败及无法继续必须可见，不把“压缩完成”显示成“任务完成”。视觉参数沿用唯一 tokens。

未运行规格见[测试计划第 26 节](../testing/verification-plan.md#26-内置-skill命令压缩与消息文件恢复验收规格)，具体接口、恢复状态名称和定制控件在实施协议中冻结，本节不预定新路由或数据库枚举。

### 27.5 免费模型分组与模型选择

2026-10-15 目标交互；2026-10-17 选择器、客户端及首条发送接线已写入源码，运行接续仍在实施复验，成绩只归统一验收表。范围与免费定义归[后续路线 §9.1](../requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)，调用责任归[运行架构 §8.6](../architecture/runtime-context.md#86-模型目录会话选择与免费调用边界)。沿用现有输入器与浮层语言（模型选择是锚定下拉，不是居中弹窗），不借此重做导航或视觉系统。

模型选择包含原已配置模型与独立「免费模型」分组；分组展示来源、最近成功更新时间、“立即刷新”、模型名称及确切 ID、已知上下文窗口/工具能力和限制说明。目录单价为零与账户额度可用分别表达；未知能力或限额不编造。当前配置继续可辨，不自动把新模型设为默认。

浏览、搜索、刷新和取消均不切换模型、不发送聊天或测试推理。`/model` 仍遵守菜单选中插入草稿、发送才执行的规则；无参数发送时打开选择器，带具体型号发送时沿原模型选择命令执行。选择器的明确应用操作就是点选清单条目（见下文 2026-10-17 指令），经服务端确认后显示“用于本会话后续请求”。保存中禁止重复提交；失败保留原选择；回执未知复用原 PendingAction 的命令身份查询/重试，不另建回执 Owner。无会话时只保存首条选择草稿：发送过程固定创建、选择和消息各自命令 ID，选择成功后把其 revision 随首请求发送；服务端在消息准入事务内核对版本并冻结快照。两命令间发生改选则拒绝消息，不先按默认发出、不静默采用其他选择；响应丢失沿原 ID 接续，不重建会话。

首次加载、刷新中、首次失败无缓存、成功但无免费模型、旧缓存且刷新失败、未配 OpenRouter 凭据、能力不足、额度耗尽、已选模型下架/转收费分别可见。旧列表显示“上次同步”，过期或无法核实的项不得继续作为可调用免费模型；已选失效项保留名称和原因，供重新选择，不悄悄改值。应用默认与会话覆盖、会话选择与活动 Run 冻结策略分别说明，活动 Run 不随选择器变化。

2026-10-16 新增目标，2026-10-17 实施中：免费分组首次选择明确告知“当前模型额度或上游限流且账户额度仍可用时，按冻结顺序有界尝试其他免费型号”；展示首选与有界候选顺序，切换无需逐次确认。实际发生时显示从 A 到 B、已核实原因、实际生效型号和尝试序号，不把首选名当本次实际调用名，不自动改应用默认。区分“当前模型受限，已接续”“账户总额度耗尽，等待恢复”“全部候选不可用”“状态待核对”；已知冷却/恢复时间按来源显示，未知不倒计时编造。用户可在下一请求前改选择，停止/取消仍作用原消息/Run；切换历史和各次真实用量可追溯，不把重试当新任务或任务完成。完整规则归[后续路线 §9.1.1](../requirements/post-v1-roadmap.md#911-免费额度耗尽自动接续)。

仅需为必要状态复用现有组件与 tokens；键盘选择、焦点返回、Esc 保留草稿、窄窗与中文 IME 不能退化。具体控件随实施映射现有模型状态区，未运行出口归[测试计划 §26.3](../testing/verification-plan.md#263-免费模型目录与选择验收规格)。

**2026-10-17 用户指令（已实施）**：选择器不再在行内摊开来源、上下文、工具与 ID——触发器显示**当前具体模型名**（未选择时显示「模型」），清单**每项只显示模型名**，具体信息（ID、上下文、能力、失效/过期/未配凭据等原因）悬停看条目 title、读屏看可访问名称，当前选择以行尾对勾与淡底标记。清单条目点击**即应用并关闭**（既有命令入口，失败与 UNKNOWN 沿原回执恢复）；首条消息场景改为点选即写入本地选择草稿，不再要求先选再按确认键。原生效校验（配置/凭据/过期/文本输入输出能力）与「目录变化不自动改选」不变；`/model <型号>` 直接发送路径不变。视觉归[设计系统 §9.16](design-system.md#916-模型选择器触发器显名与清单只显名2026-10-17)。

**2026-10-17 用户第二轮指令（已实施）**：形态由居中弹窗改为**锚定在触发键上方的下拉清单**，与输入框「+」菜单同一套浮层语言（`zIndex.popover`、`radius.panel`、`border.separator`、`shadow.floating`、收缩到内容宽度），不新增 token；参考图里的「倍率」那一列不做，可见面仍然只有模型名。随之去掉「应用到后续消息」确认键——上一轮的点选即应用已经让它成为多余的第二步，`applyOnSelect` 这个区分也随之消失，首条与会话两种场景走同一条路径。收起语义：点下拉之外一次即收、Esc 收并把焦点还给触发键、刷新进行中不收（否则「目录已更新／暂未更新」的回执会在眼前消失）。键盘仍是「Tab 到条目 + Enter/Space/Esc」，不为此自建方向键 roving tabindex。触发器与清单条目都保留原生按钮语义；`aria-haspopup` 由 `dialog` 改为 `listbox`。

**2026-10-19 用户截图指令（已实施）**：「这个模型下拉框太大了」。真实窗口 473×887 实测面板高 558px、占视口 62.9%（未配 OpenRouter 调用凭据时约 600px／68%）：清单 `min(40dvh, sideWidth)`(355px) 是最大头，底部两段脚注在 meta 档还要再占约 126px。三处收型，**事实、命令与交互一条不减**：① 清单上限改 `min(24dvh, 18rem)`，用户窗约 6 行、常规桌面约 8-9 行即开滚（仍内部滚动，筛选框照旧）；② 同步脚注（最近成功同步 + 凭据/过期/失败告警）整行改 `font.size.caption` + `lineHeight.snug`，时间戳整块 `white-space: nowrap`——meta 档下「最近成功同步：<ISO 时间戳>」实测 268px，超出被「立即刷新」挤剩的 252px 列宽会溢到按钮上，caption 档约 230px 各占一行，时间戳也不再从连字符处断成两截；③ 有界接续说明同改 caption 档并压缩文案（默认启用、触发条件、最多 3 个合格型号、绝不转收费、共享额度耗尽即停均在，完整规则仍归上文与[后续路线 §9.1.1](../requirements/post-v1-roadmap.md#911-免费额度耗尽自动接续)）。同窗复测 **386px／43.5%**。量测用 Playwright + 页面内路由夹具（不连数据库与 Provider），复跑 `modelSelectorDropdown.spec.ts` 6/6 与 `modelSelector.spec.tsx`＋`newConversationEntry.spec.ts` 21/21 通过；视觉与数值归[设计系统 §9.16](design-system.md#916-模型选择器触发器显名与清单只显名2026-10-17)。

**2026-10-20 用户指令「记住上一次选择的模型，不要每个新会话都先显示『模型』两个字」（源码已接入）**：新对话的模型芯片不再从占位文案起步，初始就是这台机器上该工作区最后一次点选的型号。落点是本机偏好 `apps/workbench/src/lib/modelPreferences.ts`（键 `relay.workbench.lastModel:1:<workspaceId>`，与 `composerDrafts`、`recentWorkingDirectories` 同属「本机偏好」这一族；按 workspace 分区，因为不同工作区可能连着不同 API 与目录、型号未必互通），写入时机是点选那一下（首条选择器与会话内选择器两处都记），读取时机是新对话挂载与同页再点「新对话」的重置——后者只清草稿与在途状态，不再顺手把模型抹回占位，否则每点一次新建都退回「模型」两个字。

这条偏好**只是初始值，不是第二份业务事实**：① 会话自己的首选仍以服务端 model-selection 为唯一事实，会话内芯片读服务端投影，本机记忆不参与显示；② 服务端对没有选择过的会话沿用应用默认，界面不会拿本机记忆冒充当前生效模型——未建会话时它只是待绑定的首条选择草稿，发送时才随 `createAssistSession` 的 `modelSelection` 交给服务端核对（沿用上文首条消息的两命令时序，幂等与 UNKNOWN 语义不变）；③ 目录、资料、Skill 选择不在这里持久化，仍按「本次请求的候选输入、发送时服务端重新复核」的既有边界；④ 存储不可读或不可写（隐私模式、配额）时按「没有上次选择」处理，选择本身不受影响，只是不跨会话记住。验证：`tests/modelPreferences.spec.ts`（存储层：往返、跨 workspace 隔离、坏 JSON、空值即删、存储抛错）与 `tests/newConversationEntry.spec.ts` 三条视图级用例（芯片初始就是上次型号且首条发送按原命令绑定、点选即写偏好且重新挂载从它起步、同页再点「新对话」不退回占位）；实际成绩与未验范围只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

**2026-10-21 用户复述同一诉求（已实施，补上另一半路径）**：「要记住上一次选择的模型，不要每一个会话都先显示『模型』两个字」。10-20 那条只覆盖了**新对话**（首条输入器从本机偏好起步）；**已有会话**还有一条没走到的路径：服务端 model-selection 为空（该会话从未显式选过模型）且用户没打开过下拉时，`currentModel` 尚未读取，芯片仍然退回「模型」占位——切到任何一条没选过模型的老会话都会看到这两个字。改法是让芯片的显示值多一级服务端兜底：`ModelSelector` **挂载即读** `getModelPortStatus`（不再等打开下拉那一下），显示链改为「会话显式选择 → 打开下拉时读到的当前值 → 挂载读到的应用默认」，三级全空才退回「模型」占位（服务端没配默认、本机没选过，此刻确实没有可显示的型号）。应用默认只来自服务端 model-port 投影，不是本地推断，因此不冒充会话事实；会话有显式选择时优先级不受影响。验证：`tests/modelSelector.spec.tsx` 新增三例（无显式选择显示应用默认、服务端无默认才退回占位、显式选择优先于应用默认）**12/12**，A/B 去掉兜底链恰好第一条转红；回归 `modelPreferences`＋`modelSelectionClient`＋`writePermissionTier` 合计 **44/44**。本机偏好与服务端兜底的分界不变：偏好只做新对话的初始值，芯片显示的「当前生效型号」仍以服务端为准。


当前界面在输入卡外读取最近一条助手消息的模型运行态，首选、最近实际调用与当前候选分别显示，冻结顺序及逐次用量置于可展开详情。生成期间只读轮询，终态停止；切换原因和额度作用域来自服务端持久事实，未知不归因为模型额度。展示的是限流核对时的共享日余额，不能伪称当前余额；旧无快照消息不倒造首选。该读投影不替代消息状态、调用账本、Run 控制或业务验收。

## 28. 协作页结构重塑（2026-10-10）

依据 [协作页 UI 优化设计](../superpowers/specs/2026-10-10-collab-page-ui-optimization-design.md)（用户 2026-10-10 逐问收敛）。本轮只动 `/agent` 的**工作区级会话态**（`task === null`）与承载它的左栏，不改业务规则、命令、状态机、权限与草稿保护；视觉数值仍只有 [design-tokens.json](design-tokens.json) 一个源。

### 28.1 左栏（`RecentWorkRail`）

- **「＋ 新对话」置顶**：由纯图标入口升为带文字的 `primary-button`（`control.height`），仍在栏头行右侧，复用既有 `/agent?new=…` 唯一入口，不新建路由，也不新建第二套会话状态。
- **单行列表与悬停摘要卡**（2026-10-16 第五轮，用户指认；同日按用户逐条指认收尾）：行只有一行文字——可选的会话图标、标题（`font.size.meta` + `font.weight.regular`，单行省略）与置顶徽标同行；**行内不再常驻更新时间**。时间与归属改由悬停／键盘聚焦时出现的摘要卡呈现：第一行是完整标题（`meta` + `medium`）与右对齐的更新时间（`caption` + `color.text.muted`，`tabular-nums`），第二行是归属（`Folder` 图标 + 目录末段／项目名，与各自的分组依据同源）。摘要卡是纯展示层（`pointer-events: none`），指针从行移到卡片上不会闪断行的悬停态；位置由组件按行的实测位置摆放（`position: fixed`，贴行右缘外、与行竖直居中对齐，越界拉回视口内），滚动即收起。按设备本地日期：今天只显示时分、昨天显示「昨天」、更早显示月日，跨年补年份；同组同名项在日期后保留时分帮助区分。`time` 的 `dateTime` 与 `title` 保留原始与完整时间，摘要卡由 `aria-describedby` 与行关联。**行内不重复项目名**，归属由组标题与摘要卡承担，行的 `aria-label` 保留完整标题及项目。字号不再缩小，留白与缩进规则见[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)。
- **行距与激活标记收尾**（2026-10-16 第五轮，用户逐条指认）：行高 `min-height` 由 `control.height.comfort`(44px) 收到 `control.height.compact`(32px)，行内竖直内边距 `space.2`(8px) → `space.1`(4px) → `space.0-5`(2px)，行间距 `space.1`(4px) → `space.0-5`(2px)，**行距 48px → 34px**（命中区仍是整行宽，不缩窄指针目标，行高下限仍是紧凑档）；激活标记（行内激活条）相对条目左缘右移 **3px**——token 里没有 3px 这一档，按用户给定值写，标为待真实窗口复核（[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)）。摘要卡的时间沿用原有口径不加相对时长，用户明确「不用改」。
- **根区间距拉齐**（2026-10-16 第五轮，用户截图指认）：目标↔工作区（目录）↔任务入口原先各是 `margin-top space.3`(12px) + `padding-top space.2`(8px) = **20px**，而任务入口↔已归档只有一档 `space.3`(12px)。用户以「任务入口和已归档的间距就很合适」为准，撤掉那条分隔线删除后已属重复留白的 `padding-top`，**四个根区视觉间距统一为 12px**。用例按「上一区最后一个可见条目的底 → 下一区 summary 的顶」实测这四处间距，此前 `[20, 20, 12]`，改后 `[12, 12, 12]`。
- **会话行内操作是浮层下拉**（2026-10-16 第五轮，用户指认）：⋯ 与行按钮同属 `.recent-work-row-head`（行本体是 `<button>`，按钮里不能套按钮），因此 `inset-block-start: 50%` 的定位基准只剩行本身。展开面板从首版的「行下方就地展开」改为 `position: fixed` 的浮层下拉——就地展开会把这一行以下整列推下去，同时把 ⋯ 的 50% 拉到「行 + 面板」的中线，这正是用户指认的「点击三个点位置会改变」。面板优先开在触发器下方、放不下向上翻，右缘与触发器对齐并拉回视口内，滚动或点到别处即收起；这一列在滚动容器里，绝对定位会被裁掉，而祖先链上没有 `transform`／`filter`／`contain`，故用 `fixed` 而不引入 portal，DOM 仍留在这一行内。改名仍是面板内的一行输入；命令语义（每命令一枚 `command_id`、409 只重读不重发、结果不明不重发）未动。
- **行内菜单分组成「图标 + 名称」**（2026-10-16 接续，用户提供参考菜单截图）：⋯ 展开的动作面板从纯文字竖排改为**两组**——置顶／取消置顶（`Pin`／`PinOff`）与重命名（`Pencil`）一组，中间一根 `color.border.separator` 分组细线，归档（`Archive`）收尾并保持状态色（`color.status.danger.text`）；归档态行仍只有单一「重开这段讨论」（`RotateCcw`），不因改版多出当前发不出去的动作。条目语言与输入器「+」弹层（[设计系统 §9.14 浮层条目](design-system.md)）同款：图标取 `font.size.body`(16px) 而非 `control.icon.size`(20px)——20px 图标压在 14px 选项名旁会比文字还重，名称取 `font.size.meta` + `font.weight.medium`，行高 `control.height.compact`，圆角 `radius.control`，悬停 `color.selection.hover`；面板外壳（`radius.panel` + `border.separator` + `shadow.floating` + `zIndex.popover`）与第五轮的浮层摆位逻辑均未动。参考菜单里的分享任务、在独立窗口中打开、批量操作与删除任务在本项目没有对应命令、接口或调用方，**不占位**；上游对照为 ZCode 的 `TaskActionMenuContent`（Item／Separator 原语注入、禁用带原因）与 opencode 侧栏行内归档。零新增 token、零新增色值、零新增命令或服务端接口；改动落在 `SessionRowMenu.tsx`、`.recent-work-row-action`／新增 `.recent-work-row-separator` 与浏览器用例的动作顺序、分组断言。
- **未读与复制会话 ID**（2026-10-17，用户指令「增加复制任务id，标记为未读这两个选项」）：行内菜单在上一轮的两组结构里扩展为五项——置顶／取消置顶、重命名、**标记为未读／取消未读**（`Mail`／`MailOpen`）仍属「常用改动」；分组细线之后是**复制会话 ID**（`Copy`）与归档（`Archive`，唯一状态色）。归档态行仍只有「重开这段讨论」，不出现未读或复制。① **未读是服务端导航标记（迁移 `0104`）**：每条命令带 `expected_revision`，成功后由 `onRowChanged` 只重读这一条，行上的圆点与菜单里的反向文案都来自读回的 `unread_at`，不做本地乐观翻转；409 只重读不重发、结果不明不重发与置顶相同。② **复制是纯客户端动作**：走 `navigator.clipboard.writeText`，不发命令、不落库、不推进修订；写入的是 `relay://sessions/<会话ID>` 而不是裸 ID（2026-10-18 用户指令，参照 `codex://threads/<id>` 的读法），粘到别处仍读得出这是 Relay 的哪条会话；本机没有注册 `relay://` 协议入口，所以它只是文本身份，粘回来不会自动打开会话，也不构成深链能力。复制成功后面板保持打开，同一行文案换成「已复制会话 ID」，1.6 秒后复原；剪贴板不可用或写入失败就地说明「请手动复制会话 ID」。③ **未读圆点**画在类型图标与标题之间，状态同时追加进行可访问名称（「· 未读」），不只靠颜色；视觉归[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)。④ **本轮不做点开自动清除**：只有人工 toggle 一个写入方，并发已由 `revision` CAS 裁决；§18.6 那句「未读资料」指消息／资料级的读态，与会话行的未读不是同一件事。服务面归 [HTTP §10.87](../api/http-command-contract.md#1087-会话未读标记2026-10-17-源码实现迁移-0104)，迁移归[数据库 §94](../database/physical-design-postgresql.md#94-0104-会话未读标记2026-10-17-源码实现)。
- **⋯ 不自带底色、菜单宽度跟条目一致**（2026-10-16 接续，用户截图指认「三个点不要有悬停阴影，然后菜单宽度要跟里面的 item 一致（留出一点内间距）」）：①触发器底色去掉——此前它常驻 `color.selection.hover`（想让 ⋯ 读成行的一部分），但行悬停本身已有淡底，控件再叠一块就成了「⋯ 自带阴影色块」；现在控件始终透明（静止、悬停、展开三态实测 computed background 均为 `transparent`），显形只靠 `display`，指针落在 ⋯ 上只把图标换成 `color.text.primary`。②面板从 `min-width: 10rem`（160px 固定下限，右侧留一片空底）改为 `width: max-content` + 兜底 `max-width: min(15rem, 100vw − space.4)`：条目满行宽，于是「面板宽 = 最宽条目自然宽 + 两侧各一档 `space.1` + 两条 `border.width`」，实测动作态 160px → **94px**。③面板改成按内容定宽后，改名输入框（默认自然宽 `size=20` ≈ 177px）与失败说明（26 字中文句 ≈ 312px）会反过来把浮层顶到上限——改名表单整体与错误句都按 `--recent-work-panel-content`（`10rem − 2×space.1 − 2×border.width` = 150px）锁宽，改名态面板实测 **160px**（与改版前那一档持平），错误句在 150px 内换行。零新增 token（仍 153）、零新增色值；坐标摆位逻辑（第五轮）与命令语义未动。
- **整行右键 = 点 ⋯，菜单贴回三个点下方**（2026-10-18，用户截图指认「现在只能通过三个点打开菜单」「菜单离三个点太远了（竖直方向）」）：① 会话行的行头整块接 `contextmenu`，`preventDefault` 掉原生菜单后经 `ref.open()` 打开**同一个**面板——锚点仍是 ⋯，不跟指针落点走，这一行因此只维护一套摆位几何（向上翻折、横向拉回视口、滚动即收起全部照旧）；任务行没有可改的会话事实，右键不接管。② 浮层与触发器的间距由 `space.2`(8px) 收到 `space.1`(4px)，与上游 Radix 下拉 `sideOffset` 同一档：⋯ 图标只有 20px 却压在 32px 的控件框里，8px 间距再加面板 4px 内边距使「点字→第一条」实际隔了约 19px。零新增 token、零新增命令；离视口边缘的 8px 留边与归档/未读/复制的命令语义不变。
- **分叉这段讨论**（2026-10-18，用户指令「增加归档、fork（fork之后的那个会话名字加一个"（1）"）」，选定「带历史 fork」）：行内菜单在「取消未读」之后、分组细线之前加入第六项 `GitFork`「分叉这段讨论」；归档态行仍只留「重开这段讨论」，不出现分叉。① **命令与重读**：单击即发 `POST /assist-sessions/{id}/fork`（`expected_revision` 取行上读回的服务端修订，回执 `201`）；成功后**源行一行都不改**——`onRowChanged` 不重读源会话、不推进它的修订，而是按回执里那条**新会话**的身份走既有 `refreshSession` 读回子行。切换会话或收起面板期间到达的回执照旧按身份隔离，不把子行插进错误的 Workspace。② **标题归服务端**：末尾「（n）」→「（n+1）」，否则追加「（1）」；编号跟着被分叉那一条自己的标题走，同一源会话分两次都得到「（1）」，界面不本地拼编号。来源经 `forked_from_session_id` 随列表/单会话投影返回，只解释编号，不参与判定。③ **409 只重读不重发**：陈旧基线、归档态与在途消息都由服务端拒绝，界面分别重读当前事实；子会话 `revision=0`，第一次行内命令的基线从 0 起。④ **复制范围**：搬已完成的消息与图片附件（按新序号重排），提案与过程/结局（用量、请求号、worker、错误码、模型选择与尝试状态）不搬——见 [HTTP §10.93](../api/http-command-contract.md#1093-会话分叉2026-10-18-源码实现迁移-0113) 与[数据库 §102](../database/physical-design-postgresql.md#102-0113-会话分叉血缘2026-10-18-源码实现)。已知限制：子会话里的历史消息不回显当时的模型选择（0098 的两列成对，复制后的历史不再需要排队期快照），桌面窗口未点验。
- **删除这段讨论**（2026-10-18，用户指令「危险操作像是会话归档删除，都要有一个 toast 可以让用户撤销动作」）：⋯ 菜单在「归档」之后新增 `recent-work-row-action--danger` 的「删除这段讨论」，已归档行的菜单同样保留这一项；删除与归档是两条通道，归档可撤销、删除不可撤销，因此**不合并**成一个「移除」。单击只开 `AppDialog` 确认框，初始焦点压在「取消」上；正文逐字写明将删除的消息、图片附件、工具调用记录与相关账本，并声明删除后不可撤销、没有回收站。确认后发 `DeleteAssistSession`，成功即把这一行从活跃与归档两个分区同时摘掉（行已不存在，不再重读）。被其它对象引用时服务端按 `409 SESSION_DELETE_BLOCKED` 拒绝，阻止项按可读中文留在确认框里并指向归档；回执不明时确认键锁死，只允许按原 `command_id` 查回执，不换 ID 重发。协议归 [HTTP §10.94](../api/http-command-contract.md#1094-会话物理删除2026-10-18-源码实现迁移-0116)，删除边界归 [ADR-027](../decisions/ADR-027-session-physical-delete.md)。
- **删除的确认改成就地浮层、条目名收成「删除」**（2026-10-19，用户指令「删除这段讨论改成删除」「这个弹窗改成这样的简单弹窗」）：上一条里「单击只开 `AppDialog` 确认框」的呈现部分**由本条替代**——确认不再铺遮罩、不再有长正文与关闭叉，而是把 ⋯ 面板就地换成一张窄卡：标题「删除这段讨论？」+ 一句后果（消息、附件与工具调用记录将永久移除，无法恢复）+「删除／取消」两键（删除在左、取消在右，两键等宽铺满内容宽——2026-10-19 用户指令「删除放左边」「删除和取消的宽度加起来要和菜单一致」），初始焦点仍压在「取消」上。两条理由：这一行刚在菜单里点过「删除」，再铺一层遮罩等于把同一件事问第二遍；而原正文里「被任务验收、项目假设、工作片段、学习记录引用时不能删、请改用归档」只在服务端真的拒绝时才成立，平时常驻只会稀释「这一下不可撤销」这唯一要紧的一句——现在它只在失败分支出现。**失败语义一条没变**：`409 SESSION_DELETE_BLOCKED` 的阻止项、409 冲突的重读说明、回执不明时锁死确认键，全部留在这一层浮层里（收起来就等于把「没删成」和「删了但结果不明」一起藏掉）。菜单条目同步由「删除这段讨论」收成「删除」，四个字由浮层标题接手；已归档行的那一条同改。视觉归[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)。验证出口：`tests/sessionRowMenu.spec.ts` 删除四例按新形态断言（无 `.dialog-panel`／`.dialog-backdrop`、取消键就在 ⋯ 面板里、标题逐字），**19/19**。
- **会话行的批量选择复选框与批量删除**（2026-10-20，用户指令「给会话 item 加一个复选框，方便删除记录」）：会话行（含「已归档」段里的）在**本行悬停或键盘聚焦时**，类型图标那一格换成复选框；已勾选的那一行始终保留复选框，**其余行不常显**（同日用户指令「复选框不要常显」——勾了第一条就让整列冒出方框，这一栏会被读成一排勾选框而不是会话列表）。勾上第一段讨论后，主内容区上方浮起一条批量操作浮层「已选 N 段讨论 · 删除 / 取消」（`fixed` 定位、不占左栏列表高度、不随聊天区滚动；同日按用户「你可以做成弹窗什么的」「应该大致放在红框部分」由左栏固定带改为正文上方浮层），点「删除」在原地换成确认（「删除这 N 段讨论？」+ 一句后果 + 删除／取消，两键等宽、左右与文字同一条边界），确认才发命令。三条边界：① **选择只是选择**——勾选不发命令、不落库、不推进任何修订，任务行没有删除命令因此不参与选择；同一段讨论同时出现在「目标」与「工作区（目录）」两段里时，两处勾选共用同一个会话 ID，删也只删一条。② **一段一条命令**：服务端只有逐条 `DeleteAssistSession`（ADR-027），客户端不假装原子，也不新增批量端点——每段各取 `command_id`、各带那一行读回来的 `expected_revision`，串行发送、逐条等回执，成功与失败分别如实报告（「已删除 2 段讨论；「×」还不能删除（被任务验收观察引用）」——同一阻断原因只写一次、标题并列，同名去重后写成「「×」等 3 段」，处置建议也只出现一次），被引用阻止的那段留在列表里并指向归档。③ **结果不明不重发**：响应丢失时勾选保留、确认键锁死，说明「本次是否已删除尚未确定」，只能退出本轮——与 ⋯ 面板里那条单条删除同一读法。④ **结果只出现一次（DEV-0098，2026-10-21）**：确认后若有阻止或部分失败，同一张卡片停在「删除结果」终态，只留「关闭」，不再退回「已选 N 段讨论 + 删除」的第三次确认；关闭清空选择，要重试需重新勾选。删除不可撤销，因此全部成功时不留提示也不给撤销条：行当场消失就是回执。视觉与实测几何归[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)（同日用户截图指令把计数行居中、取消态右键收成「取消」、两键按内容宽收窄成对居中，并让同因阻断合并成一句）；验证出口：`tests/sessionRowMenu.spec.ts` **24/24**（新增四例：勾选零命令、逐段命令与修订、部分成功、回执不明锁键；另有一例同因聚合）、`recentWorkRailDensity.spec.ts` **10/10**（行高/行距基线未回归）。
- **目标与目录分别组织会话**（2026-10-16 用户校正后实施）：
：左栏设「目标」「工作区（目录）」两个可折叠区，任务保留在「任务入口」。目标指正式 Goal，不等于 Project、Task 或文件夹；Goal 可由多个 Project 推进，也就能汇集不同目录的相关会话。当前通过已保存的 `Goal ↔ Project` 关系聚合 `task_id=null` 的会话，**未新增会话直接绑定 Goal 的能力**，不把项目关联冒充 Task 显式目标对齐。一个会话可出现在多个 Goal 入口与一个当前目录入口中，始终使用同一会话 ID 与原历史；各组计数是该组已加载入口数，不相加充当会话总数。
- **目录依据**：会话以 `GET /assist-sessions?include_context=true` 的只读 `context.working_directory` 分组，目录名只取规范路径末段、完整路径保留在提示中，不从项目名称或本地最近目录偏好猜测。`context` 缺失显示「目录待核对／目标关联暂不可读取」，真实空目录绑定显示「未绑定目录」，已绑定而路径缺失仍保留目录身份。空关联与读取失败不混用，搜索仅覆盖已加载的标题、项目、目标名及规范路径。数据库 Workspace 仍是隔离边界，UI 的「工作区（目录）」不改变它的语义。
- **目录行悬停「＋」新建会话**（2026-10-18 用户截图指令「鼠标悬停 item 的时候要显示一个新建会话的按钮，点击自动以该目录新建一个空会话」）：有真实规范路径的目录组行（`group.path !== null`）在悬停或键盘聚焦时右端显形一颗「＋」；「未绑定目录」与「目录待核对」没有可打开的路径，不长这颗键。按钮是 `<summary>` 的**兄弟节点而不是后代**——HTML 规定 summary 的后代不得是交互内容，套进去点击与折叠会互相吞；它绝对定位压在数字徽标那一格上，静止 `display: none` 不占几何，显形时徽标以 `visibility: hidden` 让位（仍占宽，标题可用宽度与行盒逐像素不动），指针从行移到「＋」上时按钮自己就是悬停目标，不闪断回徽标。点击只带一条一次性入口 `/agent?new=<commandId>&dir=<规范路径>`：左栏不建会话、不发任何命令，目录事实与首条命令仍只有协作页一个 Owner；协作页在挂载那一拍把 `?dir=` 当一次性种子，按与手动换目录**同一条 `openFolder`** 打开，落地是空白输入，会话仍在首条发送时才创建、先绑目录再发消息。**目录在途直接挂首条输入器**（2026-10-22，DEV-0104；替代 2026-10-20 三版的整页在途态）：用户复测仍点名「正在核对目标与会话」闪一下，根因是「旧会话面板 → 整页在途 → 首条输入器」至少两次整块替换。现在 `?dir=` 在途也直接挂工作区级首条输入器：发送键按 `creationPending` 禁用，细条写「正在打开目录…」，草稿可以先写；目录回执一到，项目作用域用回执里的项目事实（`project_id`／`project_title`／`project_archived`）作为首帧目标种子，`AssistView` 先画同一张输入器，再向服务端核对完整目标与会话——`targetSettled` 之前在屏上不出现「正在核对对话目标与会话」，也不显示「正在刷新目标与会话…」。任务聊天的新对话同理用已读到的任务事实作种子；恢复既有会话、默认续写与目标读回失败仍按服务端事实走，失败落到可重试错误页。**无响应时有确定出口**：`openWorkingDirectory` 仍是无超时的写命令，等待超过 4 秒在细条上方浮出「取消并回到新对话」；浮层不参与流式布局，插入与消失都不移动输入卡或空态标题（2026-10-22 真实 Chromium 复测：提示出现前后 `composerTop` 均为 584）。取消只摘掉 URL 里的 `?dir=` 种子、保留其余键（如 `?skill=`），不重发命令、不换 `command_id`（原命令结果是否落地仍由服务端决定），目录随后由细条重新打开；快路径（本机 API 通常一瞬）不显示这个出口。目录事实 Owner、命令链路与首条发送语义不变。视觉与几何归[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)。
- **目录绑定确认后必须重读作用域**（2026-10-18 用户实机截图指认「输入卡上方说当前的工作目录是 X，顶栏与左栏还写未绑定目录」）：顶栏的「会话目录」与左栏分组都是 `context.working_directory` 的只读投影，而目录绑定命令由协作页发起——两处都不会因为一次绑定自己醒过来。协作页在回执确认后递一个变化计数（`ActiveConversation.contextEpoch` 给左栏，`sessionContextEpoch` 给会话视图），两者各自重读服务端这一条再决定显示什么；计数只是「该再问一次」的信号，不是第二份目录事实，也不改会话身份、命令身份或权限。回执已确认但重读失败时保留上一份服务端读数，不把没读到的写成「已绑定」。同一目录重复选择时不重发命令，但仍重读一次，避免早前某次读取落在绑定之前后界面永久停在旧事实。同一确认也让协作页自身那份 `boundDirectory` 投影重读——任务视图「工作详情」抽屉的「工作目录」兜底行读的是它（抽屉优先显示刚打开的 `folder`），所以换目录后抽屉不再停在切会话前那次读数。
- **恢复原会话**：目标入口以 `?session=<原ID>&goal=<GoalID>` 定位，目录入口以 `?session=<原ID>` 定位；URL 中的 Goal 只是入口线索，正文只显示服务端确认的关联。项目会话深链接先核对原会话，再按其 Project 读取，不能走自由会话分支；读取失败就地重读，不创建替代会话。正文顶部独立显示「关联目标」「会话目录」，后者是已保存的会话目录，不冒充输入区尚未核对的本地执行作用域。目标入口不自动授予全部关联目录的上下文或执行权限，目录操作不改 Goal 关联。会话行仍用 `MessageSquare` 图标，挂在任务上的会话继续由原任务入口承担。
- **分组层级**（2026-10-16 截图反馈接续，同日第二轮收淡底与折叠）：目标／工作区（目录）／任务入口统一为可折叠根区，根标题使用 meta + semibold 与右侧折叠标记，**淡底只在悬停／按下时出现，静止不铺底**——三个根区常驻淡底会在窄栏里连排成灰白条纹，读成三张卡片而不是同一列的层级；层级由字号档、字重、缩进与留白表达（同日第三轮连根区分隔线也去掉，视觉见[设计系统 §9.11](design-system.md#911-近期工作栏窄列搜索框与行密度2026-10-16)）。内层 Goal／目录／项目名称走 caption + medium + secondary，向内缩一档，条目恢复 meta + regular，选中项提升为 medium。空态只显示辅助字号的短提示并**水平居中**（这一段没有可点对象，左对齐会读成还有一列没显示出来），完整已加载范围留提示。折叠状态仍写 `localStorage`（`relay.workbench.recentWorkCollapsedGroups`，纯展示偏好），根区键为 `goals`／`directories`／`tasks`，内层 `goal:<id>`／`directory:<id>` 及原项目任务键兼容保留。**折叠偏好是唯一依据**：定位（切换到另一条会话或任务）时展开它所在的区与组一次，之后不再常驻强制展开——原实现按「当前项在哪一组」把 `open` 钉住，活动会话必然落在「工作区（目录）」里，那一段因此永远收不起来。
- **当前项高亮**：`color.selection.bg` 底 + 行内激活标记（`focus.width` 宽、`color.action.primary`、上下内缩 `space.1`、收 `radius.round`）+ 主名 `font.weight.medium`（普通项 regular），三者共同表达同一状态，不靠颜色单独区分。标记由伪元素画在行内而不是 border：未选中行不必空出这 2px，切换选中时文字不横向跳动。条目列表在分组竖线内侧再留 `space.0.5`，让整条目与激活标记都离开竖线一档——原先二者贴着画，选中行的色带会与「这根线属于这一行」混读。键盘焦点仍走全局 `focus.ring` 内描边，与选中态分开表达。任务高亮取 URL 的 `?work=`；会话高亮取协作页发布的活动会话投影（见 §28.4）。
- **「查找更多任务 / 会话」入口删除（2026-10-16 同日第四轮，用户确认）**：原栏底就地展开面板删除，`components/TargetPicker.tsx` 随之无调用方一并删除。依据取证：该面板只读与左栏相同的两个端点（任务仅 `getWorkspaceTasksPage(null)` 第一页、无搜索无翻页；会话集与左栏一致且不含归档），能显示的左栏都能显示、翻页后左栏更多，是更弱的重复入口；左栏（搜索＋「更早的任务」）成为任务与会话的唯一导航入口。原 `aria-expanded`／`aria-controls` 与 Esc 返回焦点的约定随入口一并失效。纯前端删减，无 API、权限、命令或会话草稿 Owner 变更。
- **会话行拖拽改序（2026-10-17 用户需求）**：未归档的会话行可以按住拖动，拖动时在该列画一条横线，指出松手后这一行会落进哪道缝；横线不占网格轨道，拖拽期间整列的布局不跳，松手才重排，所以「横线承诺的位置」与「条目真正落下的位置」是同一处。**按住的那一行跟着指针走**（同日用户接续指认「鼠标要抓着这个 item」）：整行按「指针相对起手点走了多远」平移，抓握点因此始终按在行的同一处，读起来是手里拿着它，而不是它在原地等指针去够；带起来的只有起手那一列的那一份，同一会话在另一列里的副本留在原地。平移写在 `transform` 上，落点数学读的仍是布局（`offsetTop`），所以整行跟着手动不会把落点算偏。落点由该列实测几何算出，指针落在两行之间即取那道缝。只有未归档会话所在的列声明 `data-reorder-list`，任务行与归档区起手落空；⋯ 触发器与它的动作面板不参与起手，否则改名输入无法选字。位移不足 4px 仍算单击（照常打开这条会话），落回原来那道缝不写任何状态。松手后浏览器补发的那次 click 由组件内一个只活到下一个宏任务的护栏吞掉——那一击不是「进入这条讨论」，行只是被搬走了。**顺序是本机导航偏好，不是业务事实**：写在 `localStorage` 的 `relay.workbench.recentWorkSessionOrder`（`{ version: 1, sessions: [会话 ID…] }`），不发命令、不新增迁移、不改服务端 `pinned_at`／`last_message_at` 排序键，也不建立第二套全局会话事实；目标分组与目录分组读同一个全局次序，各组只是它的子序列，在一处拖、两处同步。规则：从未手动排过序的会话排在已排序项之上（新会话仍会出现在前面）；一旦排过序，该行位置不再跟随置顶——置顶仍写服务端 `pinned_at` 并照常显示徽标，只是不再把这一行推到列首。抓握必须 `setPointerCapture` 在行按钮 `.recent-work-item` 上而不是整行 `<li>`：Chromium 会把兼容的 `mouseup`／`click` 一并重定向到抓握者，抓在 `<li>` 上时补发的 click 落不到按钮，普通单击就打不开会话（真实浏览器用例实测到并据此修正）。**改序这件事必须在屏幕上看得出来**（2026-10-17 用户追加需求「增加一点动画，要不然都不知道有没有交换成功」）：松手后只有真换了位的行播一段位移，起点是松手那一拍它所在的位置（手里那一份从指间放下去，另一列的同一份从旧格子滑进同一格），所以动画指的就是那一次交换，不是整列重播；落回原格那一拖照样滑回家，不硬跳。刚落位的这一行随即留一档一次性落位强调，到点自己消失，连拖两次时前一次的强调立刻让位给后一次。这段只是装饰，不承担事实：本机关动效或系统要求减少动态效果时整段不播，行照样换位、强调照样给出（换成静态），次序与回执都不受影响。视觉、动效与数值见[设计系统 §9.17](design-system.md#917-会话行拖拽落位横线2026-10-17)。
- **会话按最后消息时间自动上浮**（2026-10-18 用户确认口径「就按消息的最后时间算吧，不管是 ai 还是用户」）：没人手动排过序时，未归档会话列的自动序由服务端 `GET /assist-sessions` 决定——**置顶优先，其余按最后消息时间倒序，还没说过话的回落创建时间**（`pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc`，迁移 `0111`）。客户端 `compareSessions` 用读回的 `lastMessageAt ?? createdAt` 排同一档，不再按 `updatedAt` 自行猜一套：此前左栏按会话行的 `updated_at` 重排，而那一列只由改名／置顶／未读／归档／绑定写入，AI 回完一条消息它根本不动，「按最后回复时间排」在服务端与客户端两头都不成立。口径按用户指定取**活动序**（不分发送方，失败或取消的那一轮同样上浮），不取 OpenCode 那种只在用户发起时 touch 的「最近问序」；上游对照与为什么不复用 `updated_at`、为什么不推进 `revision` 都归[数据库 §100](../database/physical-design-postgresql.md#100-0111-会话活动排序键2026-10-18-源码实现)与 [HTTP §10.91](../api/http-command-contract.md#1091-会话列表的活动排序键2026-10-18-源码实现迁移-0111)。三件事本轮**没有**改：① 手动拖出来的次序仍然优先，排过位之后不再跟随活动序（上一条的规则不变）；② 悬停摘要卡显示的时间仍是会话行的 `updated_at`，未随本列改成活动时刻——它是元数据写入时间，与「刚才说过话」不是同一件事，改显示口径属另一轮界面决定；③ 未读仍不参与排序。**实时性限制（如实）**：左栏只在挂载、整列重读与行内命令后的定向重读时取新序，没有轮询也没有事件订阅，所以 AI 说完那一刻这一行不会当场跳位，要等下一次重读才收敛。

### 28.2 主区（`CollaborationView` 的 `task === null` 分支）

- 删除消息区上方两个 `details` 大块（`folder-scope-bar`、`collab-existing-work`）：它们压在首屏最显眼处，展开体量大、折叠后又只剩一行摘要。承载的功能全部保留并换位。
- **欢迎卡**：标题「这次想聊些什么？」取 `font.size.compactPage` + `font.family.ui` semibold（原为 `font.size.page`，2.5rem 会把真正要做的事压出视线）；副说明回到 `body`；下方引导卡（`bg.subtle` 底 + `border.separator` 边 + `radius.control`）内嵌编号步骤与一行结尾提示。
- **归属回执**（PENDING / CONFIRMED / UNKNOWN / FAILED）位置语义不变：紧贴细条下方、不折叠，UNKNOWN 的原命令回执核对入口原位保留。
- **「最近动态」每行以类别标签起手**（2026-10-18 用户指令「这个项目标签移动到字的前面，就不会对不齐」）：行＝圆点 + 类别 chips（完成／项目／其他…）+ 事件摘要 + 行为人与相对时间。此前 chips 跟在摘要之后，两列排布下每行摘要长短不一，chips 起点各不相同，读成没对齐；移到行首后同一列的 chips 由列左缘决定，天然对齐。先后关系由 `tests/collaborationWorkspace.spec.ts` 的 DOM 顺序断言锁住，不锁像素。
- **顶栏右翼不再放「新建会话」（2026-10-18 用户截图指令「删除红色箭头指向的加号」）**：顶栏只负责会话身份与视图开关——右翼＝「切换讨论」（本作用域读出 ≥2 条讨论时）、「任务视图」（任务聊天）与固定在最后的「工作详情」，工作空间级、目录、项目与任务归属一律不摆新建入口。另开会话仍有两处真实入口：左栏「新对话」（每次新的 `/agent?new=…`，只建无作用域讨论）与目录细条浮层里的「新对话」（保留当前目录归属，走同一条离开保护）；`?skill=` 等非顶栏会话带（`sessionControls`）的「新建会话」渲染与延迟建会话语义不变。删除只动 `AssistView.tsx` 顶栏右翼的一行渲染与仅服务该键的标签隐藏规则；会话选择、「切换讨论」浮层、`data-testid`、命令与 Owner 均未变。视觉与取证归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)。

### 28.3 文件夹作用域细条（`FolderScopeBar`）

- 常态一行：目录图标 + 目录名（`body` medium，超长按本档省略并把完整 `canonicalRoot` 挂 `title`）+「已归入项目：X」/「未归入项目」（`meta`/`text.muted`；2026-10-18 按用户纠正「会话的话不是一定要归入项目的」：缺项目只是事实、不是缺陷，说法从「未归属」改成会话左栏同用的「未归入项目」，避免读成两个并列的问题）；底色 `color.bg.canvas`，无上缘分隔线（2026-10-16 按用户反馈去掉：消息区与输入区之间只保留这一行常驻状态，不再叠一条横线）。内容收进输入卡同宽同轴的一列（`--chat-measure` + 居中），不横贯整列。整行不收进胶囊（常驻状态线不是卡片），也不加圆角与阴影。「X」是服务端事实解析出的真实项目标题：任务路径沿 `task.projectId`、纯会话恢复路径沿会话目录绑定的 `projectId`（2026-10-16 修复：此前恢复路径无解析来源，会退回「当前项目」占位冒充归属），两条路径都不在解析失败时用占位冒充已解析。
- **目录名即「更换目录」入口（2026-10-18 用户指令合并）**：输入卡上方原先还有一行状态行（`ComposerStatusBar`，「工作目录：xx · 更换目录」+「写入权限：xx」），与细条重复着「当前目录 + 换目录动作」同一件事。按用户指令两行合并——细条是唯一幸存的那一行，「更换目录」与「未选择目录」并成一枚键：**目录名本身就是按钮**（点它打开选择框，`aria-haspopup="dialog"`，busy 时禁用），行内不再摆第二颗动作键。它首先是事实主角：颜色对比、`body` + medium 字重、本档省略与 `title` 一律照旧，告警态随细条换 `status.warning.text`；其次才是键——全局 `button` 只继承字体与颜色、不重置外框，因此这枚键自己剥掉原生边框、底与内边距，静止不描边不铺底不加下划线，悬停只补一道下划线说出「可点」，键盘 focus 走全局 focus ring（该「静止无装饰」只适用于**已有目录名**那一档，缺目录档的常驻线索见下条）。合并只动呈现与转发：颜色对比、省略与 title、告警语义、对话框行为（见下条）一律照旧；状态行的「写入权限」摘要在协作页随之不再渲染（嵌入态没有细条，仍显示只读摘要，见 §32.10）。
- **缺目录那一档写成动作，并常驻一道虚线下划线（2026-10-18 用户指认「未选择目录的话用户不一定知道这是一个按钮」）**：合并后静止态没有任何可点线索，而「未选择目录」是个状态名词，读起来像提示、不像入口。按用户选定的方案只改缺事实这一档：`directory === null` 且没有会话绑定路径时，那颗键的文案直接是动作「选择工作目录」，并常驻一道**虚线**下划线（`text-decoration: underline dashed`，色取 `text.muted`、线宽 `border.width`、偏移只有 `1px`，这一档必须 `overflow: visible`）——虚线说的是「这里还缺内容，点它是去补」，与已有目录名那种实文本分开；悬停换成实线，与另两档的悬停语义一致。**2026-10-18 用户实机截图指认「常驻下划线没生效」**：全站链接那档 `0.2em`（约 3.2px）落在 20px 行盒之外，被这颗键为省略号保留的 `overflow: hidden` 裁掉——计算样式仍报 `underline dashed`，像素却画不出来；现改为 1px 偏移、本档放开可见溢出（文案是固定短串、永不省略），浏览器用例也改成同时断言「未裁切」（按字体度量算基线＋偏移＋线宽与盒高比较），不再只看计算样式。下划线取 `text.muted` 而非 `currentColor`：告警态文字是琥珀色，同色下划线会把这一行读成一条警示。已有目录名后回到上条的纯文本＋悬停下划线，不给真实目录名加装饰。**装饰只走 `text-decoration`**：不描边、不铺底、不加内边距，因此「不落回原生控件外观」那组读数（`borderStyle: none`／透明底／`padding: 0`）一字未动，由 `tests/browser/emptyConversationWelcome.spec.ts` 与 `tests/browser/conversationToolbarDensity.spec.ts` 分别锁缺目录档（文案＋常驻虚线）与已绑定档（静止无下划线）。入口的 `data-testid="folder-scope-change"`、`aria-haspopup="dialog"` 与浮层行为全部不变；写入档位芯片那三档「未选择目录／未归入项目／未绑定目录」文案属另一枚控件（§18.1.3），本轮未动。
- 未就绪（`NOT_READY`）或未归入项目时告警由图标、目录名与状态短语三处的前景色（`color.status.warning.text`）承载，整条不铺警示底色（琥珀底横贯输入列喧宾夺主，2026-10-15 按用户反馈去掉）；文案沿用原文（`folder-scope-not-ready` / `collab-unassigned-execution-hint`）。可见区只留「这件事的后果」（「目录未就绪，暂不能执行写操作」/「不影响讨论，执行前需先归入项目」），完整原因给读屏与 `title`，不与归属那一句重复。缺项目一句必须同时说出「讨论照旧」（2026-10-18 用户纠正：会话不要求归入项目；只有执行与写文件需要它——受管目录与写入策略挂在项目下），因此前半句先解除限制、后半句才说执行前提。
- **挂载点**：细条紧贴输入卡上方，经 `AssistView` 的 `composerHeader` 槽位渲染——目录是执行准入的前提，离发送动作越近越可执行。目录写命令、草稿守卫与归属命令仍只有协作页一个 Owner，细条只做呈现与转发。
- **细条右端紧跟「待你处理」（2026-10-18 用户指令：先「这两个没有处于同一行了」，再「不要放在最右边，放到执行前需归入项目的右边」）**：`.agent-chat-prereq-row` 把目录细条（嵌入态是状态行）与「待你处理」并成一行——细条按内容收（`flex:0 1 auto`，不再撑满），待处理紧跟状态短语之后，中间隔一档 `space-4`（16px；行内其他间距仍是 `space-2`，靠这一档说出「这是两组事实」）。整行的同宽同轴由该容器承担（`--chat-measure` + 居中），细条左缘仍与输入卡对齐，只是可写宽度按内容收。窄窗放不下时整块按 `flex-wrap` 换行，目录名的省略规则照旧、先挤的是本档就省略的次要事实。「待你处理」按当前工作区给只读计数与跳转（目标 / 待判断 / 未读讨论 / 未归属任务），空态或读取失败时整条不渲染，此时该行只剩细条。归属与目录绑定回执仍各自占整行（`flex-basis:100%`），不挤进状态行。首条输入区与会话内空会话两处同一位置（不同入口的新会话首屏一致）。**两组文字必须落在同一根水平轴上**（2026-10-18 用户指认「这个待你处理为什么跟左边没有在同一个高度上」）：细条原来那 `space-1`（4px）上内边距挪到行容器上，细条自己在行内 `padding-top: 0`——`align-items: center` 居中的是盒子而不是文字，那 4px 留在细条盒子里就把细条文字压低 2px，同一行的「待你处理」因此高出 2px；呼吸留在行上，嵌入态（只有状态行）与空态同样保留。结构由 `tests/collaborationWorkspace.spec.ts` 锁（细条与该行同属一个行容器、整行在输入器之前）；真实 Chromium 的同宽同轴、待处理紧跟细条内容之后（不顶到行右缘）与两条文字的等高（中心差 <1px）由 `tests/browser/emptyConversationWelcome.spec.ts` 常驻锁住，该用例只在本例内覆盖 `/reviews**` 让「待你处理」有真实内容，其余用例仍走空列表整条不渲染；1280 宽探针实测（改前 细条文字中心 727.0／待处理 725.0，改后同为 727.0，细条 408–710、待处理 726–1008、行与输入卡 408–1152）截图存 `results/probe-pending-row.png`。
- **［更换目录］是锚在目录名上方的紧凑浮层**：`FolderScope` 控件（原生选择 / 手动绝对路径 / 近期目录 / 多项目候选）是它唯一的内容，控件本身与命令路径未动。2026-10-18 第二轮按用户参考图把它从 `AppDialog`（`size="lg"`，40rem≈640px 居中模态，带标题、副标题与全屏遮罩）改成非模态浮层：`position: absolute` 向上锚在细条上（`bottom: calc(100% + space.1)`，左缘与目录名同轴），宽 `min(18rem, 100%)`（实测 288px），单列按「近期目录 → 分隔线 → 打开文件夹／新对话 → 手动路径／候选」排布，每条一行（`control.height.compact`，32px），解释文字一律移出可见面只挂 `title`。高度上限 `min(52vh, 26rem)` 并在面板内滚动，这一档由容器约束定出而不是审美值：`.collab-center { overflow: hidden }` 会裁掉越界的浮层，1280×620 下取「+」菜单那档 60vh 时多项目候选态上缘被裁 5px，收到 52vh 后实测 top 101.6、未被裁。面板必须自己声明正文色（详见[设计系统 §9.19](design-system.md#919-更换目录浮层紧凑锚定2026-10-18)）。关闭语义（点外面、Esc、别的浮层打开时独占）与焦点交出／回原入口都收口在 [lib/popoverMenu.ts](../../apps/workbench/src/lib/popoverMenu.ts) 的 `useMenuDismiss`，和「+」菜单、模型下拉同一套；`aria-haspopup="dialog"` 不变，浮层自身仍用 `role="dialog"` + `aria-label="更换工作目录"`，因此按对话框身份查询的既有断言与测试夹具的 `folder-scope-change` 触发契约都不变。选定后浮层自行关闭（留在原位会挡住刚更新的细条）；只有需要再选一次作用域（`candidates.length > 0`）时才把它重新打开，因为候选按钮就在里面。入口 2026-10-18 起就是目录名本身（见上条）；2026-10-17 那轮「静止降到无底 + `border.separator`、hover 回完整 chip」的降档规则随独立键一并退场（规则仍留在[设计系统「协作页结构原语」](design-system.md#协作页结构原语2026-10-10)的 chips 降档变体，供后续常驻状态线复用）。同日第二轮：`+` 菜单「选择文件夹」不再借这枚键打开本浮层，改为**直接开原生目录选择器**（见 §32.3）；本浮层仍是本机没有原生选择器时（浏览器／示例模式）的目录入口与多项目候选所在，此时手动绝对路径块使实测高度到 390.5px，仍在上限内、不触发滚动。
- **「已归入项目：X」说的是这段讨论的归属，不是这个目录登记在哪个项目下（2026-10-22，DEV-0117）**：此前只要有目录打开着，这一格就取该目录回执里的关联项目，于是归属命令在途或被服务端拒掉时，同一行里同时出现「已归入项目：MyProject」与紧随其后的「这段讨论还没有归入项目」，顶栏与左栏还按会话事实说未绑定目录——用户实机报的「目录不匹配」就落在这格上。现规则：会话身份已确定（协作页已收到当前会话）时，这一格只按服务端读回的 `session.project_id` 说，没归入就是「未归入项目」；还没有会话的新对话照旧按本页选定目录的关联项目说，因为那条讨论的归属与绑定由首条发送决定。目录与会话指向同一个项目时借用目录回执里的标题，不为说一个名字多等一次项目读取。在途与被拒两档由 `tests/assistBinding.spec.ts`「细条的归属文案跟随会话事实（DEV-0117）」锁住，确认后那一档由同文件「自动续上既有未归属会话后打开目录」锁住；左栏目录「＋」带 `?dir=` 进来、这条既有讨论的归属被拒那一档由同文件第三条锁住，真实 Chromium 的改前/改后同一行截图见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)的 DEV-0117 行。

### 28.4 活动会话投影（`lib/activeConversation.ts`）

左栏与协作页在组件树上是并列的，没有父子通道。协作页把 `AssistView` 已经回报给它的「实际展示的会话」再发布到一个只读投影，供左栏做当前会话高亮；协作页卸载时清空。这不是第二套业务状态：会话身份的唯一 Owner 仍是协作页。

### 28.5 与设计稿的差异（实现时确认）

- **「未选透明底」未采纳**：设计稿 §3.4 写模式 chips 未选时透明底，§4 的规格表写 `bg.surface` + `border.control`。同一排的「资料」「普通讨论」也是 chip，取规格表使整排外观一致。
- **归属用语**：原项目任务分组继续统一用「未归入项目」；会话区已按 §28.1 分成 Goal 与目录两个维度，目录未绑定用「未绑定目录」，不得把它等同于未归入项目。
- **细条挂在输入卡上方而非消息区顶部**：设计稿 §3.2 写「输入卡上方」，§3.2 另一处写归属回执「紧贴细条下方」。两者只在细条位于输入区一侧时同时成立，§18.4 原文也写「固定在输入区上方」，因此按输入区一侧实现。
- **空态两分**：设计稿 §5 提到「首装 / 搜索无匹配 / 范围为空」三分，左栏实际只有前两种可区分，未新增第三种文案。
- **「回到最新」**：胶囊化是改样式（原为无底无框纯图标），出现/消失仍是挂载/卸载，没有退场动画。

### 28.6 验证与限制

已运行：`tsc --noEmit`、`vitest run`（100 文件 862/863，唯一失败为 `run-events` SSE 时序既有 flake，单跑 5/5）、`vite build` 均 exit 0；受结构变化影响的 10 个组件 spec 与 4 个 Playwright 布局 spec 同步改写（目录入口改走更换目录框、选择器改走左栏就地展开区、请求清单补上新增的会话读取）。真实 Windows 窗口下的中文 IME 组词、DPI 100%/150% 输入卡版式，以及浏览器布局 spec 的实机结果尚未取证，只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

本轮不做（YAGNI）：风格基调、标题带与左导航栏、有任务态（`task !== null`）布局均未动；token 零新增；不做全站推广。

### 28.7 双视图收口与密度试点（2026-10-14）

**「聊天视图 / 任务视图」此前不切换。** 两个容器 `.collab-task-view-container` 与 `.collab-chat-view-container` 都声明了 `display: flex`，作者样式压过 UA 的 `[hidden] { display: none }`，因此 `hidden={workbenchView !== "task"}` 形同虚设：任务视图下仪表盘与聊天区同时渲染，各自约 396px 挤在同一列。这是「整页很挤」的最大单一来源，**先修它再谈视觉**。修复方式是在协作页显式收口 `.collab-center > [hidden] { display: none }`，与既有 `.collab-columns > [hidden]` 同一写法，不建立全局 `[hidden]` 规则。切换后仪表盘占满整列（实测 795px），聊天区 `display: none`。

**字号减负（试点范围仅本页）。** 实测本页 302 个可见文本节点里 197 个是 `font.size.meta`（65%），正文 `font.size.body` 与之只差 2px，层级拉不开；同时 eyebrow 用 10px 临时值、统计数字用 25px 孤立体量，两端被硬编码填充。据此：

- 新增 `font.size.caption`（0.75rem）作为背景注记档，只给字段旁注、单位计数、eyebrow、状态副文案、面包屑与页头 meta。**不用于正文、列表主名、按钮和任何需要读懂的说明句**——那类文字仍走 meta/body。
- 顺带把 `TaskViewDashboard.css` 里 0.625rem / 1.25rem / 1.5625rem 三处硬编码字号收回 `font.size.caption` 与 `font.size.rowTitle`，不再存在第二套数值。
- 试点后本页 12px 占 10%、14px 降到 55%，28/18/16px 档保持不变。

**纵向节奏。** `.collab-center` 的 `gap` 与顶部内边距原为 `space.1`（4px），页头与正文之间 0px，而同页空态用 24px——同一页两套密度标准。试点把块间距放到 `space.3`、顶部内边距放到 `space.4`，页头 `.collab-goal` 内边距与右栏 `TaskInspectorPanel` 的分区间距同步放宽。

**未做**：全站推广、Codex 式单列限宽重排、右栏常驻宽度调整。这些属于布局取舍，不在本轮。

### 28.8 V4.2 工作详情与成果预览接续（2026-10-15）

`/agent` 保留聊天/任务双视图，聊天与工作详情同时打开时暂时收起独立成果栏，给消息和输入保留主列宽度。成果栏保持挂载，未发送内容与原判断状态不因收纳被清除；「查看待处理」、检查及文件工具仍沿原入口展开，用户在更多操作中明确选择对话、成果或双栏时按其选择展示。开关统一叫「工作详情」。

成果页只列现有 `Artifact`，不再把验收条件作为文件。点击文件从已有只读接口读取确切版本正文；从任务视图打开时也传递同一产物与版本身份。清单和正文分别有加载、失败/重读与空态；失败不转换成假正文或「没有成果」。任务修订变化会刷新清单，已打开的不可变版本不会自动跳到最新版；切换任务立即隐藏旧预览并忽略旧读取的迟到响应。

「版本与来源」展示读取版本的 ID、来源、摘要及当前完成凭据引用。`currentAcceptedVersionIds` 仅表示当前完成凭据所引用的版本，不代表所有历史接受或确切版本的验证结果；引用未读到时显示待读取或失败，不作确定的未引用判断。Run 结束、检查结果、人工判断和任务完成仍分别表达；运行失败不推断成检查失败，没有完成凭据时不显示正式完成成功态。

原生窗口复查接续：任务概览按当前执行者显示人工或 AI；人工完成且没有 Run 时只说明已有完成凭据，不声称 AI 执行过所有步骤。正文读取遇到 `EVIDENCE_UNAVAILABLE` 时给出读取场景说明，不能套用完成命令的「完成被拒绝」文案；真实内容不可读仍保持错误，不因版本元数据或凭据可读而转为成功。

详情与预览页签支持方向键、Home/End、单一 Tab 停靠点和 panel 关联。预览返回后恢复相应成果按钮焦点，关闭详情回到开关。聊天区新增双视图容器后须继续把剩余高度传给会话，消息局部滚动，输入卡留在底部；样式与尺寸归设计系统，实际检查与限制只归统一验收表。

会话顶栏以当前会话为主：左翼两行显示当前会话名与真实关联目标、会话目录，右翼按事实放切换讨论、新建会话、任务视图与工作详情。长标题可省略并通过 title 核对；右翼均为纯图标键，窄窗仍保留可访问名称。这里只调整信息层级，不改变会话选择、新建准入、目录绑定或详情行为，Breaking Change：No。视觉与响应式归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)。

会话与任务聊天共用 `WorkDetailsFrame`（标题、进展/成果/记录页签与关闭行为），默认收起。展开后的宽窗分列、窄窗覆盖规则相同；无关联任务时只显示对应空态，不伪造 Task/Run。关闭后焦点回到当前可见的开关。

2026-10-16 入口归一：任务入口默认进入聊天；任务仪表盘保留为显式「任务视图」。任务聊天与新对话复用同一会话工具栏、目录细条及详情外壳，Run 的 UNKNOWN/控制/待人工处理事实在聊天页仍常驻。旧 `/tasks/:id?skill=assist`、`/projects/:id?skill=assist` 分别转到 `/agent?work=`、`/agent?project=`，指定会话时保留原身份；`/agent?session=` 若经服务端确认属于任务，则恢复到该任务的同一会话。目录只从服务端持久绑定恢复；切到另一已有会话时清除上一会话的本地目录，同时保留项目导航归属，避免退回工作区空会话。普通/人设/学习身份及原历史仍按所选会话恢复。

首条消息采用「创建会话 → 绑定目录 → 发送原消息」。绑定失败不抢发消息，未知结果的重试沿原绑定 command_id 与原消息载荷。普通消息不再自动 POST 执行解释/状态解释；终态后只读回主流程保存的候选，明确执行与人工决定仍由原应用 Owner 处理。读取本身不建 Task/Run，连接与权限仍须配置。

2026-10-15 本轮接续三处：

1. **正文失败必须透出服务端给的真因。** `EVIDENCE_UNAVAILABLE` 的 detail 已由服务端按 `MISSING / TAMPERED / UNREADABLE` 区分（“受管内容文件缺失”与“内容与登记 hash/size 不一致”是两种完全不同的处置），界面此前把三者压成同一句“当前不可读取”，等于丢掉定位根因的信息。现在正文错误显示“这个版本的正文当前不可读取（服务端说明：<detail>）”，并明确重读仍针对该确切版本、不改用其他版本；仍不套用完成命令的拒绝文案。
2. **同一成果的每个历史版本都要能直接到达。** 预览栏在版本数 >1 时给出「确切版本」切换（按版本号倒序、`aria-pressed` 标注当前），切版本只替换正在读的确切版本，不改写返回焦点——返回后仍是打开它的那颗成果按钮。单版本成果不渲染该组。
3. **进展页的风险提示与成果页尾各给一条去处**：attention 条目内“查看执行与验证记录 →”与成果页尾“查看版本来源与检查”都进入记录页，避免“看见了风险却不知去哪处理”。

2026-10-16 顶栏左区去重：会话视图顶栏此前把当前会话标题显示两遍——左区一行加粗标题、中栏下拉的当前项同一个字符串，并把左块撑到三行。现在**会话身份只由中栏下拉承担**（它同时是显示与切换入口，标题被截断时完整值挂在其 `title` 上），左区只保留「关联目标 / 会话目录」两行作用域事实，完整路径与多目标仍由该块的 `title` 给出。新对话（尚未建会话、中栏刻意不给下拉）不再由顶栏重复标题，其欢迎标题仍在正文空态里。这不改变任何事实的可见性口径：目标与目录仍分别成行、目录仍只露末段（§9.11），未读到上下文时仍显示「待核对」而不是猜。视觉档位归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)。

2026-10-17 顶栏右翼与目录呈现（用户指令）：「工作详情」由带文字的按钮改为纯图标开关——无可见文字，收起态用 `PanelRightOpen`、展开态用 `PanelRightClose`，命中区 32×32、图标 18px，展开时落选中底色；`title`／`aria-label` 随状态说「展开工作详情／收起工作详情」，`aria-expanded`／`aria-controls` 与焦点返回保留。会话目录由「会话目录：路径末段」文字改为 `Folder` 图标，完整路径进入悬停提示与可访问名称，未绑定目录时图标降 muted；关联目标仍显示文字。这里只改呈现，开关仍操作同一 `WorkDetailsFrame`，目录仍只读服务端持久绑定，不授予上下文或执行权限，Breaking Change：No。视觉细节归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)，分隔条悬停与拖拽同款归[设计系统 §6.3](design-system.md#63-全局滚动条与拖拽分隔条2026-10-17)。

2026-10-18 顶栏会话目录补回目录名（用户实机截图圈出这一格问「怎么没有显示当前会话在哪个目录」）：上一轮收成纯图标后，这一格只说得出「有一个目录」，说不出是哪一个，且与同一行仍是文字的「关联目标」读成一边有值一边没值。现在显示 `Folder` 图标 + 目录名（服务端绑定的 `canonicalRoot` 的路径末段，超长按本档省略），完整路径继续在悬停提示与可访问名称里；未绑定／待核对／暂不可读取三档占位说法重新显示在可见面（缺哪件事实要看得见缺什么，不靠悬停）。仍只读服务端持久绑定，不授予上下文或执行权限，目录写入入口仍只有输入卡上方细条那一颗键；`data-testid`、路由、命令与目录 Owner 未动，Breaking Change：No。视觉与收缩规则归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)。

2026-10-21 目录完整路径的悬停载体接续（本机 `title` → 共享浮层）：会话顶栏「会话目录」格与输入卡上方细条的目录名，其完整 `canonicalRoot` 悬停提示由原生 `title` 改为共享的 `usePathTooltip` 浮层（`apps/workbench/src/lib/pathTooltip.tsx`）——原生 `title` 在 WebView2 里延迟约 1 秒、只在带该属性的元素上出现、且不可样式化，长路径读起来像「没有反应」；浮层改为悬停与键盘聚焦都即时出现，Esc 与移出即收起。**这句话本身没有变**：完整路径仍同时由可访问名称（`aria-label="会话目录：<完整路径>"`）承载，事实来源仍是服务端绑定，不新增第二份目录读数。受影响的是断言载体——`tests/assistBinding.spec.ts` 里「顶栏按服务端重读更新」那条从读 `title` 改读 `aria-label`，期望的字符串一字未动，改的只是读哪一个属性（详见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行）。视觉与浮层行为规则归[设计系统](design-system.md)；Breaking Change：No。

2026-10-22 悬停载体再共用一处：输入区底栏的上下文占用圆环（用户指令「上下文圆圈的鼠标悬停效果优化一下」）。它原先把「输入 800 / 1000 tokens（80%）」这句挂在原生 `title` 上，同一批缺陷（延迟约 1 秒、样式不可控）落在一个 18px 的圆环上更明显；现在与目录名共用 `usePathTooltip`，悬停或键盘聚焦即浮出同一句，原生 `title` 一并去掉，不留两套提示叠着。**这句话本身没有变**：`aria-label` 仍是「上下文占用 <同一句>」，读数仍取最近一次回复的 `usage` 与 `/model-port` 的 `max_call_tokens`，不新增第二份用量来源。视觉规则归[设计系统 §组件表 ContextMeter](design-system.md)，Breaking Change：No。

### 28.9 收件箱页按 V5.11 原型改版（2026-10-18）

用户以 Relay V5.11 原型的收件箱页（页头 kicker + 三张状态统计卡 + 卡片式通知行）为参考，要求改造本仓收件箱页。**只改呈现结构与信息层级，不改收件箱语义与任何数据链**：收件箱仍只收未归属项目的人工任务，live 仍只调 `GET /tasks?inbox=true` 并按 `next_cursor` 续页，fixture 仍读同一范围示例；状态/执行模式/标题筛选仍只作用于已加载范围，已加载数、当前筛选可见数与后续页状态分别显示，不把首 50 项或筛选结果称作全量；刷新、失权、切范围或 Workspace 时仍清旧数据并隔离迟到响应；响应里出现有 Project 或非人工执行的任务仍停止显示。路由与别名不变：`/inbox` 仍跳 `/tasks?tab=inbox`，顶栏图标与 Ctrl+K 入口不变。

页面从「表格 + 常驻右栏」改为「页头 → 范围页签 → 三张状态统计卡 → 紧凑筛选工具栏 → 任务卡片 → 范围说明折叠块」：统计卡只数当前显示范围里的待整理 / 可开始 / 阻塞三桶；任务行整行是一个链接（标题 + 未归属项目 · 状态 · 执行模式 · 执行者 · 修订 + 等待/阻塞原因），行首状态色块与 `StatusChip` 同一套图标与语气，待整理行用 `selection.bg` 浅绿底对应原型「未读」行；行内不放「打开」按钮，整行即入口。fixture 与 live 两条数据链收进同一 `InboxView`（`client` 为 null 走示例数据），`TasksView` 只保留全部范围与人工待处理占位；宽屏不再有常驻右栏，范围说明改用共享 `.page-explanation` 折叠块。三种空态（范围为空 / 筛选无匹配 / 已加载无匹配）与全部 `data-testid`、筛选控件名保持不变。视觉与布局规则归[设计系统 §9.18](design-system.md#918-收件箱页结构2026-10-18)；Breaking Change：No。

2026-10-17 右翼相邻键图标化（延续用户同一指令）：「切换讨论」「新建会话」「任务视图」「工作详情」四键统一为纯图标键，命中区 32×32、图标 18px、间距 `space.2`，全部靠 `title`／`aria-label` 保留「切换讨论／新建会话／任务视图／展开·收起工作详情」的可访问名称；四键的显示条件与点击语义未动——切换讨论仍只在本作用域 ≥2 条讨论时出现，新建会话仍在任务/项目归属时出现并只在该作用域内建会话，任务视图仍在任务聊天出现，工作详情常驻并固定最后。任务视图 PageHeader 的动作区仍是「查看待处理」在前、工作详情在最后；其右侧既有的「更多操作」菜单（委派、布局、任务与执行详情、文件与运行工具、模型连接）保持原位，本次没有增删条目。**未在会话顶栏新增「更多」**：顶栏没有明确的低频动作可收（进展、成果、记录仍在工作详情面板内），任务/项目/运行的低频入口已在任务 PageHeader 的既有菜单里；不建空菜单，也不把 UNKNOWN、待人工处理、运行控制等关键状态折进浮层。开关仍操作同一 `WorkDetailsFrame`，面板默认收起、宽窗分列、窄窗覆盖、焦点返回与 Esc 行为均未改，Breaking Change：No。视觉档位归[设计系统 §9.13](design-system.md#913-会话视图顶栏密度2026-10-16)。

## 29. 验收证据与投入判断

2026-10-11。**产品设计已确认，以下为未实施、未验收的交互增量**。产品取舍只归[总纲 §0.14](../../Personal_Workflow_OS_Master_Spec.md#014-验收证据与投入判断)，依赖与待核定项归[后续路线 §10](../requirements/post-v1-roadmap.md#10-验收证据与投入判断的范围和分期)。沿用同一事实源、自然语言入口和摘要加展开，不预定新路由、状态枚举或视觉数值。

### 29.1 从交付消息核对证据

单 Task 的交付消息下首先显示本次验收范围、可核对结论和关键缺口，展开后按已登记验收条件列出来源、版本、被测范围及当前适用性。Task 详情使用同一聚合投影，避免聊天与详情各自推导通过状态。默认无需模型调用；明确请求查漏时，将 AI 建议单列为待考虑条件。

“选择材料”只读取用户主动选中的文本日志、测试输出或 Markdown，展示确切材料版本和待补关联；保留尚未核实的材料入口。收录成功、关联成功、正式验证结果及 Task 完成分别呈现。不能因用户选择材料就显示检查已运行或通过，也不默认读取全仓、其他 Agent 或外部账户。

版本变化、证据过期、未运行、检查失败、工具故障、读取失败和关联不明在摘要中可见，展开给出原因与原处理入口。缺口建议引导到原补条件、验证或人工处理流程，首片不提供新的自动补验闭环。沿用[既有验收视图 §11.3](#113-面向需求的验收视图)，不能把历史匹配当当前适用。

### 29.2 试用计时与假设结论

试用记录提供找证据阶段的开始、结束、暂停、继续控件；摘要显示有效耗时和暂停状态，展开显示暂停记录、总经过时间、流程类型及适用样本。计时暂停不会触发执行控制；中断、刷新或恢复后的呈现须以核定的持久记录为准，不能凭页面存活时长补造记录。

用户可自然语言补充准备时间和整体验收耗时，应用带入本次试用上下文；记录确认后展示采用口径与缺失项。原始计时与补录说明可核对，准备成本不被藏在展开区而只显示查找加速。

明确要求建假设时复用已有想法与来源，给出主张、方法、标准和待补项；建议建档不等于创建。Agent 建议结论、用户确认结论及后来投入决定分别可辨认，样本不足显示无结论，不把完成试验或确认结论显示成 Task 完成。

### 29.3 决定复审与工作段复盘

相关依据发生已记录变化时，原回执及项目摘要显示“需要复核的决定”候选与原因，展开可回到原决定和确切依据；原决定继续显示其真实状态。处理候选走原决定入口，不能在投影内静默替代。

用户可一句话指定复盘的工作段；有开始时预期基线就带入，没有就说明缺失。保存预期的回执只说明已记录比较基线，不显示任务已创建、计划已应用或执行已启动。复盘摘要呈现预期与已验收产出差异、已确认返工/介入、实际成本及未采集项；疑似事件另列候选和依据，确认后才进入统计。

### 29.4 主动比较计划范围

从已有[下一段计划 §19](#19-下一段工作计划n04已确认规划)或自然语言请求进入推演，展示固定基线及相同可用时间下的范围候选。先比较做哪些、推迟哪些及其依赖后果，再展开估时来源与缺口；未知时不生成确定完成日期。

选择方案展示具体变化和原计划处理入口，计划应用与执行请求各自说明实际结果。来源更新、版本冲突、部分应用或读取失败保留候选及已确认事实，并沿原命令核对；不能以新的推演覆盖活动 Task 或复活旧执行授权。

未运行规格见[测试计划 §27](../testing/verification-plan.md#27-验收证据与投入判断验收规格)。选择器、计时与候选处理的具体接口和并发恢复协议须先核定，现有材料导入或任务证据组件不代表本节增量已经可用。

## 30. 输入框自动分点与手动润色

2026-10-15。**用户已确认核心交互**；2026-10-16 已按实现默认 A 接入源码（见 §30.6），**未验收**。本节为该功能的唯一详细交互事实源；范围与依赖见[后续路线 §11](../requirements/post-v1-roadmap.md#11-输入框自动分点与手动润色)，验收规格见[测试计划 §31](../testing/verification-plan.md#31-输入框自动分点与手动润色验收规格)。

### 30.1 目标与已确认选择

用户可连续描述多个需求，不必先手动用标点、换行或编号组织。停笔后自动给出分点建议，用户采用后才替换草稿；自动分点保留原话，润色由单独按钮触发。

| 决策 | 已确认行为 |
|---|---|
| 自动触发 | 选择 B：停笔后出现建议，不在输入过程中直接改正文 |
| 分点力度 | 选择 A：只拆分、换行和编号，保留原话，不顺手润色 |
| 润色入口 | 点击「润色」后优化当前草稿表达，成功后同一按钮变为「撤销润色」 |
| 撤销目标 | 精确恢复点击润色前的草稿，保留当时已有的分点格式；随后按钮变回「润色」 |
| 润色后手动编辑 | 选择 A：继续保留撤销入口；撤销连同这些手动修改一起丢弃，并显示此后果的提示 |

撤销不再弹确认框。此处的「原话」是**本次润色之前**的草稿，不是最初尚未分点的一整段；下一次润色重新建立本次快照。无须先采用分点才能润色。

### 30.2 输入、分点与采用

1. 用户在原输入框连续输入，正文和光标保持由用户控制；中文组词期间不触发分析。
2. 停笔后对当前草稿生成建议。默认只显示紧凑提示，例如「已整理为 4 个要点 · 查看」，不抢焦点、不弹模态框。
3. 展开查看原文与建议，点击「采用分点」才替换草稿；忽略或收起不发送消息、不改原文。忽略后同一草稿版本不反复出现提示。
4. 采用后仍可编辑，并提供「撤销分点」恢复采用前原文。该入口是一次分点变更的撤销，不扩展成通用编辑历史；开始润色时结束该撤销入口，后续由润色前快照负责恢复。
5. 发送沿原输入器规则执行，只发送当前可见草稿，未采用建议不能混入消息；发送仍是一条消息，不自动拆建多个 Task。

分点按含义判断边界，不能把一句原因解释机械拆成独立需求。限制、条件、否定、顺序和关联对象须留在原所属内容中，不补写需求标题或摘要。例如「先不要做短信登录」必须原样保留，不能改成待实施项。

推荐技术方式为模型仅给出原文切分边界，程序按原文切片并添加换行、编号；不能用模型重写的句子冒充保留原话。所有切片保持原顺序、连续、无遗漏、无重叠，去掉程序新加的格式后可逐字重建输入；保留原标点，不为排版删除用户字符。没有合理分点时不强拆。

示例原文：

> 给登录页加个记住密码，密码输错了要提示原因，还有登录按钮现在太小了改大一点，手机上也要能正常显示，先不要做短信登录

示例分点（只添加编号、换行，原文标点仍在）：

```text
1. 给登录页加个记住密码，
2. 密码输错了要提示原因，
3. 还有登录按钮现在太小了改大一点，
4. 手机上也要能正常显示，
5. 先不要做短信登录
```

该示例不是按逗号分割的算法规格；「把按钮改大一点，因为手机上不好点」应作为相关的一点保留。

### 30.3 润色与撤销

| 状态 / 操作 | 草稿与按钮行为 |
|---|---|
| 点击「润色」 | 冻结当前可见草稿作为本次请求来源；清除旧分点建议，按钮显示「润色中…」，不重复提交 |
| 润色成功且来源仍适用 | 保存该次原文快照、替换草稿；同一按钮显示「撤销润色」 |
| 润色期间继续输入 | 允许编辑；旧请求立即失效，返回结果不得覆盖，不能把润色前快照错误绑定到新草稿 |
| 润色失败 | 当前原文仍可编辑/发送，按钮回到「润色」，就地说明失败并允许用户再次点击 |
| 成功后手动修改 | 保留「撤销润色」与原快照，不因编辑将按钮重置；提示「撤销将恢复润色前原话，并清除润色后的手动修改」 |
| 点击「撤销润色」 | 直接、精确恢复快照，清除本次快照，按钮回到「润色」，焦点返回输入框；不调用模型 |

润色允许精简口头语和调整语序，但不得改变需求、数字、路径、否定、条件、范围和先后关系；已有分点结构保留。此为语义质量要求，不能仅因输出类型通过就宣称已保证。

润色成功至撤销或发送之前，暂停自动分点，包括成功后的手动编辑；发送成功后新草稿恢复自动分点。发送失败保留当前草稿和润色快照；发送响应未知沿原发送回执流程处理，不能撤销或改写已经冻结的在途发送载荷。切换/关闭仍遵守原草稿和未决发送保护。

### 30.4 来源隔离与失败

分点和润色都属于发送前草稿辅助，不创建消息、Task、Run、提案、业务批准或完成事实。模型整理请求仍属于真实模型调用，应走既有服务端凭据、准入、预算和用量记录，不把「未发聊天」写成「没有模型调用」。模型只获得当前草稿与必要处理规则，不默认附带会话历史、项目资料或目录文件。

每次请求绑定原输入器、连接/工作区、会话或首条草稿身份、内容版本及操作类型；采用或替换前重查来源。仅比较文本内容不足以处理删改后又恢复相同文本的情况。编辑、发送、换会话、换工作区/连接和卸载使旧请求失效；支持时取消传输，正确性仍依赖来源校验，不能只靠 AbortController。

空文本、组词期间、禁用态、在途发送及斜杠命令不自动整理；命令识别复用既有入口，不改变命令 token/参数。代码块、路径、URL、已有列表等不能被无依据拆坏；不能安全处理时保持原文并允许照常发送。相同已处理版本不重复请求，不对失败进行无上限自动重试；已有清晰列表不反复编号。

草稿及撤销快照归既有输入器 Owner；首条与已有会话共享辅助逻辑，不建立第二个正文 Owner。草稿若由原恢复机制保留，关联快照也须同范围恢复；未恢复快照时不得显示可用的「撤销润色」。不额外承诺跨应用重启恢复，也不为本功能预建服务端草稿表。

### 30.5 参数与原型待选项

以下为**实现建议，不是用户已确认数值或视觉稿**：停笔延时建议先试 2 秒，以同一常量集中维护；最小触发长度、字符/条目上限、超时与频率上限在实现时按现有服务边界核定。短输入不强拆，自动辅助不得成为发送前置。

三种待比较原型保持同一行为，只比较建议的呈现结构：A 输入框上方紧凑提示加浮层；B 输入卡内纵向展开；C 上方提示加非模态侧边对照。均不自动替换原文，不以更换颜色冒充不同方案，不抢占原工作详情/成果栏的业务身份。窄窗可降为局部纵向展开，不遮挡输入和发送。

原型未选定前，开发任务若被单独下发，可暂按 A 做最小默认呈现；必须注明这是实现默认而非用户已选视觉。开发入口为[开发任务书](../../prompts/composer-outline-and-polish.md)，三方案预览入口为[原型任务书](../../prompts/composer-outline-and-polish-prototypes.md)。

### 30.6 首版实施默认与剩余限制（2026-10-16）

2026-10-16 按 §30.5 的**实现默认 A** 接入源码，落在 `components/ComposerDraftAssist`（辅助状态与呈现）与两处正文 Owner（首条 `AssistView` 的 `first.draft`、已有会话面板的 `draft`）。以下逐条是实现默认，不是用户逐项确认的结果：

- **呈现**（对齐 `GPT页面原型/Relay_Composer_Assist_Prototype.html` 的共用键位与 `assist-bar`/`assist-popover`）：提示行是输入卡**上方**的一条紧凑行（「已整理为 N 个要点 · 查看 · 忽略」＋一句说明），点「查看」在其下方以**非模态浮层**展开原文/建议两栏对照；浮层 `position:absolute; bottom:100%` 锚在提示行上方，**不推动布局**，限高 + 内部滚动，Esc 关闭并把焦点交回「查看」。**润色键在输入卡工具行内**，与「资料 / 模式 / ContextMeter」同一行（原型 `#polishBtn` 的位置），同一键位三态，不另起一行、不并列放两颗常驻按钮；没有工具行的子页/嵌入态才把润色键并进提示行。三方案预览尚未获选稿确认；窄窗（≤48rem）两栏对照改纵向堆叠。
- **停笔延时**：2 秒，集中在 `COMPOSER_OUTLINE_DELAY_MS` 一处维护；组件另开 `outlineDelayMs` 注入点供测试与后续调参使用，**不是用户可调设置**。
- **触发与排除**：短于 8 个码点、已含换行、行首斜杠命令、空文、禁用、在途发送、中文组词期间一律不发起；同一草稿版本只请求一次，忽略与失败都不自动重试。
- **协议**：分点由模型只回原文**码点**边界序号，程序按原文切片并只加 `N. ` 与换行；润色只回 `{text}`。协议与切片规则见 HTTP §10.84，保真口径见测试计划 §31。
- **版本与来源**：请求绑定连接/工作区/会话身份与单调内容版本；编辑、发送、换会话/工作区/连接与卸载都使旧结果失效。**仅比较文本不足以处理「改了又改回相同文本」**，因此版本是必须的。
- **暂停**：润色成功后暂停自动分点（含成功后的手动编辑），撤销或成功发送后恢复。
- **草稿清空即复位**：发送成功把草稿置空，辅助状态随之清理；发送失败保留草稿与快照。因此没有单独的「发送后清理」回调，也没有跨重启的草稿持久化。

**剩余限制（未验，不得当已通过）**：真实 Provider 的语义质量样本（是否切在正确需求边界、是否保留否定与条件）尚无评价；真实 Windows 窗口下的 IME 组词、DPI 与安装态未验；三方案视觉未选定（B 卡内展开与 C 侧边对照尚未实现，本轮只做了三方案共用的键位与 `assist-bar` 呈现）。规格与已运行范围见[测试计划 §31](../testing/verification-plan.md#31-输入框自动分点与手动润色验收规格)的 §31.1。

## 31. 聊天消息时间线导航

2026-10-16。用户指认聊天区左侧的时间线并要求补充产品文档，同日按本节实施首版。**已确认核心需求：点击时间线节点，跳转到当前会话对应消息的位置。** 短刻度与悬停摘要参考本轮用户截图；下列首版默认是实现选择，不冒充用户已经逐项选择的方案。视觉归[设计系统 §9.12](design-system.md#912-聊天消息时间线导航设计补充)，验收规格与实际运行范围归[测试计划 §32](../testing/verification-plan.md#32-聊天消息时间线导航验收规格)。

### 31.1 位置与节点

时间线位于**聊天消息区左侧**，作为当前会话的阅读导航，沿消息先后排列；与近期工作栏的会话切换、Run 步骤及动态记录分别呈现。它消费原消息列表，不能另存一套消息正文或改变消息顺序。

首版以每条**已加载且正文可读的用户消息**为一个节点，点击定位该条提问；预览附带该轮助手回复的已有正文片段，便于回忆讨论内容。助手消息不建节点，只作为该轮预览片段。每个可点击节点绑定当前会话内确切的消息 ID（DOM 上同时带会话身份），不按摘要文字、数组序号或时间相同推断目标；重复提问文字、流式更新与重读都不串位。工具过程不因本功能拆成新的聊天消息。

### 31.2 预览、跳转与阅读位置

- **悬停预览**：展示对应消息的原文片段；标题取提问开头，正文取已可读的消息片段并明确截断（截断时附「原文片段已截断」），不额外调用模型生成摘要。悬停与键盘聚焦均可查看，预览本身不滚动正文、不改变焦点或发送内容；Esc 可关闭，且这一次按键归浮层，不再被面板的 Esc Esc 停止序列记成第一下。
- **悬停刻度联动**（2026-10-16 同日第二轮，用户指认）：指针在轨道内移动时，每条刻度的长度按「指针到该刻度中心的距离」连续变化——指针处最长，向外按二次曲线递减，约 ±3 格回到默认档。联动**只加长、不压短**，当前阅读刻度不会被压到比它自己的档更短；只对鼠标与笔生效，触屏点按不留残影，指针移出后按 `motion.duration.fast` 复位，减少动态效果下只去掉过渡、结果不变。联动只改刻度的呈现长度，不改变节点身份、命中区尺寸与跳转目标。
- **点击跳转**：只滚动当前消息流，使目标消息开头进入可读区并避开固定顶栏；以短暂强调帮助识别落点。跳转同时收起预览浮层，否则指针停在刻度上时浮层会压住刚定位到的正文。保留未发送草稿、输入器状态与会话归属，不触发发送、重试、执行或业务状态变更。
- **当前位置**：随实际滚动高亮当前阅读节点；手动滚动同样更新，不能只记录最后点击的节点。以消息流可读区顶部最近的节点为准，贴底时取最后一条；快速连续点击以最后一次有效目标为准。
- **新消息到达**：用户已跳到历史位置时沿用现有“不强拉到底部”的阅读保护；流式回复增长、图片或代码块撑高不能令节点改指其他消息。返回最新位置沿原入口与跟随规则处理。

### 31.3 空态、长会话与切换

无消息时隐藏时间线；消息读取中或失败时不伪造节点和摘要，原重读入口仍可用。首版仅索引已加载消息，目标暂不可读时就地提示并保留当前位置，不跳到相邻消息冒充成功。

切换会话、工作区或连接时清除旧预览、活动节点及待执行跳转；迟到结果须核对原会话和消息身份，不能滚动新会话。流式文本更新只更新原节点的预览，不随正文变化另建身份。

窄窗与长会话须保留可用的点击和键盘入口，不通过缩小命中区硬塞刻度。长会话由导航轨自身滚动，命中区保持 24px 见方。窄档判定按**聊天列实际宽度**而非视口宽度（容器查询），协作页分栏拖窄时同样降级。当前不新增 API、数据库、模型摘要或收藏能力，不重排其他开发任务。

刻度组在轨道可视高度内**垂直居中**（2026-10-16 同日第二轮）：首尾各留一个 `auto` 边距吸收剩余空间；长会话放不下时 `auto` 边距自动归零、退回从顶排列，第一条刻度不会被居中挤出可视区，滚动可达性不变。窄档展开的浮层轨同样居中。

### 31.4 首版实施默认与剩余限制

2026-10-16 实施落在 `components/ChatTimelineNav`，接入点只有 standalone 聊天列（`?new=`、`?skill=assist` 与协作页聊天视图共用同一面板）。以下三条是实施默认，不是用户逐项确认的结果：

- **节点粒度**：只索引用户提问，助手回复作为该轮预览片段。
- **导航范围**：只覆盖已加载的这一页消息（读取入口为 `messages?limit=200`，会话面板没有更早历史的续读入口）。因此首版没有额外的「仅索引已加载范围」提示条——超出这一页的消息本来就不在消息流里，跳转目标缺失时按上一条就地提示。
- **窄档降级**：聊天列 ≤ `breakpoint.medium` 时收起常驻轨，降为左缘紧凑展开入口；展开后是浮层，不压缩正文，节点与跳转能力不变。

剩余限制：**嵌入态**（任务详情 `<details>` 里的会话历史）未接入——该转录区没有自己的滚动容器，接入等于制造第二个正文滚动 Owner，按 §31.1「消息流是唯一滚动 Owner」的约束留待该入口自身改造。**本机显式关闭动效**（设置页写入的 `html[data-motion="off"]`）目前只在启动链路之外维护：跳转是否平滑按 `resolveMotionPreference()` 实时判定，样式则同时依赖系统 `prefers-reduced-motion` 与 `html[data-motion]` 两处选择器。真实 Windows 窗口与 DPI 下的观感未验收。

## 32. 「+」两级上下文菜单与二级能力入口

2026-10-16。用户下发「+ 菜单与二级能力菜单」实施提示词：一级回答**用户想做什么**，二级回答**具体选什么**，四个既有入口各自带一个向右展开的二级面板；并明确要求基于当前真实代码增量实现、优先复用既有组件、不得为完成 UI 制造假业务。本节记录交互契约与各二级项的数据来源；视觉归[设计系统 §9.14](design-system.md#914-两级上下文菜单视觉补充)，验收规格与实际运行范围归[测试计划 §33](../testing/verification-plan.md#33-两级上下文菜单验收规格)。

### 32.1 位置、层级与复用边界

菜单仍是输入卡左下角「+」上的一个弹层（`views/AssistView.tsx` 的 `ComposerAttach`），一级四项保留既有身份与 `data-testid`，二级从一级右侧展开；**不出现第三级**，也不引入 Modal、表单或整屏面板。

**不新建平行实现**：一级与二级共用同一套行组件（`AttachRow`），各项能力不各写一份菜单；资料检索打开**既有**资料选择面板（发送选项里的 `AssistSourcePicker`），选择已有 Skill 打开同一处发送选项，命令清单复用输入框内联菜单的**同一份**登记（`GET /chat-commands`）与同一套范围/状态口径（`chatCommandScope`／`chatCommandStatus`）。二级面板按需读取（命令清单只在命令面板打开时拉取一次），打开一级不做任何预取。

### 32.2 一级与状态提示

一级四项固定顺序：选择文件与资料、选择 Skill 生成、输入命令、连接器与插件（2026-10-17 新增连接器项，见 §32.9；**目录项已撤出**，见 §32.4）。状态提示只用真实事实，计数用文本、布尔态用对勾，不做彩色 Badge：

| 一级项 | 状态提示 | 事实来源 |
|---|---|---|
| 选择文件与资料 | 本次已选资料版本数 | 本次消息的候选输入（`selectedRefs`） |
| 选择 Skill 生成 | 已选 Skill 时一个对勾 | 发送选项里的当前选择；清单恒为全部内置 Skill |
| 输入命令 | 无 | — |
| 连接器与插件 | 无 | 首条消息（没有项目归属）时仍可点开，面板首句说明连接器随项目配置 |

不可用的入口如实禁用，原因只放在行上的原生 `title` 里（2026-10-19 起，见 §32.12）；**禁用的行不显示 chevron**，也不带 `aria-expanded`——显示展开控件等于承诺一个点不开的二级面板。光标已是禁止图标，解释跟在光标旁边即可，不需要面板底部再写一段脚注：「首条消息在普通档且有项目归属时可选资料（DEV-0100）」「没有项目归属或非普通档时的资料入口」各按其事实来源。

**「选择 Skill 生成」与「连接器与插件」不再禁用（2026-10-18 用户指认「选择skill和连接器与插件点击不了」）**：这两项在任何场景下都可点开，缺口由二级面板第一句说明。原因：禁用行只能靠光标变禁止图标传达原因，用户读到的是「点了没反应」；而这两项的二级里有可读信息（Skill 缺口去向、已连接能力、管理入口），先给面板再给原因比锁死入口更诚实。带内联控制的禁用项之间因此分为两类——**「没有可讲的内容」才禁用**（例如没有项目归属、助手档或学习档的资料入口），其余一律可展开。首条消息在普通档且有项目归属时资料行可展开并直接勾选（DEV-0100）。禁用原因与面板首句共用同一句文案（`noteFor`），不写第二份。

**Skill 的作用域不是入口门禁（2026-10-18 第二轮，用户指令「这些东西不应该跟工作区产生强关联，除非是我这个项目的独有 skill」）**：`target: TASK | PROJECT` 描述的是**这次调用要读谁的事实**（`skill-basis.ts` 读任务验收或项目状态），不是「谁能看见它」。上游对照——OpenCode 的 `skill` 工具只有 `permission: "skill"` 一道门（`tool/skill.ts`），发现路径是全局 `~/.claude/skills` 等项目外目录再加项目内 `.opencode/skills`；Codex 的 `SkillScope` 是 `User | Repo | System | Admin` 的**来源**分层（`protocol.rs`），`policy` 里只有 `allow_implicit_invocation` 与 `products`。因此本轮把两处过滤撤掉：①`GET /skill-definitions` 的结果不再按 `target.kind` 过滤（`AssistView` 的首条清单与会话清单都列全部内置 Skill）；②面板行按上下文标注 `需任务 / 需项目`，能就地补齐时可选中、不能时（会话归属已冻结）才禁用。详情见 §32.11。

### 32.3 二级资料与命令的接入点

| 二级项 | 动作 | 数据／出口 |
|---|---|---|
| 选择本地文件 | 禁用（标注「暂未接入」） | 见 §32.5 |
| 检索项目资料 | 打开既有资料选择面板；调用方未提供 `onSources`（如首条消息）时整行不渲染，改用上方平铺资料直接勾选 | `onSources` → 发送选项 |
| 对话中的资料 | 逐条开关本次候选输入 | 当前会话消息上已出现的资料引用（按最近去重，只收知识/记忆/决定三类且三元组齐全者） |
| 最近引用 | 逐条开关本次候选输入 | 本机「最近引用过的资料版本」偏好（`lib/recentSourceRefs`，只记 kind/rootId/version，不缓存正文） |

**目录项已从「+」撤出（2026-10-19，用户指认「好像很多东西都需要授权或者什么选择目录之类的，这些都是过度设计」）**：

- **原因**：目录有常驻 Owner——协作页的目录细条（`folder-scope-strip`）。细条上目录名即「更换目录」入口、弹层里有手动输入与近期目录，写入档位也由它显示。「+」里再放一个「选择工作文件夹」既是一份重复实现，又把「选目录」摆成**用之前必须先做的配置**，读起来像门禁；而它实际上只在没有默认目录时才有必要性。
- **删的是什么**：一级「选择工作文件夹」行、目录二级（选择文件夹／最近使用／管理工作区）、「最近使用」从弹层转发的链路（`ComposerAttach` 的 `onFolder`/`onOpenRecentFolder`/`recentFolders`/`folderPath`/`folderBound` 属性与 `AssistView` 的整段转发）；未接入的「管理工作区」与「选择文件夹」的替代路径说明随行删除。目录选择的行为契约不变：仍走协作页 `requestFolderTransition` 守卫与 `OpenWorkingDirectory`，原生选择器优先、浏览器/示例模式退回更换目录浮层（§28.3）。
- **不删的是什么**：目录细条与其弹层（协作页 §28.3）、`requestFocusFolder`（候选目录场景仍用它把细条滚入视野）。
- 验证出口：`tests/composerAttachMenu.spec.tsx` **25/25**（含「一级四项且无文件夹行」新断言，替换原目录二级两组用例）、`tests/assistantModeSwitch.spec.ts` **47/47**（「+」无目录行、细条仍在）、`tests/folderFirstConversation.spec.ts` **26/26**（原「+ 直接开原生选择器」用例改锁「+ 无目录行」；原生选择器路径仍由细条用例覆盖），`tsc --noEmit` 对本片文件干净。真实 Windows 窗口与 DPI 未取证。
| 管理工作区 | 禁用 | 见 §32.5 |
| 从描述／从文件生成 Skill | 禁用 | 见 §32.5 |
| 选择已有 Skill | 打开发送选项 | `onSkill` |
| 输入命令 | 把 `/` 填进草稿并聚焦 | `onCommand`（既有行为） |
| 登记命令清单 | 把 `/<name> ` 填进草稿 | `GET /chat-commands` 的真实登记，按档过滤方法命令（与内联菜单同规则） |

引用行与命令行**只编辑草稿或本次候选输入**：不发送、不建会话、不申请权限；命令最终落在同一个聊天输入框里，用户仍可继续改写或补充自然语言。

「+ → 选择文件夹」与细条、近期目录共用同一条目录命令，因此「选定即关框、需要再选一次作用域时把框带回来」这条规则对两条入口都成立：直接选择器路径没有开着对话框可重开，协作页在 `openFolder` 拿到结果后按同一条判据（`candidates.length > 0`）触发细条的更换框，候选按钮不会只藏在没有打开的对话框里。

### 32.4 开合、键盘与方向

- **点「+」**：关闭 ↔ 打开一级。**点一级行**：有二级则展开/收起二级（一级保持打开），没有二级则直接执行。**点二级行**：执行后收起两级。
- **选择类操作**：动作型二级项（检索资料／选择文件夹／选择已有 Skill／命令）执行后收起两级；**引用行的开关刻意不收起**，因为它是多选，收起会让用户为选第 2 个资料重新点开三次（这是本轮唯一一处与提示词「选择类操作执行后收菜单」不同的取舍，理由是连续多选的可用性；面板内实时回显一级计数）。
- **点击外部**一次收起两级；**Esc** 先收二级（焦点回到原一级行）再收一级（焦点回到「+」）；二级未开时 Esc 仍是原有的一次收起。
- **键盘**：Tab 按原生顺序走完一级与二级；↑↓ 在**当前层**内移动；→ 在一级行上展开二级并把焦点交给它第一个可用项；← 收起二级并把焦点还给原一级行；Enter 激活（原生 button）。禁用的行不进入焦点顺序。
- **方向**：二级默认贴一级右侧、保持 `space.2` 缝隙；挂载后按实际空间测量，右侧放不下且左侧放得下时翻到左侧。**纵向相对一级弹层居中**（2026-10-19 用户指令「二级要以一级的高度居中，如果一级太下面就底部跟一级对齐」，取代 2026-10-17 的「贴住当前那一行」）：`top = (一级高 − 二级高) / 2`，二级更高时自然上探出一级顶边（不设 0 下限），唯一硬边是视口顶边（上探到屏幕外才夹回）；一级贴近视口底部、居中会顶出视口时，改为**二级底边与一级底边对齐**；两者都放不下才交给既有 `max-height` 内部滚动。面板尺寸变化（项目资料异步到达、滚动条出现）由 `ResizeObserver` 重算。真实 Chromium 实测（临时预览页，见功能验收表）：1280×900 与 900×620 下 offset 恰为 `(96−222)/2 = −63`；一级贴底档（1280×380）二级底边与一级底边差 0；二级比视口还高的极端档（1280×300）被 `max-height` 夹住、未越出视口顶边。

### 32.5 尚未接入的能力与接入点

提示词要求的能力里，有三项在当前代码里**没有后端**，因此按项目既有规则如实禁用并写明原因，不假装可用、不用假数据填充：

| 能力 | 当前状态 | 接入点 |
|---|---|---|
| 选择本地文件 | 禁用，行内「暂未接入」+ 悬停 title 说明 | 桌面宿主需要文件选择命令；`lib/desktopHost.ts` 目前只有 `selectWorkingDirectory`（目录），没有选文件 |
| 工作区 | 禁用，行内「暂未接入」+ 悬停 title 说明 | 需要独立的管理工作区／受管根 UI；当前只有目录条与 `/settings/connections`（连接管理，不是工作区管理） |
| Skill 生成（描述／文件两条） | 禁用，行内「暂未接入」+ 悬停 title 说明 | 需要 Skill 生成用例与产物落库；当前只有只读的 `GET /skill-definitions` 与「选择已有 Skill 送入当前消息」这一条既有链路 |

### 32.6 实施默认与剩余限制

- **不做 hover 展开**：指针从一级移到二级的缝隙会闪断；改用点击展开，与本项目既有弹层的点击语义一致。
- **最近引用是本机偏好**：只持久化 `kind/rootId/version` 三元组，不缓存标题、摘要或正文，因此它不会变成第二套内容来源；发送成功后才记入（服务端已受理的那一批）。
- 剩余限制：真实 Windows 窗口／DPI／原生 IME 下的观感与键位未验收；浏览器层（Playwright）规格未跑；二级面板在「左右两侧都放不下」的极端窄窗下靠内部滚动而不是自动收缩宽度，该档位未单独取证。「+ → 选择文件夹」直开原生选择器只在 jsdom 里按打桩宿主验证（`folderFirstConversation.spec.ts` 的桌面宿主用例），真实 Windows 文件夹对话框下的选定／取消与多项目候选重开未取证。

### 32.7 资料面板的职责、高度与状态（CT-02，2026-10-17）

点击穿透任务书 CT-02 的现场是「输入器点『资料 0』或『普通讨论』出现同一大片面板，大标题、资料检索、生成方式、意图与长说明混在一屏」。本轮只改资料面板自身（`components/AssistSourcePicker.tsx` 与其样式），不动命令语义、不改发送选项的开关结构：

- **职责边界**：面板只承担资料职责，按「标题＋已选数量 → 检索 → 引用范围 → 内容区（状态／已选项／检索结果）→ 简短提示＋可展开依据」排列。生成方式与意图仍是发送选项设置区的内容，不进入资料面板的 DOM；`[data-region="selected"]`／`[data-region="results"]` 是这两类信息的分界标记。
- **高度与滚动**：内容区限高并在内部滚动，沿用既有档位 `min(30dvh, layout.workspace.sideWidth)`（与聊天命令菜单同一表达式，本轮不新增数值档）。检索行、引用范围与面板自身的关闭入口留在滚动区之外，长结果不再把整块面板推高。标题降到 `font.size.body` 档（面板级），不再是 `font.size.section` 的整页级 hero。
- **四类状态各自独立**：尚未检索（空态）、正在检索、查无结果、读取失败。读取失败给「重试检索」，且只在真的发出过请求并失败时出现；超出 10 个版本的上限提示是状态说明，不冒充读取失败、不给重试。错误与空列表互斥，失败时不显示「没有匹配」。
- **约束的表达**：不授予权限、只作用于本次消息这类边界用一句简短提示常驻，展开依据补齐范围（知识／记忆／决定，不含规则与停用版本）、上限、发送时冻结 kind/rootId/version 并仍由服务端复核、切换项目或连接清空选择、本地文件尚未接入。依据块展开时 Esc 先收它，再交还给外层面板。
- **零副作用**：打开面板、检索、重试、勾选与移除只编辑本次候选输入，全程不产生 POST，不创建执行、不发模型消息；业务提交仍走原发送入口。未接入的本地文件继续按 §32.5 在「+」二级菜单里如实禁用。
- **实施默认**：资料面板与生成方式/意图仍共用同一枚弹层容器（`.agent-chat-options`），因为会话选项的 Esc 收起与焦点/草稿保留契约（见 `collaborationWorkspace.spec.ts`）把 `#assist-source-query` 钉在该容器内；本轮做的是同一弹层内的分组与高度，不是把它拆成两个浮层。拆分需要同时改动该断言的 Owner，留待裁决。
- 状态：**已实现并完成工程自检**（Vitest 组件断言 + Playwright 页面内夹具几何），真实 Windows 窗口、DPI 与原生 IME 下的观感**待真实验收**；统一功能验收表的「点击后界面定向验收」行仍按实际取证更新，不因本节改写成绩。

### 32.8 二级列表化（2026-10-17）

用户第二条指令：**「子菜单应该直接将文件、skill 列出来」**，参考菜单展开后就是一列文件。本轮把两个二级面板从「先给动作、再给列表」改成「先给列表、再给动作」：

- **资料二级**新增「项目资料」一节：打开面板时读一次当前项目的启用知识（`GET /knowledge?projectId=…`，与知识页同一个接口），按 `currentVersion` 直接作为可勾选条目平铺，最多 20 条，超出提示「另有 N 条，用下方检索按关键词查找」。只收 `status === "ACTIVE"`，已归档版本不进入候选；读取失败只在该节说明，不遮挡对话引用、最近引用与检索。条目点击与既有引用行完全同一条路径（`onToggleSourceRef`），不改上限口径（仍是 10 个版本）。
- **Skill 二级**新增「可用 Skill」一节：清单与选中状态**直接复用发送选项那一份** `skills` / `selectedSkillKey`（调用方 `AssistSessionPanel` 已按目标过滤并排序），每个 id 只列最新版本，点击即写入同一处状态（`onPickSkill`），不可调用项禁用并标注「不可调用」。没有新增接口、没有第二套 Skill 选择状态。
- **「文件」的边界没有变**：`RelayAssistSourceRef` 只有 `KNOWLEDGE / MEMORY / DECISION` 三类，工作目录里的文件不是消息来源（由 Agent 在目录内按权限直接读取），所以二级列的是**资料版本**而不是文件树。为列文件树新造一种来源等于给发送链路加一条没有服务端落点的入口，本轮不做；这条差异写在「选择本地文件」行的悬停 title 里（2026-10-19 起不再有面板脚注，见 §32.12）。
- **视觉**：二级条目名改为恒定单行 + 省略号（`overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`），完整说法挂 `title`；长标题不再把 32px 的行撑成两三行，清单读起来高低一致。二级纵向位置改为**贴住当前那一行**（hover 展开的必要条件，见 §32.4；2026-10-19 起改为相对一级居中，仍见 §32.4），旧的 `[data-align="bottom"]` 兜底规则随之删除。token 零新增。
- **验证出口**：`tests/composerAttachMenu.spec.tsx` **22/22**（新增 hover 展开／固定／移开延时收起／禁用行不 hover、项目资料直接列出并勾选、项目资料读取失败、Skill 直接列出与选中），`tsc --noEmit` 通过；真实 Chromium 用临时预览页量过 hover 展开、贴行定位（二级面板 198×302、`data-flip="right"`）、移开 500ms 后二级收起且一级仍开，预览页与截图脚本用后已删。真实 Windows 窗口、DPI 与 Playwright 产品页面未跑。

### 32.9 连接器与插件二级（2026-10-17）

用户指令：项目已经有 GitHub、Chrome（内置浏览器自动化）与电脑插件这些能力族，要放进 UI 菜单里，且**不能在前端硬编码清单，必须动态读取**。落点就是「+」菜单的第五项「连接器与插件」：

- **数据来源只有服务端**：打开二级时按项目读一次 `GET /projects/:id/gateway-connections`（与命令清单、项目资料同一条按需读取口径，打开一级不预取）。GitHub（`GITHUB_READ`）、浏览器（`BROWSER_READ/ACTION/COMMIT`）、电脑（`COMPUTER_READ/INPUT`）、文件、Git、命令行等能力族都从这条连接登记里来，前端没有一份写死的插件清单。
- **前端只维护显示映射**：能力键 → 中文名在 `lib/labels.ts` 的 `gatewayCapabilityLabel` 一处（连接与同步页共用同一份）；服务端开放扩展的新能力键回退显示原始键，不会被前端词表挡住。
- **行是状态展示，不是按钮**：每个能力一行（图标 + 中文名 + 右侧状态），用 `p.agent-chat-attach-fact` 而不是 button——连接器的准入语义在执行时的权限链（能力 → 连接 → 策略 → Review）里，不是本次消息的附件，做成可点按钮等于承诺一个不存在的选择动作。停用/撤销的连接也列出来并如实标注状态，不冒充已连接。
- **管理入口**：面板底部一行「管理连接与权限」，走既有 `/settings/connections` 页；新建、停用与策略授权都在那里做，弹层不复制第二套管理界面。
- **边界**：首条消息（没有项目归属）时没有清单可读，但一级行仍可点开（2026-10-18）：面板首句只说缺口本身（「连接器随项目配置」），「管理连接与权限」照常走 `/settings/connections`；未连接本机 API 时同一位置说明要先连 API。读取失败只在「已连接能力」一节说明，不遮挡其他面板。**无项目归属时「已连接能力」整节不渲染**（2026-10-19）：该分组必然为空，再写一句「按项目登记」就是同一句话的第三次重复。

**内置插件固定成行（2026-10-19 用户指认「加号的菜单看不到这三个插件」）**：原实现只有「已连接能力」一列动态行，没有项目归属或项目还没登记连接时整块是空的，三个内置插件看起来像不存在。现在二级面板顶部固定一个「内置插件」分组，恒列 **电脑操控（`COMPUTER_READ`/`COMPUTER_INPUT`）、浏览器操控（`BROWSER_READ`/`ACTION`/`COMMIT`）、GitHub（`GITHUB_READ`）** 三行：

- **固定的是身份，不是状态**：三行只承载「本产品内置了这三个插件」这一事实与去向，**状态仍逐项取自服务端连接登记**（全部 ACTIVE＝已连接、部分 ACTIVE＝部分已连接、全停用/撤销＝已停用/已撤销），读取失败写「状态未知」。不按「装了这个插件」推断可用，也不新增前端能力词表——行里的能力名仍走 `gatewayCapabilityLabel` 同一份映射。
- **读不到登记时不写状态**（2026-10-19 修）：没有项目归属、或未连 API 时，行上状态位**留空**而不是逐行写「需在项目中授权」/「未连接 API」——那不是「未授权」，是「无从判断」，编一个状态比留空更不诚实；原因由面板首句统一说一次，去向仍在行的 `title` 里。
- **与「不硬编码清单」不冲突**：这条规则禁的是把「服务端还有哪些连接/能力」写死在前端。三个内置插件的身份是产品定义，连接与能力仍由服务端登记决定，未知的新能力键仍回退原文并出现在「已连接能力」里。
- **插入入口（DEV-0099，2026-10-21）**：插件行是按钮，点击只把 `@电脑操控 ` / `@浏览器操控 ` / `@GitHub ` 按光标位置写进当前输入框并收起菜单；不发送消息、不弹详情、不授予任何能力。连接状态仍显示在行尾，授权与管理统一走面板底部「管理连接与权限」一行，与「已连接能力」的只读 `p` 行区分。
- 验证出口：`tests/composerAttachMenu.spec.tsx` **31/31**（无项目时三行都在、状态位为空且面板只有一句说明；有项目时 GitHub/浏览器为「已连接」、电脑连接为 DISABLED 时写「已停用」；插件行点击插入 `@标签 `、无插入回调时禁用）；`tsc --noEmit` exit 0。

**同一句话不在面板里复读（2026-10-19 晚，用户指认「为什么这里需要项目中授权？好像很多东西都需要授权或者什么选择目录之类的，这些都是过度设计」）**：

- **诊断**：`gateway_connections.project_id`／`gateway_permission_policies.project_id` 都是 `NOT NULL`（迁移 0008），连接与权限策略在数据模型上就按项目登记，读清单的接口也只接受项目 id——所以「没有项目归属就没有状态」是事实，不是文案选择。问题在于**把这个事实在三处复读**：一级行 title、菜单脚注、面板首句，再叠三行「需在项目中授权」与一个必然为空的「已连接能力」分组。
- **收敛**：面板首句只说缺口（`connectorScope`），完整一句（`connectorScopeNote`，多出「进入项目后可查看授权状态」）只用于一级行 title（菜单脚注已于 2026-10-19 删除，见 §32.12）；三行插件在两种读不到登记的情况下**不写状态**；「已连接能力」在无项目归属时整节不渲染。措辞只有一份定义，`connectorScopeNote` 由 `connectorScope` 拼出，不各写一句。
- **「连接与权限」页删除「按已知项目 ID 打开」的手输 UUID 表单**（`ConnectionsView`）：那是开发自测入口，产品里表现为「要授权先背一串 UUID」。连接设置只从项目列表进；示例模式只保留「为什么要先连 API」的说明与返回项目入口。
- **验证出口**：`tests/composerAttachMenu.spec.tsx` **26/26**、`tests/assistantModeSwitch.spec.ts` **47/47**、`tests/connectionsSettings.spec.ts` **23/23**，`tsc --noEmit` exit 0；真实 Chromium 用临时预览页（`client` 非空、`projectId` 为空）实测二级面板 **156×330**（改前因三行状态位被撑宽）且首句只占一行，截图留 `apps/workbench/results/attach-connectors-no-project.png`，预览页用后已删。真实 Windows 窗口与 DPI 未取证。

### 32.10 首条消息 Skill 预选与输入器布局重排（2026-10-17 晚）

用户两条指令：①「选择 Skill 生成」应该所有场景都可以点击；②输入器改为「上方：工作目录与写入权限摘要，底栏：＋ [权限] [模式 ▾] [发送选项 ▾] [润色] […] [发送]」。

**首条消息 Skill 预选（真接线，不是解禁）**：核查确认服务端首条消息命令（`POST /assist-sessions/:id/messages`）本就接受 `skill_ref` + `skill_input`，前端此前写死 `intent: "DISCUSS"` 是缺口。本轮接线：首条消息界面按 target 深链加载同一份 Skill 清单（按 `target.kind` 与输出白名单过滤），「选择 Skill 生成」在有项目/任务归属时可直接展开并选中，随首条消息一起发送；带 `skill_ref` 的首条消息不传 `intent`（服务端禁止混用），`skill_input` 为空对象。**硬约束保留**：无归属的纯新讨论（服务端校验 `Skill 与会话目标作用域不匹配`）、助手档（服务端 409 拒绝 skill_ref）、只读会话三处仍不可选；**但入口本身始终可点开（2026-10-18 修）**——面板第一句就是不可选的原因（`noteFor("skill")`，没有脚注时用「当前这条消息还没有项目或任务归属，Skill 需要归属后才能预选」），下方仍列出生成类动作行与「在发送选项里选择」。选中项计入首条草稿守卫（dirty），新建会话时重置。

**输入器布局重排（两个输入器统一）**：
- **上方状态行**（`ComposerStatusBar`，输入卡外）：`工作目录：{名称|未选择} · 更换目录`（链接走既有 `onRequestFolder`）+ `写入权限：{摘要}`。写档位摘要由底栏 [权限] 芯片同源上报（`WritePermissionControl` 新增 `onTier` 回调，不另发第二份查询）；映射：auto/ask→已就绪、none→只读、denied→已拒绝写入、blocked→未就绪、unbound→未就绪（未绑定目录）。助手档不显示写权限段。该行只显示事实，不复制第二套操作。
  - **几何（2026-10-18 按用户实机截图修正）**：与目录细条、输入卡同宽同轴——`width:100%` + `max-width: var(--chat-measure)` + `margin-inline:auto`，并允许换行（目录名很长时不换行会把「写入权限」挤出列宽，flex 项默认不缩到内容以下）。首版只写了 `display:flex` 与字号色，整行按 `.agent-chat-start` 的整列宽铺开，文字落到输入卡左侧很远处，读成「这一行没有样式」。
  - **「更换目录」是 `<button class="text-link">`**：全局 `button` 只继承字体与颜色、**不重置外框**，`.text-link` 自己也不带 `border/background` 重置，因此这颗键会落回原生控件外观（2px outset 边框 + 灰底）。按本仓既有链接键（`.conversation-diff-toggle`）的做法在 `.composer-status-item .text-link` 就地剥掉外框并给 hover 下划线；其他直接套 `.text-link` 的 `<button>` 有同一缺口，改动它们需各自复核，不属于本轮。
  - 出口：`tests/browser/emptyConversationWelcome.spec.ts` 新增一条常驻断言锁「与输入卡同左缘同宽」与「无原生外框」，改动前后 A/B 各跑一次（挂回旧 CSS 时该条红，左缘差 198px）。
- **两行合并（2026-10-18 用户指令「这两行的功能重复了……更换目录和未选择目录合并成一个按钮」）**：状态行与目录细条在协作页同时常驻，重复着「当前目录 + 换目录动作」；细条是保留的那一行（颜色对比由它承担），「更换目录」并进目录名本身（细条只呈现事实、只转发动作，见 §28.3）。合并后 `ComposerStatusBar` **只在嵌入态渲染**（没有 `composerHeader` 细条的页面，如任务 Skill 事实子页），且只读——`onChangeDirectory` 链接随合并删除（嵌入态本来也没有目录操作入口，换目录归协作页细条一个 Owner）。状态行的「写入权限」摘要在协作页不再出现；该事实仍由底栏 [权限] 芯片同源显示（档位上报链路未动）。`tests/browser/emptyConversationWelcome.spec.ts` 的几何断言改锁细条与目录名键（同左缘同宽 + 无原生外框 + 上方只有一行），`conversationToolbarDensity` 的「动作静止降档」一例改写为「目录名即入口：静止无控件外观、悬停只补下划线」。
- **底栏精简**：`＋ [权限] [模式 ▾] [普通讨论 ▾] [润色] […] [发送]`；模型选择、资料入口、用量计量收进 `[…]`（`ComposerMoreMenu`，`useDetailsMenu` 收口开合，浮层语言与「+」菜单同款、向上弹出右缘对齐）。资料行在会话档点击即打开既有资料面板；首条消息的资料当时是禁用说明（资料选择在会话中）。**这一句已被 DEV-0100（2026-10-21）取代：普通档且目标有项目归属时，首条消息也能直接选资料并随建会话载荷冻结，见 §18.1.1。**
  - **改为常驻（2026-10-18 用户指令「把这三个单独放到输入框里面，普通讨论的右边就可以了」）**：`[…]` 收纳布局撤销，模型选择、资料入口、用量计量三项改为常驻工具行、在「普通讨论」右侧成组，顺序两个输入器一致（模型 → 资料 → 用量）。行为不变：模型 chip 点开原有下拉清单（仍锚定 chip 向上弹出），会话档资料 chip 点击打开既有资料面板，首条消息的资料当时仍是禁用说明（同上，已由 DEV-0100 取代），用量计量仍是只读环。`ComposerMoreMenu` 组件随之删除；行右端顶格改由发送键自己的 `margin-left:auto` 承担（计量原先在浮层里的 auto 外边距移除，否则一行出现两个 auto）。验收出口：`composerSourcePanel.spec.ts` 与 `modelSelectorDropdown.spec.ts` 11/11（此前两项藏在收起的浮层里，Playwright 直点点不到）。**其中「模型 → 资料 → 用量」这一句已被 2026-10-19 深夜的指令覆盖（模型与计量移到行左端，资料仍留在「普通讨论」右侧），见[§32.13](#3213-工具行左端两枚事实与浮层只浮出内容2026-10-19-深夜接续)。**

**验证出口**：`tests/composerAttachMenu.spec.tsx` **24/24**（含首条禁用行的悬停 title 断言）、`tests/assistantModeSwitch.spec.ts` **47/47**（首条 notes 改为 sources/skill 各一条，连接器 title 断言），`tsc --noEmit` 通过、`check-docs` 通过。`collaborationWorkspace` 的轨迹/执行摘要 4 例为并行改动（tool-loop）既有失败，与本轮无关（改动前后同一组失败）。当时未跑：Playwright、真实 Windows 窗口与 DPI——Playwright 侧已于 2026-10-18 补状态行几何一条（见上），真实 Windows 窗口与 DPI 仍未取证。

### 32.11 Skill 的目标芯片与作用域交接（2026-10-18）

用户第二轮指令：「这些东西不应该跟工作区产生强关联的，除非是我这个项目的独有 skill 可能需要这么设计；你看一下上游怎么设计的，肯定也是不管哪里都可以使用的」。核查后按 B 方案落地：**入口全量可见 + 调用时按需给目标**，不是把作用域删掉。

- **清单全量**：首条输入器与会话输入器的「+ → 选择 Skill 生成」都列出全部内置 Skill（`GET /skill-definitions` 的结果只按输出契约白名单过滤，不再按 `target.kind` 过滤）。助手档与学习档例外——服务端对这两档拒绝 `skill_ref`，因此不传清单，沿用原脚注说明。
- **行内标注**：需要上下文而当前没有时，行尾显示 `需任务` / `需项目`（替换原来的版本号提示），`title` 补一句「需要 X 上下文」。这不是错误态，只是事实。
- **首条输入器能就地补**：选中缺上下文的 Skill 后，工具行出现 `ComposerTargetPicker` 芯片（`选择任务` / `选择项目`）。它按需读 `GET /projects?status=active`，任务类再读 `GET /tasks?project_id=…`；前端不写死任何项目/任务清单。选定后经 `AssistView.onRequestSkillTarget` 交回宿主，宿主用 `?work=` / `?project=` 把这条讨论带到该目标的真实作用域，并带 `?skill=` 预选刚选的 Skill、`?new=` 保证落在新对话上。**归属仍只在建会话时确定**——芯片不建会话、不改归属，所以不会造出「会话归属与面板不一致」的第二套事实。切换前走 `requestTransition` 的既有草稿守卫。
- **会话输入器只标注**：会话归属在建立时冻结（`projectId/taskId` 不可改），因此缺上下文的 Skill 在这里禁用并标注；发送选项的 `<select>` 同步不可选，下面写清「要回到对应目标开始对话」。不提供点了不会生效的入口。
- **为什么不做「原地建会话」**：`App` 按 `pathname + search` 重挂载整棵子树（`App.tsx` 的 `<div key=…>`），工作空间级面板过滤 `projectId/taskId` 都为空的会话；在这里建一条带归属的会话，它既不会出现在本面板的会话列表里，也无法在本面板显示，只能伪造归属或让会话变成孤儿。因此交接点放在宿主，和既有「打开某个任务的对话」走同一条 `setSearch` 路径。

**验证出口**：`tests/composerAttachMenu.spec.tsx` 25/25（新增「清单全量：缺上下文的行标注、能就地补齐时仍可选」一例）、`tests/composerTargetPicker.spec.tsx` 4/4（项目来自接口、任务经项目两级、空清单与读取失败文案、无 API 与发送中不可展开）、`tests/assistantModeSwitch.spec.ts` 47/47、`tsc --noEmit` 通过（并行会话的 `composerImageAttachments.spec.tsx` 有未完成改动，与本节无关）。未跑：真实 Chromium/Playwright 产品页面、真实 Windows 窗口与 DPI；`?skill=` 深链预选只有 jsdom 断言，没有真实路由端到端取证。

### 32.12 去掉菜单里的说明文字（2026-10-19 晚）

用户看实机截图后指认：「每个菜单下面都有文字……你看一下上游都没有设计这个的，这个文字很影响体验」。指的是「+」一级弹层底部那段灰字（「资料在会话中选择」「连接器随项目配置；进入项目后可查看授权状态」）与二级面板底部那段（未接入能力的接入点），不是选项行本身。

- **删掉什么**：`.agent-chat-attach-note`（一级脚注）与 `.agent-chat-attach-subnote`（二级脚注）两个渲染分支与对应 CSS；`attachPendingNotes` 映射表；`noteId` 与 `aria-describedby` 接线（它原本指向这些节点，删了节点再留着属性就是悬空引用）。菜单高度自此只由选项行决定。
- **留下什么**：行内状态位照旧——资料计数、目录/Skill 对勾、`暂未接入`、`需已有会话`；**原因改由行上的原生 `title` 承载**（「本地文件选择尚未接入：桌面宿主当前只有目录选择器」「工作区管理尚未接入」「Skill 生成尚未接入」等），光标已在禁止图标上，解释跟着光标走，不再让用户去面板底部找。空态（「本机还没有最近目录」）是内容不是说明，保留。
- **命令行不再写「可用」**：`chatCommandStatus` 现在只在例外时返回文字（`待接入` / `需已有会话`），可用返回 `null`，内联菜单与二级菜单共用同一口径。每行都挂一句同样的「可用」只是噪音，真正需要读的是例外。
- **没有改的**：两级的开合、hover、键盘、翻转、on-demand 读取、禁用语义全部不动；`notes` prop 仍由调用方传入，但只用于「禁用行的 title」，不再渲染成块。
- **验证出口**：`tests/composerAttachMenu.spec.tsx` 26/26、`tests/chatCommandInput.spec.tsx` 7/7、`tests/assistantModeSwitch.spec.ts` 47/47（真实路由下的「+」弹层断言改为「脚注节点数为 0、原因在 title」）；`tsc --noEmit` 只剩并行改动涉及的三份测试文件报错，与本轮无关。真实 Chromium 的 `uiOption2FirstSession.spec.ts` 单条用例在本机两次单跑分别停在首次点击与发送环节（失败点不同，均早于本轮改动的断言），判为该用例在本机的不稳定，未作为本轮证据。

### 32.13 工具行左端两枚事实与浮层只浮出内容（2026-10-19 深夜接续）

用户同一条消息两件事：①「模型下拉按钮放到输入框左边，再左边是上下文圆圈」；②「普通讨论是干嘛的，点击之后 ui 还会消失，关闭菜单之后 ui 又出来了」。

**「普通讨论」这颗 chip 是什么**：它是**发送选项**浮层的入口，`summary` 文本就是当前选择的结果，不是档位名。浮层里两件事——生成方式（普通 Assist 或某个 Skill）与本条消息的意图（讨论 / 提出 Markdown 候选 / 提出任务定义）；只选了生成方式、意图为讨论时，chip 显示「普通讨论」，选了 Skill 显示该 Skill 标题，选了提案显示「提案」。因此「点一下文字变了」是设计如此。2026-10-18 的拆分把资料与发送选项各开各的面板，两颗 chip 互不相干（见 §32.10）。

- **工具行新顺序（两个输入器一致）**：`[上下文计量环] [模型下拉] ＋ [权限] [模式 ▾] [润色] [普通讨论 ▾] [资料 N] → 发送`。计量环最左、模型紧随其后，其余入口整体右移一档；两枚都放在「+」的**左侧**而不是行尾，是为了保住 2026-10-18 定下的两条邻接关系（「+」紧邻写档位 chip、资料仍在「普通讨论」右侧），并把「这一行最左边先回答『用什么模型、还剩多少上下文』」放在扫视起点。§32.10 那句「模型 → 资料 → 用量」按本条作废，其余内容（常驻、不收回 `[…]`、发送键 `margin-left:auto` 顶住右端）不变。`.agent-chat-composer-tools > .model-selector { min-width: 0 }` 是子项选择器，与位置无关，窄窗换行行为未变。**（2026-10-20 起这一档顺序按 §32.14 作废：计量与模型改到发送键左边。）**
- **展开浮层时入口芯片不再消失**：根因是原来这条规则写在 `.agent-chat-options[open]` 上——给整个 `<details>` 上 `position: absolute`，`<summary>` 作为它唯一在流内的子项跟着一起离开 flex 行，于是点开时芯片从行里凭空消失、关掉又冒回来。现改为只浮出**内容**：三处浮层（首条输入器的档位说明、资料 `sourcePicker`、发送选项 `sendOptionsFields`）各包一层 `<div className="agent-chat-options-panel">`，规则挂在 `[open] > .agent-chat-options-panel` 上。契约一句话：**入口芯片常驻工具行，展开的只有面板**。
- **实测几何（1162×782 夹具，真实 Chromium）**：芯片 top/bottom 724／756 与工具行 724－756 完全重合（改前这一条不可能成立，芯片已不在行内）；面板仍与输入卡同宽（742px＝`--chat-measure` 上限）向上弹出，`bottom: calc(100% + space.2)`、`max-height: min(60dvh, workspace.sideWidth)` 与限高内部滚动都不随本次改动变化。
- **没有改的**：开合、Escape、焦点回 summary、`aria-expanded`、面板内容与滚动策略全部不动；零新增 token、零新增色值。
- **Breaking Change：No。**

**验证出口**：`tests/browser/composerSourcePanel.spec.ts` 新增 3b 一段常驻不变式（芯片上/下沿不得跳出工具行、面板底边不得压到工具行、面板宽度不得窄于芯片），并在改动前后各跑一次 A/B——把选择器挂回 `.agent-chat-options[open]` 后该条在 spec 第 233 行转红，恢复后 5/5 绿。同批 `composerSourcePanel`／`modelSelectorDropdown`／`conversationToolbarDensity`／`responsiveFoldGeometry` **28/28**、`composerDraftAssist.spec.ts`（浏览器）**3/3**、`tsc --noEmit` 通过。

顺序另加两条常驻锁，因为 jsdom 看不见 CSS 但文档序就是渲染序，而真实 Chromium 侧的宽度量测会被换行掩盖：`composerSourcePanel.spec.ts` 3c 断会话输入器的 `toolOrder` 前两位为 `agent-chat-usage`→`model-selector` 且资料仍在「普通讨论」右侧；`tests/assistantModeSwitch.spec.ts` **48/48**（本轮新增一例）对首条输入器锁同两条事实加「+ 紧邻档位 chip」。首条输入器另用一次性探针脚本对着本机 dev server（`127.0.0.1:5173`）在真实 Chromium 里跑过：行序为 `○ 模型 ＋ 未开放写入 普通 Agent 润色 普通讨论 资料 0`，展开「普通讨论」时芯片仍与工具行重合（724／756）、面板在行上方 563－639、宽 742，截图留 `apps/workbench/results/probe-first-row-open.png`，脚本用后已删。

本轮**未做**真实 Windows/WebView2 与多 DPI 目视。

### 32.14 工具行右端一组：上下文与模型下拉移到发送键左边（2026-10-20）

用户指令：「上下文和模型下拉按钮整体移动到发送按钮的左边，用 tasteskill 优化一下这一行所有按钮」。上一轮（§32.13）刚把这两枚放到工具行**最左**，本轮再把它们整体搬到**发送键左边**——两轮都是同一用户的连续调令，不互相否定：模型与上下文是「发这条消息时最常核对的两项」，贴在发送键旁比贴在行首更近。

- **新顺序（两个输入器一致）**：`＋ [权限] [模式 ▾] [润色] [普通讨论 ▾] [资料 N] 〔上下文计量环 · 模型下拉〕 → 发送`。§32.13 的「计量环最左、模型紧随」按本条作废；其余邻接关系不变（「+」紧邻写档位、「资料」仍在「普通讨论」右侧）。工具行左端改由「+」起头。
- **收成一组而不是两枚散件**：新容器 `.agent-chat-composer-tail`（`display:inline-flex; gap:space.1; flex:0 1 auto; min-width:0`）紧跟 `.agent-chat-composer-tools` 之后、发送键之前。三条理由：① 组内沿用工具行自己的 4px 节距，与工具行之间留 actions 行既有的 8px，读起来仍是同一行的延长而不是新起一截；② 窄栏换行时工具行自己内部换行，右端一组与发送键始终同处一行，不拆开；③ 整组可收缩，长模型名由触发器内部的省略号收尾，发送键不会被顶出输入卡。
- **模型下拉的锚点改到右缘**：触发器移到行右端后，`left:0` 锚定的 22rem 清单会越过输入卡右缘、把页面顶出横向滚动条。`.agent-chat-composer-tail .model-selector-menu { left:auto; right:0 }` 让清单从 chip 右缘向左展开，向上锚定与限高内部滚动不变；`modelSelectorDropdown` 的「下拉层右缘越出视口」一例锁的就是这条。
- **一行按钮的复核结论（本轮逐项量过，未发现需改的不一致）**：所有行内控件高度同为 `control.height.compact`（32px）、垂直中线对齐（`align-items:center`）；图标控件（「+」、发送键）为 32×32 方形，`control.icon.size`（20px）字形；四档状态画法一致——hover／展开同一底色 `selection-hover` + 文字升 `text-primary`，禁用态 `text-muted` + 0.85 不透明度 + `not-allowed`，键盘焦点走全局 inset ring（模式档那枚自画的同款 inset ring，不另行加粗）；命中区 32px 已高于 `control.target.minimum`（24px）。本轮未新增 token、未新增色值。
- **Breaking Change：No。**

**验证出口**：顺序锁两处同步改写。`tests/browser/composerSourcePanel.spec.ts` 3c 改为锁「工具行左端是「+」、底栏三个直接子件为 `工具行 → tail → 发送键`、tail 内为 `计量环 → 模型`，资料仍在『普通讨论』右侧」，三个视口（1162×782／1000×800／860×800）**5/5**；`tests/assistantModeSwitch.spec.ts` 首条输入器改锁同一组事实（底栏三个子件 + tail 内顺序 + 两条邻接不变）**48/48**，同批回归 `composerDraftAssist`＋`modelSelector` 共 **23/23**（三文件合计 71/71）；`modelSelectorDropdown` **6/6**（含右缘锚定后的视口包含断言，会话输入器与首条输入器各半）。真实 Chromium 探针量过改后行序：会话输入器 `＋ ⓘ 写入档位待核对 ▾ 普通 Agent ▾ 润色 普通讨论 ▾ 资料 0 ▾ ○ 模型 ▾ ↑`、首条输入器 `＋ 未开放写入 普通 Agent ▾ 润色 普通讨论 ▾ 资料 0 ▾ ○ 模型 ▾ ↑`，两处 tail 与发送键同行同高；`tsc --noEmit` 对本轮路径零报错（仅剩并行会话未跟踪的 `tests/tmpFlashProbe.spec.ts` 一例旧错）。探针脚本用后已删。

本轮**未做**真实 Windows/WebView2 与多 DPI 目视；未做独立验收；未 commit/push。860px 档工具行换行成两行属既有窄栏行为（改前同样换行），发送键仍与 tail 同行。

### 32.15 select chip 的文字垂直居中：select 不撑满 chip（2026-10-20）

用户截图指认「输入框底部那些的竖直重心没有在一个高度」。像素实测（用户截图逐段墨迹分析）：两枚原生 `select` chip——会话模式「普通 Agent」与聊天模式「讨论/计划/目标」——的文字比同排其它 chip **偏高 7–8px**（文字墨迹重心 151.7，邻居 ≈160）。

- **根因**：`.agent-chat-mode-select` 写了 `height: 100%` 把 select 撑满 32px 的 chip。Chromium（含 WebView2）把 select 的**内部文字**按内容盒从顶部排，不随盒子拉高而垂直居中——盒子居中（flex `align-items:center` 对 select 盒生效）掩盖不了文字贴顶。§32.14 的「垂直中线对齐」复核只量到盒子级，select 内文字位置是 DOM Range 触达不到的 UA 绘制区，当时漏过。
- **修法**：`height: auto`。select 收缩回内容高（14px 字 × `lineHeight.heading` ≈ 17.5px），文字贴顶＝贴盒顶＝盒内居中；整枚盒子再由 chip 的 `align-items:center` 居中到 32px 中线。零魔法数、零新增 token，字体度量变化不破坏对齐。
- **普适规则（工具行与同款 chip 通用）**：chip 化的原生 select 一律**不写撑满高度的 `height`**，靠外层 flex 居中。将来若有第三枚 select chip 进工具行，同一条约束适用。
- **Breaking Change：No。**

**验证出口**：真实 Chromium（headless）夹具会话输入器修前/修后像素对照——select chip 文字墨迹重心 94.2/94.9 → 101.2/101.9，同排邻居 101.0–101.6，全行差 ≤0.9px；select 盒中心 722.05 与 chip 中心 722 重合。`composerSourcePanel.spec.ts` 新增 3d 断言（`select` 高度必须 < chip 高度 − 4px）三视口 3/3，并做 A/B：改回 `height:100%` 断言精确转红、恢复后回绿。`uiOption2FirstSession` 既有几何断言（chip 与发送键等高 ±1px、四视口单行）在修前修后都执行通过（该用例的失败点在其 339 行键盘切档，回退法验证为既有失败，与本改动无关）。截图留证 `apps/workbench/results/composer-baseline-row0.png`。

本轮未做真实 Windows/WebView2 目视（用户实机为 WebView2，修后需刷新窗口核对）；select 内文字位置无自动断言（DOM 触达不到），防回归锁在「select 不撑满 chip」这一盒子级不变式上；未做独立验收；未 commit/push。

## 33. 输入框粘贴图片与消息附件

2026-10-16。用户指认「输入框无法粘贴图片」，核查确认前后端均无此能力后按任务书全链路实施；后端（上传端点、消息命令 `attachment_ids`、模型能力闸门、多模态组装）已按 [HTTP §10.85](../api/http-command-contract.md#1085-assist-消息图片附件2026-10-18-前后端接线) 落地，**当时前端尚未接线**。2026-10-18 用户再次指认同一问题并要求「优先参考上游做法，有分歧就问」，本轮补齐了前端接线、放开了「只有图片没有正文」、补了附件只读端点与历史缩略图，并给未入目录的模型加了显式能力声明（见 §33.4）。状态与成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行。

### 33.1 输入与范围

- **粘贴**：输入器内 `Ctrl/Cmd+V`。剪贴板含图片位图或图片文件项时进入附件暂存；**纯文本粘贴行为逐字不变**（照常进正文，不弹附件）。
- **拖拽**：图片文件拖入输入器区域，悬停高亮（引用现有 token），释放后同样进入暂存。
- **V1 仅图片**：`image/png`、`image/jpeg`、`image/gif`、`image/webp`；其他类型（含 PDF、文本文件）粘贴/拖入时给出明确提示「当前版本仅支持图片」，不静默丢弃、不假装接收。文本/PDF 类扩展留后续。
- **上限**（与服务端同值，前端预检 + 服务端为准绳）：每消息 ≤4 张、单张 ≤2 MiB、总量 ≤6 MiB。

### 33.2 暂存与发送

- 附件 chip 列表呈现在输入卡内正文下方：缩略图（`URL.createObjectURL`）、名称、大小、逐个移除；视觉引用现有 token（资料 chip 同层级），不新增色值/字号/圆角。
- **悬停预览**（2026-10-19 用户指令「粘贴进去的图片鼠标悬停需要能够展示图片内容」，随后追加「历史消息也要」）：指针移入锚点或键盘聚焦到锚点内任一控件时，原图浮出；移出、按 Esc、滚动或改窗宽即收回。两处消费者（输入框芯片、历史消息附件）共用 `components/attachmentPreview.tsx`——几何、收回条件与浮层外观只写一遍，不复制第二套。浮层走 portal 挂在 `document.body` 上、`position: fixed`——输入卡在发送中 `overflow: hidden`，对话列本身也是滚动容器，留在锚点子树里会被裁掉。几何按锚点矩形与该图**实际**显示高度算：优先在锚点上方浮出，上方放不下翻到下方，两侧都放不下取空间大的一侧并把高度收到该侧余量（竖屏长截图不越出视口）；水平夹在视口内。上限 `min(480px, 视口宽-24)` 与 `min(520px, 视口高 60%)`，图按比例缩到上限内不裁切、也不放大小图（放大只会糊）。浮层 `pointer-events: none`（挡在光标下也不会把自己触发成 mouseout 而闪烁），`aria-hidden`（名称在锚点里已读得到，不重复播报）。没有可读内容时不浮空框：输入框里没有预览 URL、历史附件还没读到或读失败，都只有名称与大小。
- 上传中显示进度态；失败保留附件与明确错误，可重试，不丢用户已选内容。发送时先逐张上传拿 `attachment_id`，再随消息命令 `attachment_ids` 提交；任一失败不发送正文命令，错误就地可读。
- 未发送附件计入**未保存保护**（与已选资料、Skill 输入同一守卫）；离页前提示。重挂载/刷新后附件不保留——二进制不进草稿持久化，UI 明示此限制。
- 能力预检：`GET /model-port` 的只读投影 `image_input`（2026-10-19，次日补声明层），取值与发送闸门同一份判定（`application/chat-image-input.ts`），来源顺序为**目录 → 声明表 → 环境变量 → 拒绝**：`SUPPORTED`/`DECLARED` 可发；`MODEL_LACKS_IMAGE_INPUT`/`MODEL_NOT_IN_CATALOG`/`NOT_CONFIGURED` 会在**图片刚粘进来时**就在芯片行给出警示条（含模型名与出路：换模型或声明该模型接受图片输入），不必等上传完、点了发送才被 422 拒绝；`UNKNOWN`（这次读不到目录）沉默，不拿未知当不支持。**只说明、不拦发送**：服务端闸门仍是准绳，禁用发送键会把「只发这段文字」也卡住。声明本身在设置页「模型端口」卡片内维护（支持 / 不支持 / 撤销 + 依据备注），写入后下一次读取立即生效，不需要重启实例；卡片同时显示这次结论来自哪一层（目录 / 你的声明 / 服务端环境声明）。（此前 2026-10-18 记录为「前端未做这项预检」，2026-10-19 补齐提示、2026-10-20 补齐声明入口。）

**2026-10-20 补：原地声明（P1-5 前半）**。`MODEL_NOT_IN_CATALOG` 这一档以前把用户推去改 `RELAY_MODEL_IMAGE_INPUT`——那是兼容期的服务端环境变量，普通用户既改不了也不该知道。现在这一档在芯片行下方直接给两个动作：「声明支持图片」「声明不支持」，写的是**当前 provider + 当前模型名**（`PUT /model-capabilities/{provider}/{model}`），写完立即重读 `/model-port`，判定变成 `DECLARED` 后提示与入口一起消失。

- 只有这一档给入口。`MODEL_LACKS_IMAGE_INPUT`（目录明确说不支持）**不给**：目录判定优先于声明，给了按钮等于承诺一件做不到的事。`NOT_CONFIGURED` 也不给：那里缺的是模型连接，不是能力声明。
- 不新增第二套判定：写入后仍读同一个 `image_input` 投影，客户端不自行宣布「已生效」。
- 设置页「模型端口」卡片新增「生效范围」一行：本实例所有会话共用；声明跟随 provider 与模型名，换模型要重新声明。端点的读写与多连接切换仍不在本轮范围（P1-5 后半，见 `CODEX_NEXT_STEP` 的差异分析）。

### 33.3 边界

- 附件只是会话输入快照：不进资料体系、不授予读取/执行权限、不影响显式选源 10 条上限。
- 历史消息里的图片以文本占位说明（模型不回放历史图片内容）；消息气泡呈现附件缩略图（前端接线时补）。气泡里的图受 `20rem × 12rem` 约束，竖屏截图会被压到读不出内容，因此悬停/聚焦时浮出原图——与输入框芯片共用 `attachmentPreview.tsx`（2026-10-19）。**尺寸预留（2026-10-23，禅道 #154）**：占位符换成 `<img>` 之前先解码拿固有宽高，插入时就带 `width`/`height`，让浏览器在解码前算出被 `max-width`/`max-height` 约束后的确切盒高——不再从 32px 占位一步撑到最高 192px 而把后面的消息推下去。解码失败或宿主不回调（测试环境不加载图片）时最多等 200ms 就先铺图，退回无尺寸渲染，不把历史消息卡在占位符。
- 助手（只读）与学习会话同规则可用；归档会话上传被服务端拒绝，输入器相应禁用。

### 33.4 前端接线与「只有图片」的放行（2026-10-18）

用户第二轮指令：「输入框中无法粘贴图片，估计只能输入文字……优先参考一下上游是怎么做的，有分歧就询问我」。四处与既有契约/本机环境冲突的地方一次问清，用户选定：**允许仅图片发送**、**首条消息也支持**、**补只读端点做历史缩略图**、**加显式能力声明开关**。

- **粘贴/拖拽照上游**（zcode `prompt-input-textarea.tsx`，源自 vercel ai-elements）：`onPaste` 只在剪贴板**真有文件项**时 `preventDefault` 并交给附件暂存，其余粘贴（文字、表格、代码）逐字不变；拖拽在输入区 `dragenter/over/leave/drop` 上用进入计数维持高亮，`drop` 只接管文件。**不**把非图片静默丢掉——交给暂存层给出「当前版本仅支持 PNG、JPEG、GIF、WebP」。与上游唯一的有意差别：上游在正文为空时按 `Backspace` 删最后一张，本轮不做（键盘语义与中文组词/光标移动容易冲突，且芯片上已有显式移除键）。
- **芯片位置**：正文下方、工具行上方（`ComposerAttachmentChips`），缩略图 40px + 名称（可截断）+ 大小 + 移除键。**卡外的「档位说明/回执」规则不变**：芯片是这条输入的组成部分，不是卡的状态，因此留在卡内不会让空闲/在途的卡片形状随状态跳。
- **上限**：`components/composerAttachments.ts` 与服务端 `application/assist-attachments.ts` 同值（4 张 / 单张 2 MiB / 合计 6 MiB），一致性由 `tests/composerImageAttachments.spec.tsx` 直接比对服务端源码锁定；前端只做发送前预检，服务端仍是唯一准绳。
- **上传时机**：点发送后、命令产生前。会话输入器先逐张上传再发 `RequestAssistMessage`；首条消息先建会话（上传端点以会话为作用域），再上传，按同一份 pending 里的 `attachmentIds` 发首条。任一上传失败**不发**消息命令，芯片留在框里，错误就地可读；成功后 `attachment_ids` 已进命令载荷，重试永远沿同一组 id 重放（换 id 就是换载荷，服务端会按 `COMMAND_ID_REUSED` 拒绝）。
- **只有图片**：正文空串 + 有附件是合法的**讨论轮**；`Skill` 与提案意图仍要求正文（服务端同一裁决，客户端先说明）。没有附件时空正文照旧拒绝。
- **首条消息**：允许只贴图开新会话；标题按既有兜底取「关于{目标}」或「新讨论」。上传失败时保留 `pendingFirst` 的失败原因，「按原命令重试」会先补传再发送。
- **历史缩略图**：`GET …/message-attachments/{id}` 按单张读，`MessageAttachments` 用进程内缓存（同一张图重读会话不再请求）；读失败显示占位与「重新读取」，不冒充「没有图片」。
- **模型能力**：目录里没有该模型条目时，`RELAY_MODEL_IMAGE_INPUT=true` 是运维声明；目录里有条目时以目录为准，未声明仍按未知拒绝（fail-closed 不变）。本机 `agnes-3.0-flash` 属自建 Provider，不在 OpenRouter 目录里，因此**需要这一行**才能真的发送图片。选项 6（DesktopDev）读的是 `<repo>\.relay-test\desktop.env`（`test-desktop.ps1` 只重写 DB/workspace 四个 runtime 键，`RELAY_MODEL_*` 归用户原样保留），改完要重开窗口——宿主只在启动时读该文件。2026-10-19 实测该 Provider 接受 OpenAI 风格的 `image_url` data URL（返回 `prompt_tokens_details.image_tokens`），声明与实际能力一致。
- **拒绝原因必须可读**（2026-10-19 用户截图「attachment_ids 不符合契约」后修）：能力闸门与附件归属校验都以 `VALIDATION_FAILED` + `field_errors: [{ field: "attachment_ids", message: … }]` 返回，而 `detail` 恒为「请求结构不符合端点契约。」——真实原因只在 `field_errors[].message` 里。客户端原先只拼字段名（`liveErrors` 的 `VALIDATION_FAILED` 分支），把原因吞掉了；现在改为「请求未通过服务端校验（字段）：服务端说明」，同字段多条去重，说明为空时退回通用提示。这样同一处错误能直接告诉用户是「模型不支持图片」还是「目录里没有该模型、需要声明 `RELAY_MODEL_IMAGE_INPUT=true`」。

**验证出口（如实分层）**：`tests/composerImageAttachments.spec.tsx` **6/6**（上限对齐服务端源码、逐张裁决、纯文本粘贴不改行为、暂存期间零请求、发送时先上传再带 `attachment_ids` 提交空正文、首条消息「建会话→上传→发消息」顺序、历史缩略图读取）；2026-10-19 增补 1 条「上传成功但命令被拒时图片留在输入框」后为 **7/7**；同日增补悬停预览 1 条（浮出/内部移动不收回/离开收回/聚焦可达/Esc 关闭/portal 不在输入卡子树）后为 **8/8**，历史附件那条同时补了「读到的图可预览、读失败的条目不浮空框」；再增 1 条「模型不接受图片时粘进来就说明、且不禁用发送键」后为 **9/9**；真实 Chromium 侧 `tests/browser/attachmentHoverPreview.spec.ts` **3/3**（输入框芯片、历史消息附件、能力预检各一例：原图解码出 320×200、浮层父节点是 `document.body`、大于原缩略图、整块在视口内且不压住锚点、`pointer-events: none`、移开即消失；预检那条断言说明含模型名且发送键仍可用），截图 `results/composer-attachment-hover-preview.png`、`results/message-attachment-hover-preview.png` 与 `results/composer-image-capability-notice.png`；服务端真实 PG 集成 `assist-message-attachments.integration.test.ts`（绑定/投影/跨会话与跨 Workspace 不可见/空正文例外/能力声明/上限）见验收表，`model-port.integration.test.ts` 已同步新字段断言。**未验**：真实 Windows 窗口的粘贴与拖拽（含 DPI 与输入法）、真实 Provider 的多模态语义质量、桌面壳暂存 API 是否已含本轮改动；悬停预览未在触摸屏/无指针设备上验（该场景只有聚焦路径可用），也未验超大长截图（>520px 高）在两侧都放不下时的实际观感；能力预检的 `UNKNOWN`（目录读不到）与 `SUPPORTED`（目录明确支持）两态只有纯判定单测，没有真实目录数据下的浏览器取证。

## 34. 会话局部与总 diff

2026-10-16 编制，2026-10-17 实施前三个工作包。状态：**W1–W3 已写入源码并通过工程自检**（client 只读方法、局部行与输入卡上方总数两处 UI、jsdom 组件断言与页面内夹具的真实 Chromium 几何）；**W4 的真实 PG／Git 集成与运行验收尚未闭合**，成绩只归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。用户以两张截图要求编辑记录旁的局部增删行数，以及输入框上方居中的总 diff，并明确选择 **B「本轮对话开始以来的净变化」**，不采用整个仓库相对 HEAD 的全部未提交变化。开发入口为[专项提示词](../../prompts/conversation-live-diff.md)，验收条件归[测试计划 §34](../testing/verification-plan.md#34-会话局部与总-diff-验收规格)。截图只是位置和信息参考，不是当前 Relay 已有能力的证据。

### 34.1 已确认选择与方案默认

| 项目 | 来源与状态 | 本方案 |
|---|---|---|
| 两个位置 | 用户已要求 | 局部在聊天的具体文件编辑记录旁；总数在输入框上方的中间位置 |
| 总数口径 | 用户已选择 B，2026-10-20 收窄范围 | 会话起点至当前的净变化；不采用 HEAD 基线，也不累加每次编辑行数。**范围只含本会话自己写过的路径**——用户原话「工作详情那里统计总目录就好了，这里就只统计当前会话的 git diff」，同期外部修改不进这条入口 |
| 实时反馈 | 用户已要求 | 编辑生成中持续更新局部数字；落盘后总数刷新，不只在最终回复时出现 |
| 「本轮对话」生命周期 | 本次推荐默认 | 绑定原会话身份，不按每条用户消息或每个 Run 重置；继续讨论、暂停、恢复、重启不另起基线 |
| 同期外部编辑 | 本次推荐默认 | 总数是时间范围内的目录净变化，包含人工及其他程序同期修改；不是 Agent 贡献归因 |
| 展开与动画 | 本次推荐默认 | 两处都可查看对应 diff；数字直接更新、等宽排列，可用既有短时淡入，不做逐个补数的滚轮动画 |
| 工程接口与数值 | 开发时核定 | 在现有 Owner 下补最小能力；具体表、端点、扫描上限与刷新参数不在本轮伪装成已确定实现 |

后续细则是本次交付的推荐方案，用于开发与审查；不把用户仅回复「B」扩写成其逐项确认过所有工程细节。后续明确下发任务书后可按推荐默认实施，影响统计语义、权限、范围或历史承诺的偏离须先显式说明。

### 34.2 两种比较与数据含义

**局部：一次编辑前 → 这次编辑后。** 以原模型调用／工具调用／动作及文件相对路径归属，列出 `✎ 正在生成 computer-adapter.ts · 预览 +66 −2`，实际写入核对后变成 `✎ 已修改 computer-adapter.ts +78 −5`。一个 changeset 有多个文件时逐文件展示；同一文件修改三次留下三条局部历史，后来继续编辑不重写旧记录。

**总数：会话基线文件内容 → 当前实际文件内容，范围限本会话写过的路径。** 入口文案为 `本次对话 · 3 个文件 +145 −8`，内容居中，位于输入卡外的上方；与目录细条、草稿辅助和在途提示协调，不把输入卡内部撑高。展开标题为「本次对话的文件变化」，展示基线时间、目录、逐文件增删行、可用性与完整 diff；说明「只统计本会话写入的文件；同一目录里其他程序或其他会话的同期修改不计入」。**会话未绑定工作目录时这一行整块不出现，也不发任何统计请求**（2026-10-17 用户指令「不要有这个提示」）：同一屏里输入区上方的目录细条已常驻写着「选择工作目录／执行前需归入项目」（2026-10-18 第三轮前该档文案是「未选择目录」），入口再复述一遍「暂不统计」等于把同一件事讲两次。这不改变事实与口径，只改呈现 Owner——目录归细条，数字归这一行。

**归因规则（2026-10-20，用户指令「工作详情那里统计总目录就好了，这里就只统计当前会话的 git diff」）**：候选路径**只认实际落盘的冻结变更集**——本会话执行请求所对 Run 的 `change_sets` / `change_set_files`，并按当前根路径过滤（换过目录的会话不会把旧根的相对路径算进新段）。**模型声明过但没落盘的路径完全不出现**（用户 2026-10-20 明确「完全不出现」）：声明只代表打算改，把它算进来会让「别人恰好在同一窗口改了那个文件」被记成本会话的改动。写工具直连 Gateway 的路径同样落 `change_sets`，因此不再单列 `session_tool_calls`。归因只圈定**候选**：行数仍由「基线 → 当前内容」算出，写了又改回原样的路径会因摘要相同而自然消失。**本会话一个路径都没写过时不扫描整目录**（纯聊天会话每 4 秒轮询一次，不该付 2000 文件的扫描成本），入口直接显示「暂无文件变化」。

同一行先改再改回，总数归零，局部历史保留；新建后删除同样抵消，已有文件删除后恢复原内容同样抵消。会话开始前已有的脏改动和未跟踪文件作为基线的一部分，不计为这次新增；但它们在会话中继续变化的部分要计入。暂存、取消暂存或提交不能重置会话基线；首次提交、HEAD 移动和分支切换也不能静默改成新的 HEAD 比较。切分支引发的内容变化会反映在目录净变化里，并说明比较仍基于原会话快照。

按统一的逐行文本 diff 规则统计插入和删除，替换通常同时计入两侧；不以字符串长度、工具调用次数或整个文件行数代替差异。末尾无换行、CRLF/LF、空文件和重命名规则必须固定并测试；推荐不把纯换行编码变化计入增删行，首版不做模糊重命名推断，按原路径删除和新路径新增统计并说明。总数与其展开列表必须来自同一份修订，不能分别计算出相互矛盾的结果。

### 34.3 会话基线、范围与恢复

- 新会话在有读取权限且绑定目录后，于首条消息开始处理、任何写入前建立基线；纯聊天尚无目录时不做全盘扫描，绑定后显示真实「统计起点」。目录在首条消息前已绑定的会话，起点就是首条消息处理前。不能把较晚采集的起点标成会话创建时间。
- 基线绑定 Workspace、Session、受管资源身份及资源 epoch／等价现有版本。一次原子发布只产生一个有效基线，保存时间、范围、内容摘要、必要文本与缺失原因；后续消息、Run、前端刷新、服务重启沿用它。不创建 Git commit、stash、分支或 worktree，不修改用户 index 来保存基线。
- 读取范围限当前获准受管根；它是仓库子目录时只覆盖该子目录，不因 Git 顶层在上级就读取全仓。覆盖范围内的已跟踪文件与未被忽略的未跟踪文件；`.git` 内部、越界路径、目录链接／重解析点和子模块内容不得因此递归读取。敏感内容仍服从既有文件读取规则，Git 跟踪不等于获得读取权限。
- 基线要保留开始时的文件清单及允许统计文本的真实内容，当前版本相应重新核对；只存 HEAD、hash、路径或事后首次写入前文本，不能重建会话起点。**禁止用延迟的首次触碰快照冒充整个会话基线**，它会漏算之前的人工修改。大仓库、超限、二进制或不可读项显式列为不可统计，并返回完整性标记；不能静默跳过后宣称总数完整。
- **存在性与内容摘要必须分开判定**（2026-10-20 修）：文件「是否存在」只能取自目录清单（`git ls-files` 的已跟踪与未忽略未跟踪并集），不能从「摘要为空」反推。超过单文件读取上限（当前 1 MB）或采集时读失败的文件，两侧都存在却都没有摘要——旧实现把当前侧的 `sha256: null` 当成「当前不存在」，于是本仓库 147 个字体与截图文件被报成 `DELETE`，界面显示「本会话删了 147 个文件」。现在的规则：两侧都在而摘要读不到时判 `UNVERIFIED`；字节数相同则**不进文件列表**，只计入覆盖里的 `unverifiableFiles`；字节数不同说明内容确实变了，按不可统计的 `MODIFY` 列出（行数仍不编造）。
- 应用写入与基线采集沿已有资源排他机制协调，文件清单及内容做有界一致性复核，变化中重试有上限。外部程序不受 Relay 锁控制，无法保证全目录操作系统原子快照，故显示实际采集时间窗；无法得到可接受基线时标不可用，不冒充原子、不开无限重试。扫描不占长数据库事务。
- 基线采集超时／失权／失败不破坏原消息和执行流程。若执行开始前未取得有效基线，该段总数保持「缺少会话起点」；之后最多以明确的新统计起点建立新段，不倒造过去。旧会话同理，不能从当前磁盘反推历史；如提供「从现在开始统计」，须用户主动触发且显示其时间，不标为原会话起点。
- 更换目录必须结束旧段并明确提示「目录已变化，统计将从新目录起点开始」，新段不与旧段求和；返回旧目录也不能复用错误 epoch。切换会话只切换原会话快照，旧响应立即不可见；失权时隐藏历史及当前 diff 正文，不能通过基线读接口继续泄露内容。历史基线不随前端卸载或普通重启删除；归档保留已记录快照，不持续后台扫描。
- 同目录的多个会话各有自己的起点、共享既有实际目录写排他；**会话口径只统计本会话写过的路径**，同目录其他会话或人工的同期编辑不进这条入口（2026-10-20 起；目录级总变化若要做，属工作详情那类视图，不在这条入口冒充）。两件事都不能据此给另一会话授写权限或给本会话标完成。

### 34.4 生成预览、实际落盘与实时更新

当前模型端口会累计完整工具参数再解析，只有文本回调，没有文件修改参数预览。要实现生成中的数字变化，需在原工具参数流上增添**只读、有界、临时预览**，不改变完整校验之后才执行的规则。

- 用原 `model_call_id`、Provider 工具调用身份／流内 ordinal、文件路径及单调 revision 关联预览；动作尚未 prepare 时不能捏造 operation ID。片段只在确定属于 `apply_changeset` 且路径、动作已可安全识别后展示。并发调用、多个文件及重试轮次不得串到其他编辑行或会话。
- JSON 参数片段须通过有界增量解析取得真实 `content` 文本，处理转义、拆开的 Unicode 和半截字符串；不使用 `eval`、不靠粗略正则数换行、不把半截参数交给执行器。完整流到达仍走原 schema、基线校验、批准及 Gateway；局部预览不授予任何权限。
- CREATE 可显示已收到内容的插入预览；MODIFY 只有匹配原摘要的可用基线时才计算，否则显示「正在生成，行数待核对」。内容尚未收全时不要把尚未收到的文件尾部全部算成已删除；删除数在完整目标／可靠完整替换范围可得后发布，不能可靠计算的字段用待核对。预览值允许修正和回落，不承诺单调增加。
- 等待批准显示「待应用」，不冒充已修改；拒绝／取消／失败结束临时态，保留真实原因。只有确切逐文件账本与内容摘要支持时才用过去时说法，动词跟账本里的动作走（新增／修改／删除各写各的），生成中的行始终只写「预览」。部分写入逐文件区分；UNKNOWN 显示待核对，不盲重试、不把拟写目标当落盘事实。总数仍可展示独立读取到的当前目录状态，但不得借此宣布原动作成功。
- **总数只采用当前已落盘内容**，不把尚未执行的生成预览混进去。生成中局部数字可连续变化，总数通常在每次文件应用后跳变，这是两者不同来源的正常结果。
- 复用原 Run 事件提示、权威查询及版本守卫；两处展示消费统一统计来源，不各建一套计算账本。普通 Agent 会话如走 session 工具账本，沿原 session 身份接入，不为展示强造 Task/Run。进程重启无需恢复半截预览为成功，重新读取原动作事实和会话基线即可。
- 推荐局部预览节流 150–250ms，应用完成立即触发总数重算；用户正在查看活动会话时以低频有界轮询兜底同期人工/CLI 修改，回到前台、重连和写入后主动刷新。具体周期为实施推荐值而非已确认产品数值，不为每个 token 启动 Git 或全仓扫描，不添加通用文件监听平台；若选择监听器，必须保留同等补偿能力。
- 刷新失败保留上次可信结果并标「更新失败／截至…」，无历史结果才显示不可用；读取中不反复归零。「更新失败·截至…」与「部分不可统计」这类入口级标记只写在入口那一行上（展开时仍在那颗按钮里），保留可信值的展开面板照常显示上一次那份逐文件清单，不再在面板里重复一条失败。无目录（前端侧这一行直接不出现，见 §34.2；服务端在读取瞬间回 `NO_RESOURCE` 的竞态仍按不可用呈现）、非 Git 根（首版推荐明确不可用）、基线缺失、权限变化、二进制、超限、空差异分别呈现，未知不能显示为 `+0 −0`。完整且空的结果可显示「本次对话暂无文件变化」。
- 「不完整」分三类，条数与措辞各自独立、不得合并成一句（2026-10-20）：**扫描覆盖不足**（`baseline`/`current` 的 `complete=false`，附停下来的原因）、**文件未核对**（`uncheckedFiles` 起点有本轮没核到、`unverifiedFiles` 本轮有起点没覆盖且已被 Git 跟踪）、**内容未核对**（`unverifiableFiles` 两侧都在但摘要读不到且字节数相同，见 §34.3）、以及**已发现但行数不可统计**（列表里逐条标 `unavailableReason` 的文件）。只有第一类与「文件未核对」才说明目录没扫全；`unverifiableFiles` 只说明这些文件的内容没读，不能因此把它们画成改动。总数不可统计时，面板空态写「没有可统计的文件变化；本次统计不完整」而不是「本次对话暂无文件变化」。

### 34.5 责任、取舍与实施边界

应用层拥有会话基线的建立、读取与失效协调；既有文件/Git 适配与 Gateway 拥有获准目录读取和实际写入，模型端口仅提供临时参数片段，前端只消费同一服务端统计投影。会话基线和 diff 是展示证据，不是 ArtifactVersion、Verification PASS、Task 完成或恢复动作的替代权威；不能修改原 `arguments`/`result_ref` 来塞第二套历史。

| 比较方案 | 取舍与结果 |
|---|---|
| HEAD 到工作区 | 成本低，但会混入开始前的脏改动，已被本次 B 选择排除 |
| 局部数字累加 | 容易展示，但反复编辑／恢复原内容会重复计数，排除 |
| 首次触碰时才记录每个文件 | 存储少，但不是会话开始快照，不能实现已选语义，排除 |
| 持久化会话范围快照并比较当前内容 | 本次推荐；保留真实起点、净变化和重启恢复，代价为有界扫描与文本存储。2026-10-20 起用会话写账本把范围收窄到「本会话写过的路径」，同期外部编辑不再混入总数；代价是多一次账本查询，且归因依赖写账本完整（声明了却没落盘的路径由内容摘要相同自然消失） |

首版只做两个位置、基线与净差异、临时生成预览、展开阅读及必要恢复/失效；不增加 Git 暂存/提交/推送、自动回滚、贡献排行榜、通用工作区历史或跨目录汇总。持久化结构、读权限和预览清理生命周期在开发时按现有能力核定，必要时更新架构与 ADR、HTTP（Breaking Change 与兼容策略）、数据库 migration（兼容/回滚），不预占迁移编号。实现前若发现无法满足本节的基线时点或预览能力，必须说明具体差异，不得以最终数字或模拟动画冒充已完成实时功能。

### 34.6 工作详情的「变更」页签（2026-10-20）

用户指令「工作详情那里统计总目录就好了，这里就只统计当前会话的 git diff」：**目录级总变化搬到工作详情**，对话输入卡上方那一行只留会话口径。两条入口消费同一份服务端投影（同一份基线、同一套行规则、同一份覆盖信息），差别只在范围参数 `scope`。

- 页签位置：会话工作详情（`WorkDetailsFrame`，`collab-conversation-inspector`）在「进展／成果／记录」之间插入「变更」，任务工作详情仍是三页——任务没有会话基线，不能凭空多一页空视图。
- 内容：页签正文直接内联摊开（无「展开／收起」这一层），依次是统计起点与目录、一句「整段目录自会话起点起的净变化，含同期人工与其他程序的修改；不代表全部由 Agent 产生」、逐文件增删行、缺口说明与逐文件正文。
- 读取：`GET …/conversation-diff?scope=DIRECTORY`；单文件正文同一 `scope`。会话口径（省略 `scope`）仍然只放行本会话落盘过的路径，目录口径按目录范围放行。页签内的轮询拉到 **20 秒**（对话入口仍是 4 秒）：目录口径每次读取都要重扫受管根，本机 2000 条约 3 秒，4 秒一次等于常驻满负荷；面板底部「重新读取」仍可手动取最新，会话口径零写入时服务端直接短路不扫描。
- 未绑定目录或会话身份尚未建立时，页签照常出现并说明原因（「这段讨论还没有会话身份」／服务端 `NO_RESOURCE`），不像输入卡上方那一行那样整块隐藏——那里是常驻行，这里是专门来看统计的页。
- 视觉：内联形态去掉浮层的阴影、描边与内边距，避免在抽屉里出现第二层卡片；数字配色与省略规则沿用设计系统 §9.15。

## 35. 浮层菜单的关闭语义（2026-10-17）

用户指认「多菜单重叠：菜单打开后点击菜单外的部分无法关闭」。收口前只有四处弹层自管外部关闭（「+」菜单、通知面板、模型选择器、会话切换），写入档位、页头「更多操作」、发送选项、首条「普通讨论」说明、协作区「版本与比较」、草稿分点浮层都没有——绝对定位浮层可以同时打开并互相压住。

关闭语义收口在 `lib/popoverMenu.ts`，三条规则，全部弹层共用：

1. **点到外面即收**：document 捕获阶段 `pointerdown`，目标不在「浮层＋触发器」外壳内即收起；捕获阶段先于 summary 的 click，先收旧层这一次点击才开新层。
2. **Esc 收起**：组词期（isComposing / keyCode 229）与带修饰键的 Esc 不消费，已 preventDefault 的不重复处理；非受控 details 由钩子把焦点还给 summary。
3. **同一时刻只保留一个浮层**：打开一个即把其余已注册浮层收掉；常驻折叠披露区（「查看依据」一类内联 details）不是浮层，不注册，行为不变。

接入清单：写入档位、页头「更多操作」、「+」菜单（替换原自有实现，右键在外也算点了别处）、首条「普通讨论」、发送选项（仅独立态浮层，内嵌常驻面板不参与）、协作区「版本与比较」（仅 compact 弹层形态）、草稿分点浮层、通知面板（替换原自有实现）、「切换讨论」、模型选择器与近期工作 ⋯ 菜单（原有完整关闭语义保留，仅补独占注册）。

验证出口：`tests/popoverMenu.spec.tsx` 5 项（点外关闭、层内点击不收、Esc 还焦点、双实例独占、组词 Esc 不收）；`writePermissionTier`、`composerAttachMenu`、`composerDraftAssist`、`modelSelector`、`sessionRowMenu`、`interventionNotifications`、`artifactReader`、`assistantModeSwitch`、`collaborationWorkspace` 等既有套件无回归。真实 WebView2 窗口仍未复验。

## 36. 电脑、浏览器与 GitHub 能力的日常使用（2026-10-18）

本节把现有能力与用户路径集中说明。连接器的入口、状态读取与管理位置沿用 §32.9；能力是否进入当前回合仍由服务端连接、策略与执行身份决定。以下规则以 [Computer Plugin V1](../architecture/computer-plugin-v1.md)、[F25 GitHub 范围](../requirements/v1-scope.md#内置-github-skill-范围补充)、[ADR-023](../decisions/ADR-023-builtin-github-skill.md) 与已接受的 [ADR-025](../decisions/ADR-025-extension-bridge.md) 为依据。验收结论与证据唯一归[统一功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 36.1 共同入口和权限

- 用户在有项目归属的会话里打开「+ → 连接器与插件」查看服务端返回的能力与状态；此列表只展示事实，不是切换开关。连接和策略从「管理连接与权限」进入项目设置，权限变化由原 Gateway/Review 路径裁决。
- 没有有效连接或当前动作策略不允许时，工具不可用或按既有审批机制等待人工判断；菜单可见、Skill 被选中、Agent 委托都不代表已获权限。连接失效应显示停用/撤销状态，不沿用旧授权。
- 外部网页、GitHub 内容及电脑画面都属于待处理数据，不能覆盖产品规则、审批或用户授权。

### 36.2 电脑：先观察，再授权输入

- **会话独占（2026-10-18 用户已确认，正在实施）**：第一次桌面输入准入后，本次操控会话由同一 Run 独占；其他 Run 即使属于不同目录也不能插入桌面输入。同一 Run 可连续操作，读取能力不因此扩权。独占持续到应用确认安全停止或执行结束；超时、租约到期、输入结果未知均不等于旧进程已停止，不自动让出桌面。暂停、取消、交接、完成、失败及恢复必须处理相应释放或隔离，不以 Overlay 展示行充当执行权。实际实现和验收状态以统一验收表为准。
- **目标**：在 Windows 桌面读取环境/窗口/截图，并在用户授权后对指定桌面执行有限输入。桌面自动化与浏览器 DOM 自动化分别授权。
- **使用路径**：用户先为项目配置 `COMPUTER_READ` 和/或 `COMPUTER_INPUT` 连接及策略；Agent 先读取环境、窗口或截图，确认目标后再提出点击、键入、按键或拖动等输入。会话只读轮次只能读取，输入通过 Task/Run 执行。
- **授权与反馈**：读取可按策略自动准入；输入必须逐动作批准或明确授予本次任务范围，不能因 `AUTO` 策略或菜单显示而免批。执行期间系统 Overlay 应显示正在操控、当前动作和退出提示；用户按 Esc 请求停止。只在控制状态与在途动作结算确认后显示已停止；结果不确定时保留 UNKNOWN/人工核对，不提示成功。
- **首次使用、失败与恢复**：连接/策略由「连接与权限」管理；真实运行时缺失、窗口不可用、权限拒绝或输入回执不确定时，应给可理解的原因并回到重新观察/人工处理，不用任意 Shell 或宿主自动化绕过准入。重新观察不会自动重放先前输入。
- **当前状态**：两个能力已接线到连接设置与动态能力列表；本轮已通过真实 Gateway → Windows Runtime 向自有空白记事本输入固定标记，并核对实际窗口。迁移 `0110` 补齐应用角色访问控制状态表的权限；停止请求与取消命令同事务提交，重复请求保持 STOP_REQUESTED，安全点确认后才成为 STOPPED。真实 Overlay/Esc 中断、安装态及真实模型驱动仍待独立验收；结果唯一归统一验收表。

### 36.3 浏览器：使用现有 Chrome 的非激活标签页

- **已确认目标**：默认使用用户日常 Chrome、复用登录态，通过扩展创建并操作非激活标签页；不把用户当前聚焦页当作默认页，不抢前台，不静默退回独立 CDP Chrome。旧自有 Chrome/CDP 仅作显式对照后端，见 [ADR-024](../decisions/ADR-024-builtin-browser-automation.md) 与 [ADR-025](../decisions/ADR-025-extension-bridge.md)。
- **首次配置**：用户在 Chrome 显式加载 Relay 扩展，在扩展设置中填 Relay 本机 API 地址与配对令牌并保存连接。Chrome 的调试提示条应如实告知；配对信息不能进入日志或对话。扩展未配对、断开或令牌错误时应显示诊断和安装/重连指引，不切换后端。
- **使用路径**：Agent 为本次执行新建自己拥有的后台页，读取页面快照并按快照元素进行导航、填写或点击；不得操作未归属页面。读取为 `BROWSER_READ`，一般页面动作是 `BROWSER_ACTION`，提交/上传是 `BROWSER_COMMIT`。提交/上传始终逐动作审批，即使任务已有范围授权。
- **停止与恢复**：取消、标签页变化、扩展重启或桥接断连时，若动作是否生效不明则标记 UNKNOWN/STALE，重新读取并由用户核对；不盲目重放。等待必须由扩展侧机制驱动，不能依赖后台页可能被节流的定时器。
- **当前状态**：已修复桥接路径与 hello 令牌，真实隔离 Chromium 加载实际 MV3 扩展后走通配对、后台建页、读取/填写/点击/截图/导航、用户页拒绝、关闭自有页及断线重连；发送后丢失响应按 UNKNOWN 隔离，重读后恢复。随后用户已在日常 Chrome 手动加载并配对，真实后台页读取/填写/点击/截图通过，原有标签页激活状态保持；点击需对自有页启用文档焦点模拟。空闲后仍复现 MV3 休眠断线，API 保活修复正在实机复验；登录态复用、真实停止和正式安装包仍待验证。CDP M1/M2 旧链路证据不替代扩展路线。

### 36.4 GitHub：只读查询当前受管仓库

- **目标与入口**：在受管工作目录对应的 GitHub 仓库上读取仓库信息、Pull Request 和 Issue；用户通过自然语言提出具体查询，现有 `GITHUB_READ` 工具按 ACTIVE 连接进入当轮词表。面板只展示连接状态，不新增 GitHub 专属工作台。
- **首次配置**：用户在 Relay 外完成 GitHub CLI 安装/登录，再在项目「连接与权限」设置中启用 `GITHUB_READ` 并为所需动作配置策略。CLI 查找依次采用显式 `RELAY_GH_PATH`、Node 同目录随包文件、系统 PATH；查找入口不代表当前发行包已包含 CLI。目标仓库只从该受管目录的 GitHub remote 确认，不采纳模型另行指定的仓库名。
- **只读与写入边界**：当前首片只开放仓库查看、PR 列表/查看、Issue 列表；不创建/评论/关闭 Issue，不创建/合并 PR。`gh api`、任意 Shell、仓库内容及 Skill 原文均不额外授予动作。GitHub 侧写入须另有已冻结的审批与 UNKNOWN 核对协议。
- **失败与恢复**：缺少 CLI、未认证、无 GitHub remote、限流、网络或权限错误应分类呈现，失败不转为空结果；不自动登录、不改授权范围、不重试不确定写动作。GitHub 读取为只读，用户可在修复连接/认证后重试查询。
- **当前状态**：本轮已由用户完成 CLI 认证，四个只读动作经真实会话/Gateway/PG 账本验证成功，返回结果带不可信外部内容标记；2026-10-18 另补第五个只读动作 `GITHUB_ISSUE_VIEW`（issue 正文与有界评论），尚未在真实已认证会话里复验。上游官方 Skill 原文的打包规则已加入构建，但登记与运行时提示注入尚未完成，因此只读 adapter 可用不等于完整官方 Skill 已交付。成绩与安装态限制归统一验收表。

### 36.5 本轮验收出口

电脑、浏览器与 GitHub 分别记录自动化、真实 PG/HTTP、真实桌面、真实 Chrome/扩展、真实 GitHub 认证和安装包证据；一层通过不能替代另一层。只有已实际运行并核对的层级才标为通过；未配对、未登录或环境不可交互时写明阻塞条件，不把产品规则或静态代码检查算作运行验收。

## 37. 定时任务（2026-10-18 已实施，完整出口未验）

到点自动创建并启动任务，按天或按周重复。产品规则归[后续路线 N08](../requirements/post-v1-roadmap.md#n08-周期定时启动任务)，取舍归 [ADR-026](../decisions/ADR-026-scheduled-task-autostart.md)，协议归 [HTTP §10.94](../api/http-command-contract.md#1094-周期定时启动任务2026-10-18-源码实现迁移-0115)。

**入口。** 侧栏次级导航第 5 项「定时任务」（`/scheduled-tasks`），图标 `CalendarClock`；列表与新建共用同一路径，新建走 `?view=create`，与 `/tasks?view=create` 的既有约定一致。详情页 `/scheduled-tasks/:id` 的导航项按路径前缀保持选中，面包屑为「工作空间 / 定时任务 / 定时任务详情」。

**列表页。** 七列：定时任务（标题 + 本地时刻与时区）、项目、重复、下次触发、已执行 `runs_started / max_runs`、状态、操作。下次触发按**任务自身时区**格式化，不按浏览器时区——否则「每天 09:00」会显示成别的钟点。行内操作按状态派生：启用中显示「暂停」与「停用」，已暂停显示「继续」与「停用」，已停用/已到期不显示停用。列表顶部固定一句范围说明：只在应用运行期间生效，关闭后不会触发，错过的时段只形成一条待处理。

**新建页。** 字段顺序按「先决定做什么、再决定什么时候做」：项目 → 定时任务名称 → 每次任务标题 → 每次任务目标 → 验收标准（每行一条）→ 重复规则（按天「每隔几天」/ 按周勾选星期几）→ 首次日期 / 本地时刻 / 时区 → 最多启动次数 / 授权到期。时区默认取浏览器时区并给候选列表，但可以改。创建前在本地校验：至少一条验收标准（否则任务无法就绪）、首次日期与时刻格式、次数 1–100、到期可解析。

**草稿与结果未知（DEV-0095 / DEV-0096，2026-10-21 源码与组件回归已完成，未做真实桌面复验；2026-10-22 补齐 HTTP 5xx 分类）。** 字段改动后登记既有 `DraftGuard`：侧栏、页内返回/面包屑、顶栏前后退与窗口关闭走同一离开确认，选「保留并继续编辑」回到原字段；异步落位的默认项目只修补比较基线，不把干净表单误判为已修改。未采用本机草稿存储，跨重启恢复不在本切片范围。提交时一次生成并冻结 `command_id`、完整载荷与发起时的 API/Workspace；响应丢失或无法核对时表单与创建按钮锁定，显示原 ID，只提供「查询原命令回执」，以及回执 `COMMAND_NOT_FOUND` 后的「按原 ID 和原内容重试」。回执必须核对命令类型、定时任务与项目；待核对期间切换连接不解锁，切回原连接才可核对，创建页在连接 epoch 变化时保持挂载（与 `/tasks?view=create` 同一保留规则）。「结果未知」不当作失败，也不替换原身份。

**哪些错误算结果未知（三页共用，DEV-0096 / DEV-0123）。** 判定只用 [`needsReceiptCheck`](../../apps/workbench/src/lib/liveErrors.ts) 这一个 Owner：传输失败、HTTP 5xx、`retry_action=CHECK_RECEIPT_THEN_RETRY`，以及非 `RelayApiError` 的本地异常（含 2xx 正文无法按契约核对）都算未确认，必须保留原 ID 与载荷并锁住普通按钮。**不能反过来判**：`describeLiveError` 的 `kind` 只用于文案，5xx 会被归成 `unknown`，早期按 `kind === "transport"` 判定曾把已可能入库的 500 当明确拒绝解锁（独立验收反例 `output/ledger-acceptance-20261022-http500-probe.tsx`）。只有服务端明确业务拒绝（如 422、409 版本冲突）才解除锁定，修正后可生成新命令。

**列表状态与详情时段处理（DEV-0123，2026-10-22）。** 「暂停 / 继续 / 停用」与「补跑一次 / 忽略」沿用同一套冻结与核对：提交前记下 `command_id`、`expected_revision`、目标 ID、动作与发起时的 API/Workspace，结果未知时页内显示冻结的原 `command_id` 与「核对原命令回执」，同页其它普通按钮一律禁用；回执按命令类型与确切对象（定时任务 ID 或发生 ID）核对，不匹配就留在待核对。待核对期间离页走同一 `DraftGuard`（本页没有可丢弃草稿，只有未决命令）。

**详情读取失败就地重读（DEV-0124，2026-10-22）。** 首次读取失败不再只剩「返回列表」：错误页保留原因与「重新读取」，按当前确切 ID 重发同一次 GET，成功即就地渲染详情，期间零写命令。403/404 仍如实显示不可见，不保留失权正文。

**详情页。** 上半部是「设置与授权」：项目（归档时标注）、状态、下次触发、已启动次数、授权到期、每次任务标题与目标、验收标准。下半部先列「待处理的触发」（只列 `BLOCKED`），每条给「补跑一次」与「忽略」；再列「触发历史」：时段、结果、任务/执行链接、说明。说明把已知原因码翻成中文（执行次数已用尽 / 授权已到期 / 应用关闭期间错过 / 上一轮任务还没有验收），未知原因码原样显示，不假装成成功。

**为什么列表要显式写「上一轮未验收，本轮不启动」。** Run 完成后 Task 进入等待验收，本轮时段会被记「已跳过」。这不是故障，而是产品规则：不自动代答验收，也不堆出一串待验收任务。文案必须让用户能预期这件事，否则会以为定时任务失效了。

**状态语义。** 「暂停」与「停用」都只是不再产生新的触发，**不取消已经启动的执行**；已启动的 Run 走原控制入口。`EXPIRED` 的计划不能直接「继续」，须先编辑延长授权——界面不给这个按钮，避免用户以为点一下就能复活已用完额度的计划。

**通知。** 待处理的触发走既有 `InterventionNotifications` 通道（`kind='SCHEDULED_TASK_BLOCKED'`），点击跳到 `/scheduled-tasks/{id}`；不新开第二条轮询，也不与 N05 提醒混用去重键。

**未验。** 真实 Windows/WebView2 窗口、多 DPI、安装态与多实例并发未点验；`navigation.spec.ts` 已复跑确认新增第 5 项不破坏既有选中语义，但没有为窄屏抽屉单独补定时任务的选中用例。

## 38. 历史消息内容块的呈现（2026-10-19）

用户指认「美化一下 agent 的历史消息」：一条回复里同时有普通文字、可复制文本块、运行命令、更改文件、运行工具等多种内容，此前分别落在朴素 `pre`、一串「·」分隔的统计文字和纯文字 diff 行上，观感与语义都不成体系。本轮只统一**呈现**，不改任何事实来源与口径。

**一档共享的可复制文本块（§38.1）。** 新组件 `components/MessageCodeBlock.tsx`：外框细线 + `bg.subtle` + `radius.control`，顶行左侧是等宽来源标签（语言，或「工具 · 目标」），右侧是一枚复制键；正文 `<pre><code>` 逐字保留，块内滚动（上限 18rem，可按调用方覆盖），长串允许任意折行。三处历史消息内容共用它：

| 场景 | 顶行标签 | 入口 |
|---|---|---|
| 模型回复里的代码 fence | fence 信息串第一个词（小写），无标注时「代码」 | `SafeMarkdown` 新参数 `codeCopy`（默认 false；文档预览等阅读面保持朴素 `pre`） |
| 工具回执（读取/检索结果） | `工具名 · 目标路径` | `ExecutionTrajectorySummary` 展开的「本次读取结果」 |
| 命令输出 | 随工具回执同一档（`run_check` 的 stdout 即 result_ref 正文） | 同上，不另造第二种块 |

复制是纯客户端剪贴板动作：不新增命令、不落库、不把「已复制」说成已保存事实。成功后按钮变 √，并在共享浮层给一条「复制成功」短回执（固定定位、不进文档流，不推走正文），2.4s 后按钮自行还原；失败只把按钮还原成可重试（`复制失败，可重试`），不发成功回执。没有剪贴板能力时按失败处理，不谎报成功；换一段正文即还原按钮。顶行恒定在场——没有标签时只剩右端一枚键，复制入口不消失。

**调用统计改标签行（§38.2）。** `ExecutionTrajectorySummary` 顶部由「读取/检索 3 次 · 写入 1 次 · …」改为一类一枚的 `.execution-count` 徽牌（细线 + `radius.badge` + caption 档 + 等宽数字），等待原因移到标签行下方，不与计数抢同一行。计数口径（只算已结算、失败/等待/进行中单列）不变。

**文件编辑行对齐同一档观感（§38.3）。** `ChatLocalFileDiff` 的行结构不变（图标 / 状态 / 文件名 / 标签 / 数字 / 说明，`data-phase` 与全部 `data-testid` 原样保留）：手写 `✎` 字符改为 lucide `FilePen`（与全仓图标同一来源），路径与数字改等宽，行加 `radius.control` 内边距，「预览」从纯文字升级为细线徽牌，与统计标签同一档；不可统计等原因保持纯 caption 文字。数字仍不参与截断、仍有 `visually-hidden` 可访问名（设计系统 §9.15）。

**边界。** 不语法高亮、不改 `result_ref`/`arguments` 原文、不在块内截断后冒充完整（超限只滚动并另行说明还有多少行）；展开的冻结前后文本对照（`FileWriteFrozenDiffPanel`）是独立比较面，不并进这一档。零新增 token、零新增色值。**Breaking Change：No。**

### 38.4 段落与列表的边界：列表必须能打断段落（2026-10-20 用户截图，已实施，实机未验）

用户问「AI 回复的消息还有没有什么问题」。实机那条回复里「**当前状态：**」换行后是四行
`- 分支：main` / `- HEAD：119f51dc` / `- 未暂存改动文件很多…` / `- 未跟踪文件也有不少…`，
界面却渲染成「当前状态： - 分支：main - HEAD：119f51dc - 未暂存改动文件很多（未提交工作量大）
- 未跟踪文件也有不少（新功能模块：memory、plugins 等）」一整行流水账；上一条回复的
「具体场景：」同样被吞成一行。

- **根因**：`SafeMarkdown` 的段落收集循环只在空行、标题、fence 与表格处断开，**列表行不在
  断开条件里**，于是被 `paragraph.join(" ")` 并进上一段。模型最常写的「一句话 + 紧跟列表」
  （中间不留空行）因此永远显示成一行，`- ` 变成句子里的破折号。
- **修法**：把列表行判据提成模块级 `BULLET_LINE` / `NUMBERED_LINE`（与顶层块识别共用同一对
  正则，避免两处口径漂移），段落循环遇到列表行即断开，列表照原块渲染成 `ul` / `ol`。
  纯段落里的续行不受影响——只有真正的列表标记才打断。
- **验证**：`tests/safeMarkdown.spec.ts` 新增「段落与列表的边界」3 例（无空行的无序列表、
  有序列表、纯段落不误断），修前 2 红、修后 **19/19**；使用同一渲染器的 `readingPresentation`、
  `taskDetail`、`knowledgeCaptureLayout` 复跑见验收表。

### 38.5 回复正文的排版（2026-10-20 用户「我想做好看的回复」，已实施，实机未验）

用户要求把那条 AI 回复「复现一下」，并用合适的 skill 把回复做好看。复现方式是真实协作页
（1270×694、API 全部 `page.route` 伪造）跑同一段正文，改前改后同脚本截图。量到的现状与改法：

| 项 | 改前 | 改后 |
|---|---|---|
| 回复正文 | 18px / 行高 1.8（`reading` 档） | 16px / 行高 1.7（`body` + `lineHeight.relaxed`） |
| 与用户消息的关系 | 用户 16px、AI 18px，同屏两种正文档 | 两档统一 16px |
| 无序列表记号 | 空心圆（`circle`）+ 16px 缩进 | 实心点（`disc`）+ 16px 缩进，记号色 muted |
| 有序列表 | 序号顶到正文左缘、与文字之间没有缝 | 缩进 24px（`space.6`），序号与文字各归其位 |
| 块间距 | 统一 8px（`space.2`） | 统一 12px（`space.3`）；列表项之间 4px |
| 强调 | UA 的 700 | `semibold`(600) |
| meta 行 → 正文 | 4px | 8px（`space.2`） |
| 引用块 `> …` | 不支持，`>` 原样显示成正文 | `blockquote` + 2px 竖线 + `text.secondary` |
| 行内代码 `` `x` ``（2026-10-22 DEV-0109 接续） | 与正文同色同底，只靠等宽字形区分 | 行内底色 `bg.subtle` + `radius.control` + 左右 `space.1`，**文字仍 `text.primary`** |

- **为什么是 16px**：设计系统 §4 把「控件与业务正文」定为 `font.size.body`，`reading`(18px) 是
  知识库/论文这类长文阅读面。2026-10-16「聊天区的字号减小 2px」当时只落在纯文本外壳
  （`.assist-message-content`）上，Markdown 回复一直吃 `.markdown-preview` 的 reading 档，
  于是同一屏出现两种正文档。行高取 `lineHeight.relaxed`(1.7)，16px 的中文成段仍有气口。
- **为什么记号是空心圆**：消息列表本身是 `<ul>`，Markdown 列表落在第二层，Chromium 对第二层
  `ul` 默认用 `circle`；显式写 `disc` 才稳定。有序列表多给一档缩进，是因为「1.」这种两位
  记号在 16px 缩进里挤不出缝隙。
- **引用块**：`SafeMarkdown` 新增 `quote` 块（连续 `> ` 行并成一段，不展开嵌套），渲染成
  `blockquote.markdown-preview__quote`（左侧 2px `border-control` 竖线 + `text.secondary`，
  不加底色，避免与代码块抢同一档「块」）。与列表行一样，引用行能打断段落。
- **2026-10-22 DEV-0109 接续（用户「ai回复怎么都是一个颜色？是因为其他情况还没有出现吗？」）**：
  先把事实说清——**回复正文本来就是一种颜色**，标题、加粗、列表全部走 `text.primary`，层级由
  字号与字重说出（[设计系统 §4 字体与排版](design-system.md#4-字体与排版)），会变的颜色
  全是**状态**：生成失败（`action-error`）、状态词（`text.muted`）、引用块（`text.secondary`）、
  链接（`action.text`）、代码块（`bg.subtle` 底）、列表记号（`muted`）、待确认提案（`status.warning`）、
  生成中草稿块。用户截图那条是正常完成、正文里没有引用块也没有链接，所以只剩一种正文色——
  **「其他情况还没出现」这句大体成立**。但核对代码后有一处不属于「等情况」：行内代码此前只被
  `.markdown-preview code { font-family; font-size }` 命中（`src/styles.css`），**与正文同色同底**，
  文件名、命令、路径这类高频行内代码只靠等宽字形区分。本轮补一档行内块：
  `.assist-message-markdown .markdown-preview :not(pre) > code { padding: 0 space.1; background: bg.subtle;
  border-radius: radius.control }`——底色与代码块/用户气泡同一档 token，**文字色不变**（层级由底色说出，
  不新增第五种文字色），`:not(pre) > code` 保证消息里的可复制代码块（`.msg-code-body > code`）不叠第二层底。
  **只落在回复正文这一处**：资料、知识、任务详情那几个阅读面本轮未动，避免一次改四个阅读面。
  验证：`tests/browser/replyTypography.spec.ts` 第三条（真实 Chromium 读计算样式：底色非透明且等于用户气泡底色、
  `color` 等于段落色、左右内边距 4px、圆角 8px、列表项内同样生效、代码块内部仍透明）**3/3**，
  A/B 去掉该条规则即红；截图 `output/dev-0109-screenshots/assistant-reply.png`（改前即用户工单附图）。
- **未改（复现结论，等用户决定）**：同一条回复里「已在受管根目录创建 aa.md」与「文件已提交为
  执行候选，待系统执行阶段写入磁盘」自相矛盾。这是提示词缺口而不是渲染问题——候选分支
  （`conversationExecutionOutputLines(false)`）只约束 `execution` 字段，没有约束 `reply` 的措辞；
  只有直写分支写了「写入结果以工具回执为准」。改它要动提示词并重跑真实 Provider。

验证：`safeMarkdown` **21/21**（新增引用块 2 例）；与 `readingPresentation`＋`taskDetail`＋
`knowledgeCaptureLayout`＋`assistantModeSwitch` 合计 **105/105**；真实 Chromium 对照见
`output/ui-zoom/reply-before-after.png`（1270×694、伪造 API）。真实 Windows/WebView2 未目视。

验证出口：`tests/messageCodeBlock.spec.tsx`（标签、逐字保留、无标签时键仍在、复制成功/失败/无剪贴板）、`tests/safeMarkdown.spec.ts`（默认朴素 `pre`、`codeCopy` 升级、无语言标注）、`tests/executionTrajectorySummary.spec.ts`（回执块顶行与正文、统计标签）；`chatLocalFileDiff`、`executionSummary`、`readingPresentation` 无回归。观感截图 `apps/workbench/results/history-message-blocks-2026-10-19.png`（一次性静态预览，页面已删）。真实 Chromium 消息流与 Windows 窗口未复验。

**第二轮（同日深夜，用户「应该还有其他 UI 元素吧？继续开发」）**：把同一档语言铺到消息流里其余仍不成体系的块，口径与事实来源继续不动：

1. **来源条逐行化（§38.4）**：`assist-source-summary` 展开区由「引用 · AVAILABLE · 打开来源条目 · reason」的「·」串改为行式排版——引用是主文字（`text.primary`，可任意折行），状态收进与统计标签同族的细线徽牌并**翻成中文**（AVAILABLE→可用、UNAVAILABLE→不可用，未知枚举原样回显、原文挂 `title`，不编造解释），reason 是 muted 说明；不可用行整行降为 `text.secondary`。摘要行（「已读取 N 份资料 · 生成候选完成」）不变。
2. **等待批准升 attention 档（§38.5）**：调用统计里「N 项等待你批准」是唯一要求用户动手的类别，徽牌加 `data-tone="attention"`（琥珀细线 + 琥珀文字，与任务提案 PENDING 态同一状态色来源）；「打开审批入口批准或拒绝这次动作」由灰说明行升级为琥珀细线行动块（`.execution-waiting`）。计数与审批定位口径（operation_id 对齐、找不到退回原审批页）不变。
3. **生成中草稿收进浅底块（§38.6）**：`assist-live-preview` 由「灰说明行 + 裸文本」改为一张 `bg.subtle` 浅底块（`.assist-draft`），说明行 caption 档置顶，草稿正文仍纯文本不提前渲染 Markdown——块会被最终回复整体替换，不加重结构。
4. **候选卡状态徽牌（§38.7）**：`AssistCandidateCard` 的状态词（待确认/已接受/已拒绝/已失效）收进同族徽牌，PENDING 用琥珀档；「查看候选」仍是非交互指引（候选卡的接受入口在提案区，用例锁「卡内无按钮」不变）。

验证出口：`executionTrajectorySummary` **8/8**、`executionSummary` 与 `folderFirstConversation` 全绿、`collaborationWorkspace`「AI 消息内按正文、来源条、候选卡的顺序」**通过**、`assist-preview` 草稿相关用例通过（该文件余 1 例失败为并行会话的 `assist-session-select` 缺失，与本轮无关）；`tsc --noEmit` 本轮路径零报错。观感截图 `apps/workbench/results/history-message-blocks-round2-2026-10-19.png`（一次性静态预览，页面与脚本用后已删）。真实 Chromium 消息流与 Windows 窗口未复验。**Breaking Change：No。**

## 39. 排队消息的插话手势（2026-10-19 已实施）

2026-10-20 接续：连续插话保留全部原文，相关补充累积、冲突要求由后文修正、明确换目标才替换；临时提问不自行取消原目标，关系不清且影响执行时澄清。服务端在工具派发边界先停止未执行批次并重新判断，已执行结果保留，不代表已回滚。具体语义、时序和未验边界归[运行架构 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。本轮不新增交互控件，也不改变插话命令回执只代表「已请求」的含义。

运行中发送的消息照旧进队列（服务端 `PENDING`，等这一轮结束）；本节补的是队列的**第二种出路**：把它并入正在生成的那一轮。上游依据与上下文位置归[运行时上下文 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)，命令归 [HTTP §10.102](../api/http-command-contract.md#10102-排队消息的插话2026-10-19-源码实现)。

### 39.1 两个动作与手势

| 手势 | 条件 | 结果 |
|---|---|---|
| Enter（有正文） | 任意 | 原样发送；在途时按既有路径排队，行为逐字不变 |
| Enter（空草稿） | 正在生成 + 队列非空 + 没有待上传附件 | 对队列里**每一条可插话的项**发一次 `SteerAssistMessage` |
| 「插话」按钮（队列每行） | 同上，且这一条不带图片 | 只对**这一条**发命令 |

空草稿的 Enter 在插话条件成立时不再是一次空提交——这是它唯一新增的含义；条件不成立时保持原行为（独立形态提交表单，嵌入形态不响应）。判定集中在 `canSteerQueue`：`!busy && pending === null && writeBlockedReason === null && draft.trim() === "" && 暂存附件为空 && 可插话队列非空`。

### 39.2 队列面板的措辞与状态

- 摘要是「等待中 · N 项，当前回复生成中」，与既有读法一致（有 `RUNNING` 才构成队列）。
- **2026-10-20 用户指认后收敛**（「弹层里不放整段说明」的同一条纪律）：面板只承担事实与动作——一行摘要 + 每行一项。说明句整段移出可视层，由面板原生 `title` 承担，仍按「有没有可插话项」分两句；摘要行右侧保留一枚短标签「输入框为空时按 Enter 插话」（仅有可插话项时出现）——手势必须可见，解释不必常驻。
- 每行是「位置 · 原文 · 动作」一段中轴：位置（第 N 项）与原文单行省略，动作用文字键（`text-button`）而非描边按钮，行高与工具行同档；底色改一档 selection（sage），与白底输入卡同列分层——队列是「进行中的临时事实」，不与输入卡同重。
- 已请求插话、生成方还没消费的那一项显示「插话待生效」，不显示「插话」按钮（避免重复点），取消入口保留。它不是完成态：消费与否由服务端状态决定，界面不提前宣称「已并入」。
- 回执文案是「已请求插话：生成方会在下一次模型请求前把这条并入当前回复」，不说「已并入」。传输失败时说「已受理 N 条；下一条结果未核对」，不自动重发。

### 39.3 边界

- 带图片的排队消息不给插话入口：插话通道只送用户原文，图片会被丢掉，服务端也按类型化原因拒绝。
- 不新增浮层、不新增 token、不改输入卡几何；`data-testid` 新增 `assist-queue-steer-<n>`、`assist-queue-steer-pending-<n>`，既有 `assist-queue-*` 原样保留。
- **Breaking Change：No**（只增命令与只增只读字段 `steer_requested`；旧服务端缺该字段时客户端读成 false，队列行为与旧版一致）。

验证出口：`tests/assistQueueSteer.spec.ts`（空草稿 Enter 只发插话、有正文时 Enter 仍发送、每行按钮走同一命令）。真实 Chromium 与 Windows 窗口内的手感未复验。

## 40. 长短期记忆（2026-10-20，产品行为已确认，前端已接，实机未验）

用户确认普通聊天自动召回已确认长期记忆，并可关闭；完整后端模块完成后统一交付前端任务书。长期 Memory 与会话短期摘要分别呈现，摘要不显示为已确认事实，不承担 Project State、Task 完成、权限或工具恢复。

- 设置提供 Workspace 级「自动使用已确认记忆」「自动整理会话历史」，初始状态必须读服务端；修改携带配置修订，409 重读后由用户决定。关闭自动整理不禁止手动整理，关闭长期召回也不能让已引用内容从旧答复/摘要匿名回流。
- 普通会话消息提供明确的「保存为长期记忆」入口：先读确切原文，展示并允许编辑标题/内容，明确选择全局或原会话项目，用户确认后才发送原消息 SHA256 与会话修订。默认不自动从对话提取或保存；来源失效、原文不符、范围变化明确说明并保留草稿。
- 会话控制区提供「整理记忆」「清除工作记忆」「记住本会话」；复用现有信息层级，不重做聊天排版。无摘要、读取中、有效摘要、失效摘要、整理排队、整理中、取消中、失败分别显示。202 只表示受理，完成以 GET 状态为准；取消 RUNNING 只代表请求停止，不能立即标为已取消。
- `/compact` 与 `/压缩` 选择时只插入草稿，发送后走原 chat-commands 新增整理分支。原 `/clear`、`/new` 继续新建会话；清除工作窗口为独立明确动作，不能偷换两者语义。
- 清除只影响以后发送给模型的窗口，保留可浏览原聊天和工具历史，也不删除长期 Memory。记忆关闭时只采用当前用户输入，明确显示一次性状态；重新开启从新边界开始，关闭期间的轮次不自动并回工作窗口。有在途消息/整理时按服务端拒绝，不靠 UI 清空代替安全结束。
- 消息记忆来源入口可读直接/传递来源、确切版本及 checkpoint；未记录显示未知，不能补成「未使用」。失效时不缓存回显旧摘要正文，换 Workspace/会话、取消读取或迟到响应不污染当前视图。长期有效/过期/停用管理沿 §13.3，不重复建设。

接口、字段、状态码、限额与兼容语义只归 [HTTP §10.99](../api/http-command-contract.md#1099-长短期记忆接口2026-10-19)；实现边界归 [ADR-028](../decisions/ADR-028-memory-layers.md)。

前端接线（2026-10-20，任务书 `prompts/memory-module-frontend.md`）：

- **client 单入口**：新增 `api/dtos/memory.ts`、`api/parse/memory.ts`、`api/resources/memory.ts`，由 `relayClient` 门面暴露；九条端点各自严格解析布尔、UUID、十进制修订与枚举，缺失或未知取值显式失败，不回落到 `false`／空数组。`/compact` 与 `/压缩` 走 `resources/chatControls.ts` 的 `compactAssistSession`，与 `/clear`、`/new` 共用 chat-commands 通道但**不**共用语义。
- **设置**（`components/MemorySettingsCard.tsx`，挂在「AI 设置」页模型端口之后）：两个独立开关，初始值读服务端；保存同时提交两个开关与读回修订（整行 CAS，只带一个会把另一个写成默认值）；409 重读基线并**保留草稿**，由用户选「按最新修订保存」或「丢弃改动并重读」；传输失败保留原 command_id 与载荷，只给「查询原命令回执／按原命令重试」，回执类型不是 `SetMemorySettings` 时明确拒绝。
- **保存为长期记忆**（`components/SaveMemoryDialog.tsx`，入口在已完成且有正文的消息行）：打开时**重读原消息**而不是用界面上的旧文本，标题取首行可改、正文可改，范围只有「全局／原会话项目」（会话无项目时项目项禁用并说明）；提交的 `content_sha256` 恒为**原消息正文**的 UTF-8 SHA256（`lib/sha256.ts` 纯实现，不依赖 `crypto.subtle` 的安全上下文），编辑草稿不改变来源；成功后重读服务端 Memory 与 provenance 再展示；409 保留草稿要求重读来源；传输失败保留原命令与载荷。
- **会话记忆面板**（`components/SessionMemoryPanel.tsx`，位于队列之后、输入卡之前，仅有效普通 Agent 会话）：四态可辨——无摘要／有效摘要（含覆盖边界、来源条数、非已确认事实声明）／摘要失效（不回显旧正文）／读取失败（与「没有摘要」分开，并标注下方是过期读取）；整理记录显示排队／运行／取消中／完成／失败与 typed error 中文原因；202 受理后按 request_id 每 2 秒读回、终态停止、超过约两分钟停止轮询并说明；取消 RUNNING 只说「已请求停止」；清除需二次确认并写明不删除聊天／工具历史／长期记忆，在途时展示服务端拒绝；一次性开关成功后回调上层重读会话修订。
- **消息足迹与长期来源**（`components/MessageMemorySources.tsx`）：AI 回复展开才读 `GET …/messages/{id}/memory`，`recorded=false` 显示「未采集」、`available=false` 显示来源已失效，二者都不写成「没有使用记忆」；资料页记忆详情展开「保存来源」，手工创建的空来源如实说明。
- **未决命令**：设置、保存、整理／清除／一次性五处都把「响应丢失」与「明确失败」分开；前者保留原 command_id 与原载荷，只允许查回执或原样重试。

验证与未闭合项见[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「长短期记忆前端接线」行；真实浏览器链路、Windows/WebView2、安装态与真实 Provider 摘要质量需各自取证，不能用本轮 jsdom 证据代替。

自动捕获（2026-10-20 用户确认方向，**已接前端、集成未验**）：用户指认「长期记忆应该是自动保存有价值的内容而不是手动」，并否决了「候选 + 一次确认」（「要人手动确认感觉很麻烦」）。方向定为[ADR-030](../decisions/ADR-030-zero-click-auto-memory.md)：结算后提取并直接写入 Memory，`origin = AUTO_CAPTURE`、`confirmed_by = auto-capture`，参与召回但同等相关度下排在人工确认之后，**没有待确认队列**。前端只做三件事：设置页第三个开关「自动记住有价值的约定」；资料页记忆列表与详情标「自动记住」并写明确认方不是人；消息来源与足迹对自动记忆标「自动记住」。撤销就用既有的「停用记忆」，**不新增常驻面板、不收件箱、不加角标**。现有手动保存入口保留，两者并存。真实 Provider 的误报率与真实 PG 行为未验，不能把「自动记住」写成「已确认」。

来源类别与判断主体（2026-10-21，[ADR-032](../decisions/ADR-032-memory-source-kind.md)）：**是否生成这条记忆由系统判断，不逐条问用户**——设置页第三个开关是总闸（默认开），人工只保留事后停用某一条与整体关掉。自动记住的条目要标出「这句话是谁说的」：引用用户原话的标「用户原话」，引用助手叙述的标「模型观察」（可能含工具结果或网页正文的转述，不能当成你的偏好或授权），来源未知的标「来源未标注」。资料页记忆列表、记忆详情与消息来源三处一致；旧服务端缺该字段时按「来源未标注」读，不猜。

### 40.1 聊天里的记忆 UI 全部移除（2026-10-20 用户指认，已实施，实机未验）

用户在聊天页截图上圈了四处并写「删除方框里面的 ui」。四处是同一族东西——**消息级的
「保存为长期记忆」「记忆来源」，以及输入卡上方的「会话记忆」控制带**。它们回答的都是
「记忆这件事」，但常态只有一个「无摘要」徽牌，占着发送前最后一行与每条回复的末尾。

- **移除的渲染点**：`AssistMessageRow` 的 `.agent-message-memory-actions`（用户与 AI 消息各一次）
  与 `MessageMemorySources`；`AssistSessionPanel` 里队列之后、`ExecutionSummary` 之前的
  `SessionMemoryPanel`；以及随它们一起失效的 `saveMemoryMessageId`、`memoryRefreshToken`
  两个状态与 `onSessionReload` 回调（后者只服务面板的一次性开关）。
- **不动的部分**：服务端的自动捕获、召回、摘要与 `GET /assist-sessions/{id}/memory` 全部保留；
  `/compact`、`/压缩` 仍是同一条命令（受理文案改为「以服务端整理记录为准」，因为面板不再读回）；
  `/clear`、`/new` 语义不变；设置页「自动使用已确认记忆」「自动整理会话历史」「自动记住有价值的
  约定」三个开关与资料页的记忆列表/保存来源照旧。
- **组件与单测保留**：`SessionMemoryPanel.tsx`、`SaveMemoryDialog.tsx` 与
  `MessageMemorySources` 的默认导出暂时没有渲染点，但文件、样式与各自的单测（`sessionMemory` 13、
  `saveMemory` 11）都留着——它们是当天刚写、尚未提交的工作，删掉就找不回来；恢复入口只需在
  `AssistView` 里接回一行。`MemoryProvenancePanel` 仍被资料页使用。
- **回归守卫**：`tests/assistMemoryView.spec.ts` 改写为「移除后的守卫」——聊天页不渲染这三处、
  不预读 `…/memory`（读取计数为 0），`/compact`、`/压缩`、`/clear` 的命令路由不变。

## 41. 日常操作减负：工具状态与高级配置分层（2026-10-20 已实施，实机未验）

用户诉求是「普通 Agent 操作不该要求我理解并逐项配置底层能力、连接、受管资源和策略」。本轮只做「把日常层与高级层分开、把缺口说清楚」，不新增第二套授权机制，也不删任何已确认能力。

**连接页（项目设置 → 连接与权限）**

- 顶部新增「可以用的工具」：一行一个用户真正要用的东西（本机文件 / Git 只读 / 网页抓取 / 命令行 / 电脑操控 / 浏览器操控 / GitHub），状态只读服务端已返回的连接与策略快照。**「已连接」与「已授权」分开**：有 ACTIVE 连接但没有非拒绝策略时写「已连接，尚未授权」；连接停用/撤销分别如实标注；未配置时给一句「去哪儿补」，不要求先懂能力键。
- 原来的三段逐动作表单（新建连接、登记受管目录、新建权限策略）整体收进「高级：逐动作配置」，默认收起。列表、只读健康核对、撤销与回执核对全部留在里面——「检查实际配置与撤销状态」的能力没有搬走，只是不再挡在日常操作前面。
- 测试能力 `FAKE_WRITE` / `FAKE_PUBLIC_READ` 不再出现在普通下拉里；只有地址带 `?dev-capabilities=1` 时才放进选项（显式开发入口）。历史策略若引用了测试能力，选中修订时仍能回填，不会被这条限制弄坏。
- 日常路径本身没有新机制：打开目录 → 应用建立读取配置（HTTP §10.86）→ 在会话里直接读；写档位仍在输入器的权限芯片里切换。

**会话「+」菜单 → 连接器 → 内置插件**

- 点电脑 / 浏览器 / GitHub 只把 `@电脑操控 ` / `@浏览器操控 ` / `@GitHub ` 插进当前输入框（DEV-0099，2026-10-21）：按光标位置插入、替换选区、句首不补前导空格，随后收起菜单；只编辑草稿，不发送消息，也不授予任何能力。连接状态仍显示在行尾（已连接／部分已连接／已停用／已撤销／未授权）。
- **取代 2026-10-20 的原地插件详情**：运行环境诊断与本项目授权的两行详情不再在这个菜单里出现，授权管理归面板底部「管理连接与权限」→ 当前项目的连接页。没有项目归属时仍可直接插入 mention；运行时状态接口 `GET /plugins/status` 保留，本菜单不再读取。

**Git 只读**

- 打开 Git 仓库根目录时，Git 的 status / diff / log 随目录授权自然成立（HTTP §10.103），不再要求手工建 `GIT_READ` 连接与三条策略；stage / commit / push 仍不开放。
- 打开的是仓库子目录时，细条上出现「Git 只在仓库根授权」，更换目录浮层里说明原因并提供「在仓库根打开」——是否扩大作用域由用户点这一下决定，不自动切换。撤销、停用或历史规则存在时只报告，不自动恢复。

**保存失败的呈现（写入档位、默认视图）**

- 结果未知时先由程序核对一次同一条命令的回执：查到就是已保存，芯片直接读回重读到的档位（2026-10-22 同日第二轮指令后不再另写一句「已生效」）；查不到才把「重新核对 / 重试保存」交给用户。
- 用户看到的是「正在核对是否保存成功」「保存结果还没确认」，命令标识、原修订与目标档位收进可展开的「诊断信息」。原 ID 与原载荷在核对期间保持冻结，重试仍发同一份请求对象。

**移除的占位入口**

- 「+」→ 资料里的「选择本地文件」已移除：桌面宿主只有目录选择器，这一行没有真实去向。需要本机文件时走目录与检索；本地文件附件仍是待实现需求，记录在本文 §32 的未接入清单，不靠一个禁用行承载。
- 设置 → 执行策略里两行「暂不可用」（界面语言、通知偏好）合成一句说明：语言偏好仍缺读写接口，通知规则已确认但暂不可修改。不再摆两个不能操作、也没有下一步的设置项。

验证：`tests/connectionsSettings.spec.ts` 24/24（含日常工具状态、FAKE 只在开发入口、高级区默认收起）；`tests/composerAttachMenu.spec.tsx` 31/31（含插件插入 mention；本轮复跑）＋ `tests/settingsView.spec.ts`（占位行移除、执行策略文案，前轮）；`tests/writePermissionTier.spec.tsx` 14/14、`tests/viewConfiguration.spec.ts` 6/6（自动核对与诊断折叠）；后端见 HTTP §10.103 / §10.104 的验证段。真实 Windows/WebView2 窗口、多 DPI 与真实 `gh` 登录态未目视，属未验范围。

### 41.1 实机走查后的导航与处理减负（2026-10-21 已实施，Windows 实机未验）

执行范围归[日常减负任务书第三轮](../../prompts/product-complexity-reduction.md#第三轮真实-windows-操作阻力整改提示词2026-10-21-已实施windows-实机未验)。下列五条按 R3-01～R3-05 实施，写的是当前产品行为；授权、版本绑定与协议不变，成绩只归统一验收表。

- **插件配置保留范围（R3-01，已实施；DEV-0099 后修订）。** 管理入口是连接器面板底部的「管理连接与权限」：按当前会话作用域站内导航到 `/projects/{id}/connections?from=`，连接页校验后给出「返回原会话」；没有项目归属时落到全局挑选页并续传 `from`。插件行本身改为插入 `@标签 ` mention（DEV-0099），不再逐插件带 `tool` 参数跳转。状态展示与授权仍分开，不因查看、跳转或插入 mention 授予能力。
- **新对话目录语义一致（R3-02，已实施）。** 还没有持久化会话时，顶栏读「本次已选目录」并挂出「发送后绑定／未就绪／待确认」，与输入卡上方细条同一事实，不再一处已选、一处尚未绑定。这一份目录是只读投影，不参与准入，也不提前创建会话；是否持久化及真正准入仍由原 Owner 决定。
- **待处理先说事项（R3-03，已实施）。** 通知浮层在汇总入口之外逐项列出真实标题、翻译后的原因与直达原请求的链接；待处理队列卡片按「对象名称 → 你要做什么 → 下一步（一个主入口）」排列。枚举与原因的中文读法唯一出自 `lib/labels`，编码、UUID、修订号和未决 Operation 收进「技术细节」折叠。同一请求跨组出现时两处互相说明是同一条，计数口径与「读取不完整」提醒不变；项目名读不到就写「暂不可读取」，不拿 ID 冒充名字，也不从聚合页批量批准或跳过版本核对。
- **长正文可定位决定区（R3-04，已实施）。** 待处理页首屏在列表上方提供「查看判断条件 / 前往决定」，只滚动并把焦点落到对应区块（焦点环沿用全局焦点 token），不代替阅读、不触发提交；缺对象、版本未确认、读取失败、已过期与示例数据这些闸门一行未改。判断依据逐条改用户语言：布尔读「是/否」、数组用顿号、检查结果与决定复用共享枚举文案，原始键名与 JSON 收进「原始依据数据」折叠，待处理页与协作页共用同一套基座样式。窄窗仍是单列阅读，不改回多列。
- **权限禁用有解释（R3-05，未复现失效，只补覆盖）。** 实机「权限不能点击」经核对是自动化点击方式差异（UIA 索引点击无变化、鼠标坐标点击成功），不是人工失败，因此不重实现。`canChoose` 闸门、状态投影和撤销处理一行未改，不靠默认授权消除阻力；补齐只读投影仍可选、上层拒绝时不假装档位已改、提交中禁用带可见原因与匹配的下一步三组覆盖。

验证：`tests/attentionQueueReadability.spec.ts` 5/5、`tests/interventionNotifications.spec.ts` 与 `tests/reviews.spec.ts` 25/25、`tests/writePermissionTier.spec.tsx` 19/19、`tests/composerAttachMenu.spec.tsx` 29/29、`tests/connectionsSettings.spec.ts` 29/29、`tests/folderFirstConversation.spec.ts` 29/29；真实 Chromium 的页内定位与键盘路径见 `tests/browser/reviewDecisionJump.spec.ts` 3/3（1162×782：决定区原本落在首屏以下约 4330px，一次点击或 15 次 Tab＋Enter 即可到达并聚焦，全程零写命令；折叠的 JSON 不计入可见文本）。Windows/WebView2 桌面窗口、多 DPI、真实授权写入与回执未复验，本节不宣称实机出口。

## 42. 日常减负第二轮：资料、规则、任务起步与记忆呈现（2026-10-20 已实施，实机未验）

用户实机走过「资料 → 新建」「任务 → 新建」「定时任务」「会话记忆」四处，反馈同一件事：**普通操作被底层概念挡住了**。本轮按 `prompts/product-complexity-reduction.md` 第二节（R2-01～R2-07）实施，只改入口层级与谁承担默认值，不动授权、版本绑定与协议。

**R2-01 普通资料新建**

- 新建/追加笔记**只有标题、正文与一个保存动作**。来源类型与媒体类型默认落在 NOTE + `text/plain`，收进可折叠的「来源与收录设置」，需要绑定原件时才展开。
- 收录仪式（人工收录草稿、本次收录内容、对照来源、保存前核对、确认复选框）**只属于 ARTIFACT_VERSION**：来源切到产物版本时才展开，右栏确认区随之出现。普通笔记不再渲染「从标题猜测来源」这类本不需要他理解的说明。
- 保存标签分开：普通笔记是「保存资料 / 保存新版本」，产物收录仍是「确认收录 / 确认收录新版本」——同一个动作在两种语境下说法不同，不能混用。

**R2-02 产物版本选择**

- 产物来源下先给**本项目可收录的版本列表**（标题 · 版本 · 任务 · 时间），点一条即读取该确切版本正文并高亮选中；不再要求用户从别处复制 UUID。
- 「按版本 ID 指定」保留为折叠入口（跨入口带着 ID 过来、或列表读取失败时仍可用），读回正文不因是列表点选就跳过。
- 候选只来自当前项目：服务端只允许同项目产物提升，列别项目的版本等于先给一个必然失败的选项。工作空间级资料没有项目归属，直接说明「到所属项目的资料页收录」，不假装能选。
- 路由带 `?artifact_version=<uuid>` 时预填来源并读一次正文，但**不替用户勾选**「已核对」——确认仍是人的动作。

**R2-03 规则**

- 普通入口只要**规则内容 + 强度**；作用域、规则键、执行检查路径、检查方法、目标约束 JSON 全部收进「范围与执行检查（高级）」。
- 规则键缺省时由服务端生成，形态 `rule-<command_id>`：**按 command_id 派生而不是随机**——同一个 command_id 的幂等重放必须算出同一个键，否则回执的载荷哈希对不上，重试会被误判成「命令被复用于不同载荷」。显式给出的键原样提交，既有跨范围 `rule_key` 引用与 HARD 覆盖判定不变。
- 列表不再把 `rule_key` 当名字：规则行显示陈述首行（截断 60 字），键留在详情与版本历史里核对。

**R2-04 任务起步**

- 「新建任务」默认进一句话登记（`?view=create&light=1`），验收标准、项目、执行方式与依赖不是第一步的前置；「填写完整定义」是同一页的次要入口，不是另一个隐藏页面。
- 空态主按钮与列表主按钮同一语义；一句话登记仍固定以收件箱意图提交，不尝试 MarkTaskReady，也不代填项目。

**R2-05 项目选择器**

- 创建表单打开即加载进行中项目首屏（一次分页 GET），去掉「读取进行中项目」这一用户步骤；失败给「重试读取项目列表」与就地说明，手填项目 ID 仍在「手动查看或指定」里，只作已知 ID 的辅助入口。
- 仍然只有首屏，不在挂载时预取整个项目库；搜索范围与「已加载 N 项」计数照旧写明。

**R2-06 定时任务**

- 名称只填一次：每次任务的标题默认跟随名称，用户改过才独立。
- 首次日期与本地时刻留在主体；时区、最多启动次数、授权到期收进「时区、启动次数与授权到期」折叠，**摘要行始终显示当前时区 / 次数 / 到期**——折叠的是表单，不是授权承诺。三项仍是真实默认值并参与校验，校验失败时摘要行指出「展开后可看到具体原因」。

**R2-07 会话记忆**

- 普通视图只说「会记住什么、摘要覆盖到第几条、有没有摘要」；窗口修订、会话修订、已清除至第 N 条收进「诊断信息」。
- 整理记录、一次性模式、取消、清除与轮询协议未改，纯呈现层调整。

验证：`tests/knowledgeSimplify.spec.ts` **4/4**（普通笔记提交体不带来源选择器、候选点选即读正文、规则省略 rule_key、显式 rule_key 原样提交）；回归 `knowledge`＋`knowledgeCaptureLayout`＋`knowledgeReading`＋`projectKnowledgeGuide` **40/40**、`tasks`＋`liveTasks`＋`taskLightweightEntry`＋`createTaskProjectPicker` **26/26**、`scheduledTasks` **6/6**、`sessionMemory` **13/13**（本轮合计 90/90）；工作台 `tsc --noEmit` 仅剩并行会话未跟踪的 `tests/tmpFlashProbe.spec.ts`。后端见 [HTTP §10.106](../api/http-command-contract.md#10106-规则键可由服务端生成2026-10-20-源码实现)。

**未闭合**：R2-02 的「从产物或版本详情点进来」只在路由层支持（`?artifact_version=`），产物阅读面板上还没有一个「收录为资料」的按钮——那需要面板拿到项目归属；真实 Windows/WebView2 窗口、多 DPI 与窄窗下的折叠观感未目视；真实 PG 未运行，规则键的集成用例（`information.integration.test.ts` 末条）只做了类型检查；未做独立验收。

## 43. 日常工具执行不强制正式交付（2026-10-20 后端已接续，实机未验）

用户确认痛点同时涉及文件工具、浏览器/电脑操作及任务/审批/验收繁琐。默认交互沿“选目录 → 发消息 → 工具工作 → 结果”推进：

- 普通文件编辑与明确 MODIFY 方法在 AUTO/FULL 且写工具可用时同会话直写，不要求用户建任务或填验收表；只审查仍只读。
- 需要审批、运行检查或操作浏览器/电脑时，由原消息的已有自动启动链创建内部执行，不再要求用户另说一遍目标。已成功改动不在后续候选中重复执行。
- 工具权限与连接配置缺失时给具体原因，不要求用户补无关的任务信息。审批继续绑定确切动作；点击“开始”、选择目录或方法名不是批准。
- 普通工具结果报告“改了什么、检查了什么、还差什么”。正式 Artifact 验证、人工接受与业务完成只在正式任务交付时适用，工具成功不冒充 PASS。

本次未新增界面或第二套审批面板。执行轨迹与审批入口复用已有实现；浏览器/电脑逐动作确认数量未在本轮减少。自定义策略的会话待审批恢复、无目录操作会话及真实窗口验收仍未闭合。工程责任与边界归[运行架构 §2.10](../architecture/runtime-context.md#210-日常工具工作与正式交付分层2026-10-20-实施)。

### 43.1 就绪候选由服务端推进；界面只呈现阶段（2026-10-20 第二轮，已实施，实机未验）

上一轮把推进入口留在了本页：读到 `auto_start` 的 READY 投影后由 effect 调
`POST …/applications`。用户指出真正的问题——**关掉页面之后那条已经明确授权的请求还走不走？**
本轮把推进责任收回服务端，界面只负责「说清楚现在到哪一步、卡在哪、要不要你决定」。

- **撤掉「计划执行方式」本设备偏好**（设置 → 执行策略里的下拉，键
  `relay.workbench.planExecution`）。它是同一件事的第二次确认，也是前端必须持有推进责任
  的唯一理由；目录写档位与逐动作审批已经表达授权。遗留的本地键不再读取，也不代为清理。
- **执行摘要不再提供「按这个目标执行」**。`READY`/`TASK_PREPARED` 显示「正在准备执行」，
  `DELEGATED` 显示「正在执行」；正常路径上没有任何按钮。
- **唯一的按钮是「继续原请求」**，只在服务端自动推进失败（阶段 `FAILED`、还没有 Run）
  时出现。失败原因是服务端写回原请求的**具体**一条（缺哪个连接、缺哪个目录、会话已有
  在途 Run），原样显示在摘要里——用户关掉页面再回来仍然看得到，不需要重述目标。
- **内部身份不进日常界面**：`task_id`/`run_id`/`revision` 不再出现在按钮文案里，
  入口改成「查看执行详情」。
- 摘要文案统一为用户语言：「不需要再确认一次：准备完成后会直接继续」「删除会在执行前
  单独请你确认」「文件内容在读取真实内容后决定」。

推进器、失败登记与阶段语义归[运行架构 §2.10.1](../architecture/runtime-context.md#2101-推进-owner-收归服务端与能力事实说明2026-10-20-第二轮)，
投影字段归 HTTP §10.107。仍未闭合：无目录操作会话、普通检查仍随 Run 进入正式验收、
真实 Windows/WebView2 与真实 Provider 未验。

### 43.2 执行摘要的边框盒必须容纳自己的内容（2026-10-20 用户截图，已实施，实机未验）

用户在「正在准备执行」卡片上画箭头指「样式有问题」。实机截图里能看到两件事同时发生：
卡片下边框在「当前目录：…」半行处截断，而「新建 · aa.md」「不需要再确认一次：准备完成后
会直接继续。」这些**同一张卡的行画到了边框外面**，于是整块只剩一条绿色细线。

- **成因**：`.execution-summary` 为了不把转录区压没而写了 `flex: 0 1 auto; min-height: 0`
  （§43.1 的前一轮），可它同时是 `display: flex` 的列容器且没有 `overflow`——被压到比内容矮时，
  边框盒缩小、子项按 `overflow: visible` 继续往下画。压缩本身是对的，缺的是「盒子自己承担溢出」。
- **修法**：`.execution-summary` 加 `overflow: auto` 与 `overscroll-behavior: contain`。
  有空间时与原来完全一致（不出滚动条）；被压缩时内容在盒内滚动，不再越出 `border` 与圆角，
  也不再出现「正文断在半行、剩下的字跑到卡片下面」。
- **验证**：真实 Chromium 探针复现了修前修后（`output/ui-zoom/execution-summary-probe.html`，
  同一 flex 上下文两列对照：修前子项底边 459 落在卡片底边 288 之外，修后 `scrollHeight` 264 >
  `clientHeight` 92 即内容被盒子收住）；`conversationDiffLayout.spec.ts` 9/10，唯一失败是既有的
  「文件夹细条名宽 35.28 < 40」，与本条无关。真实 Windows/WebView2 窗口未复验。

## 44. 聊天目标与计划模式

2026-10-20，产品设计已确认；后续已接入模式选择器、计划卡与目标卡源码，真实 Provider、Windows 窗口及独立验收仍未闭合，实际成绩只归统一功能验收表。行为定义唯一归[总纲 §0.15](../../Personal_Workflow_OS_Master_Spec.md#015-聊天目标与计划模式)，以下维护目标交互，不表示全部场景均已验证；不复用旧本设备「计划执行方式」偏好作为模式状态。

### 44.1 入口与计划卡

输入框旁只显示当前模式，不摆下拉选择（2026-10-22，DEV-0105）：普通模式不占位；计划/目标模式显示一枚静态徽标与「退出」键，退出即切回普通模式（活动目标先安全暂停）。进入模式用「+ → 命令」里的 `/plan`、`/goal`，或直接输入 `/plan 内容`、`/goal 内容` 一次提交；菜单点击仍只预填。新会话默认普通模式，恢复旧会话读取保存的模式与状态。模式是会话行为约束，不增加人设或执行权限。

`/plan` 讨论保持正常聊天，形成计划后显示会话内计划卡：目标、范围、步骤、验证方式、待定事项和版本；支持查看及用自然语言提出修改。默认存会话，需要时导出文件。「按此计划执行」绑定选定版本进入 `/goal`，沿用需求与讨论；过期或冲突版本须核对后再执行，不静默改用另一版。写入试验先解释范围并取得授权。

### 44.2 目标卡与控制

当前会话固定显示一张目标卡，详细步骤可折叠，不在每条消息重复完整计划。卡片显示目标、运行状态、当前步骤、简短进展；自行调整步骤时展示原因及剩余工作。运行时提供「暂停」「取消」，暂停后提供「继续」；完成时展示成果与验证依据，阻塞或额度耗尽时显示具体原因。重新打开会话仍显示原记录。

**取消目标要先确认（2026-10-23，禅道 #153）**：`取消目标…` 是终止性操作，按 §13.2「没有反向命令」那一列走 `AppDialog` 事前确认，不直接发命令。确认框标题「取消这个目标？」，正文说明两件事——不再继续推进，以及已经发生的修改与外部操作不会回滚、无法恢复——并把「暂停」作为可恢复替代指出来；初始焦点压在「再想想」，确认键用 danger。确认后才发原 `controlGoal(cancel)`：命令身份、重放与在途安全结束规则都不变，也不给撤销条。点击前不再依赖「先取消再解释」——后果说明在动作之前给出。

**呈现层级（DEV-0103，2026-10-22）**：目标卡按「标题带 → 目标正文 → 可展开事实 → 动作」分层。标题带只放「目标」眉标、服务端状态芯片（文字 + 色点）与轮次/成功条件计数胶囊；目标正文用正文档字号与中等字重，不再和辅助行同为 meta 常规；当前步骤、进展、成功条件作为辅助事实，成功条件状态同时给出文字与色点，颜色不是唯一线索；动作行以分隔线收口，说明在宽窗右对齐、窄窗独占一行。卡片内容超过 `42vh` 时在卡内滚动，暂停/取消用 sticky 停在卡底，不被证据挤到滚动区外。字段、服务端 `actions`、轮次事实与业务状态均不因版式变化。

不提供应用额外的总时长、轮次、调用次数预算上限。额度耗尽后保留现场，恢复额度后点「继续」接续原目标；继续失败保留原状态并给出原因，不新建另一份目标，不循环自动尝试。额度信息未知时明确未知，不编造余额、重置时间或完成。

暂停、取消及转计划模式先显示处理中，在途行动安全处理后才显示已暂停/已取消或完成模式切换；取消不表达撤销已发生的副作用。询问进度不停止执行，补充要求融入后续；与原目标冲突时暂停受影响行动并展示待澄清事项。活动目标中「先讨论」安全暂停后进入 `/plan`，之后执行采用明确选定的计划版本。完成、等待人工验收、阻塞及额度耗尽分别呈现，不以步骤勾完表示目标完成。

### 44.3 实现状态与已知差异（2026-10-21 实施者自检）

已落地：模式状态徽标与「退出」（显示服务端持久模式，退出即切回普通模式；进入模式走命令菜单与 `/plan`、`/goal`）、命令菜单仅预填与「命令 + 正文一次提交」、计划卡（版本列表、SUPERSEDED 标记、按确切版本执行、复制 Markdown）、固定目标卡（服务端 `actions` 决定可用控制、成功条件逐条状态与依据、停止原因与轮次事实；2026-10-22 按 §44.2 的呈现层级重排版式；2026-10-23 起「取消目标…」先走 `AppDialog` 确认，见上节）、卡外模式说明行。推进、结算、额度授予与恢复链归[运行架构 §9](../architecture/runtime-context.md#9-聊天目标与计划模式的运行边界)，接口归 [HTTP §10.108](../api/http-command-contract.md#10108-聊天目标与计划模式2026-10-20-源码实现)。

**已知差异——计划导出文件未实现。** 现计划卡只提供「复制 Markdown」；「需要时导出文件」这一独立写操作需要新的 Gateway 写入来源（导出类），涉及 origin 登记、迁移 CHECK 与审计，本轮未做。落地前不得用会话直写或模型写工具代劳：导出必须是用户明确请求后的一次独立写操作，不能成为规划时自动写项目的理由。差异已在[功能验收表](../testing/overall-acceptance-2026-09-28.md)记为剩余项。

## 45. 长期项目协作的差异化体验

2026-10-22，纳入规划，以下为推荐交互，未实施本节完整体验。产品规则归[总纲 §0.17](../../Personal_Workflow_OS_Master_Spec.md#017-长期项目协作的差异化体验)，范围与分期归[后续路线 §14](../requirements/post-v1-roadmap.md#14-差异化体验的范围与推荐顺序)。复用现有会话、项目摘要、待处理与验收入口，不新增独立工作台或第二套状态。

| 场景 | 摘要与展开内容 | 操作边界 |
|---|---|---|
| 成果失效提醒 | 摘要说明什么变化、哪项结论需复核；展开显示原证据版本、变化来源、确定/可能/未核对及待补验条件 | 进入原证据或复验入口；只读查看不触发检查或重开任务 |
| 项目接手演练 | 自然语言或显式入口主动发起；先说明资料范围，结果逐项给下一步、决定、验证、恢复依据及缺口 | 无权读取、未找到、冲突和读取失败分别呈现；取消/失败/预算耗尽保留真实状态，不显示演练通过 |
| 决策重审提醒 | 沿 §29 的决定复审展示原决定、登记前提、变化依据和待判断事项 | 查看、继续讨论及正式替代走原入口；不以关闭提醒替代业务决定 |
| 修改前的影响预演 | 在原对话或变更草案中展示影响摘要，展开关联对象、在途执行和未核对范围 | 仅讨论不应用；用户明确应用仍需核对当前版本、原写入条件和在途动作 |
| 面向用户的成果验收 | 交付消息和验收详情展示同一业务步骤、预期现象、版本与证据；区分已有自动结果、待人工检查和环境缺口 | 回到原接受/拒绝入口记录结果；浏览或勾选建议不自动形成批准 |
| 围绕待决定事项组织工作 | 沿 §11 待处理摘要展示需要决定什么、哪些任务受阻及排序依据；同一决定合并入口 | 延后保留待处理状态；决定后的可继续条件与实际执行分开显示 |

统一采用「摘要＋展开」，失败、冲突、重要影响、待决定事项及 UNKNOWN 直接可见。初次读取、生成中、读取不全、错误、过期和空结果分别表达；空列表不能暗示全项目无影响。重读后核对原对象及版本，失效操作入口给出原因与重新核对路径，不通过前端推断可执行权限。基线变化后的结果显示适用范围已变，复核后再提出应用；通知沿既有合并与安静规则，不为本节另建后台触发器。具体布局和数值尚未确定，不新增 token。

## 46. 项目事项与外部 Agent 共享任务

2026-10-23，**交互规则已确认、待实现，未验收**。产品规则归[总纲专题](../../Personal_Workflow_OS_Master_Spec.md#项目事项与外部-agent-共享任务协作)，工程范围归[路线 §15](../requirements/post-v1-roadmap.md#15-项目事项与外部-agent-共享任务协作)。本节只维护交互，不新增视觉 token 或独立管理后台。

### 46.1 入口、登记与查看

项目内增加“事项”入口，需求与 Bug 可查看说明、来源、优先级、完成条件、当前版本及关联 Task；事项详情引用任务、执行、产物、验收、批准和集成记录，不复制业务状态。聊天支持“登记这个 Bug”“把这条交给开发 Agent”“查看等待我确认的事项”等明确操作，按原自然语言入口核对项目、对象、范围及权限；信息不足时就近补齐，普通讨论不自动登记或开放执行。

详情页用于编辑和复杂确认，聊天明确指令可表达同等决定，无需普遍再填表。登记、生成拆分建议、确认范围与实际执行分别呈现；进入可领取队列时显示等待外部 Agent 领取，不显示已经运行。外部工具实际连接并领取后才显示执行者及执行记录，用户能区分范围已授权与 Agent 尚未上线。

### 46.2 开发、验收与人工处理

- 任务显示角色要求、领取者、确切执行基准、关联 worktree 和当前结果版本；独立验收引用同一提交及条件，不能只显示一条“已测试”的聊天结论。
- 退回显示失败项、证据、待返工及剩余轮数；基础设施故障单独解释。达到上限、争议、权限不足或范围变化时给出实际原因及人工处理入口，不显示自动运行承诺。
- 失联显示待核对的原执行与改动，明确超时不代表停止；接手操作依服务端准入，不提供绕过资源核对的“强制继续”捷径。
- 修改需求或验收条件后，展示版本差异、受影响执行及沿用旧范围/切换新范围的决定；历史证据保留适用基准，不继承到新版本。
- 独立验收通过后，人能对照确切变更、条件及证据批准集成；批准后分别显示待集成、集成中、失败、回归及最终完成的真实投影。集成失败或回归失败保留下一动作，不因批准成功显示全部完成。

上述阶段是界面语义，具体枚举与按钮协议待工程核定。暂停/取消/重开沿原入口，重开不自动授权执行；Loading、空结果、读取不全、失权、冲突、未决请求及 UNKNOWN 分别显示，重读不得被旧响应覆盖。按钮消费服务端当前可执行动作，不能由页面推断授予权限。

### 46.3 试运行与证据边界

启用后新事项在 Relay 试运行，旧事项继续在禅道处理。引用旧事项时保留当前登记处和原链接，不把历史导入快照当作最新状态，也不自动迁移、双写或同步关闭。尚未启用时不向用户宣称可以在 Relay 登记执行本闭环。

验证场景归[测试计划 §43](../testing/verification-plan.md#43-外部-agent-共享任务协作的目标验收)；页面原型、受控 API 和 jsdom 不能代替真实外部 Agent 接入或 Windows 窗口验收。

## 47. 长期 Agent 团队私聊群聊与工作概览

2026-10-23，**产品及交互规则已确认，长期团队界面待实现、未验收**。规则归[总纲 §0.18](../../Personal_Workflow_OS_Master_Spec.md#018-项目级长期-agent-团队与跨会话协作)，范围归[路线 §16](../requirements/post-v1-roadmap.md#16-项目级长期-agent-团队与跨会话协作)。不在本节冻结布局、像素或第二套 token。

### 47.1 成员与定向交流

项目能按需添加长期成员，提供产品、设计、开发、测试等模板；协调者建议增员时展示职责和原因，由用户决定，不自动创建全套角色。成员详情显示稳定身份、职责、运行方式、模型和当前工作；模型默认继承项目、可单独配置，不能把模型名称或会话标题当成员身份。成员归档、更换协调者及运行端变更的具体交互待协议核定。

用户可以私聊任一成员或查看其相关会话，返回时仍是同一成员。跨会话接续显示当前目标、授权范围、已有结果及待决定事项的来源；成员记忆与确认项目事实可辨认，不默认把所有成员私聊公开。现有只读人设助手与长期成员分开说明，不能靠切换外观取得写权限。

### 47.2 项目群聊与工作概览

群聊支持指定成员接收，未指定由协调者接住并按需邀请。成员间可发起有对象、有目标的讨论；展示被邀请者、问题、关联任务/版本及当前结论，避免同一消息触发全员重复响应。讨论未解决、需要决定或已结束可辨认，摘要可追溯原交流；群聊中的“已完成”不能直接关闭 Task。

工作概览聚合当前授权工作、成员职责与实际执行、任务依赖、成果和待决定事项；私聊、群聊、事项详情及概览使用同一事实源。主要动作回到原授权、Task、Review 或集成入口，技术详情按需展开，不要求用户在群聊里人工抄送进度。

真实阻塞、重要风险、需要决定及成果待批准主动通知；普通交流与工具过程集中汇总并可查阅。相同问题合并提醒，保留各来源，不将通知已读、延后或关闭当成业务决定或任务完成。

### 47.3 运行、消耗与异常

区分等待事件/下次巡检、可领取、外部成员等待连接、实际执行、暂停处理中、已暂停、范围待核对和失联等事实。成员长期保留不意味着持续调用模型或永久在线；关闭窗口继续本机推进，明确退出/关机后停止，重启展示实际核对与恢复情况，不许以 Loading 隐藏未知外部效果。

不提供强制项目/成员累计费用、时长、轮数或调用次数配额；可展示真实消耗及不可观测部分，不能误导为免费或无限账户额度。服务商额度耗尽、模型不可用、权限变化及用户暂停有明确原因和接续路径；备用模型仅按用户配置使用，不静默切换。原默认三轮返工后人工处理等规则仍可见，不能因“额度不限”让返工无期限继续。

成员、群聊或运行端切换不得丢失草稿、未决请求、当前任务和原控制意图；失权清除不可读投影，过期/迟到结果核对身份和版本。具体按钮、生命周期枚举、归档及恢复协议待工程核定；本轮不声称已覆盖这些界面。

验证归[测试计划 §44](../testing/verification-plan.md#44-长期-agent-团队与跨会话协作的目标验收)，真实内置/外部运行、浏览器和 Windows 分别取证。

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
| /inbox | 无项目人工任务、快速录入 | Task，不自动建 Project |
| /projects | 项目列表、类型与归档 | Project |
| /tasks | Workspace 任务列表，按项目/状态/模式筛选 | Task 查询投影 |
| /knowledge | Workspace 资料，按项目/来源/最近筛选 | Knowledge 查询投影 |
| /activities | 全局时间线，按 Me/AI/System 与项目筛选 | Activity 查询投影 |
| /projects/:id/overview | State、关键产物/决定、下一步 | State 及带版本投影 |
| /projects/:id/tasks | 任务列表、筛选、详情 | Task/验收/执行者 |
| /projects/:id/knowledge | 资料、Memory、Decision、Rules 分页签 | 各自类型 Owner |
| /projects/:id/workbench/:kind | 内置场景页面组合 | 只有展示选择，kind=general/thesis/development |
| /tasks/:id | 任务详情、产物、Run、验收 | Task 主视图，无 Project 也能打开 |
| /runs/:id | 步骤、等待、控制请求、证据 | Run/调用/验证查询 |
| /reviews | 待判断 Inbox | Review；按紧急性和时间排序，不自动批准 |
| /settings/connections | 连接健康、范围、权限、执行配置 | 设置命令，不能从视图切换隐式修改 |

页壳：左侧全局导航，中央工作内容，右侧可收起 AI Panel；窄屏右侧变抽屉，关键按钮始终可键盘触达。项目名、Task ID/标题、当前版本与执行者在操作附近可见，防止跨项目误操作。

Ctrl+K 提供搜索、新建任务/项目、打开项目、委托当前任务和打开 Activity；操作复用 GUI 的准入条件。原总纲的 Start Focus 与后置完整 Focus Mode 有歧义，暂不据此实现计时/Work Session，待确认项见设计审计。

首次使用只收集项目名、目标、可选导入。无模型连接时仍能创建项目并手工录入状态；连接模型后提供 Initial State、轻量 Milestone、Next Action、Workbench 建议，用户查看并 Apply 后才写入对应事实。建议过期需重读，不自动应用，不把模型配置作为创建项目前置条件。

2026-09-20 蓝图交互补充（Proposed）：首个 [Relay Skill](../architecture/relay-skills.md) 将此流程命名为“从目标创建项目蓝图”。先创建最小项目，再生成建议；拒绝建议保留项目。预览只使用同一内置组件注册表和只读投影；Diff 展示状态、Goal 关联、新任务与导航变化。Rules、Workflow 与验证配置单列“后续配置建议”，按钮打开各自确认入口，不能被“应用蓝图”顺带生效。

生成中、校验失败、待预览、提交中、回执核对中、冲突/过期、拒绝、已应用必须可区分。修改内容或选中项形成新候选后重新预览；接受绑定项目、候选 hash 和基线版本。超时查询原回执；冲突保留用户草稿并显示当前差异，不自动覆盖。切页后的结果始终回到原目标。基础导航、Review/恢复入口不允许被隐藏；模型建议不能生成任意新路由。Goal 修改或 Skill 升级只提示新提案，不自动重排导航。

内置 Pack 在现有引导/配置入口作为可选领域组合展示，不增设安装市场。区分“本次选择”“已应用配置”和“当前工具权限”；显示成员版本、缺失能力及用户修改冲突，不能仅显示“Pack 已安装”暗示全部生效。Proposal Diff 基于真实影响说明哪些规则/执行配置需要另行确认、哪些活动执行可能失效；多个命令分别反馈结果。旧配置恢复使用“恢复配置建议”，明确需要新修订，不能承诺撤销外部效果。

Run Detail/Assist 增加轻量 Sources View：展示实际 Manifest 引用、版本、允许查看的片段与排除/裁剪原因。只读接口重新鉴权，禁止显示无权对象的名称/ID/数量；来源缺失与未选中分开，不冒充完整 Inspector 或展示模型思考。Projection Profile 仅控制已授权事实的呈现，不改变 Today 的业务排序、必需 Review 可见性和 Context 规则。完整比较/搜索 Inspector 按后续路线实现。

## 3. 三套工作台

| 工作台 | 默认主区 | 辅区 | 首要操作 |
|---|---|---|---|
| General | 下一步、任务、产物 | State、决定、近期活动 | 开始/继续、保存结果、完成 |
| Thesis | 资料与草稿版本、验收项 | 引用证据、研究阶段、Decision | 选资料、请求草稿、核对引用、人工接受 |
| Development | 受管根/隔离副本、变化集、检查结果 | Git 状态、Run/审批与权限 | 审查 diff、受控测试、接受变更、批准特定 Git 动作 |

配置是代码内注册的组件组合，不生成任意路由或执行脚本。缺少相应 capability 显示“未连接/未启用”并引导到设置，不能显示假测试或假 diff。切换 kind 只改 ViewConfiguration，Run contract hash 必须不变。

Project Type 决定 phase 词汇，例：GENERAL 的 PLANNING/EXECUTING/REVIEW；THESIS 的 TOPIC/LITERATURE/METHOD/EXPERIMENT/WRITING/REVIEW；DEVELOPMENT 的 DISCOVERY/DESIGN/IMPLEMENTATION/VALIDATION/RELEASE。这是推荐内置词汇，可版本化配置；用户显式设置阶段，系统不按 Task 完成数量自动跳阶段。

## 4. 任务与版本交互

闭环 Skill 入口按[首批设计](../architecture/relay-skills.md#7-首批闭环能力与后续目录)接入：任务页提供“完善任务定义/生成验收方案”，项目页提供“继续这个项目”，创建引导保留蓝图预览。委托前展示并确认任务与验收版本；组合“确认并委托”须区分提案已应用与 Delegate 成功，失败后不能显示已开始。恢复摘要标注来源及时间，过期后重新读取；没有比较基线不显示虚构的上次变化。Repair 显示失败证据、新版本及复验状态；交接包区分等待安全点与已接手，仅需判断的场景留在 Review。这些交互不新增一级导航或要求八个独立页面。

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

2026-09-24 M03 G03 查询片：Run 页的“执行结果未知或待核对”现合并展示 P08 未结清效果与该 Run 的 Gateway UNKNOWN 原 `operation_id`。文案要求先核对目标与效果证据，证据不足时保留待核对；不提供盲重试、换 ID、恢复写入或直接标记成功入口。字段没有逐项状态，页面不能把所有条目都称为已执行或已失败。Gateway UNKNOWN 变化目前没有专属 Run SSE 事件；手动刷新、重开页面或约 15 秒周期重读可获取最新查询投影。完整动作核对详情仍需后续接口与交互。

2026-09-24 M03 Mock 动作 UI 开发增量：Task「执行记录」页签仍默认提交普通固定 Markdown Delegate。用户主动勾选文件动作时，页面只读取当前 Project 已生效的 `FAKE_WRITE` Connection 和受管目录，由用户填写目录内完整目标路径与内容；缺少配置或必填项时不提交。可选 `mock_gateway_action` 随原 Delegate `command_id` 一起发送，202 之后按既有回执规则处理，响应不明不改 ID 重试。Connection、目录和策略的创建/变更仍由 P09 HTTP 入口负责，页面选择不授予权限，Gateway 在效果前继续核对。Run 页新增按需读取的动作历史，显示原 operation_id、目标、Operation/Invocation 状态；它是当前查询结果，不把批准当作写入成功，也不提供 UNKNOWN 直接结清按钮。此处是前端接线与定向自检，完整桌面业务链仍按 M03 状态记录。

2026-09-24 M03 React 首片：真实 Task 的「执行记录」页签对有 Project、READY/HUMAN 且服务端 `allowed_actions` 提示可开始的任务提供单独 Delegate；创建 Task 的模式选择不创建 Run。真实创建成功结果中的任务 ID 可点击，直接进入该任务详情；原返回任务入口与示例模式保持不变。提交绑定 Task revision 与新 `command_id`，202 回执核对 Task/Run 身份后进入实际 Run；响应不明时保留原 ID，只查询匹配 `DelegateTask`、Task ID 和结果的回执。Review 决定的即时响应与原命令回执也核对 `ResolveReview`、Review ID、决定及版本，匹配失败维持未决。此处是前端组件接线与回执保护，独立 Worker/SSE、真实 PG 联动与桌面运行仍由 M03 分片验收。

2026-09-24 M03 事件客户端准备片：真实 Run 首读服务端 Run/Task/Reviews 后，用内存 Bearer 的 `fetch` 订阅该 Run 的 SSE；`after` 只记录完整、连续的十进制事件序号。事件正文只作重新查询提示，不能直接改写任务、运行或审批事实；重复事件忽略，缺号或截断后保留旧游标补历史，较大的正文不进入页面状态。短时间密集事件合并读取 Run/Task/Reviews，周期读取和手动刷新仍校正来源 Manifest；断流显示重连，鉴权失效停止旧凭据订阅并重新查询，离页只 Abort 订阅而不发取消命令。该准备片先由受控流组件与浏览器自检验证；后续受控服务端断流实测见下段，其他网络故障仍须单独核对。

同日的 M03 组合开发自检使用冻结 Windows release、WebView2、隔离 PostgreSQL 18.6、真实 API 与 Mock Worker：Run 页从历史事件启动并在 Worker 提交后重读权威快照；页面离开未提交控制命令；受控 WebView `fetch` 中断后按原序号补读；阻断 SSE 时服务端快照校正页面；宿主强杀后四个进程停止，重启页面从持久历史重读，原命令保持一份。无 Bearer、错误 Origin/Host 和跨 Workspace SSE 均被拒绝，测试核对 URL、浏览器存储和宿主日志无令牌。可复跑输入、精确包哈希、原始日志及未验证边界见 [M03 SSE 桌面自检](../../apps/desktop/results/m03-sse-webview-evidence.txt)。该次 CDP 离线仿真未切断已经建立的 loopback SSE，故未证明产品同页自动重连。随后在**同一冻结 release** 上的[独立同页断流反例](../../apps/desktop/results/m03-sse-same-page-evidence.txt)以隔离 PG 表锁唯一定位正在轮询的 SSE 会话，精确终止该会话；旧 WebView 请求关闭后，未离页的 RunView 自行携已消费的 `after=1` 重连。测试仅延迟这条已发出的请求，让真实 Mock Worker 提交 seq 2–31，再放行历史补读；页面随后重读权威 Run 快照并显示修订 v6，宿主与 API 原进程仍运行。该有界片已独立复跑通过，但只覆盖这一种受控服务端断流；其他网络故障、完整 M03/G01–G08 和 Windows 安装交付仍未验收。

2026-09-23 P10 开发增量：`/knowledge` 与 `/projects/:id/knowledge` 共用真实资料页；项目页按项目参数读取，服务端可同时返回适用的 Workspace 事实。四类页签分别读取 Knowledge 的不可变版本、Memory 的确认修订、Decision 的替代指向、Rule 的版本及作用域/强度/检查路径；新建、追加版本、归档或停用携带独立 `command_id` 与变更时的 `expected_revision`。Memory 新建和修订均须由用户勾选明确确认；Decision 替代保留旧决定可查；Rule 表单区分 HARD/PREFERENCE 和 PRE_ACTION/POST_CHECK/SEMANTIC/HUMAN，冲突或检查路径不可用时保留输入并展示服务端拒绝原因。搜索使用服务端有界字面接口（每页 20 条、游标续页），支持中文短词并忽略迟到响应。命令响应丢失或回执无法核对时保留原 ID，仅查同一命令回执；切换资料类型期间禁用再次写入。示例模式只说明未接入，不伪造资料；当前支持受管文本、笔记及产物版本引用，未提供 URL/PDF/向量导入。此处记录开发实现与组件自检，不代表真实桌面验收。

2026-09-23 P11 开发增量：真实 `/runs/:id` 的步骤附近提供只读“本次输入来源”，从该 Run 的 Manifest 列表与详情查询读取构建状态、版本摘要、预算、实际可读片段及合法排除。BUILD_CONTEXT 尚未开始、进行中、失败（必需来源缺失或超预算）和已完成但无 Manifest 分别显示；历史 Manifest 无预算时标明未记录。相关来源区分标题字面命中与同范围最近资料补位，片段正文始终按纯文本展示。详情由服务端按当前权限重新过滤；重新读取、切换 Run 或连接时先清除旧正文，迟到的旧请求不能覆盖当前视图。若预算用量因隐藏来源被置空，只显示权限过滤提示，不据此推断无权来源的数量；无权来源及其排除项不显示 ID、名称、正文或条数。示例模式不生成来源，页面不提供完整 Inspector 或模型隐藏思考。当前组件自检不代表真实桌面验收；已打开页面上的权限变化需要重新读取来源才能反映。

批量 Review 不属于 V1；一个请求一个明确决定。拒绝操作不显示为“执行失败”，请求修改需展示原契约与修正预算。

## 6. AI Panel 与可追溯性

Panel 顶部显示当前 Project/Task、只读 Assist 或 Delegate 模式、采用的来源版本。切页时旧响应留在原会话；发送按钮冻结请求目标，迟到响应不能注入新 Task。

输出分为建议、候选产物、可接受提案。接受前展示差异和目标；Task 被 AI 占有时“保存编辑”改为接手入口，不绕过执行权。隐藏模型私有推理；可查看输入来源、步骤结果与验证证据。

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

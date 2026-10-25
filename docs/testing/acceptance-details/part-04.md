# 功能验收详细记录：分册 04

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../overall-acceptance-details-20261025.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 条目 051

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 「+」→ 连接器 → 插件行只把 `@标签 ` 插进输入框（2026-10-22，DEV-0099） | **实施者自检通过（真实 Chromium 会话路由＋组件回归 31/31）；真实 Windows/WebView2 窗口未复验** | 用户指认「点击插件会出现这菜单，对应插件应该直接出现在输入框里面的」。插件行从 2026-10-20 的原地插件详情改为插入入口：点击把 `@电脑操控 ` / `@浏览器操控 ` / `@GitHub ` **按光标位置**写进当前输入框并收起菜单；不发送消息、不弹详情、不授予能力；连接状态仍在行尾，授权管理统一走面板底部「管理连接与权限」（去掉逐插件 `tool` 深链，仍带 `from` 回原会话）。新增导出 `insertPluginMention` 处理光标插入、选区替换与空白边界；首条消息与会话输入器均接线，无插入回调时插件行保持禁用。**证据**：真实 Chromium 在 `/agent` 会话路由先输入「看一下 」再点 GitHub，输入框值变为 `看一下 @GitHub `、菜单收起、全程 **零 POST**（临时探针已删；截图 `apps/workbench/results/dev0099-plugin-mention.png`）；`composerAttachMenu.spec.tsx` **31/31**；工作台 `tsc --noEmit` 仅剩并行会话未跟踪探针的 `TS6133`（与本次无关）；`node scripts/check-docs.mjs` 通过。规则归[工作台 §32.9](../../frontend/workbench-design/part-11.md#329-连接器与插件二级2026-10-17) 与 [§41.1 R3-01](../../frontend/workbench-design/part-13.md#411-实机走查后的导航与处理减负2026-10-21-已实施windows-实机未验)，台账 DEV-0099。 | 真实 Windows/WebView2 窗口与中文 IME 未目视；`GET /plugins/status` 与本项目授权的详情已从菜单撤出，连接页与运行时诊断的入口仍需实机点验；未做独立验收；未 commit/push。 |

## 条目 052

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 目标模式目标卡版式层级（2026-10-22，DEV-0103） | **实施者自检通过（真实 Chromium 完整态、窄窗滚动与第 0 轮空态＋浏览器回归 3/3）；真实 Windows/WebView2 窗口未复验** | 工单只有一张第 0 轮目标卡截图（目标「用three.js做一个房子」），未给验收口径。按「字段与 actions 不变、只重排呈现」处理：标题带改为绿色 Target 眉标 + 状态芯片（文字 + 色点）与轮次/成功条件计数胶囊；目标正文由 14px 常规升为 16px 中等字重；当前步骤标签、进展降为辅助行；成功条件状态改为「文字 + 色点」，MET/UNMET 分别取成功/警告色；动作行加分隔线、说明右对齐（≤48rem 独占一行）；卡片超过 42vh 卡内滚动时暂停/取消 sticky 停在卡底。服务端字段、轮次事实、可用 actions 与业务状态未改。**证据**：新增 `apps/workbench/tests/browser/goalCardLayout.spec.ts` **3/3**（1600px 层级/颜色/右对齐/无横向溢出；1000px 卡内滚动时 sticky 控制键可见；2000px 第 0 轮空态），截图 `apps/workbench/results/goal-card-layout.png`、`goal-card-layout-narrow.png`、`goal-card-layout-empty.png`；临时探针另拍第 0 轮 `apps/workbench/results/dev0103-after-empty.png`（已删）；`chatPlanGoal.spec.ts` **11/11**；工作台 `tsc --noEmit` 仅剩并行会话未跟踪探针的 `TS6133`（与本次无关）；`node scripts/check-docs.mjs` 通过。规则归[工作台 §44.2](../../frontend/workbench-design/part-14.md#442-目标状态条与控制)，台账 DEV-0103。 | 工单无验收口径，本次为重排版式（信息结构与业务语义未改），仍需用户确认观感；真实 Windows/WebView2 窗口未目视；未做独立验收；未 commit/push。2026-10-25 该版式已再收成输入框上方单行状态条（见 CODEX_NEXT_STEP 同日条目），本行保留为当时验收记录。 |

## 条目 053

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 批量删除失败后不再退回第三次确认（2026-10-22，DEV-0098） | **实施者自检通过（真实 Chromium 批量流程＋组件回归 24/24）；真实 Windows/WebView2 窗口未复验** | 用户指认「已删除 0 段讨论；…还不能删除（发起过执行请求）」这张卡片是连续动作的第三个弹窗，第二个确认后不该再出现。批量删除状态机新增终态 `result`：确认后若有阻止/部分失败，同一张卡片改为「删除结果」并只留「关闭」，**不再退回「已选 N 段讨论 + 删除」的第三次确认**；关闭清空选择，重试需重新勾选。业务拒绝仍按 ADR-027 原样报告（EXECUTION_REQUESTS 等，不可强制删除），同因聚合与「先改为归档」建议不变；全部成功仍直接消失、不留提示。**证据**：真实 Chromium 以两条同名「关于Relay-Agent」走勾选→删除→确认，服务端 409 `SESSION_DELETE_BLOCKED` 后卡片为「删除结果」、无删除/确认按钮、仅「关闭」，关闭后勾选清空（临时探针已删；截图 `apps/workbench/results/dev0098-batch-result.png`）；`sessionRowMenu.spec.ts` **24/24**（含部分成功、同因聚合、回执不明三例改为终态断言）；工作台 `tsc --noEmit` 仅剩并行会话未跟踪探针的 `TS6133`；`node scripts/check-docs.mjs` 通过。规则归[工作台 §28.1 批量删除](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)，台账 DEV-0098。 | 真实 Windows/WebView2 窗口未复验；阻断原因仍只能在确认后由服务端返回，确认前不预判；未做独立验收；未 commit/push。 |

## 条目 054

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 桌面宿主：已收敛启动记录清理失败不再杀掉整个应用（2026-10-21，DEV-0072，**主目录整合**） | **通过（MSVC `cargo test --lib` 45/45、`cargo check` exit 0）；真实桌面进程启动未验** | 根因：`start_api` 在 supervisor 就绪后对 `remove_reconciled_launches(...)` 使用 `?`，临时记录被占用等删除失败会 abort 启动，并随 `ManagedProcess` 丢弃终止已拉起的 API 与 supervisor；同一语义在重启路径只记日志，两处强度不一致。修复：抽出 `cleanup_reconciled_launches(data_root, reconciled, worker_log)`，**首次启动与重启共用同一 helper**，删除失败只写 `host: reconciled launch record cleanup failed: {error}` 并继续；残留记录留给下次启动协调再次收敛。**不放宽** supervisor 就绪与残留进程的安全检查（就绪前的私有握手与进程存活判定一行未改）。**证据**：新增 Windows 用例 `reconciled_launch_cleanup_failure_is_logged_not_fatal`（真实 ARMED 记录 + `share_mode(FILE_SHARE_READ)` 禁止删除，确认失败被记录、记录仍在、函数不向外传播）；主目录 `cargo +stable-x86_64-pc-windows-msvc test --lib` **45/45**（`RELAY_TEST_NODE` 指向本机 node，缺它时 `maintenance_session` 那条真实 Windows Job 用例会因环境要求失败）、`cargo check` exit 0。 | **未跑真实桌面进程启动**：本机已有 Relay 桌面实例在运行，单实例守卫会拒绝第二次启动，因此「临时文件被占用时完整启动链不失败」只在 helper 层与单测层取证，未经真实 EXE/窗口验证；本机默认 GNU 工具链的测试二进制启动报 `STATUS_ENTRYPOINT_NOT_FOUND`，故用 MSVC 工具链；未做独立验收；未 commit/push。 |

## 条目 055

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 电脑操控运行时：启动失败不再谎称「效果未知」（2026-10-21，DEV-0075，**主目录整合**） | **通过（单元 24/24、真实 spawn ENOENT 复现、真实临时 PG `computer-control` 10/10、`tsc` exit 0）；真实桌面输入未验** | 复现：可执行文件不存在时 `spawn` 报 ENOENT，请求被拒为 `IPC_DISCONNECTED`＋`effectUncertain=true`（谎称效果未知、要求人工核对），而进程从未起来、请求从未派发；Node 侧**没有**未处理异常或进程崩溃（原「stdin 写失败会拖垮 API 进程」的假设经实测不成立）。修复：用 Node 的 `'spawn'` 事件判「进程是否真的起来」（`spawnedChildren` 弱集合，逐进程记），进程从没起来时在途请求一律 `RUNTIME_UNAVAILABLE`、不置 `effectUncertain`；**进程已起来且请求写出后断开仍按效果未知结算**（崩溃恢复路径一行未改）。整合方式：只把分类修复与两条回归并入主目录 `runtime-client.ts`（保留并行会话的 UTF-8 严格解码与按子进程归属的 `onProcessGone` 重构，未整树复制、未覆盖并行改动）。**证据**：主目录 `computer-runtime-client` **24/24**（新增「进程根本没起来（假进程）」「真实 spawn 失败（可执行文件不存在）」两例；既有「进程崩溃」「interrupt」两例仍断言效果未知）、真实临时 PG `computer-control` **10/10**（会话工具轮次投影与桌面控场路径未回归）、`apps/api` `tsc` exit 0。 | 真实 Windows 桌面的输入动作与真机运行时二进制未验；失败分类只覆盖「进程从未起来」与「起来后断开」两类，中途部分写入的边界未单独取证；`spawn` 事件在极窄的时序下可能晚于首次请求，届时的判定仍以事件为准；未做独立验收；未 commit/push。 |

## 条目 056

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 人工完成指针写入的守卫强度复核（2026-10-21，DEV-0028，**主目录整合**） | **前提不成立：守卫已存在；新增真实 PG 并发用例 2/2 锁住该不变量；未改产品代码** | 应用层已有三重核对——`lockTaskInWorkspace`（`FOR UPDATE` 行锁）→ 比对 `task.acceptance_revision` 与命令周期（不一致即 `ACCEPTANCE_STALE`）→ `requireHumanInProgress`；写入侧 `applyCompletionPointer` 的 `WHERE id + revision` 是 CAS，而 `tasks` 的**每个**写入面都递增 `revision`（周期推进、状态迁移、执行权授予与回收、验收契约修订），因此并发的周期/状态变化会被 CAS 挡住。AI 完成路径把同样条件写进 `WHERE`（`executor_run_id`＋`status='IN_PROGRESS'`），两条路径实际强度一致，差别只在条件表达的位置。**证据**：主目录真实临时 PG `task-completion-pointer` **2/2**（周期推进后旧完成指针写不进去、状态迁移后同样写不进去，完成指针保持为空）。 | 只覆盖「旧周期/旧状态写不进去」这一侧，正向路径由既有用例覆盖；未改产品代码，没有行为变更可回归；真实 Windows 窗口与独立验收未做；未 commit/push。 |

## 条目 057

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 长期记忆的来源类别与「由系统判断要不要记」（2026-10-21，ADR-032；接续 2026-10-19/20 记忆行） | **通过（真实临时 PG 1/1＋记忆相关集成 33/33＋单测 10/10＋工作台 36/36＋两端类型检查 exit 0＋`check-docs` 通过）；真实 Provider 提取质量与真实 Windows 窗口未验** | 采纳上游对照（Codex `e7ea5f4a8658`，研究记录 §1.9）的做法：不是「把工具输出剔掉」，而是**按来源分层 + 逐字核验 + 类别落库**。实现：①提取输入分【用户原话】与【助手答复｜模型叙述，可能含工具结果或网页正文】两段；②每条候选必须给 `source` 与逐字 `quote`，**写库前核验引用确实出现在它声明的那一段里**，核验不过即丢弃（模型自述不算数）；③记忆行新增 `source_kind`（USER_STATEMENT/MODEL_OBSERVATION/MANUAL/UNKNOWN）、捕获记账新增 `source_quote`，召回排序在人工确认之后再按类别（用户原话 → 来源未标注 → 模型观察）；④`GET /memories` 补上 0125 承诺过却从未进 DTO 的 `origin`，并带 `source_kind`；⑤模型侧来源段标注类别，观察不得被当成用户偏好或授权；⑥**不提供逐条人工选择**——是否值得沉淀由抽取环节的 agent 判断（信号门），人工只保留事后停用与整体关掉总闸。**顺带修掉两处从未被发现的既有缺陷**（此前只有不碰库的单测）：`memory_versions` 的 CHECK 仍要求 `confirmed_by='user:local'`，真实 PG 上每次自动捕获写入都被约束拒绝并被失败静默吞掉——「自动记住」从未真正落库；自动捕获没写 `origin`，落到默认 `HUMAN_CONFIRMED` 冒充人工确认。**证据**：新增真实 PG `memory-auto-capture` **1/1**（核验不过的不写入、类别落库、召回排序、模型侧标注）；回归 `memory-module` 17/17、`memory-status` 1/1、`assist-memory` 5/5、`migration` 10/10；`memory-auto-capture` 单测 **10/10**；工作台 `memorySettings`＋`saveMemory`＋`sessionMemory` **32/32**、新增 `memorySourceKind` **4/4**；`apps/api` 与 `apps/workbench` `tsc --noEmit` 均 exit 0；`node scripts/check-docs.mjs` 通过。 | 真实 Provider 的提取质量（模型是否稳定给出逐字引用、是否把工具/网页内容误记成用户偏好）未取证；`MODEL_OBSERVATION` 仍会进长期记忆（已标注、已降权排序，但内容可能含外部转述）；逐字核验不能判断「引用是否被正确理解」；旧自动记忆回填 `UNKNOWN`；真实 Windows/WebView2 窗口与安装态未验；未做独立验收；未 commit/push。 |

## 条目 058

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 聊天 `/goal` 与 `/plan` 完整实施（2026-10-21，按 `prompts/goal-plan-modes.md`，迁移 0127） | **实施者自检通过（真实 PG/HTTP + jsdom）；浏览器、真实 Provider、Windows/WebView2 与独立验收未做** | 垂直链落地：`/plan 内容`、`/goal 内容` 前缀由客户端与服务端同一约定剥离，模式随消息进同一命令同一事务；不带正文进命令菜单只切模式；输入框旁模式选择器显示并切换持久模式（新会话缺省 CHAT，模式不改变会话身份）。只读落到**工具准入**：PLAN 轮次不声明写工具，写请求被 Gateway 拒且账本留类型化拒绝，本轮照常出计划；应用层另挡提案意图与 MODIFY 方法。计划信封结算正文只落 `reply`，版本按「会话 × 版本号」递增、「会话 × 源消息」唯一，旧版标 `SUPERSEDED`，「按此计划执行」绑定确切 plan_id。目标由 **Worker tick 唯一推进**，页面请求不参与；轮次按消息唯一键幂等，重启重扫不产生第二条链；`PAUSING`/`CANCELLING` 先在途安全停下才归一；COMPLETE 只进 `AWAITING_ACCEPTANCE`，人工确认才 COMPLETED；一条会话最多一个未终结目标（部分唯一索引）。额度不设应用额外总上限，会话级闸门对活动目标按授权账本放大，授予量取自可核对事实，重放只加一次。**证据**：真实临时 PG 18.6 + 真实 HTTP API 进程 `chat-plan-goal` **11/11**（模式受理与拒绝、写尝试被准入拒且账本留痕、计划两版与 SUPERSEDED、按版本执行、多轮推进至待验收、人工确认完成、暂停/取消/恢复与在途竞争、额度授予与继续、HTTP 面 DTO 投影、领取顺序回归）；jsdom `chatPlanGoal` **11/11**；API/Workbench `tsc --noEmit` 均 exit 0（并行会话的 `steer-provider.integration.test.ts` 本轮开始前有编译错误、其后已被补齐，最终全量通过）；单测 909/924，14 失败全在原生发布/内容冻结/受管存储面，与本次无关；提示词路由注册表回归通过。契约归[HTTP §10.108](../../api/http-command-contract/part-08.md#10108-聊天目标与计划模式2026-10-20-源码实现)，存储归[数据库设计 §109](../../database/physical-design-postgresql/part-05.md#109-0127-聊天目标与计划模式2026-10-20-源码实现)，覆盖说明归[测试计划 §41](../verification-plan/part-07.md#41-聊天目标与计划模式验收规格)，进度归 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)。 | 浏览器实际操作未做（规划→修改→执行→暂停→继续→取消→重开恢复）；真实 Provider 的意图理解与额度识别未证（Fake 只证明协议与恢复接线）；Windows/WebView2 实窗、安装态与窄窗未验；无独立验收；计划导出文件（用户明确请求后的独立写操作）未实现，当前只能复制 Markdown；未 commit/push |

## 条目 059

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 模型芯片显示链：无显式选择时显示应用默认而非「模型」占位（2026-10-21，用户复述「要记住上一次选择的模型，不要每一个会话都先显示『模型』两个字」） | **实施者自检通过（jsdom）；真实 Windows/WebView2 窗口未复验** | 诉求两半各有归属：**新对话**一半 10-20 已由本机偏好覆盖（`modelPreferences.ts`，点选即写、新对话挂载与「新对话」重置时读，`modelPreferences.spec.ts` 10/10）；**已有会话**一半本轮补齐——服务端 model-selection 为空且未打开过下拉时，`currentModel` 未读取，芯片仍退回「模型」占位，切到任何没选过模型的老会话都会看到这两个字。改法：`ModelSelector` 挂载即读 `getModelPortStatus`（不再等打开下拉那一下），显示链改为「会话显式选择 → 打开下拉时读到的当前值 → 挂载读到的应用默认」，三级全空才占位（服务端没配默认、本机没选过，此刻确实没有可显示的型号）。应用默认只来自服务端 model-port 投影，不冒充会话事实；会话有显式选择时优先级不变。**证据**：`modelSelector.spec.tsx` 新增三例（无显式选择显应用默认、服务端无默认才占位、显式选择优先于应用默认）**12/12**，A/B 去掉兜底链恰好第一条转红、恢复回绿；回归 `modelPreferences`＋`modelSelectionClient`＋`writePermissionTier` 合计 **44/44**。规则归[工作台 §27.5](../../frontend/workbench-design/part-09.md#275-免费模型分组与模型选择)。**另核**：「未开放写入」文案今天已按上午指认改为「不可写入」（代码/测试/文档齐，`writePermissionTier`＋`newConversationEntry` 34/34），5173 dev server 实测已在服务新模块（curl 命中 4 处）——用户 22:06 截图仍见旧文案，判为桌面窗口 WebView2 模块图陈旧，需窗口内 Ctrl+R 后复验 | 用户实机窗口刷新后的目视未复验（WebView2 旧模块未排除硬刷以外的缓存路径）；「不可写入」的观感反馈未回收；模型芯片在目录未就绪时不发选择命令的既有边界未重跑；未做独立验收；未 commit/push |

## 条目 060

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 电脑运行时 stdout 分块解码与单行字节限额（2026-10-21，接续上方 DEV-0088） | **通过（DEV-0088 本单独立复验通过；不代表整个电脑模块通过）** | 根因：`apps/api/src/computer/runtime-client.ts` 对每个 stdout chunk 直接 `toString('utf8')`，跨块多字节字符变成 U+FFFD；随后用 `stdoutBuffer.length`（UTF-16 码元）比较 `maxLineBytes`，且先检查整段缓冲再切行。修复只动该解析入口：改为 Buffer 缓冲、只在完整换行边界用严格 UTF-8 解码（非法字节不会被替换后当合法回复），逐行按字节执行单行上限；同一 chunk 的多条合法行逐行处理，不再把合计字节当单行。坏数据仍走既有 `killProcess` → `IPC_DISCONNECTED/effectUncertain` 结算，不静默成功、不自动重放。**证据**：修前探针同单复现「`测试窗口`→`���试窗口`、256B 在 200B 上限下仍成功」，修后逐字还原、超限失败关闭；`computer-runtime-client` **19/19**（新增 5 例）、`computer-plugin`＋`computer-action-labels` **28/28**、`run-integration.ps1 -SkipBuild -TestFile computer-control` 真实临时 PG **10/10**（真实 Windows 输入 1 例按设计 skip）、`tsc -p apps/api` exit 0、`node scripts/check-docs.mjs` 通过。规则归[电脑插件 §2](../../architecture/computer-plugin-v1.md#请求回复)，台账为 DEV-0088。  接续独立运行：固定 Node24 API 构建 exit 0、解析器 **19/19**、原探针中文还原/超限拒绝、真实临时 PG **10 通过＋1 按设计跳过**，服务停止与临时目录清理成功；日志 `output/second-audit-build.log`、`second-runtime-unit.log`、`second-computer-pg.log`，台账 DEV-0088 已独立通过。| 未 commit/push；未跑真实 Windows 桌面输入与安装态；DEV-0075 的修复仍在独立 worktree，与本轮同文件相邻逻辑需整合时人工核对，主目录未合并；已做本单独立复验；新协议问题 DEV-0090/0091 另行待修。 |

## 条目 061

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 电脑运行时回复 envelope 严格校验（2026-10-21，DEV-0091） | **通过（受控假进程定向单测；不代表真实桌面协议）** | 根因：`onLine` 只校验 `version` 后便把任意 JSON 当回复——`null` 抛 TypeError、字符串 `"false"` 被当作成功、非对象 `result` 原样 resolve、`error` 字段类型不受约束。修复只动回复解析：要求 JSON 纯对象、`version` 严格相等、非空字符串 `request_id`、布尔 `success`；成功分支要求纯对象 `result`，失败分支要求字符串 `code`/`message` 与布尔 `retryable`；任一项不合规即 `killProcess`，在途请求按 `IPC_DISCONNECTED`＋`effectUncertain=true` 结算，不重放已写动作。未知 `request_id` 的合法回复仍静默丢弃。**证据**：新增 10 种畸形回复表驱动用例＋未知 ID 用例；`computer-runtime-client` **22/22**，`computer-plugin`＋`computer-action-labels` **28/28**（合计 **50/50**），`tsc -p apps/api` exit 0。规则归[电脑插件 §2](../../architecture/computer-plugin-v1.md#请求回复)，台账 DEV-0091。 | 受控 EventEmitter 假进程，未向真实桌面注入故障；未 commit/push；未做独立验收。 |

## 条目 062

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 电脑运行时旧进程迟到事件隔离（2026-10-21，DEV-0090） | **通过（受控假进程定向单测；不代表真实进程已失管场景）** | 根因：`attach` 的 `error`/`exit`/`close` 回调不校验事件来自哪个子进程；旧实例 `exit` 后新实例被 spawn，旧 `close` 迟到即清空 `this.process`、stdout 缓冲、环境缓存并失败**新实例**的在途请求（复现时 `alive=false`、新请求 `IPC_DISCONNECTED/effectUncertain=true`）。修复在 `onProcessGone` 入口按子进程身份守卫：`this.process !== child` 的事件直接忽略；stdout 本就绑定产生它的实例。kill/dispose/idle 仍只作用于当前实例，written→UNKNOWN、不自动重放语义不变。**证据**：新增「旧 exit → 新 spawn → 旧 close/error」顺序用例，新进程不被 kill、新请求正常 resolve；`computer-runtime-client` **22/22**（合计 **50/50**）、`tsc` exit 0。规则归[电脑插件 §2](../../architecture/computer-plugin-v1.md#请求回复)，台账 DEV-0090。 | 受控假进程复现 2 次，未向真实桌面注入故障；未 commit/push；未做独立验收。 |

## 条目 063

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 今日页切换查询时区后眉线错一天（2026-10-21，DEV-0097） | **实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验** | 根因：`TodayView.tsx` 把查询参数里的日历日期先拼成设备本地正午（`new Date(\`${date}T12:00:00\`)`），再按查询时区格式化；设备在上海、查询洛杉矶时，2026-10-21 显示成「10 月 20 日星期二」，刷新后持续。修复只在展示层：眉线中文长日期与星期直接由 `YYYY-MM-DD` 按 UTC 锚定格式化，不再经过设备本地中午；选中日期、服务端查询参数与返回事实、任务分组及延后/焦点命令语义均未改。**证据**：`todayView.spec.ts` 新增设备上海/查询洛杉矶用例（页头日期与星期等于所选日历日期，切日期与刷新后一致），**11/11**；工作台 `tsc --noEmit` exit 0。规则归[工作台 §7](../../frontend/workbench-design/part-02.md#7-视觉与可访问性基线)，台账 DEV-0097。 | 复现截图来自用户实机（Windows/WebView2）；本轮只有 jsdom 证据，真实窗口未复验；跨年、月末与夏令时未逐档另取证据；未做独立验收；未 commit/push。 |

## 条目 064

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 新对话草稿按内容作用域保存（2026-10-21，DEV-0092） | **实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验** | 根因：协作页路由 effect 无条件把草稿清空；未发送正文在「新对话 `?new=A` → 旧会话 → 后退回同一 `?new=A`」后丢失，命令草稿与普通正文均可复现。修复：草稿写入与恢复都绑定草稿内容所属的 `?new=` 键；路由切换只在内容键确实变化时恢复该键已存草稿，同键返回保留正文，切到另一个新键仍是空白，A 键正文不会串入 B 键。未引入第二套会话事实，不改变既有「会话文本可自动保存、不再弹离页框」的决定。**证据**：`newConversationEntry.spec.ts` **16/16**（含同键返回恢复、异键互不串写、未发送不建会话）；工作台 `tsc --noEmit` exit 0。规则归[工作台 §18.1.1](../../frontend/workbench-design/part-04.md#1811-新对话直接起步2026-10-05-接续实施)，台账 DEV-0092。 | 复现来自用户实机；本轮只有 jsdom 证据，真实窗口与原生 IME 组合未复验；跨连接重连后的草稿恢复未逐条取证；未做独立验收；未 commit/push。 |

## 条目 065

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 定时任务创建表单离页保护（2026-10-21，DEV-0095） | **实施者自检通过（工作台 jsdom）；真实 Windows/WebView2 窗口未复验** | 根因：创建页未登记 `DraftGuard`，名称或目标改完后经侧栏、面包屑、顶栏前后退离开会静默清空。修复：字段改动后登记既有 DraftGuard，侧栏、页内返回/面包屑、顶栏前后退与窗口关闭共用同一离开确认，「保留并继续编辑」回到原字段；异步落位的默认项目只修补比较基线，不把干净表单误判为已修改；未采用本机草稿存储，跨重启恢复不在本切片。**证据**：`createScheduledTaskRecovery.spec.tsx` 含默认项目不置脏、干净表单直接离开、改名后保留并继续编辑三例，整套 **8/8**（与 DEV-0096 同套件，2026-10-22 补 5xx 两例后）；工作台 `tsc --noEmit` exit 0。规则归[工作台 §37](../../frontend/workbench-design/part-13.md#37-定时任务2026-10-18-已实施完整出口未验)，台账 DEV-0095。 | 复现来自用户实机；本轮只有 jsdom 证据，真实窗口关闭与原生选择器未复验；跨重启草稿恢复未实现；未创建任何真实定时任务；未做独立验收；未 commit/push。 |

## 条目 066

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 定时创建响应未知后的命令身份冻结与回执核对（2026-10-21，DEV-0096／禅道 #7） | **通过（确定性组件回归 8/8＋真实临时 PG/HTTP 重放 1/1；真实 Windows/WebView2 窗口未复验）** | 根因：响应丢失后再次提交会生成新 command_id，服务端把同一调度重复启用。修复：提交时一次生成并冻结 command_id、完整载荷与发起时的 API/Workspace；未知响应锁定表单并显示原 ID，只提供「查询原命令回执」；回执核对 command_id、command_type=CreateScheduledTask、定时任务与项目；仅 COMMAND_NOT_FOUND 允许按原 ID/原载荷重试；待核对期间切换连接不解锁，切回原连接才可核对，创建页在连接 epoch 变化时保持挂载；只有服务端明确业务拒绝（如 422）才解锁并允许新命令。**2026-10-22 独立验收退回后的补修**：原实现按 `describeLiveError(...).kind === "transport"` 判未知，HTTP 500 落到 `unknown` 被当成明确拒绝、清掉 pending 并允许换新 ID；三处判定（创建页、列表状态、详情时段）统一改用单一 Owner [`needsReceiptCheck`](../../frontend/workbench-design/part-13.md#37-定时任务2026-10-18-已实施完整出口未验)（传输失败／5xx／`retry_action=CHECK_RECEIPT_THEN_RETRY`／非 `RelayApiError` 均按未确认保留原 ID 与载荷。**2026-10-23 复核**：`liveErrors` 中这个 Owner 与列表／详情两页的实现均已丢失，创建页只剩指向它的 import、工作台 `tsc` 因此报 TS2305；本轮按本行原口径补落，见下一行）。**证据**：`createScheduledTaskRecovery.spec.tsx` **8/8**（响应丢失冻结、回执成功导航、**500 后回执命中即进详情且不再提交**、**500 后 404 只按原 ID 原载荷重试**、404 后同 ID 同载荷重试、422 解锁换新 ID、跨 Workspace 拒绝核对且不发请求、回执对象不匹配仍待核对）；A/B 把三处判定退回旧 `kind === "transport"` 写法后恰有 4 条 5xx 相关断言转红，恢复后 14/14 转绿；既有真实临时 PG/HTTP 用例「到点自动新建 Task 并启动，同一 command 重放不重复建任务」复跑 **1/1 PASSED**（证明服务端幂等基座）。日志 `output/ledger-acceptance-20261022-http500.log`（退回取证）与本轮 `output/zentao-scheduled-recovery-20261022.log`。规则归[工作台 §37](../../frontend/workbench-design/part-13.md#37-定时任务2026-10-18-已实施完整出口未验)，禅道 #7（原台账 DEV-0096）。 | 组件证据为受控 fetch 假响应，真实 Windows/WebView2 窗口未复验；真实 PG 用例只覆盖同一 command 重放幂等，未覆盖真实 5xx 后的完整 UI 核对链；未创建用户桌面调度；本轮为实施者自检，未做独立验收；2026-10-23 本行所述源码与检查已随批次 commit/push。 |

## 条目 067

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 定时任务状态变更、时段补跑与详情读取的恢复入口（2026-10-22，禅道 #37／#36，原 DEV-0123／DEV-0124） | **实施者自检通过（2026-10-23 补做丢失实现后确定性组件回归 6/6＋A/B；真实 Windows/WebView2 窗口未复验）** | 根因：`ScheduledTasksView.changeStatus` 与 `ScheduledTaskDetailView.changeStatus/resolveOccurrence` 每次点击直接 `createCommandId()`，catch 只设错误文案，通用提示要求「用同一个 command ID 查询回执」但页面既没保存也没展示原 ID；详情读取失败落进 `task === null` 分支后只剩「返回列表」，页内重读入口只在成功分支里。修复沿用创建页已验证的冻结与核对口径，不新建通用命令框架；「结果是否未知」的判定 `needsReceiptCheck` 落在 `liveErrors`，与 `describeLiveError` 同一 Owner：状态变更与 `RETRY`/`DISMISS` 各自记住 command_id、`expected_revision`、目标 ID、动作与发起时的 API/Workspace，结果未知时页内显示冻结的原 command_id 与「核对原命令回执」，同页其它普通按钮一律禁用，回执按命令类型与确切对象（定时任务 ID／发生 ID）核对后才收口；仅 `COMMAND_NOT_FOUND` 暴露「按原 ID 重试」；4xx 明确拒绝才解锁。两页登记既有 `DraftGuard`（`hasUnsavedChanges` 只由未决命令决定，`discard` 空实现——本页没有可丢弃草稿，未决命令不能靠离页丢掉），离页与关窗走同一保护。详情错误页新增「重新读取」，按当前确切 ID 重发同一次 GET，期间零写命令；403/404 仍如实失权，不保留旧正文。**证据**：新增 `scheduledTaskRecovery.spec.tsx` **6/6**（列表暂停响应丢失后重复点击仍 1 条命令、404 后原 ID 原载荷重试且载荷逐字段相等、**列表 500 也按未知处理且回执命中后收口**、409 版本冲突解锁后允许新命令、详情补跑同链路冻结与重试、**详情回执对象不匹配仍待核对**、详情首次读失败就地重读恢复且零 POST）；**2026-10-23 复核补做**：本轮接手时工作树只剩创建页与这份 spec——`liveErrors` 里没有 `needsReceiptCheck`（工作台 `tsc` 报 TS2305）、列表页与详情页没有任何冻结或重读代码（该 spec 6 例中 5 例因选择器缺失转红），前一轮的两页实现未落盘。按本行口径补 Owner（判定口径与工作台 §37、上一行 DEV-0096 补修一致：传输失败、HTTP ≥500、`retry_action=CHECK_RECEIPT_THEN_RETRY` 与不合契约正文都算结果未知，只有服务端明确业务拒绝——如 422、409 版本冲突——才解锁）与两页实现后，A/B 把判定退回「只有 transport 算结果未知」时 **5 条转红**、恢复后转绿；同组定向 `scheduledTaskRecovery`＋`createScheduledTaskRecovery`＋`scheduledTasks`＋`draftGuardCoexistence`＋`liveErrors` 合计 **27/27**；工作台 `tsc --noEmit` exit 0；`node scripts/check-docs.mjs` 通过。日志 `output/zentao-scheduled-recovery-20261022.log`、`output/scheduled-recovery-20261023.log`。规则归[工作台 §37](../../frontend/workbench-design/part-13.md#37-定时任务2026-10-18-已实施完整出口未验)，禅道 #37/#36（原台账 DEV-0123/DEV-0124）。 | 只有 jsdom 与受控 fetch 证据，真实 Windows/WebView2 未复验；本轮未跑真实 PG/HTTP 的 5xx 注入（服务端幂等由 DEV-0096 既有 1/1 用例背书）；列表与详情的待核对区块只显示原 command_id，未把原载荷展开给用户核对；未做独立验收；未创建或改动用户真实调度；2026-10-23 已 commit/push。**同族 DEV-0126（禅道 #34，历史 20 条窗口吞掉旧 BLOCKED）与 DEV-0125/DEV-0127 等本行未覆盖，仍留原登记处。** |

## 条目 068

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 记忆列表状态筛选标签溢出（2026-10-21，DEV-0093） | **实施者自检通过（真实 Chromium 1162×782 实测＋A/B）；真实 Windows/WebView2 窗口未复验** | 根因：资料页左列 208px，列表内边距后实宽 158px，共享 `.segmented` 的四枚 `flex:1` 按钮各约 40px；「已过期」「已停用」被拆成三行并越出固定 48px 高度（实测文字行数 3、scrollHeight 59 > clientHeight 46）。修复只在 `.knowledge-memory-filter` 内：同一组按钮改为网格，默认 2×2，容器内宽达到 18rem 后转 4 列；标签不拆行、按钮独立圆角、4px 节距；选中态、四项顺序、键盘切换与其它 `.segmented` 用法不变。**证据**：新增 `knowledgeMemoryFilter.spec.ts`（真实 Chromium，1162×782）：四枚标签各 1 行、无横向/纵向溢出、不越过列表内容右缘、2 行布局，Tab 到「已过期」按 Enter 后 aria-pressed 与 `effective_status=EXPIRED` 重读均成立；A/B 把 CSS 退回旧写法时首条断言转红（「全部」2 行），恢复后 **1/1**；`knowledge`＋`knowledgeReading`＋`knowledgeCaptureLayout`＋`knowledgeSimplify`＋`memoryStatus` **41/41**；工作台 `tsc --noEmit` exit 0；`check-docs` 通过。规则归[工作台 §13.3](../../frontend/workbench-design/part-03.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)，台账 DEV-0093。 | 复现截图来自用户实机；本轮为 headless Chromium 实测，真实 Windows/WebView2 窗口未复验；字体放大与多 DPI 档位未逐档取证；未做独立验收；未 commit/push。 |

## 条目 069

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 目标推进扫描饥饿：50 个较旧静止目标挡住暂停/取消与轮次结算（2026-10-21，DEV-0094） | **通过（真实临时 PG 定向 1/1＋chat-plan-goal 全套 12/12＋A/B；不代表真实 Provider）** | 根因：`settleControls` 与 `settleRounds` 共用 `listOpenGoalsForTick(50)`——全部未终结目标按 `updated_at` 升序取 50 条，PAUSED / WAITING_USER 等没有本阶段动作的静止行长期占满窗口，较新的 PAUSING / CANCELLING 与待记账轮次永远进不了扫描集合；移走两条无关目标后同一次 tick 立即收口，证明停滞来自窗口而非在途状态。修复按阶段缩小候选：控制阶段只查 `PAUSING/CANCELLING`，有在途轮次的取消排到无在途目标之后；结算阶段只查「最新一条已结算消息尚无 `assist_goal_rounds` 行」的非终态目标，按 `updated_at, id` 稳定排序。每处理一条即离开集合，单 tick 仍有界；未提高 50 上限、未改写无关目标时间戳、未新增第二个推进 Owner。暂停目标上未记账的轮次仍会被结算（不因排除 PAUSED 丢事实），CAS、消息幂等、written→UNKNOWN、暂停/取消优先与「在途取消只请求停止、不提前宣称取消」均保持。**证据**：真实临时 PG 新增用例（50 条早于被测目标的 PAUSED/WAITING_USER、较新的 PAUSING/CANCELLING、PAUSED 与 ACTIVE 各一条待记账已结算轮次、一条 CANCELLING 在途轮次；3 次 tick 内全部按预期收口，静止目标原状保留）**1/1**；chat-plan-goal 全套 **12/12**；A/B 把两处调用临时退回旧全量扫描，恰在「PAUSING 应收口为 PAUSED」断言转红，恢复后转绿；`apps/api` `tsc --noEmit` exit 0；`node scripts/check-docs.mjs` 通过。日志 `output/dev-0094-chat-plan-goal-full.log`、`output/dev-0094-ab-old-scan.log`、`output/dev-0094-fair-scan-restored.log`。规则归[运行架构 §9](../../architecture/runtime-context/part-03.md#9-聊天目标与计划模式的运行边界)，台账 DEV-0094。 | 只有真实临时 PG 与 Fake 模型协议，未跑真实 Provider；未做真实 Windows/WebView2 窗口（本单无 UI 变更）；未做独立验收；未 commit/push。测试同时暴露一条相邻的独立缺陷：CANCELLING 目标的 PENDING 轮次被 tick 标记 `cancel_requested` 后仍会被生成 Worker 领取，主流程分支未 await 导致异常逃出 tick，已另单记录（DEV-0102），不在本行冒充已修。DEV-0102 修复后，本行夹具中的在途轮次改为 RUNNING 领取形态（PENDING 会被直接收口），整套复跑 13/13 见下一行。 |

## 条目 070

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 取消目标时 PENDING 轮次被 Worker 领取后异常逃出 tick（2026-10-21，DEV-0102） | **通过（真实临时 PG 定向 1/1＋chat-plan-goal 全套 13/13＋A/B；不代表真实 Provider）** | 根因链：`plan-goal-repository.markMessageCancelRequested` 只置 `cancel_requested=true`，没有像 `assist-repository.setCancelRequested` 那样把 PENDING 直接收敛为 CANCELLED；`claimNextPendingMessage` 不排除 `cancel_requested=true` 的 PENDING 行，领成 RUNNING 后生成端 `recordGenerationSources` 以 `AssistPreviewOwnershipLostError` 拒绝；目标轮次分支的返回未 await，拒绝逃出 `runAssistGenerationTick`，Worker 主循环只在外层 catch，进程退出。修复复用既有消息取消语义：PENDING 在收到取消意图时直接 `CANCELLED`，RUNNING 仍只记录停止意图、由生成方结算；未新增第二套取消账本。目标状态仍只由推进器在轮次记账后置 `CANCELLED`；未改 `assist-runner`（该文件有并行在途改动，目标仓储修复已切断触发路径）。**证据**：真实临时 PG 新增「取消目标时 PENDING 轮次直接收敛为 CANCELLED，生成 Worker 不会领取失权消息」——取消时消息仍 PENDING，一次目标 tick 后消息 CANCELLED、目标 CANCELLED、`round_count=1`、轮次 `CANCELLED_ROUND`、领取队列为 0，随后生成 tick 返回 undefined 不抛错；A/B 把 SQL 退回旧写法，恰在「PENDING 应收敛为 CANCELLED」断言转红；chat-plan-goal 全套 **13/13**；`apps/api` `tsc --noEmit` exit 0。日志 `output/dev-0102-cancel-pending.log`、`output/dev-0102-cancel-pending-ab-old.log`、`output/dev-0102-chat-plan-goal-full.log`。规则归[运行架构 §9](../../architecture/runtime-context/part-03.md#9-聊天目标与计划模式的运行边界)，台账 DEV-0102。 | 只有真实临时 PG 与 Fake 模型端口，未跑真实 Provider；未改 `assist-runner` 的未 await 分支，其他异常仍可能从该分支逃出 tick，属独立边界、未在本单扩大范围；未做真实 Windows/WebView2（本单无 UI 变更）；未做独立验收；未 commit/push。 |

## 条目 071

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 首条消息也能先选项目资料并随首条消息冻结（2026-10-21，DEV-0100） | **实施者自检通过（工作台组件 40/40＋新增视图回归 1/1；真实 Windows/WebView2 窗口未复验）** | 根因：首条输入器的「资料」chip 是固定禁用的说明按钮，「＋ → 选择文件与资料」在 `onSources` 为空时一级行也禁用，首条消息前完全没有资料入口，只能先发一条讨论再在会话里选。修复：普通档且目标已有项目归属时，「资料」chip 改为真实选择器（复用 `AssistSourcePicker`，首条不做检索浮层），「＋」资料一级在有 `onToggleSourceRef` 时也可展开，直接平铺项目启用资料与最近引用勾选；选中项写在既有 `selectedRefs`，建会话 action 冻结为 `PendingCreate.sourceRefs`，由 `sendFirstMessage` 随 `requestAssistMessage` 发出，服务端照旧按权限、启用状态与版本复核（≤10）；没有项目归属、助手档与学习档保留禁用说明（提示先选项目/目录或切普通档）。会话建好后由新会话资料选择器的挂载 effect 清空本次候选，避免把首条选择带进下一条消息。未新增第二套状态或绕过领域入口。**证据**：`composerAttachMenu.spec.tsx` 新增「首条消息只有勾选入口：资料一级可展开并直接勾选，检索动作不冒充可用」，与 `assist-source-picker.spec.ts` 合计 **40/40**；`assist-target.spec.ts` 新增视图用例「首条消息先选项目资料：点击即成为本次候选，发送时随首条消息冻结」（真实客户端解析、点击两级菜单勾选、断言 messages POST 携带 `source_refs: [{kind: KNOWLEDGE, root_id: k-1, version: 3}]`）**1/1**；同套件 **5/6**，唯一失败「切换 Project 到 Task 后迟到的旧目标响应不能落到新目标」用 HEAD `AssistView` 临时对照同样失败（`assist-flow` 4 例亦然），属既有陈旧桩，不计入本单；工作台 `tsc --noEmit` 仅剩并行会话未跟踪探针的 `TS6133`（`--noUnusedLocals false` exit 0）；`node scripts/check-docs.mjs` 通过。规则归[工作台 §18.1.1](../../frontend/workbench-design/part-04.md#1811-新对话直接起步2026-10-05-接续实施)与[§32.2](../../frontend/workbench-design/part-11.md#322-一级与状态提示)，台账 DEV-0100。 | 首条资料入口只在「普通档＋目标已有项目」出现，未复验同一屏切换目录后再选资料；只有 jsdom/受控 fetch 证据，真实 Windows/WebView2 窗口与真实 Provider 未验；未做独立验收；未 commit/push。 |

## 条目 072

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 台账待验收项独立复核与新 Bug 走查（2026-10-21，主工作区） | **Relay 13 条通过、2 条退回、4 条保留待验收；不代表整体交付** | 本轮独立运行：真实临时 PG **62/62**（附件 5、目标计划 11、Git 人工只读 15、迁移 10、恢复 18、工作段 3），固定 Node **24.21.0** 定向单测 **39/39**，恢复探针/隔离/Git 定向 **31/31**，前端组件 **99/99**；API 已构建成功。逐单结论与理由已写入本机台账。DEV-0075 在主目录真实 ENOENT 探针仍为 `IPC_DISCONNECTED/effectUncertain=true`，修复只在独立 worktree；DEV-0072 主目录仍以 `remove_reconciled_launches(...)?` 传播清理错误，且提交基线已过期，按允许的状态调整退回处理中，未伪造有效 review。Computer Use 实际打开桌面项目、工作台和通知弹层，只作为界面走查。原始输出位于本机 `output/relay-ledger-integration.log`、`relay-audit-targeted-correct.log`、`relay-audit-restore-target.log`、`relay-audit-components.log`；逐单回执为 `output/ledger-review-results.json`。  **接续电脑插件实测**：原会话的工具过程路径不存在，点重新读取后仍失败，已去重补入 DEV-0089（含修复提示词；未证实文件实际创建）；待处理页正常载入1项且“前往决定”定位成功；输入 `/` 后 Enter 仅插入 `/review` 草稿，未发送；最小化后用插件再次启动当前 debug EXE 恢复同一主窗口，DEV-0078 补证但保留待验收（未验无主窗口分支及完整构建对应）。新问题 DEV-0090/0091 为受控协议探针：旧 close 污染新进程重复2次、null 抛 TypeError、字符串 false/非对象结果被当成功，均已附修复提示词，不能计为真实桌面故障。证据 `output/desktop-second-audit-red.txt`、`desktop-second-audit-command.txt`、`second-runtime-probe.json`、`second-ledger-results.json`。 接续第三轮电脑插件发现 **DEV-0092 未通过**：新对话未发送草稿→旧会话→后退回相同 `?new=xac1hjbw` 后文本为空，命令草稿/普通文本两次复现；源码路由 effect 无条件 `draft: ""` 覆盖按 new 键保存的草稿。已入台账并附修复提示词，未修改业务代码、未发送消息。证据 `output/third-draft-before.txt`、`third-draft-after.txt`、`third-draft-ledger-result.json`。 第四轮Computer Use新增 **DEV-0093 未通过**：1162×782、近期栏展开时记忆状态筛选三字标签拆三行并越出固定按钮边框，已附实机截图和修复提示词。任务创建离页保护/保留文本、空表单返回及全局搜索空态走查正常；未创建任务或记忆。证据 `output/fourth-memory-filter-repeat.png`、`fourth-memory-filter-repeat.txt`。 第五轮新增 **DEV-0094 未通过**：真实隔离PG中50个旧PAUSED占满扫描窗口，较新PAUSING/CANCELLING在连续3个tick均不收口；移走两个无关旧目标后立即收口。探针1/1只证明复现，证据 `output/fifth-goal-starvation.json`、`fifth-goal-starvation-retry.log`，临时套件入口已清理。电脑插件确认已有任务v1/v2、完成凭据v2、血缘父来源与Run深链正常，未操作控制或真实Provider。 接续Computer Use新增 **DEV-0095 未通过**：定时创建表单无本机草稿/离页守卫，名称→侧栏→后退、目标→面包屑→后退两条路径均静默清空；已附前后截图和修复提示词，未提交真实调度。证据 `output/sixth-scheduled-draft-before.txt`、`sixth-scheduled-draft-after.txt`、`sixth-scheduled-objective-before.txt`、`sixth-scheduled-objective-after.txt`。 接续新增 **DEV-0096 未通过**：真实定时创建组件注入响应未知后，再提交生成新command ID且没有回执核对按钮；隔离真实HTTP/PG提交这两个ID产生两条同名ENABLED调度，重放原ID仍返回原对象。组件探针1/1与PG探针1/1只证明复现，原始证据 `output/seventh-scheduled-recovery.json`、`seventh-scheduled-http.json`及同名前缀日志；临时测试入口已清理，未操作用户桌面调度。 接续Computer Use新增 **DEV-0097 未通过**：设备上海时区、今日查询2026-10-21且选洛杉矶时区，页头变20日星期二，刷新后持续；日历日期先按设备中午解析再转查询时区造成错日。已附实机截图/修复提示词，未执行安排写命令；证据 `output/eighth-today-date-after-refresh.png`及同名txt。| DEV-0028 的并发测试未整合主目录，DEV-0074 缺 env-file 的实际桌面传递证据，DEV-0078 已补当前 EXE 最小化后再次启动恢复证据，仍缺无主窗口分支及构建对应，DEV-0085 缺本轮独立连续三次全量结果：原提交三份 916/915/0/1 日志已读，本轮两次扩展全量均中止（一次误用 PATH Node22，一次收敛为定向检查），不计通过。新发现 **DEV-0088**：电脑运行时按 chunk 解码损坏跨块中文、以码元检查字节限额（133 字节回复变成「���试窗口」；256 字节在 200 字节限额下仍成功），受控假进程已重复复现，修复提示词已入台账。未修改业务代码，未跑真实 Provider、安装和完整 Windows 副作用闭环。 |

## 条目 073

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| GitHub 插件登录态误报：探测读不到 Windows 凭据（2026-10-21，接续 [HTTP §10.104](../../api/http-command-contract/part-07.md#10104-插件运行时状态2026-10-20-源码实现)） | **通过（真实 gh 2.102.0 隔离实测＋单测 4/4＋`github-read` 22/22＋构建 exit 0）** | 复现：Windows 上 `gh` 的登录凭据在 `%APPDATA%\GitHub CLI\hosts.yml`；`plugins/runtime-status.ts` 的探测白名单缺 `APPDATA`/`LOCALAPPDATA`，而适配器 `githubEnv()` 有——实测把 APPDATA 指向含 `hosts.yml` 的临时目录时 gh 能读出账号，去掉后 gh 报「You are not logged into any GitHub hosts」，于是已 `gh auth login` 的用户在插件状态里被报成未登录。修复：两份白名单收敛为同一份 `github/gh-env.ts`（探测与适配器共用），并让 `NOT_AUTHENTICATED` 分「没有登录」与「凭据存在但不可用」两档。**证据**：真实 gh 隔离实测（临时 APPDATA＋假 hosts.yml，未触碰本机凭据）、`gh-env` 单测 **4/4**（含真实 gh 一例）、`github-read` **22/22**、`tsc -p` exit 0。 | 本机当前没有真实 gh 登录态，真实登录用户的一次端到端未取证（真实 gh 验证的是「键在不在决定 gh 能否读到自己」这一机制）；`runtime-status.ts` 是并行会话在途的新文件，本次只做定点编辑；未做独立验收；未 commit/push。 |

## 条目 074

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 输入框图片附件：4 例活跃红灯修复（2026-10-21，接续 2026-10-19 六项收口行） | **通过（真实临时 PG `assist-message-attachments` 5/5；能力判定单测 5/5；构建 exit 0）** | 在主工作区复现 4 红：2 例为 `NOT_CONFIGURED`（测试进程没有默认模型），2 例为 `MODEL_NOT_IN_CATALOG` 的错误文案缺少 `RELAY_MODEL_IMAGE_INPUT`。修复不放松闸门：附件用例统一显式传入目录外模型名 `not-in-catalog-model`；HTTP 子进程以 `RELAY_MODEL_NAME` 注入同一模型并显式关闭 `RELAY_MODEL_IMAGE_INPUT`；服务端 `MODEL_NOT_IN_CATALOG` 文案保留兼容期变量名，仍同时指向声明表。断言意图、目录/声明/环境变量优先级与 `NOT_CONFIGURED` 拒绝均未改。**证据**：`run-integration.ps1 -TestFile assist-message-attachments` 5/5；`node --test dist/test/unit/chat-image-input.test.js` 5/5；构建 exit 0。 | 真实 Windows/WebView2 窗口、真实 Provider 多模态语义未验；本修复只覆盖主工作区未提交源码，未 commit/push；未做独立验收。 |

## 条目 075

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 过程可见、简单问题收口与权限禁用可读（2026-10-21 用户三项指认，未 commit/push） | **部分通过（jsdom、真实临时 PG、提示词单测齐全；Windows/WebView2 窗口未复验）** | 三件事各自落到一处，互不捎带。① 权限下拉四行一起变灰却什么都不说：`WritePermissionControl` 只在**禁用态**补一行可读原因，文案优先取服务端 `readiness.detail`（如「该实际工作目录正被其他动作占用或隔离。」），前置条件缺失时由 `readinessHint()` 说清缺哪几项，并给「重新核对」触发既有只读查询；闸门判定一行未改，可选态仍只由悬停承载（2026-10-19 指令不变）。② 「思考过程看不到」：`session_tool_calls` 自迁移 `0060` 起只有写入口，新增只读投影 `application/session-tool-call-projection.ts` 与 `GET …/messages/{message_id}/tool-calls`（[CD §10.109](../../api/http-command-contract/part-08.md#10109-会话工具轮次的只读投影2026-10-21-源码实现)，Breaking Change: No），协作页 AI 消息下 `SessionRoundTrace` 折叠面板按「第 N 轮 · 工具名 · 目标 · 状态」列出已落账轮次；在途自动展开并 2 秒轮询、进终态补读一次后停止，刷新后的终态回复等首次展开才读。③ 「很简单的问题需要想很久」：`AGENT_MAIN_LOOP@1.0.5` 增加工具准入判定（只有需要本地事实时才调工具，问候、概念解释、复述本轮已有内容直接输出正文），**不改** `assist-runner.ts` 的路由谓词、不按文本猜「这是简单问题」。**证据**：真实 PG 18.6 临时集群 `assist-session-tool-calls` **3/3**（按轮分组与 ordinal 升序、参数逐字节透传、REJECTED 带原因、HTTP 体逐字段等于投影返回值、14 键契约集合、跨作用域与跨会话 404、无轮次消息 200 空集合、读取不推进账本）；工作台 `sessionRoundTrace` **8/8**、`writePermissionTier` **16/16**；API 单测 `runtime-prompt-router` **7/7**、`conversation-prompts`＋`agent-runtime-prompts`＋`assistant-readonly-round` **30/30**；`apps/api` `tsc --noEmit` exit 0、工作台 `tsc --noEmit` exit 0、`node scripts/check-docs.mjs` 通过。归因：`assist-flow` 4 红与 `assist-preview` 1 红在挂上折叠面板前后完全一致，属并行改动的既有红灯，只报不修。 | 模型私有推理**未实施**：该文本仍只随工具轮次落在 `run_tool_calls.assistant_message`，不经任何轨迹口子暴露，要可见需先补 migration 与 ADR 限定三处现行禁令；`1.0.5` 是提示词层收口而非硬路由，「简单」的边界仍由模型判，真实耗时改善幅度未在窗口取证；权限禁用其余分支（`PERMISSION_DENIED`、`RESOURCE_DISABLED`、旧 API 404）未在真实窗口逐条走查；改过 `apps/api` 的桌面 dev 窗口须 `-RefreshApi` 重新暂存才能看到新 GET（未复跑）；多 DPI、安装态与独立验收未做；未 commit/push |

## 条目 076

| 功能 | 结论 | 已验证范围与依据 | 剩余项 |
|---|---|---|---|
| 日常操作阻力 Windows 定向走查（2026-10-21，只验收与提示词） | **部分通过：菜单、已抽查导航可达；上下文丢失与处理成本待整改** | 电脑技能实际操作现有 debug Relay Agent / WebView2 窗口，开发地址 127.0.0.1:5173，界面显示已连接本机 API。完全访问菜单经鼠标能展开；最近动态“查看全部”进入动态页（/activities 是已登记别名）；铃铛→人工待处理→确切 Review 与应用后退可用。实测插件管理由已绑定项目会话跳到 /settings/connections 全局项目选择页，源码两处 location.assign 对应；新对话输入区已选目录而顶栏显示尚未绑定；人工队列重复引用 Review 并展开英文码/UUID；约 1162×782 审批单列长正文后才到决定区。推荐规则归工作台 §41.1，交接归日常减负任务书 R3；本机落点图 output/triage/ux-20261021/01-plugin-manage-global-project-picker.jpg | 未修改产品代码、未切权限档位、未提交审批、未发送模型消息；不能将首次 UIA 索引点击无效当成人类鼠标失效。权限禁用各分支、保存回执、草稿往返、键盘、真实授权写入、Provider、多 DPI 与安装态未验；当前源码可能存在尚未加载到活动窗口的并行补丁。整改尚未实施，本行不是整体交付结论。**同日接续**：本行只记录走查与推荐；第三轮 R3-01～R3-05 的实施与自检见下一行，本行的「待整改」由该行接续 |


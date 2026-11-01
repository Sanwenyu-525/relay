# 运行时与 Context 架构：分册 02

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../runtime-context.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 2.7 普通 Agent 的连续工作轮次（2026-10-15，已确认、待重构）

2026-10-31 执行事实回流接续：普通 Agent 每轮装配上下文时，经原会话执行请求关联
重读最多五条 Run/Task 当前状态与 revision，携带原用户消息、请求、Task、Run 身份。
只读取当前轮次之前且未撤回的来源，不混入其他会话/Workspace，也不从旧回复推断结果。
同一只读装配还经原 Verification/Artifact Repository 读取该 Run 的最近验证：确切验证身份、
受验版本与摘要、每项最新检查尝试，以及验收版本是否匹配和适用性是否已撤销。每条最多
五个受验版本、十项检查，省略数明确列出；不混入其他 Task/Workspace 的产物，不注入原始
日志或证据正文。没有验证记录时明确尚未登记。旧结果不继承到新版，ERROR/NOT_RUN 不作 PASS。
这是只读事实，不是执行权、当前有效性的完整裁决或文件内容证明；Run 成功不等于业务验收
完成。更完整的工具/检查证据仍由原 Owner 提供，不由该摘要伪造，也不驱动重试或完成提交。

检查命令另投影最近五条 `run_check` 回执：原 tool_call_id/check_id、工具状态、权威 Operation
状态、已知 outcome 与退出码，明确省略数；按调用时间排序，不注入命令参数、stdout/stderr。
读取时重查 Operation 的 Workspace/Task/Run 归属和状态；UNKNOWN/未结算不借旧 SETTLED 行的
退出码冒充成功。命令退出 0 不等于受验产物或业务验收通过，聊天读取不重放检查。

目标不再固定运行“无工具聊天 + 执行解释 + 状态维护解释”三条模型分支。沿一次原用户消息形成连续轮次，必要读取返回原模型上下文，必要业务动作经原应用入口派生；完整 Owner、事务与兼容规则归[领域模型 §12.6](../domain-model/part-02.md#126-普通-agent-主流程的应用边界)，模板选择与工作编排的区别归[提示词设计 §2.4](../agent-prompt-design.md#24-普通-agent-主流程与模板选择的区别)。

**当前实现边界（2026-10-18，阶段 A/B/C 已实施，原消息 Run 摘要已回填）**：§2.7.1 的持久协议、**会话读取轮次**（来源 `AGENT_SESSION_READ`、目录取自 `assist_sessions.working_resource_id`、路由 `AGENT_MAIN_LOOP`）、**执行候选提交**、**状态维护提交**与**会话内 Run 排他**已落地——主流程收尾的那一次模型输出同时给出回复、可选的执行候选与可选的状态维护候选，两者都经既有确定性校验后落进**原**请求行，因此每条消息不再需要两次额外的解释模型调用。状态维护的基线在**这次模型请求之前**就由 `freezeStateInterpretationBaseline()` 冻结并原样传下去，模型在途期间的人工修改不会被吸收成原基线（R3）。**同一会话不并行推进两条执行链**：`applyConversationExecution()` 在建 Task 之前按 `findLiveRunForSession()` 问「这条会话上是否已有别的请求到了 DELEGATED、且那个 Run 还没收口」，有则按类型化 `EXECUTOR_CONFLICT` 拒绝并指回原 Run；活动状态集与 Task 级 `findLiveRunForTask()` 逐字一致，原 Run 收口后同一会话可再发起执行。Apply 后原用户消息现可读取同一 `request_id`/Task/Run 的摘要投影；更完整的 Run 详情继续由原 Run Owner 提供。旧状态维护解释仍使用独立请求 Owner，相关 UI/窗口及 Provider 范围见统一功能验收表。§2.6 中 A 档无工具/B 档只读的描述保留为当前实现事实。

**会话读取轮次的预算收尾（2026-10-19，真实模型跑通普通会话文件修改时补）**：`runSessionReadonlyRounds()` 在**最后一次轮次**或**工具调用预算已用尽**时，本轮不再向模型声明任何工具，并追加一条收尾指令要求用已有结果作答。此前只靠轮次计数在循环结束后返回 `SESSION_TOOL_ROUNDS_EXHAUSTED`：真实 Provider 会反复 find/list/read（同一文件连读两次），提示它收尾时仍会再请求一次工具，整条消息于是以失败收场，用户看到的是一次报错而不是答复。「不声明工具」是机制而不是劝导——模型没有可调用的工具，只能输出正文。同一轮把模型异常按 `MODEL_TIMEOUT`／`MODEL_TOOL_OUTPUT_INVALID`／`MODEL_BUDGET_EXHAUSTED`／`MODEL_FAILED` 分类，不再一律折叠成 `MODEL_FAILED`：只保留类别，不复制 provider 正文或凭据。

**预算的口径与「说得出为什么停」（2026-11-01 全链路测试整改）**：

- **额度只按这条助手消息计**，`usedCalls` / `round` 在 `runSessionReadonlyRounds()` 内部累加，读取、Git、委派、待办共用同一把尺；同一条响应里并行声明的每个工具请求各占一次额度，**被拒掉的请求同样已经计入**（`NOT_EXECUTED` 那一条不占）。会话默认 `DEFAULT_MAX_ROUNDS = 6` / `DEFAULT_MAX_TOOL_CALLS = 12`，与对话内工具循环（`CONVERSATION_TOOL_LOOP_*`，同为 6/12）取同一产品默认；契约上限 `TOOL_LOOP_MAX_ROUNDS = 12` / `TOOL_LOOP_MAX_TOOL_CALLS = 48` 仍是天花板，单测锁住「默认值不得越过契约、会话与对话两处不得各说一套」。额度是**次**不是 token：上下文用量（ADR-037）与它是两条独立轴，所以会出现「用量 7%、额度已尽」。
- **每轮把额度事实注入 system**（`toolBudgetNotice()`）：第几轮／共几轮、已用几次／上限几次、还剩几次、并行声明各占一次、被拒也计入、`todo_write` 不占读取额度。此前模型从未被告知额度，只能在烧完之后从一句「预算已用尽」里猜自己踩了哪条墙。
- **收尾答复必须是三段事实**：已经执行了哪些步骤及其结果、因额度用尽而**逐项点名**没有执行的步骤、用户可以怎么继续。把「生成了一条最终回复」当成「任务完成」，或把没执行的步骤写成已完成，都是这条指令明确禁止的错误陈述。
- **额度耗尽后仍留一个有界的清单收尾窗口**：`todo_write` 是应用内动作，不读目录也不走 Gateway，因此在这一窗口里豁免读取额度，但自身另有 `MAX_TODO_SETTLEMENT_CALLS = 6` 的上限，且**最后一轮、结构化协议（PLAN／GOAL_ROUND）与上下文压力收尾都不开放**——最后一条模型请求仍然不声明任何工具，循环的终止保证没有被削弱（集成用例 TL-51 锁住这一点）。此前收尾轮一律 `tools: []`，模型连「把没做完的那几步如实标成未完成」都做不到，清单永远停在创建时那一版，这正是「已完成 0/10 + 生成已结束」的成因。
- **拒因带上数字**：`SESSION_TOOL_BUDGET_EXHAUSTED` / `SESSION_TOOL_ROUNDS_EXHAUSTED` 的 detail 现在写明上限与实际轮次，`TODO_SETTLEMENT_BUDGET_EXHAUSTED` 说清是清单写回次数用完，前端 `activityReasonLabel` 逐条有中文名，机器码仍留在第三层核对。
- **词表与实际准入必须同源**（同轮整改）：普通 Agent 会话没有持久绑定目录时，`assist-read-tools.ts` 不再按项目猜那唯一一份受管资源——猜中会把 `read_file` 声明给模型，而 `agentSessionReadOrigin()` 每次都拒，拒掉的调用照烧额度。人设助手与学习档仍按项目取唯一 ACTIVE 资源（它们的来源解析本来就这么判）。能力事实块同步：没绑目录但本轮确有文件工具时，说成「系统推断的作用域，不是用户指定的绑定」，不再写「因此文件类工具不可用」。

**执行候选的交付种类归一（2026-10-19）**：`expected_outputs.kind` 描述的是本次**可审查的交付说明**，不是被改动的文件。真实模型面对「把 greet 改成 X」会合理写成 `CODE_FILE`，而 `validateConversationCandidate()` 原来只认 `MARKDOWN_DOCUMENT`，整条执行请求因此被判成澄清，文件修改永远到不了 Run。现按同义表归一到当前工作流唯一可判定的种类，未知值仍然拒绝；`file_changes` 才是「改哪些文件」的唯一声明位置。提示词两处（主流程与独立解释模板）同步写清这条语义。

纯会话读取复用 §2.6 的 `session_tool_calls`、Gateway 与消息租约机制；新 AGENT 来源必须被明确校验，不能伪装成人设助手或拿到 RUN 写权限。Task/Run 执行继续使用 §2.3 的 `run_tool_calls` 和原图；逻辑主流程接续 Run 时引用其原身份和工具结果，不把同一副作用登记为两次独立调用。会话工具调用与 Run 调用各有确切来源，跨边界关联保存后才能恢复。

主流程须具备持久的领取与推进责任、预算和停止出口：结果保存前后崩溃按原调用/动作核对，不用重新问模型再生成一次动作；取消传到当前实际执行端，UNKNOWN 阻止盲重放。只读结果回放包含真实来源、截断与失败，不把工具正文当指令；历史轮次缺失的元数据保持未知。所有实际模型调用沿原计量记录，不能用移除分类调用的设计直接宣称已降低成本。

这里只定义必须满足的接续责任，不冻结新的表、端点、工具名或引入 Runtime 依赖；实施任务须先核对现有机制再决定最小协议差异。

#### 2.7.1 主流程的最小持久协议（2026-10-15 实施前核对结果）

实施任务书 §5 要求「修改前给出简短映射」，以下是按**当前源码**核对出的差异与本次采用的最小协议。每条都注明依据文件，规则本身仍归[领域模型 §12.6](../domain-model/part-02.md#126-普通-agent-主流程的应用边界)。

| 要回答的问题 | 核对结果（源码事实） | 本次协议 |
|---|---|---|
| 原消息/轮次的唯一推进 Owner | `assist_messages` 的 PENDING→RUNNING 领取、租约与按 Worker 的 CAS 结算是**唯一**推进责任（`assist-runner.ts` `claimNextPendingMessage` / `settleGeneration`）。前端另有 `FirstMessageOwner` 只保存草稿与未决命令，不推进业务。 | 主流程复用同一领取/租约/CAS，不再新增推进 Owner。回复仍是 `assist_messages` 的一行，不是第二套执行状态。 |
| 当前目录事实从哪里查询、冻结和重查 | **缺口**：`assist_sessions` 只有 `project_id`/`task_id`，没有目录列；绑定只存在于浏览器组件状态（`CollaborationView.folder` → `AssistView.executionScope.association.resource_id`）。`assistant-readonly-round.ts` 的 `projectManagedResource()` 直接取 `rows[0]`，正是「多资源任取第一项」。 | 新增 `assist_sessions.working_resource_id`（只增列，可空）与 `BindAssistSessionDirectory` 命令；主流程**只**按该列读回一次受管资源，读不到就以类型化原因拒本次读取，不回落到「取第一个」。每次调用前重查该列与资源/连接的当前状态，因此切换、停用与撤权在下一轮立即生效。 |
| 会话只读来源、账本、业务用例工具、Run 接续的责任与最小类型 | 只读机制已完整存在：账本 `session_tool_calls`、来源 `ASSISTANT_READ`、准入 `originAllows()` 的只读 capability 词表。业务用例工具与 Run 接续沿 `conversation-execution.ts` 与 `run-steps.ts`。 | 新增**第五种**来源 `AGENT_SESSION_READ`，与 `ASSISTANT_READ` 同形（自带 project/resource/session/message，只放行 `FILE_READ`/`FILE_QUERY`/`GIT_READ`），但不复用它的名字：两种身份不得互相冒充，普通 AGENT 轮次不冒充人设会话。 |
| 哪些事实已沿现有消息/请求/回执保存，缺哪些持久关联 | 原消息、命令回执、候选、`session_tool_calls` 行与 Operation 都已持久。**缺**：消息↔目录（见上）、消息↔已发起 Run 的关联（`conversation_execution_requests` 只在旧解释入口产生）。 | 本次先补消息↔目录。消息↔Run 关联归阶段 C，未实现前不宣称可续。 |
| 工具/命令身份何时保存，中断后如何读回 | `session_tool_calls` 在派发**前**插入（`REQUESTED`），准入后再 `attachOperation`，结算改 `SETTLED`/`REJECTED`/`UNKNOWN`。`listPending(messageId)` 是恢复入口。 | 不变。回复正文在最后一轮结算时与消息同一 CAS 写入；崩溃留下的 `REQUESTED` 行按原 Operation 核对，不重新问模型生成动作。 |
| 会话接续 Run 的提交边界与双推进 | 阶段 C，未实现。已知风险：消息 Worker 与 Run Worker 若各自推进同一动作会双写。 | 本次不接续 Run，因此不产生该风险；阶段 C 须先持久化关联与推进责任再放开。 |
| 旧路径与新路径的切换依据 | 2026-10-16 起前端不再随发送触发执行/状态解释；首条先绑定目录再发送，终态后只读回既有请求行。 | 阶段 D：切换依据落在服务端是否已具备本次所需来源与目录，**不是**浏览器内存开关；旧解释/状态维护请求按原 `command_id` 继续可查、可批、可撤。 |
| API Breaking Change 与兼容 | 无既有端点删除或改形；新增为增量。 | 新增 `BindAssistSessionDirectory` 与会话 `working_resource_id` 只读投影属**非破坏**；`conversation_execution_requests` 与旧解释端点原样保留（历史命令、回执、人工决定及撤回继续可用）。 |

**为什么不复用 `ASSISTANT_READ`。** 该来源在迁移 0060 的三条 CHECK、`GatewayOriginKey` 与 `attachOperation()` 中都写死了 `ASSISTANT_READ`，而 §2.6.3 要求「两种执行身份不得互相冒充」。让普通 AGENT 轮次用这个名字，等于允许它与冻结人设快照的会话在账本上无法区分，也让 `originMatches()`/`attachOperation()` 的身份核对失去作用。新增来源的代价是三条 CHECK 各加一支（0054 重述 CHECK 时漏分支的教训见 0060 注释），换来的是两种身份在库层面可分辨。

### 2.8 新会话的默认工作目录作用域（2026-10-18，已确认、待实施）

产品规则归[工作台 §18.1.5](../../frontend/workbench-design/part-05.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)，不变量归[契约 01 §5](../../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)，取舍依据见[研究 §1.8](../../research/p00-source-study.md#18-未选目录时的默认工作目录机制对照2026-10-18)，实施切片归[任务书](../../../prompts/default-working-directory.md)，场景归[测试计划 §17.1.5](../../testing/verification-plan/part-03.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)。2026-10-19 接续：**后端配置、创建事务继承与来源投影已实施，前端设置入口、创建后作用域读回与来源标记已接入**；本节标题保留原方案日期与链接锚点。实现协议见 [HTTP §10.96](../../api/http-command-contract/part-07.md#1096-workspace-默认工作目录2026-10-19-后端实现)与[数据库 §104](../../database/physical-design-postgresql/part-05.md#104-0117-workspace-默认目录2026-10-19)，运行结果只归统一验收表。

**要解决的问题**：`assist_sessions.working_resource_id` 为空时，普通讨论照常，但会话读取按 `AGENT_SESSION_HAS_NO_WORKING_DIRECTORY` 拒掉本次工具调用（§2.7.1、`assistant-readonly-round.ts` 的 `agentSessionReadOrigin()`）。用户提出的不是「让模型自己找个目录」，而是「用户可配置的默认落点」，因此本节把兜底责任从读取期挪到创建期，并要求该落点是一个已确认的持久事实。上游五家都保证 cwd 有值，共同落点是进程目录；Relay 不采纳，因为 API/Worker 的进程目录是安装目录而非用户内容。

| 要回答的问题 | 本次协议 |
|---|---|
| 默认目录这条事实的 Owner 与形状 | Workspace 级持久配置：迁移 `0117`（原计划号 `0111` 已占用），单行/Workspace，字段为 `workspace_id`（主键）、可空 `resource_id`、`revision`、`created_at`、`updated_at`。清除保留行和修订，避免旧表单在清除后覆盖新选择。写入方是 `SetWorkspaceDefaultDirectory` / `ClearWorkspaceDefaultDirectory` 命令，以及 `OpenWorkingDirectory` 在**当前没有默认目录**时的首次登记（2026-10-19 用户要求「基础能力不该让开发者自己配置」；已有默认不覆盖）。属 Workspace 应用配置事实，与 `0020`/`0089` 的「会话内选择不是应用默认」分层互不覆盖。**不进 localStorage**：本机偏好不构成授权，而作用域是事实。 |
| 默认目录如何取得资源身份 | 复用既有 `OpenWorkingDirectory`：规范化真实路径、必要时建立最小 Project 与受管资源，**READY 才允许登记为默认**；`READY` 且工作区尚无默认时在该命令的同一事务内直接登记（`ensureWorkspaceDefaultDirectory`），因此「打开过一次文件夹」就等于配好了默认目录。因此默认目录连带其 Project 与 `local_directory_access.write_tier`；AMBIGUOUS（同目录多项目）与 NOT_READY（重叠根等）不写默认值、如实显示服务端原因，不新建第二个写执行 Owner，也不换另一个根兜底。 |
| 新会话如何继承 | 在 `CreateAssistSession` 的**同一短事务**内完成：仅普通 `AGENT` 且未指定 Project/Task 时继承，显式 Project/Task 仍沿用原绑定流程；Workspace 配了默认目录、该资源仍 ACTIVE、Project 未归档、真实路径可核对且无活动重叠根时，写 `project_id`＝资源所属 Project、`working_resource_id`＝默认资源、作用域来源＝`WORKSPACE_DEFAULT`。任一条件不满足则按「没有默认目录」建会话，不猜测、不改用其他根；ASSISTANT/LEARNING 不继承。 |
| 为什么落在创建期而不是读取期 | 读取链不改：`agentSessionReadOrigin()` 仍只按会话行读回一次受管资源，缺目录仍以类型化原因拒本次读取，**不查默认配置、不加兜底**。默认作用域一旦随创建事务落定就是会话自身的事实，可追溯、可重放；读取期临时推断会让「这次读取用了哪个根」重新变成不可核对的隐式状态，违反 §2.7.1 与契约 01 §5。 |
| 来源如何持久且可追溯 | `assist_sessions` 增可空列 `working_directory_source`（`USER_PICKED` / `WORKSPACE_DEFAULT`；无资源时为 NULL），与绑定同事务写入；会话上下文的 `working_directory` 投影带出该值，界面据此显示「默认目录（来自设置）」。用户在会话内显式换目录后改为 `USER_PICKED`。历史会话不回填，作用域不变。 |
| 写权限与档位 | 默认目录不自带写能力：没有本目录档位事实时按**只读**兜底（2026-10-18 用户选定），有档位则沿用该目录自己的档位。写仍逐次经 Gateway 判定，非完全访问目录的删除仍单独确认；Git、CLI、浏览器、电脑与外部服务不因默认目录获得权限，ASSISTANT/LEARNING 身份边界不变。默认目录的配置入口不提供「自动批准」，也不提供「完全访问」（2026-10-18 档位接续后该边界不变，见工作台 §18.1.5）；「绑定是作用域不是准入」的既有原则不动。 |
| 与 `BindAssistSessionDirectory` 三条边界的关系 | 不放宽同 Project、ACTIVE、无在途消息三条边界，也不放宽 `hasInflightMessages` 与重叠根守卫：默认作用域在创建时由同一事务建立，不产生事后绑定命令，因此不与在途消息竞争；会话内换目录仍走原命令、原 `command_id` 与原核对流程。 |
| 失效与回落 | 默认资源停用、其 Project 归档或跨 Workspace 借用时，创建按「没有默认目录」进行并在投影中给出未生效原因；已在途与历史会话保持原绑定，不因重设默认目录恢复已撤销的权限。 |
| API、迁移与兼容 | 只增可空列、只增表、只增命令与只读投影，属**非破坏**；`createSessionBody` 若新增可选目录入参，按既有「同 `command_id` 异载荷拒绝」处理。未配置默认目录时全部既有回执形状与拒绝语义逐字不变，`AGENT_SESSION_HAS_NO_WORKING_DIRECTORY` 的提示原文保留。 |
| 验证落点 | 默认作用域的继承与回落用真实 PostgreSQL 集成测试；读取正确性沿 §2.7.1 既有工具账本与真实文件证据，不靠前端禁用断言，也不以合成 fixture 代替真实 PG。既有「缺目录拒读」「不猜目录」用例必须在未配置默认目录时原样通过。 |

### 2.9 排队消息的「插话」进入上下文的方式（2026-10-19，已实施）

领取边界（2026-10-30 修复）：同会话有 `RUNNING` 消息时，后续 `PENDING` 不由另一 Worker 提前领取；其他会话仍可独立推进。生产领取在原 Application 短事务内先锁会话，再用新语句快照核对并更新消息，避免只锁单条消息而造成同会话并行生成。心跳与停止监听持续到异步生成真正结束；宿主停止与用户取消分别处理，前者不自动写成业务 `CANCELLED`。根因与回归落点见[生成生命周期记录](../../development/agent-generation-lifecycle.md)。

普通 Agent 会话里一条回复正在生成时，用户再发一条消息仍按既有路径落库为 `PENDING`（排队等这一轮结束）。本节的「插话」是同一批消息的**第二种投递方式**：用户要求它并入**正在生成的那一轮**，而不是等这一轮结束后另起一轮。交互归[工作台 §39](../../frontend/workbench-design/part-13.md#39-排队消息的插话手势2026-10-19-已实施)，命令归 [HTTP §10.102](../../api/http-command-contract/part-07.md#10102-排队消息的插话2026-10-19-源码实现)，物理列归[数据库 §106](../../database/physical-design-postgresql/part-05.md#106-0122-排队消息的插话意图2026-10-19-源码实现)。

**上游依据（2026-10-19 核验 `.research/upstream/deepseek-harness`）**：

- `packages/core/agent-loop/src/agent.ts:167-173`：`steer()` 把消息插进 `next-step` inbox，`followup()` 插进 `next-turn`——两者是**不同投递目标**，不是同一个队列的两种状态；
- 同文件 `:359-364`：一步结束时若 `nextStep` 非空，**这一轮不结束**，再跑一步。插话因此不会「排队等下一轮」，也不会丢掉；
- `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:155`：`canSteerQueue` = 输入框为空 + 正在运行 + 队列非空；空草稿的 Enter 是插话手势，队列每行的「插话」按钮是同一操作的单条版本；
- `packages/api/session-controller/src/commands.ts:477-497`：`steer` 只在目标仍是 `next-turn` 且 agent 仍 `running` 时受理，否则返回 `session/steer-unavailable`。

**本项目采用的映射**：

| 问题 | 结论 |
|---|---|
| 意图如何持久 | `assist_messages.steer_requested`（0122，默认 false）。命令 `SteerAssistMessage` 只把排队行置位，不搬动消息、不新建请求行；与 `cancel_requested` 同一性质：先落意图，生成方在安全点观察。 |
| 谁消费、何时消费 | 唯一消费方是普通 Agent 主流程 `runSessionReadonlyRounds()`：模型请求前、正文结算前以及每个工具派发前检查 `drainSteerRequests()`；只有仍有后续模型请求机会时消费。它把命中的排队行在同一句里收口为 `CANCELLED` + `error_code='STEERED'`，并带回各自紧邻的用户原文。 |
| 进入上下文的什么位置 | `assistMessages()` 保留真实顺序：`system → 历史 → 工具结果 → 新插话 → 根据该插话发出的工具及结果 → 后续插话`。尚未引发工具的插话放在末尾，引发工具后移入对应 `ModelToolTurn.steersBefore`，后续请求不再把旧插话移动到所有工具之后。原文逐字保留为用户消息，不增加资料前缀、不丢弃已执行结果。 |
| 为什么这一轮会多跑一步 | 与上游 `:359-364` 同语义：模型已给出正文、但这一步之后又有插话到达时，本轮不结算，带着插话再跑一轮；最终只保留最后一轮的正文。这条路径不流式预览（`assist-runner.ts` 既有注释），因此被丢弃的中间正文用户从未看到，不会出现「答案跳变」。 |
| 预算与收尾 | 只在**还有轮次预算**时消费（`shouldWrapUpReadonlyRound()` 为假）。收尾轮不再消费插话：接了却没有下一次请求，等于把用户消息取消掉却永远不回答它。 |
| 排队行为什么不再自己回复 | 消费即收口为 `CANCELLED/STEERED`；这一行不出现在消息列表与历史里（`listMessages` / `history()` 都排除），用户原文仍作为真实 USER 消息留在转录区。 |
| 迟到与竞争 | 插话意图已落库、那一轮恰好结算：意图留在行上，这一行随后按普通排队被领取（`claimNextPendingMessage` 在同一句里清零 `steer_requested`），消息照常得到自己的回复——不丢、不重复。生成中的那一轮自己不能插话（`RUNNING` 拒绝）。 |
| 带图片的排队消息 | 不插话：插话通道只送用户原文，图片字节不在其中；命令按类型化原因拒绝，界面也不给这个入口，避免「图片被悄悄丢掉」。 |
| 与取消的关系 | 两者都只作用于排队行，但语义相反：取消让这一行结束且不再回答；插话让它在当前这一轮里被回答。取消仍优先：`cancel_requested` 的行不再被插话消费。 |
| 只在哪一档成立 | 仅普通 `AGENT` 会话。人设档与学习档的在途栅栏直接拒绝再次发送（§2.6.4「B 档不排队」），因此没有插话对象；单次生成路径（无工具、非 DISCUSS、Skill/提案意图）没有「步」的概念，排队消息照旧另起一轮。 |

**不宣称**：插话不保证一定并入——它与「这一轮何时结算」竞争，落败时消息按普通排队被回答（用户可见原文仍在，回复顺序不变）。真实 Windows 窗口、原生 IME 与真实 Provider 下的手感未验。

#### 连续插话与方向变化（2026-10-20，已授权、源码实现）

用户指出连续插话可能属于同一目标，也可能后文已经撤回前文。本轮沿用既有队列与消费 Owner，不新增意图分类模型、第二套任务状态或数据库字段。语义规则由 `ASSIST_STEERING_RULES`（`USER_STEERING_V1`）在发生插话后追加到本轮 system；模型结合全部原话核对当前目标、仍有效约束、被替代要求及已执行结果。这是对话理解，不是已确认的结构化业务事实，也不保证任意 Provider 都正确理解。

| 输入关系 | 已确认处理规则 |
|---|---|
| 相关补充 | 累积为同一目标，保留原要求；如登录页、手机号、验证码 |
| 局部修正 | 后文只替代冲突部分，其余继续有效；如红色改绿色 |
| 做法或阶段变化 | 按「先方案／不要修改」调整下一步，停止旧修改计划 |
| 明确替换目标 | 按「原目标先不做，改做另一件」停止旧方向后续动作；不能机械执行已被后文撤回的要求 |
| 临时提问或进度询问 | 回答问题，不自行取消原目标、不强行合并无关问题 |
| 关系不清且影响执行 | 暂停受影响动作并简短澄清；不能只因最后一句较新而丢弃其他有效要求 |

**工具边界由代码保证**：工具派发前收到新插话，本批未执行的所有工具返回 `NOT_EXECUTED / NEW_USER_INPUT`，不创建工具账本或 Gateway 动作；保留完整 tool-call/result 配对，再由下一次模型请求决定新动作。已完成的结果保留；执行中的动作按既有结算机制处理，不能宣称中断或回滚。进度询问也会先让未派发批次回模型判断，但不据此取消业务目标。不增加轮次预算，预算最后一次请求只能收尾；无后续请求机会的插话留在队列。

**与正式 Task/Run 的边界（覆盖范围）**：插话的停止与转向只作用于**本轮会话工具循环里尚未执行的动作**。已经登记的执行候选与正在执行的正式 Run 不受聊天改向影响，不会因插话自动停止或改向——停止、调整与重新发起只能走项目既有的任务与运行控制入口（领域 Owner）。`USER_STEERING_V1` 明确禁止模型声称「已停止该任务」「已按新方向调整运行」；第二条执行候选与活动 Run 的冲突由既有领域拒绝（AM-06 类型化冲突）兜底。正式 Run 执行期间没有 `RUNNING` 的会话回复，插话手势本身也不出现；只有在新一轮生成与活动 Run 并存时插话才可用，那时它改的是**这一轮生成**的方向。

正式 Task、Run、验收和权限仍由原领域入口拥有；聊天换方向不直接改冻结契约，也不复用旧批准执行新动作。多个输入按消费时已到达的集合处理，不能预知用户尚未发出的后续消息。

本轮未增加派生目标快照或 Worker 重启后的工具/插话时序持久化，不据此宣称崩溃窗口恢复已闭合。真实 Provider 的补充、修正、换目标、临时提问和歧义澄清质量，以及 Windows/安装态和独立验收，须另行验证。

**失败与恢复窗口（2026-10-20 独立检查，真实 PG 已验）**：被消费的插话不靠内存数组单独承担恢复——失败、取消与预算耗尽后的恢复事实是数据库里的既有行，不需要新增持久化字段：

| 窗口 | 实际行为 |
|---|---|
| 消费后模型失败（含预算耗尽） | 排队占位行保持收口（`CANCELLED/STEERED`），不复活、不重复回答；失败的中间正文不落库；USER 原文行仍是 `COMPLETED`。用户重发新消息时，`assistMemory.history` 与 `listCompletedHistory` 都排除 STEERED 占位行、包含 USER 原文，恢复轮上下文能同时看到原要求与插话原文。 |
| 消费后取消 | 取消在下一轮请求前生效，本轮按 `CANCELLED` 收口、零工具；已消费的插话行不因取消复活，USER 原文同样保留。 |
| Worker 崩溃 | `failExpiredLeases` 把失联的 RUNNING 收口为 `FAILED/LEASE_LOST`，**没有**同一条消息自动重新生成的路径；此后恢复与上一行同构（靠新消息历史）。内存里未消费的 `steers` 数组随进程消失，但不存在"消费成功却静默丢失"的窗口：消费即已在数据库收口，未消费的行本来就还在队列。 |
| 关闭记忆的会话（`remember=false`） | 历史只保留最后一条 USER（会话记忆的既有语义），被消费插话的原文**不会**进入恢复轮上下文。这是用户显式关闭记忆的既定代价，不是插话机制的缺陷；如实声明。 |

**真实 Provider 检查（2026-10-20）**：`apps/api/test/integration/steer-provider.integration.test.ts` 用真实模型逐场景验证六类语义（相关补充、局部修正、改变阶段、明确替换目标、临时提问、关系不清）。默认整体跳过，只有显式 `RELAY_STEER_PROVIDER_CHECK=1` 且 Provider 配置可用时才跑（避免全量回归烧真实模型）。断言分两级：插话原文进入请求、被停止工具零账本/Gateway/磁盘改动、排队行收口是**硬断言**（与模型无关，失败即缺陷）；回答措辞与语义选择只记录供复核。场景 C 在 FULL 档位下用「先别改，只给方案」验证插话到达后写动作确实停止派发、磁盘逐字节不变。

### 2.10 日常工具工作与正式交付分层（2026-10-20 实施）

用户反馈覆盖文件工具、浏览器/电脑操作及任务/审批/验收步骤。调整遵循 [ADR-031](../../decisions/ADR-031-session-direct-write.md) 的接续决定：日常文件工作不必制造正式任务；正式验收不因聊天回复而完成。

| 工作 | 当前推进路径 | 人工边界 |
|---|---|---|
| 查看文件、目录与已连接工具的只读状态 | 同一消息连续工具循环 | 无额外“开始读取”确认 |
| AUTO/FULL 目录的普通文件修改，包括明确 MODIFY 方法 | 同一循环直接写，保留基线与动作账本 | 不创建 Task/Run，不要求正式任务验收 |
| ASK 写入、AUTO 删除、会话直写遇自定义 ASK 策略 | 创建会话 Operation 前转原消息候选 → 已有自动启动 → Run/Gateway | 在确切动作处审批；不要求重述目标或手工建任务；旧待审批动作按原身份核对 |
| 修改后的检查 | 仅剩余检查进入 Run，已成功修改不再重复执行 | CLI 允许清单与冻结程序摘要仍有效 |
| 浏览器、电脑操作 | 候选 `interaction=BROWSER|COMPUTER` → 原 Run 工具循环 | 仅解析本项目 ACTIVE 连接；不因工具需求自动新增范围授权；提交与外部副作用仍按原审批 |
| 正式任务交付 | Artifact → Verification / Human Acceptance → Business Commit | 绑定确切版本；普通工具成功不等于业务完成 |

`planToolLoop` 在登记 Task 前核对所需连接；缺工具先报告具体能力缺口，不留下无法委托的任务。浏览器/电脑连接不需要文件根，文件/Git/CLI 的目录匹配规则不变。`interaction` 只传达本次需要哪组工具，不能成为新的执行权或批准来源。

限制：浏览器/电脑目前仍要求会话有项目与受管目录，尚未独立出无目录操作会话；会话自身没有异步动作审批恢复。自定义策略已经生成的 WAITING_APPROVAL 与 UNKNOWN 都按原动作核对，禁止用新候选绕过。真实模型选择质量与 Windows 操作效果需单独取证。

#### 2.10.1 推进 Owner 收归服务端与能力事实说明（2026-10-20 第二轮）

上一轮把「文件直写」留在了会话里，但「候选 → Task/Run」这一步仍由**前端 effect** 触发。
后果是可预期的：关掉页面、刷新错过时机、或请求由另一台设备发起时，一条已经明确授权、
已经落库的请求会停在 `READY` 等一次没有信息量的点击；同时前端与后台各自持有推进责任。

- **唯一推进 Owner 是服务端 tick 函数**：`runConversationExecutionAutoStartTick()` 每次被调用
  时扫
  「决定 PREPARE、候选 READY、还没有 Run、阶段在 READY/TASK_PREPARED」的原请求，沿
  请求行上**已固定的三个阶段命令身份**调用既有 `applyConversationExecution()`。
  没有新命令、新表或第二个推进状态；重复与迟到扫描只重放原回执。
- **前端不再推进**：本设备「计划执行方式」偏好（`relay.workbench.planExecution`）撤除。
  它是同一件事的第二次确认，也是前端必须持有推进责任的唯一理由；目录写档位与逐动作
  审批已经表达授权。界面只保留：显示阶段、失败后显式「继续原请求」。
- **失败必须带原因并退出扫描**：推进失败把 `DomainError.detail` 写回原请求的
  `clarification.questions`，阶段记 `FAILED`，候选与阶段命令身份全部保留。因此
  「缺哪个连接、哪个目录、会话已有在途 Run」在关掉页面再回来时仍然可读，补齐前置条件
  后仍可沿原 `request_id` 接续——而不是让用户重述目标、或在后台把同一失败刷成噪声。
- **`auto_start` 变成阶段感知的投影**：`FAILED` / `DELEGATED` 不再为真。前端与服务端
  扫描共用这一个判定，两处不会对同一行给出不同结论。
- **能力缺口由服务端事实块说明**：普通 Agent 的 `DISCUSS` 轮次在 system 末尾追加一段
  `assist-capability-notice`（有无目录、目录写档位、本轮真实可用工具、缺哪几族能力）。
  它让模型把「无法执行」说成具体缺项，而不是「没有被赋予访问能力」或「请补充任务目标
  与验收标准」。这段文字是**事实说明，不是授权**：词表、档位、连接与 Gateway 准入
  一条都没有改变；Skill 轮次的严格输出协议不并入。

仍然未闭合，且不能由本节推定：

- **浏览器/电脑仍要求项目与受管目录**。`logical_operations` 的来源 CHECK 与
  `conversation_execution_requests.resource_id` 都是非空，`prepareGatewayAction()` 除
  `USER_IMPORT`/`WEB_FETCH` 外一律要求受管资源行。要做无目录的操作会话，最小改动是给
  浏览器/电脑动作引入可空的资源身份并逐条重述这三处 CHECK——这是一次库层身份变更，
  不是给一条路径加分支；在没有清楚归属前不用默认目录或别人的资源顶替。
- **只要产生 Run，就仍是正式任务**：检查命令（`check`）与 ASK 写都走 Task/Run/验收。
  「普通检查不卡在人工验收」需要区分「内部执行载体」与「正式交付」两种 Run，属于下一
  项决定，本轮未做。
- 真实 Provider 的选择质量、真实浏览器/桌面操作、Windows/WebView2 与安装态另验。

### 2.11 常驻进程与后台 tick 的对应关系（2026-11-01，ENG-SA-01 修复）

推进责任分散在若干 `run*Tick()` 应用 Owner 里，但**函数存在不等于有进程去调它**。桌面宿主与
`dev-stack.ps1 -WithWorker` 实际拉起的进程组合是「常驻 API ＋ 常驻 Supervisor ＋ 按需一次性
Worker」：`--once` 只领 Run 命令，`--assist-once` 只做会话生成，持续 Worker（`worker/main.ts`
不带标志）在这两种拓扑里都没有启动入口。2026-11-01 核对到的现状：

| 常驻进程 | 实际驱动的 tick | 归属位置 |
|---|---|---|
| API（Fastify，`onReady` 自挂载、`setTimeout` 自续、`timer.unref()`） | 定时任务扫描、项目提醒、任务链、后台工作派发（网页导入／会话执行自动推进／成员唤醒） | `api/routes.ts` 的四个 `register*Scheduler` |
| Supervisor | 过期 invocation 上报、闲置控制意图、Run/Assist 派发决策、`runAssistGoalTick` | `worker/supervisor-main.ts` |
| 一次性 Worker 子进程 | `--once`＝一条 Run 命令；`--assist-once`＝一轮会话生成 | `worker/supervisor.ts` |
| 持续 Worker | 全部 tick（只在有人手工启动时存在） | `worker/main.ts` |

修复前，成员唤醒、会话执行自动推进与网页导入**只出现在最后一行**，于是发布拓扑里没有执行者：
不是「关掉页面才停」，而是没有任何页面能触发它们，只能等有人手工启动持续 Worker。这与 §2.10.1
「推进 Owner 收归服务端」不矛盾——那一步把责任从前端 effect 收到应用函数，却把「谁周期性调用」
留在了一个没人启动的进程里。

- **新执行者挂 API，不挂 Supervisor**（取舍与备选见 [ADR-039](../../decisions/ADR-039-background-work-tick-host.md)）：API 是唯一在所有拓扑都常驻的进程；Supervisor 的主循环
  是串行派发路径，一次成员唤醒的模型调用在租约内可持续数十秒，内联进去会推迟同进程的 Run 派发。
  `runtime/background-work-scheduler.ts` 复用三个既有 tick，不新增状态机、命令或第二套调度引擎。
  认领身份是 `api:<pid>`：宿主重启后的新进程不能顶着旧身份接续一条可能还活着的租约。
- **与手工启动的持续 Worker 同时在跑是安全的**：领取 CAS、job 行锁、请求行命令身份与租约清扫
  都在各 tick 内部。真实双宿主用例观察到一条消息只有一位结算者，只产生一条回信与一条
  `kind='MEMBER'` 调用账本。
- **维护排空与崩溃接续沿用原协议**：准入门在 tick Owner 函数内部（`web-import-runner.ts:42`、
  `conversation-execution-autostart.ts:47`、`member-wakeup.ts:157` 各自 `readAdmission(..., 'share')`
  先退出），派发器不重复判断；排空期间过期 CLAIMED 行也不清扫，恢复准入后才由
  `sweepExpiredWakeup` 在尝试上限内回到 RECORDED 接续，超上限按 `WAKEUP_ATTEMPTS_EXHAUSTED`
  收口，不改成静默重发。空闲时候选查询返回空集，不产生模型调用。
  同日 `advanceGoals()` 补上同一栅栏（§2.12）：目标推进的**投递下一轮**属于新执行，排空期间
  不准入；**控制意图落定与已结束轮次的记账**仍在准入判断之前照常收口，排空不冻住了结。
- **本轮不动的归属**：`runAssistGoalTick` 仍归 Supervisor、`runAssistGenerationTick` 仍由
  一次性 Worker 承担，各自只有一个驱动者；把它们并到 API 会造成同一个 tick 两个竞争者、
  并把派发决策拆成两处。
- **仍未闭合**：真实 Tauri 窗口的隐藏/销毁、Job 对象与「明确退出后不再发起本机执行」只有
  代码路径与进程级用例支撑，缺实窗证据（见[验收表](../../testing/overall-acceptance-2026-09-28.md)）。

### 2.12 与长期自主协作机制的差距对照（2026-11-01，ENG-SA-01 审计）

以 DeepSeek Super Agent 的五类机制为**对照轴**，逐条标注本项目当前事实；它是参照物，不是照搬目标。
标签只用五种：**已实现**（有代码与测试证据）／**部分实现**／**设计已确认未编码**／**新增未确认建议**／
**明确排除**。本节只核定边界与差距，不改变当前阶段与开发顺序；范围与前置约束仍以
[ADR-034](../../decisions/ADR-034-persistent-project-agent-team.md) 和[路线 §16](../../requirements/post-v1-roadmap/part-02.md#16-项目级长期-agent-团队与跨会话协作)为准。

**A 路由与执行者（Router / Worker）**

| 对照机制 | 本项目事实 | 标签 |
|---|---|---|
| 中心 Router 在多个执行后端之间选型 | 不存在选型组件：`run_command_outbox` 一行只被一条串行派发链消费（`worker/supervisor-main.ts:257` `listPending(1)`），后端固定为「一次性 Node Worker ＋ LangGraph」；`gateway/adapter-metadata.ts` 是静态能力描述表，`application/gateway-actions.ts` 按 `capability_key` 硬编码分支 | 明确排除（AGENTS.md 已列「不提前建设通用 Router Runtime」） |
| 一次一条命令的独占领取 | `run/run-dispatch-repository.ts:18-23` `for update skip locked`、`:228-239` `claimInvocation` epoch+1 且 `where status='IDLE'`、`:178-199` outbox/invocation 行锁；`application/run-dispatch.ts:26,31,36,61-63` 再叠加准入门、项目写锁与 `PAUSED`/`WAITING_APPROVAL` 判断 | 已实现 |
| 后台 tick 需要常驻驱动者 | 见 §2.11；本轮补齐 | 已实现（§2.11） |

**B 事件驱动与会话订阅（event-driven / Thread Subscription）**

| 对照机制 | 本项目事实 | 标签 |
|---|---|---|
| 状态变化推给前端 | 只有两条 SSE：`api/run-events-api.ts:81` 每帧只发 `event: run_hint` 与 `{kind}`，是「重新 GET」的提示而非载荷，且服务端自身按 `POLL_MS = 1000`（`:13`）轮 `run_events`；`api/preview-events-api.ts:84-167` 是同一 DTO 的重复投影，无事件表 | 已实现（但语义是提示，不是推送事实） |
| 事件与业务事实同事务 | `migrations/0012_m03_run_events.sql:19-97`：触发器写 `run_events`，序号在 Run 行 `FOR UPDATE` 下分配，表只授 SELECT/INSERT，前端可断言连续（`run-events-api.ts:80`） | 已实现 |
| 成员消息／会话生成完成／执行请求／定时事项有订阅面 | 四条都**没有**推送面：`assist_session_todo_events`、`work_segment_events` 无 SSE 路由，`api/routes.ts:178-239` 未注册任何相关订阅入口；前端靠定时轮询（`workbench/src/views/AssistView.tsx:4669,4991`、`components/RecentWorkRail.tsx:106-110` 等） | 设计已确认未编码 |
| 唤醒改由事件触发而非秒轮询 | 现状是 §2.11 的 1s 轮询；改为 DB 通知（如 `LISTEN/NOTIFY`）能去掉最坏一秒延迟，但要新增连接生命周期与重连补扫，收益仅是延迟 | 新增未确认建议 |

**C 异步多任务与执行隔离**

| 对照机制 | 本项目事实 | 标签 |
|---|---|---|
| 同一实际工作目录跨 Task 互斥 | `application/gateway-actions.ts:1420-1423`（占用即 `RESOURCE_OCCUPIED`）与 `:558-564`（重叠检查 `rootsOverlap`）；数据库偏唯一索引 `migrations/0008_*.sql:129` `uq_resource_occupied` 兜底 | 已实现 |
| 租约过期不等于旧进程已停 | 注释即写在代码里：`application/run-dispatch.ts:58-60`；收口靠停止证据与 `pg_advisory_lock`（`worker/supervisor.ts:64-66`，键为 `relay:stopped-run:<runId>`） | 已实现 |
| 并发上限 | 只有结构性约束：一条 Task 一个活动 Run（`migrations/0004_*.sql:88-95`）、一个会话一条 RUNNING 消息（`assist/assist-repository.ts:1040-1060`）、桌面前台输入单例行。派发宽度是 `listPending(1)` 的串行循环，**没有**跨项目的全局 Worker 上限或令牌桶 | 部分实现（缺“同时最多 N 个执行者”这一显式闸） |
| 模型消耗有预算闸 | `model/model-call-repository.ts:176-241` 目标额度与 `ModelScopeBudgetError`；`application/task-chains.ts:126` 预算耗尽即 `BUDGET_OR_USAGE_UNKNOWN` | 已实现 |

**D 上下文与跨会话接续（Context / continuation）**

| 对照机制 | 本项目事实 | 标签 |
|---|---|---|
| 上下文用量档位归会话 | ADR-037；运行时消费点 `application/assist-context-projection.ts:42,74,89-92` | 已实现 |
| 待办清单跨重启可恢复 | ADR-038：事件＋快照同一事务，按 `(session_id, tool_call_id)` 幂等，UI 与模型读同一份投影 | 已实现 |
| 子 Agent 补充回注主循环 | `application/subagent-supplements.ts:15-104`，仅 `conversation_mode === 'AGENT'`；消费在共享只读轮次 `application/assistant-readonly-round.ts:656-658,731` | 已实现 |
| 一条会话的工作交接给**新**会话继续 | 没有载体。`project_member_messages.handoff_payload` 只有写入与 DTO 回显（`application/member-conversations.ts:178`、`:89`），唤醒路径恒写 `null`（`application/member-wakeup.ts:301`），`apps/workbench/src` 零引用；Run 侧交接载荷同理（`application/control-requests.ts:241-242` 写入后无人读取） | 设计已确认未编码（ADR-034 的跨会话交接） |

**E 看门狗（第一层确定性监测／第二层可选语义诊断）**

第一层现状按「发现了什么、谁收敛、收敛动作」拆开，差距不在检测而在收口：

| 机制 | 本项目事实 | 标签 |
|---|---|---|
| 崩溃后接续原领取 | 成员唤醒：`team/member-conversation-repository.ts` 的 `sweepExpiredWakeup` 在上限内回到 RECORDED、超上限 `WAKEUP_ATTEMPTS_EXHAUSTED`；会话生成：`assist/assist-repository.ts:1188-1191` 过期 RUNNING 记 `FAILED`+`LEASE_LOST`（**只标记不重投**） | 已实现（收口强度不一致） |
| 孤儿 claim 收敛 | **2026-11-01 P1 已接上证据约束的收口与可见化**：常驻 Supervisor 对过期 invocation 先调 `recoverStrandedFencedClaim`（`worker/supervisor.ts:56-75`），只有 `run_worker_fences` 的持久停机依据允许重入，且 `run.worker_id` 非空立即退出；无证据或受阻时 `noteStrandedWorker`（`application/recover-run.ts:20-44`）写一条 SYSTEM 事实 `RUN_RECOVERY_REQUIRED`（同 Run+Worker 只留一条，活动流可见），不再依赖被宿主丢弃的 `worker_recovery_required` 帧。Run 级租约过期不告警：单步可超过 30s，只有领取心跳（`run_invocations`）可靠，因此 `scanRecoveryCandidates` 仍不用于滞留判定。桌面宿主协议与「运行事件启动后丢弃」未改。实机受害 Run `8d19e398` 这类无 fence 的领取仍不能被自动收口（[验收详情 条目 327](../../testing/acceptance-details/part-17.md#条目-327)、[条目 348](../../testing/acceptance-details/part-19.md#条目-348)） | 部分实现（证据约束下可自动重入＋人可见事实；无停机证据仍需人工/OS 证据） |
| 人工等待过期 | `review/review-repository.ts:98,107` 的过期只在读取与决策时惰性执行，`api/routes.ts` 未注册相关巡检 | 部分实现（未被查看的 Review 长期 `OPEN`） |
| Gateway 结果歧义核对 | `application/gateway-reconcile.ts:21` 仅由 `worker/supervisor.ts:121-136` 的停止核对与人工 POST 触发，没有周期 reconciler；UNKNOWN 保持原 `operation_id` 不重发 | 已实现（符合「不盲重试」约束） |
| 第二层语义诊断（判断“进度是否合理”而非“租约是否过期”） | 完全没有；也不该由进程自己判断业务完成 | 新增未确认建议 |

Watchdog 的不可越界约束（本轮核定为边界，不是待议项）：监测者**不得**自行提升权限或放宽档位、
**不得**放宽验收条件、**不得**重试 UNKNOWN 的外部动作、**不得**宣布 Task/Run 业务完成；它能做的只有
按原 Owner 收口租约/控制意图，以及把事实呈现给人。第二层若要做，只能在第一层已把「滞留」变成
可见事实之后，作为可选诊断建议出现，且默认不自动执行。**不新设 Watchdog 进程**：现有 Supervisor
已经常驻并已在检出，缺的是给它接上既有恢复 Owner 与一条人可见的通知，属于扩展而非新增。

**本轮结论**

- 孤儿 claim 的收口与可见性（E 的第二行）已按 P1 最小收口：Supervisor 复用既有恢复 Owner，
  在持久 fence 且 Run 无归属时自动重入；没有停机证据时只写一条人可见事实，不按租约或重启
  抢夺执行权。Rust 宿主协议与「运行事件启动后丢弃」未改，因为可见事实落在数据库而非宿主弹窗。
  仍未闭合：无 fence 的孤儿领取需要人工/OS 停机证据，当前没有公开恢复路由；Windows 宿主实机
  与安装态未取证（见 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)）。
- `runAssistGoalTick` 曾是唯一不做准入判断的 tick Owner（`enqueueRound` 直接 `insertMessage`），
  维护排空期间仍会排入新的目标轮次。**2026-11-01 同日已复现并闭合**：反例先证明 DRAINING 下
  `advanced` 非空且新插了一条待生成消息，修复按其余 tick 的同形做法在 `advanceGoals()` 取候选
  与拿租约**之前**退出，前两个阶段（控制意图落定、已结束轮次记账）不受影响。证据见
  [验收详情 346](../../testing/acceptance-details/part-19.md#条目-346)；租约不被空占是这条
  检查位置的硬约束，否则恢复准入后要先等一次租约过期。
- 并发闸（C 第三行）与订阅面（B 第三行）是真实差距，但都没有本轮的复现证据支撑改动。
- 明确不做：云端常驻、跨设备执行、通用 Router Runtime、多 Agent 自主扩权、未经批准的自主执行。


## 3. Context Builder 管道

输入 `ContextRequest(task_id, run_id?, step_kind, target_refs, contract_ref, budget)`。查询 canonical facts 后生成 manifest，不从聊天历史恢复任务真相。

1. 校验范围：无 Project 的 Assist 仅包含用户当前文本与明确选中的非项目资料；Delegate 必须有 Project。
2. 加 Mandatory：任务验收、相关 HARD 规则、当前执行约束、不可跳过的证据与安全边界。
3. 加 Step-specific：Draft 取资料；修正取失败项+确切候选；Verifier 取验收/原文/产物/执行证据，排除 Worker 的自我评价；恢复取已完成动作身份。
4. 加 Relevant：显式选中资料优先，再检索同作用域 ACTIVE 信息；按稳定评分排序、按版本去重。
5. 预算：先计算系统/输出/工具 schema 预留；Mandatory 不可删。超限返回 CONTEXT_REQUIRED_OVER_BUDGET，展示需要缩小的输入；Relevant 可裁剪并记录排除原因。
6. 固化：保存实际采用片段/范围、来源版本/hash、模板/构建器版本、预算与裁剪记录；再交 ModelPort。

不强制某个模型 token 估算算法。支持 tokenizer 则精确统计，否则标估算并留余量；服务端拒绝超限时进一步减少可选输入，不能删 Mandatory。外部文本在独立数据段标记来源和不可信性，不得拼成系统授权。

新增 context_builds 的结果可复用已有 context_manifests；exclusion entries 仅解释筛选，不作为新事实表。缓存键包含契约、step、来源版本及 template_version；任意键变化不能命中旧 Context。摘要有 source_refs/version，失效后重建。

扩展配置补充：Context Profile 可增加已授权的必需输入或选择合法可选内容，不能删除核心 Mandatory；新增必需项缺失/超预算同样停下。Recipe 是已有 WorkflowVersion 的引用名称，不增加恢复器。Pack/Profile/模板的实际解析版本与摘要进入依赖快照及相关 Context 缓存键。轻量 Sources View 从真实 Manifest 投影，读取时重新鉴权；排除原因不能暴露无权资料的名称/ID/数量。来源引用说明输入依据，不提供模型私有思考或无证据的因果解释。Projection 只组织已获准事实，不改变上下文访问与业务规则。

### P11 当前实现边界（2026-09-23）

固定 `markdown-deliverable-v1` 的 BUILD_CONTEXT 已由 P05 占位换成真实 Builder：冻结 ExecutionContract 与当前 Project/Task/Run 为 Mandatory，修正轮失败证据为 Step-specific；同作用域活动 Knowledge/Memory/Decision 为 Relevant。P11 尚无用户显式 `target_refs`/Assist 请求入口，故先用 Task 标题前 12 字做有界字面命中，再按 `updated_at DESC,id DESC,kind` 从最近同范围资料补最多 3 条，总 Relevant 最多 10 条。`selection_reason` 分别记录 `TITLE_MATCH`/`RECENT_SCOPE_FALLBACK`；这只是确定性降级，不表示语义相关性。P12 接真实 Provider 前必须增加显式选择并复核最小必要输入，不能直接把近期但无关资料外发。

每个采用片段最多 1600 个 JS 字符，保存实际 UTF-8 字节范围、片段 SHA-256、原完整来源 SHA-256、不可变版本、内容及 `UNTRUSTED_DATA` 标记；受管 ArtifactVersion 先在短事务外核对原文件 hash/size，缺失或损坏记 `SOURCE_UNAVAILABLE`，不把 `content_text=null` 当成空资料。当前估算为规范 JSON 的 UTF-8 字节数除以 3 向上取整，默认 8192 token，上限中预留 1536；估算值不是 Provider 计费或精确 tokenizer。Mandatory 超限以 `CONTEXT_REQUIRED_OVER_BUDGET` 使 BUILD_CONTEXT 失败，不裁剪契约；Relevant 超限可整段跳过并记 `BUDGET_TRIMMED`。第一方固定 Profile `run-default@1` 只定义当前允许的来源与界限，Run Manifest 保存 Profile 摘要、Builder/模板版本、Skill=null；Assist 的第一方 Skill/Pack 注册与冻结见 [Skill 专题](../relay-skills.md)，不自动进入 Run Manifest。

独立 `context_revision` 随长期信息写入递增，Rule 写入也递增它但仍由 `rule_revision` 负责执行栅栏。Builder 在 authority→Task→Run 的提交事务中核对装配时的 authority/context 版本与 Project/Task revision，变化时不提交过时 Manifest。已成功的 BUILD_CONTEXT 在继续执行时按实际消费的 Task 标题、所属 Project 和验收版本，以及 authority/context/Project 修订判定来源是否过期；Task 行修订仍记录在 Manifest 中，但审批或状态变化本身不重做成功草稿。DRAFT 前且没有外部效果的来源变化可以重新 BUILD_CONTEXT，新片段生成新 hash，旧 Manifest 保留。

固定 Mock 图的 Gateway 动作在 Admit 的 authority→Task→Run 短事务内再次核对原 Manifest；审批等待期间来源过期时不执行 Fake 写入，保留原动作身份与拒绝依据。效果已发生而受管候选尚未发布时，后续来源变化阻断 BUILD_CONTEXT/DRAFT 重做，须按原动作身份核对。发布成功后不重放或抹掉效果证据，VERIFY/COMPLETE 仍依冻结 CheckPlan、当前验收与各自 Gate 判断，修正回路会重新装配。列表与详情读取当前范围、根状态、Memory 到期和受管文件可用性，过滤无权来源及其排除项，不返其 ID/名称/正文/数量；历史快照不授予新的动作准入。Verifier 不消费 Manifest 中的 Worker 自评。无 Project Assist 尚无 P12 端口，本段不为它制造 Run 或假资料。

2026-09-25 显式来源选择入口（M04 非凭据部分，开发自检）：Delegate 命令新增可选 `context_sources`（KNOWLEDGE/MEMORY/DECISION 根 + 具体不可变版本，最多 10 条），随执行契约冻结为 `context_sources`。Delegate 事务内校验根的 Workspace/ACTIVE/Project 作用域与版本存在性，失败不创建 Run；构建期根停用或版本缺失按 Relevant 既有语义记 `SOURCE_UNAVAILABLE` 排除。Builder 装配顺序按本节设计：显式选中资料优先（`EXPLICIT_SELECTION`，读取冻结引用的版本而非根当前版本），同作用域 `TITLE_MATCH` 检索保留，存在显式选择时不再做 `RECENT_SCOPE_FALLBACK` 最近资料补位（最小必要输入复核的第一步）。无显式选择的既有行为不变。尚无前端选源管理页；真实 Provider 外发仍关闭，`RECENT_SCOPE_FALLBACK` 仅在无显式选择时作为确定性降级保留。

## 4. 检查器与总判定

CheckPlan 由验收与规则映射确定，Worker 无写权。内置 checker 首先支持 Markdown 必需节、产物类型/数量、引用标识存在；每个都声明检测范围。Semantic checker 提交 PASS/FAIL/UNCERTAIN 和可定位证据，不接受无证据的高置信数值。

Checker ERROR 与结果 FAIL 区分；同 checker 两次连接重试仍不可用则 HUMAN/PAUSED 并保留未决。人类只可对允许 HUMAN 的项判断，不能通过“接受全部”覆盖 HARD 失败。完成前重新核对绑定集合与适用性。

检查器实现端口 `check(CheckInput) -> CheckOutcome`；registry 只注册内置 checker，不下载插件/执行用户表达式。规则 enforcement 与可用 checker 不匹配时不可 Ready/Delegate，不悄悄降级为建议。

P10 当前固定 Workflow 已在 Delegate 前解析有效 Rule 版本，并把来源引用与对应 criterion 冻结到同一 ExecutionContract；VERIFY/Review 继续从该快照重建 CheckPlan。HARD 的 POST_CHECK 只接受当前确定性的 Markdown 结构/引用检查器；HARD PRE_ACTION 尚无接入 Gateway 的 Rule 检查路径；HARD SEMANTIC 必须使用已配置的真实 `semantic-model-v1`，缺少时返回 `RULE_ENFORCEMENT_UNAVAILABLE` 而不授予 Run。普通验收条件的 `SEMANTIC` 在 Delegate 时冻结真实模型检查器；未配置真实模型时改为 `human-evidence-v1`，保持未决并进入人工 Review。`fake-semantic-v1` 只供显式测试夹具，VERIFY 会拒绝未授权的 Fake 检查计划。Rule 更新由 Workspace authority 版本栅栏阻止旧 Run 的下一步/下一次 Gateway 准入，已发生的效果仍保存原结果；影响范围与代价见 [ADR-009](../../decisions/ADR-009-rule-revision-fence.md)。

## 5. AI Assist 与提案

Task.mode 明确为 ME、AI_ASSIST、DELEGATE_AI。HUMAN 可用显式命令切换 ME/AI_ASSIST；Delegate 用例原子设置 DELEGATE_AI 并授予执行权；安全 Stop/Handoff/失败释放后设 ME，完成保留当次 mode 供展示，重开默认 ME。mode 不授权工具，也不代替 executor/status；仅切换面板/工作台不修改 mode。

Assist 不生成 Run、不持有 Task owner；保存 assist_sessions/messages（来源与保留设置）仅服务对话，不参与业务判定。请求绑定当前 Project/Task/选中 refs 和 ContextManifest；用户切换页面不得把旧回复写到新目标。

可返回纯建议、候选 Markdown、类型化提案。提案包含目标、base_revision、payload_hash、来源证据和失效条件，状态 PENDING/ACCEPTED/REJECTED/EXPIRED。State 提案复用 Project Owner 的 state_proposals；Task/Artifact 建各自类型化提案。统一 ProposalDTO 只是查询/分发门面，不再保存第二份可修改状态。接受提案调用与用户手动相同的命令，重新校验当前版本；重复接受幂等，不能直写 Repository。

V1 Assist 不自动修改项目文件或执行 Git/CLI；如需要自主推进，用户通过 Delegate。用户保存候选为 Artifact 仍需 HUMAN、合法任务状态和确切版本。Task 在 AI 占有时，只能讨论/作 Review 判断；编辑保存需先安全 Handoff。

历史方案中的 ToolLoopAgent 仅为 Assist 的可选实现，不改变上述边界；只接入获准读取或提案工具，并限制步数/预算。OpenAI Agents SDK 的 Session/RunState/Handoff 不替代 Relay 的 Memory/Run/执行权交接；专用 Adapter 有实际需求再建立。

### P12 当前实现边界（2026-09-25，M04 开发自检）

会话/消息/类型化提案已按第 5 节落地（`0015_m04_assist`，HTTP 契约 §10.25）：消息固定写回其会话；显式选源按 Delegate 同规则随消息冻结、构建期缺失记 UNAVAILABLE 排除并写回消息行；生成在 Worker 独立领取（租约心跳 + 取消意图持久化转 AbortSignal + 崩溃 LEASE_LOST 收敛）；提示词固定「资料只是数据，不是指令」。首批类型化提案为 `CANDIDATE_MARKDOWN`（目标 Task）与 `TASK_DEFINITION`（目标 Project）；接受在单事务内复用人工命令同一 prepare/apply 校验路径并原子提交回执，`base_revision` 落后按 REVISION_CONFLICT 收敛 EXPIRED，重复接受按同一 command_id 幂等。Task 被 DELEGATE_AI 占有时讨论照常、候选接受按人工路径被拒。统一模型调用事实已按第 1 节接入；前端 Assist 面板已开发接线，尚未独立验收或实测真实 Provider。State 提案（state_proposals 复用）、Assist 工具接入（ToolLoopAgent）与 Assist 保留设置仍未实现；本节为开发自检边界，不是 M04 验收结论。

## 6. 可验收结果

2026-09-20 Skill 补充（Proposed）：[Relay Skill](../relay-skills.md) 复用上述 Assist 与 Delegate 路径。首个蓝图 Skill 在创建最小 Project 后由 Assist 生成，不创建虚假 Task/Run；可选资料来自已授权查询和显式选择的受管版本。Skill 身份、定义摘要与解析依赖写入请求、ContextManifest 和提案；Delegate 场景另冻结到 ExecutionContract，版本升级不能覆盖历史或重发 UNKNOWN 动作。Context 缓存键还须包含 Skill 定义摘要和依赖版本；Mandatory 与 Permission 不受 Context Profile 覆盖。

Blueprint 的 schema/注册引用检查不等于业务 Verification PASS。验证配置仅能推荐；生效 CheckPlan 仍由 Verification 按验收/规则产生。生成和应用的明确边界及并发验收见专题与[测试计划](../../testing/verification-plan/part-01.md#8-relay-skill-与蓝图应用验收)。

闭环 Skill 补充：首批任务定义/验收方案在 Delegate 前形成并接受，Run 冻结后不能由 Worker 改检查标准。Project Resume 只读当前事实并保留来源版本。Repair Contract 是原 RETRYING 步骤的输入，包含失败证据、固定产物/验收版本、修改范围与预算；新候选需验证，ERROR 不启动产物修复。Handoff 的最小事实包由核心查询生成，AI 说明失败不阻塞安全控制；确定性 State delta 不经模型生成或 Skill 调用，仍在 CompleteTask 事务计算。完整职责见[闭环目录](../relay-skills.md#7-首批闭环能力与后续目录)。

Fake 场景固定涵盖合法输出、结构错误、缺资料、必需 Context 超限、checker 超时、修正耗尽、审批等待、延迟结果、取消。模型成功示例不能代替这些测试。A04–A06、B01–B08、C01–C09 与 D01–D06 是业务依据。

Context 历史重放只能证明“输入可重建”，不保证随机模型产生相同输出，不提供模型私有思考的展示或审计。Provider 协议要求的必要回传字段与普通摘要分开处理，目标边界见第 8 节；不能把本条当作丢弃协议必需字段的理由。

## 7. 产品 Agent 提示词与输入协议

2026-10-03，用户确认产品 Agent 采用有判断的项目搭档、范围内自主决策及显式连续授权边界；行为定义归[产品总纲 §0.6](../../requirements/product-spec/part-01.md#06-agent-协作行为2026-10-03已确认设计)。完整目标模板草案、消息/资料分层、工作模式、Skill/工具说明、输出追溯及当前源码差距只在[Agent 提示词设计](../agent-prompt-design.md)维护；运行程序不加载该设计文件。

用户随后明确授权接入，现有 Assist 对话/提案、第一方 Skill、DRAFT 与请求解释已引用 [agent-system-prompt.ts](../../../apps/api/src/workflow/agent-system-prompt.ts) 的固定公共核心；语义检查保持独立窄提示词。专用规则继续限制各入口实际职责和原输出 schema，DRAFT 仅调整既有 CANONICAL 工作约束标签，资料/工具正文仍是数据。未引入通用工具循环或跨任务授权。评价规格见[测试计划 §18](../../testing/verification-plan/part-03.md#18-agent-提示词与输入协议评价目标设计)，工程结果只见统一功能验收表，真实模型评价未运行。

## 8. 会话压缩与消息文件恢复

2026-10-11，产品目标与控制边界已确认。2026-10-19 接续普通 AGENT 的持久短期摘要与长期确认事实召回，工程边界见 [ADR-028](../../decisions/ADR-028-memory-layers.md)、协议见 [HTTP §10.99](../../api/http-command-contract/part-07.md#1099-长短期记忆接口2026-10-19)。本次不实现 Run 中途压缩、Provider 原生压缩、思考协议完整持久恢复或消息发送前文件恢复；文件检查点与 LangGraph Run 检查点仍各归原 Owner。阶段和实际成绩分别归 CODEX_NEXT_STEP 与统一验收表。

### 8.1 模型容量、工作预算与压缩时机

用户偏好模型上下文窗口为 **256K–512K tokens**，该值不表示压缩阈值，也不假定所有 DeepSeek 型号、服务商或接入方式都支持此容量。实施时分别核定模型实际窗口、应用允许的工作上下文预算、输出及必要增长预留、自动压缩触发策略；当前 `max_call_tokens` 和 Context Builder 的片段预算均不能冒充物理窗口。

2026-10-30 用户接续确认应用工作预算可选 **256K / 512K / 1024K**，另保留跟随默认；这不扩大模型实际能力。短期会话的自动整理与输入保护统一消费冻结有效调用预算，替代真实模型路径原有固定消息数/字节阈值；工程公式与兼容回退归 [HTTP §10.99](../../api/http-command-contract/part-07.md#1099-长短期记忆接口2026-10-19)。原 Owner、检查点事务、恢复与来源失效边界不变。

分批接续仍由 Assist/Application 协调既有持久请求：冻结父检查点与本批原文，完整轮次范围逐批 CAS 发布，模型调用不进入长事务；旧原文保留，当前工作读取检查点＋增量，不反复加载累计前缀。资料装配压力可先把原助手消息重新排队等待整理；活动工具循环只作完整请求容量检查、提前收尾或明确停止，不在途中重放动作或修改活动工具协议。取舍见 [ADR-028](../../decisions/ADR-028-memory-layers.md#分批接续实施细化2026-10-30)，具体阈值及兼容语义仍归 HTTP §10.99。

支持手动 `/compact` 和自动压缩，自动策略不能仅在接近硬上限时才启动。按新增上下文预算与已完成工作节点提前整理，在完整请求/工具轮次的安全边界建立检查点；硬上限检查仍在每次实际调用前执行。可用输出和下一步所需增长须留余量，Mandatory 或活跃协议段仍放不下时停止并报告，不能删约束硬凑。

先分层处理：过大的旧日志和重复读取按来源引用及有界摘录整理；已结束的旧讨论与工具结果进入接续摘要；近期用户原文、关键约束、未决决定、当前进展和必要活跃工具链优先保留。新消息和工具结果追加到当前检查点之后，避免每轮重新总结整段历史。具体高低阈值、增长额度、保留长度及防反复压缩策略是待实测工程参数，不在本轮预定数字。

### 8.2 DeepSeek 的协议与缓存

压缩以 DeepSeek 的稳定接续、缓存和总成本为首要适配目标，不能只验证普通文本调用成功。默认由当前正在工作的模型生成摘要：会话普通请求使用当时生效的会话配置，活动 Run 使用原冻结模型，不另配便宜摘要模型。

固定公共核心、Skill 定义快照和必须稳定的协议前缀，随后组织版本化接续摘要与新增轮次。尽量避免反复改写前缀；规则、来源权限或定义实际变化时仍按原失效协议重建，不为缓存沿用过期内容。DeepSeek 的缓存依据公共前缀，命中是尽力行为；实际命中、缺失用量和压缩额外调用均按真实 Provider 读数计量，不保证固定收益。依据：[DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。

思考模式的工具调用链按实际 Provider 协议完整回传必要 `reasoning_content`、工具调用及结果，不能把必需字段概括成摘要或只重建空正文 `AIMessage`。协议数据由模型端口映射，依原会话/Run 身份最小保留供续接和恢复，不进入用户可见摘要、普通日志或思考审计；其可见性、保留/清除及存储保护在实施契约中核定。尚未结束的工具调用链作为完整协议单元处理。依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

首版推荐以应用生成的通用接续摘要支持 DeepSeek；是否同时接入其他 Provider 的原生压缩尚未逐项确认，不作为首版必交承诺。原生压缩与文本摘要不能互相假扮：不透明 Provider 压缩项按其协议使用，不能作为普通 Markdown 摘要修改。各模型能力需实际核验，不从“OpenAI 兼容”推定支持 `context_management`。依据：[DeepSeek Responses 兼容边界](https://api-docs.deepseek.com/guides/responses_api/)、[OpenAI 压缩协议](https://developers.openai.com/api/docs/guides/compaction)。

### 8.3 接续摘要与持久恢复

摘要至少包含原目标、本次范围、关键决定和用户偏好、当前进展与有依据的结果、下一步、未决问题、失败/UNKNOWN、必要文件/产物/工具来源及确切版本。模型推断与用户确认、成功与未结算必须可区分；摘要不修改 Project State、Task、验收、批准、权限或完成结果。

Assist/Application 拥有会话上下文检查点，Workflow 拥有 Run 续接位置，Context Builder 装配同一合法事实。检查点冻结来源覆盖范围/边界、摘要内容和摘要版本、模型配置/调用身份、来源引用及必要协议数据；提交时核对原上下文版本、在途身份与控制状态，旧压缩结果不能覆盖随后消息或新配置。原聊天与工具/动作历史保留可追溯来源，压缩只改变模型下一轮采用的工作窗口。

检查点成功持久化后才切换工作窗口；失败保留原窗口，接近硬上限则明确暂停下一次调用。重启按已提交检查点加后续记录重建，恢复不重新摘要全历史、不重新执行成功工具。正在进行的模型请求不原地替换输入；`/compact` 沿持久请求与安全边界处理，不伪装成已完成。摘要调用纳入原范围预算和实际用量；`model_calls` 继续只承担计量，不用成本账本存第二套原始对话或执行状态。

Codex 机制参考来自本地只读源码快照 `e7ea5f4a8658ebe49e879be933effed2340fa276`，不代表最新桌面版本：窗口与阈值分开，默认 total 阈值为窗口 90%，支持手动压缩、轮前/续轮和可配置轮末检查，并保存压缩后的恢复信息。入口为 `.research/upstream/codex/codex-rs/protocol/src/openai_models.rs`、`core/src/session/turn.rs`、`core/src/compact.rs`、`core/src/session/rollout_reconstruction.rs`。Relay 的提前分层整理是本轮额外设计，不能声称 Codex 默认更早压缩或已预测下一轮输入。

### 8.4 当前缺口与冻结条件

2026-10-11 调查时 Assist 仅截最近20条；2026-10-19 普通 AGENT 改为已提交摘要＋后续已结算原文，原记录保留，丢失/失效检查点回到合法原文；大于有界输入时明确失败。手动整理和自动触发共用持久请求、租约/CAS、既有计量和冻结工作模型；失败不发布新窗口。参数与来源撤销规则归 HTTP §10.99，不把固定字节阈值说成模型物理窗口。ModelPort 仍无完整窗口/压缩能力画像，思考协议的完整持久还原与真实 DeepSeek 缓存/摘要质量仍未验证。

2026-10-11 调查时模型来自[进程配置](../../../apps/api/src/workflow/model-port-config.ts)，[ExecutionContract](../../../apps/api/src/workflow/execution-contract.ts) 当时未保存 Provider/模型配置快照；该记录不覆盖后来模型选择及冻结接线。后续事实归 §8.6 与工作台 §27.5，成绩归统一验收表。旧 Run 缺少快照时仍须核定兼容/继续策略，不能伪造其“原冻结模型”或随会话设置静默切换。

实施前核定实际 Provider/模型能力、计数与余量、协议字段和持久恢复、检查点并发/CAS、预算与成本口径。以真实 DeepSeek 长任务对照未压缩或现有截取基线，观察接续成功率、约束遗漏、工具链错误、缓存命中、全部调用成本和延迟后冻结参数；不能以摘要变短或单次调用通过宣称收益。


# Runtime、Workflow、Context 与 AI Assist

2026-10-11 已确认产品增量：[第 8 节](#8-会话压缩与消息文件恢复)记录优先适配 DeepSeek 的压缩、持久接续和消息文件恢复边界；新增机制未实施、未验收。既有 Run、会话身份、Gateway、计量及业务完成 Owner 保留，具体协议与参数仍须按该节冻结。

> 当前接续（2026-09-24）：[ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)选择的 LangGraph.js 1.4.17 与官方 PostgresSaver 1.0.5 已接入 M03 固定 Mock Workflow，后端固定图分片已独立验收，整体验收仍待 G01–G08。PG 持久 command/outbox 负责分发；一个 Run 只使用一个图线程，节点复用既有 `advanceRunStep` 业务入口。旧的 AI SDK Core/ToolLoopAgent 推荐仅保留历史解释。M03 Mock 创建、SSE、审批、取消和故障恢复整体验收通过后才进入真实 Provider。Run/Review/Gateway/完成仍归既有 Owner，检查点不能替代业务事实或外部效果核对。

日期：2026-09-19。状态：Proposed。状态迁移唯一事实源：[契约 02](../../contracts/02-state-and-execution.md)；验证：[契约 03](../../contracts/03-verification-and-approval.md)。

## 1. 运行职责与模型端口

本文件描述业务需要的职责，不要求每层自研。按[复用策略](复用策略.md)优先选用现成 SDK、Agent loop 或 runtime；P00 验证后明确唯一执行 Owner。当前 StepResult/ModelPort 是候选边界，只实现实际调用需要的适配，不为所有候选预建通用插件层。

Application 调用 Workflow 决定下一步，Runtime 只执行一次有界步骤。返回 StepResult（结果类型、产物/工具请求、证据、耗时、用量），不能修改 Task 状态。模型输出先按 schema 解析、校验引用和作用域，再变成受约束命令；自由文本中出现“已完成”不触发完成。

ModelPort 输入：模型配置版本、实际 ContextManifest、输出 schema、时间/令牌限制、取消信号。输出：结构化内容或 typed failure、provider request id、可获取的用量、结束原因。密钥通过 secret_ref 解析，不进入 Context/Trace。具体 SDK 在 P12 兼容验证时选择；第一实现是 FakeModelPort。

历史推荐为 AI SDK Core（已由 ADR-010 接续），当时选型状态见 [ADR-006](../decisions/ADR-006-typescript-first.md)。Delegate 由 Workflow 驱动单次 generateText/streamText：完整模型响应与工具意图先持久化，再经 Gateway 执行；不注册可绕过该顺序的自动 execute。恢复加载原参数和工具结果，不靠重跑模型生成“同一个”动作。必要 Provider 协议数据只在 Adapter 映射，断流半成品不执行。

`0018_m04_model_calls` 已为 DRAFT、SemanticChecker 与 Assist 的每次实际 Fake/真实模型调用追加一行 `model_calls`：新 `call_id` 关联原 StepAttempt（语义检查还关联 criterion/check_attempt）或 AssistMessage，DRAFT 另关联 Manifest；仅保存非敏感 Provider/模型标识、配置摘要、可得的 Provider request id、调用状态、已知 token 用量与错误类别。调用前独立提交 `STARTED`，模型返回后条件式结算；真实端口关闭 SDK 隐式重试，让一次端口调用对应一次 Provider 尝试。崩溃遗留的 `STARTED` 表示结局与计费未知，不自动改为零或成功。重入再次调用会新增 `call_id`，不覆盖旧失败记录；业务 Run/CheckResult/AssistMessage 仍由原 Owner 结算，计量表不成为第二个业务状态机。`0019_m04_draft_read_input` 为新 DRAFT 调用补结构化输入 SHA-256 与原读 operation/invocation 引用，旧调用列保持 NULL；这些列不复制正文。当前无公开计量查询 API 或成本金额推算。

2026-09-26 M04 Provider 端口开发片：`openai-compatible` 的默认 endpoint 固定为 `https://api.openai.com/v1`，不读取 SDK 环境中的隐式 base URL；自定义 endpoint 必须是可解析的公网 HTTPS 主机，拒绝凭据、查询、片段、IP 字面量及本机域名。每次 SDK fetch 限定配置的确切 origin/API 路径，发起前复核 DNS 地址并禁止 HTTP 重定向。DNS 预解析与实际 socket 建连不是原子操作，不能将该检查称作完整 DNS 重绑定隔离；此处 base URL 是受控进程配置，不是用户输入或通用外部 URL 代理。`ChatOpenAI.stream` 由端口内部消费，要求 SSE `[DONE]` 后才把完整内容交给 DRAFT/Assist/语义检查作业务结算；缺终止帧、断流、超时、取消、超出字节/令牌预算都不把半截内容结算为成功。语义检查只接受完整且字段受限的 JSON；缺失 usage 保留 NULL，已知超预算用量保留真实值。普通 `DISCUSS` 的生成中临时草稿见第 5 节；Run SSE 首字反馈仍是独立出口。

`0026_m04_model_call_budgets` 为真实 Provider 的每次 STARTED 调用冻结 token 预留；新调用前在短事务中锁同一 Run 或 AssistSession，DRAFT/SEMANTIC 共用 Run 计数、并发 Assist 消息共用 Session 计数。已结算且两项 usage 均已知时计实际值，STARTED/未知用量计冻结预留，历史无预留且未知用量的行按 scope 上限保守阻止；超额拒绝后不启动网络调用。单次输入上限用 UTF-8 字节/3 估算并加输出预留，不等同 Provider 精确 tokenizer 或计费；范围限额是多 Worker 共享的数据库门槛，模型/工具并发上限和真实 Provider 质量仍未验收。真实 Provider 的新 BUILD_CONTEXT 不选 `RECENT_SCOPE_FALLBACK`，升级前含该来源的旧 Manifest 在模型端口被拒绝，不因最近排序外发。端口内流式消费也不等于 Run SSE 已展示首 token，用户可见首输出延迟仍需完整链路实测。

`0028_m04_assist_live_preview` 只为普通、无 Skill 的 Assist `DISCUSS` 保存生成中临时文本前缀。端口收到文本片段后，用独立短事务按当前消息、Worker、取消状态 CAS 更新，数据库锁不跨模型网络等待；前缀最多 16 KiB UTF-8，按完整字符截取。首片段立即写入，生成期间后续写入至少间隔 100 ms，完整输出返回前可再刷新一次。独立 API 进程可按 Workspace/Session/Message 读取累计前缀和递增 revision，断线后重读即可；读时复核当前目标和本轮及历史引用来源，失权隐藏内容。取消、失败、租约过期或完成后删除临时行，完整消息仍由既有输出校验与原 Assist Owner 结算。该草稿不是 Message、Proposal、已接受事实或持久模型响应；结构化建议、Skill 与语义检查不公开原始片段。轮询可展示首批文本，但仍需真实 Provider 与客户端测量首字延迟，不能把这项开发自检当作真实连接或桌面体验验收。

`0029_m04_run_draft_live_preview` 为当前 Run 的 DRAFT 模型调用保存同样有界的临时 Markdown 前缀；每次写入在短事务内核对当前 Run/StepAttempt 的 Worker、claim epoch、租约、dispatch invocation、原 `model_call_id` 与待处理控制意图，不持锁等待模型网络。新的领取会删除旧前缀；旧 Worker 或重试轮次的迟到片段不能覆盖当前 Attempt。独立 GET 每次重新核对 Workspace、Task/Run、当前 Manifest 来源及 FILE_READ/WEB_FETCH 原动作对应的 Connection/Policy/Resource 可见性，来源失权只返回空草稿，不暴露来源身份。取消请求、租约过期、Step 完成/失败时草稿不可用；最终候选、Artifact、验证与完成仍走原业务 Owner。当前 Run SSE 仍仅传事实刷新提示，生成中文字由独立短轮询读取；端口片段实际可见延迟、真实 Provider 与桌面交互仍待测。

2026-09-29 失败分类统一：`model_calls.error_kind` 与连接验证的 `error_category` 共用一套 Provider 失败词表（AUTH / RATE_LIMIT / TIMEOUT / STREAM_BROKEN / PROTOCOL / NETWORK），实现在 `model-error-classification.ts`。分类只依据 HTTP 状态与传输层特征（沿 `cause` 链检查，覆盖 `TypeError: fetch failed` 包裹真实原因），不解析自由文本；无法归因给 Provider 的失败（预算、工具拒绝、语义解析、租约）保留 Relay 自身错误名，套用 Provider 类别会误导排查。机制借鉴 `.research/upstream/deepseek-harness/packages/llm/llm/src/error.ts` 的稳定错误码与 cause 链展开思路，按本项目词表实现，未引入上游依赖。Assist 失败出口同步保全 `provider_request_id` 与已知用量：模型可能已计费时，证据必须跟着消息行落库，缺失保持 NULL 不补 0。该分类目前只写入账本，Assist/Run 界面显示的仍是 Relay 级 `error_code` 与步骤 `reason`；要让 Provider 类别上浮需要给 `assist_messages` 加列与迁移，尚未做。

## 2. 固定 Workflow

内置 `markdown-deliverable-v1`：BUILD_CONTEXT → DRAFT → PERSIST_CANDIDATE → VERIFY → COMPLETE。CREATE Run 时冻结 ExecutionContract；BUILD_CONTEXT 只装配/复核，不修改冻结的验收内容。修正回路由 Workflow 的 RETRYING 处理，不引入任意图结构。

M03 当前源码以一个官方 `StateGraph` 编排该固定流程：`advance` 节点每次只调用一次 `advanceRunStep`；实际 OPEN 的验证类 Review 进入 `awaitCommand` interrupt，FAKE_WRITE 在 DRAFT 后、PERSIST 前进入 `gatewayAction`，M04 的 FILE_READ/WEB_FETCH 在 BUILD_CONTEXT 后、DRAFT 前进入同一节点，ASK 的 ACTION_APPROVAL 进入 `awaitAction` interrupt。两个 interrupt 都核对当前 Review 的确切 ID、类型及原决定，工具路径还核对冻结的原 `operation_id`；旧 RESUME 遇到后继 Review 只能确认自身投递，不能唤醒新 Review。升级前已完成 DRAFT 的读动作保持旧 DRAFT 绑定和原 Review/operation 身份，不重做草稿；修正轮复用已成功的读证据。Gateway 准入、动作身份、效果核对和 Run/Task 变更仍由原 Owner 负责，图只保存 Run ID 与路由提示。`thread_id=run_id`；LangGraph 1.4.17 的根图实际写入空 `checkpoint_ns`，版本隔离使用固定物理 schema `relay_graph_v1`，不依赖传入 namespace。官方 Saver 与业务提交是两个事务：崩溃后按原 command/attempt/operation 身份重入，不能将图状态视作已发生效果的凭据。Worker 启动前只读核对 Saver schema，不执行 DDL；安装见[部署设计](../deployment/本机部署.md)。M03 固定图与 Mock Gateway 的既有分片独立复验结论见[M03 独立验收](../testing/m03-independent-acceptance.md#windows-action-context-修复与新版-mock-试用链独立复验)；M04 读入模型切片已进入开发自检，尚未独立验收。

M03 在途 Mock 取消由独立 Worker 观察 PostgreSQL 中已提交的 `PENDING` 控制请求，并向当前图、FakeModelPort 与 Gateway 传递 `AbortSignal`。DRAFT 模型等待在业务事务外；步骤结果写入前仍在 Task→Run 短事务里复核控制，未发生外部效果时不把中止结果写成成功。Worker 停止后，监督器须先观察子进程 `close` 并 fence 旧 epoch；若没有未决效果，恢复用例才把旧纯计算 `RUNNING` Attempt 结清，再应用控制。已派发或结果不明的效果保留原 `operation_id` 和资源隔离，继续按既有核对路径处理。Windows 强制终止子进程不能假定模型在进程内收到可处理信号；只有停机证据可用于恢复。真实 Provider 的取消仍属 M04。

| 步骤 | 输入 | 持久输出 | 重试/恢复 |
|---|---|---|---|
| BUILD_CONTEXT | 契约、当前合法事实、所需资料 | 不可变 Manifest | 必需内容缺失/超预算停下，不删除约束硬凑 |
| DRAFT | Manifest、输出结构 | 模型尝试记录、候选内容 | 纯生成最多 2 次基础设施重试，指数退避且可取消；这是推荐预算，可版本化配置 |
| PERSIST_CANDIDATE | 完整候选 | ArtifactVersion | 按稳定来源尝试 ID 去重；未知存储状态先核对 |
| VERIFY | 版本集合、验收与规则绑定 | Session/CheckResult | Checker 故障重试 checker，不重复生成；改产物产生新版本/Session |
| COMPLETE | 适用证据、执行权 | CompletionRecord、Task/Run/State | 只重做短事务，绝不重跑成功工具 |

M04 读证据输入切片：冻结的 FILE_READ/WEB_FETCH 意图只在 Gateway 授权与原 Invocation `SUCCEEDED` 后供同 Run 的 DRAFT 消费；DRAFT 领取前没有成功读取则不得调用模型。使用原操作结果中的规范目标、原始响应/文件 SHA-256、提取文本的 SHA-256、实际截取文本的 SHA-256、`operation_id` 与 `invocation_id` 组装 `UNTRUSTED_DATA` 数据段。文件最多读取 128 KiB，网页适配器保持自身上限；模型片段最多 16 KiB UTF-8，按完整字符截取，并按 Manifest 既有 UTF-8 字节/3 估算连同原内容计入总预算和输出预留。不足时先缩短读片段，元数据仍超预算则以 `CONTEXT_REQUIRED_OVER_BUDGET` 结束 DRAFT，不发生模型调用。原 Manifest 不改写；每次实际模型调用的结构化输入摘要及原读身份保存在 `model_calls`，`DRAFT.result_ref` 同时保存输入摘要。已结算的类型化读取 `FAILED` 保留原 operation/Invocation 失败证据，并将 Run 收敛为 FAILED、释放 Task 执行权；若已有待处理控制意图，则先释放 Worker claim，再由既有安全点应用控制。成功动作恢复时复用原结果，不因图 checkpoint 丢失重读；`DISPATCHING`/`UNKNOWN` 仍按原 Invocation 核对，不能直接给模型。此切片为开发自检边界，不代表真实 Provider 或桌面验收。

Run 默认修正预算 2 次，与模型连接重试分开统计；总调用/成本上限由执行配置提供。耗尽进入 Review，不自动增预算。所有默认值进入版本化配置和 UI，不隐含为不可更改业务事实。

Development 的 `change-and-verify-v1` 目标流程：确认本次任务范围 → 读取实际基线 → 生成变化集 → 基线复核并在受管原目录应用 → 运行已配置检查 → 验证证据 → 完成。删除、Git 提交/推送与扩大范围分别按[任务范围授权规则](tool-adapters.md#12-本次任务范围内的工具授权2026-10-03)确认。2026-10-03 用户已确认默认原目录修改，替代此前隔离副本优先的建议；具体文件规则见[工具适配器 Files](tool-adapters.md#2-files)。复用同一 Run/Gateway/Review 机制，工具循环仍待实现。

执行器实现由 P00 复用验证决定，有界线程池只是一种候选。业务执行先按 DB 协议取得合法执行权；排队不等于持有资源写权。外部 harness 的 session/thread/turn 与产品 Run 显式关联，重复事件去重，不把 SDK 状态当第二套业务事实。每轮下一步前核查控制请求；进程退出时保存控制/核对信息，不能强行标记成功。框架 checkpoint 与业务完成事务不默认原子，恢复必须处理两边提交不一致。

### 2.1 Relay 内部工具循环接入方向（2026-10-03）

用户已确认接入方向：由 Relay 内部模型根据实际工具结果决定下一步调用，复用现有 LangGraph 编排与 Gateway 准入。外部 Coding Agent 协议适配不作为本轮传统工具能力接入的主路径；此次确认属于方案方向，尚未授权代码实施。

目标调用链为「模型请求工具 → Run 保存完整调用意图 → Gateway 权限/审批 → 本地适配器执行 → 保存并回传实际结果 → 下一轮模型调用」。模型请求与结果须沿用可追溯身份；审批、取消、资源互斥、UNKNOWN 核对及业务完成继续由既有 Owner 负责，具体执行规则复用[工具适配器](tool-adapters.md)与[恢复契约](../../contracts/04-recovery-and-commit.md)。当前模型端口拒绝工具调用输出，Run 只有固定动作链，不能将本节目标当作已实现工具循环。

审批粒度已确认，规则及当前代码差异见[工具适配器 §1.2](tool-adapters.md#12-本次任务范围内的工具授权2026-10-03)；首批范围归[工具适配器 §1.3](tool-adapters.md#13-首批内部工具范围2026-10-03)，默认修改位置及冲突自动适配归 [Files](tool-adapters.md#2-files)。预算耗尽沿用[契约 02](../../contracts/02-state-and-execution.md)的等待用户选择新预算、接手或停止规则，不自动增加额度。输入与结果持久化协议、循环具体限额及状态映射须在实施前核定；方案确认不直接修改运行中的权限或执行状态。

### 2.2 内部工具循环实施与验收顺序（2026-10-03，推荐方案）

以下是上述已确认行为的推荐实施拆分，尚未启动代码实施。沿用现有模型调用预算、Run/Gateway/Review Owner 与 LangGraph；保留固定 Markdown 生成及既有恢复路径。新工具请求/结果协议和所需的最小追加 migration 在开工时按实际代码冻结，不先制造通用工具转发 API 或第二套 Agent 状态机。

1. 只读循环：扩展 `workflow` 模型端口的完整工具请求/结果协议，接入 `application` 与 `worker/run-graph.ts` 的持久循环；补目录浏览、路径查找和内容搜索，接通现有 FILE_READ 与 GIT_READ。验证 Fake 模型按实际工具结果连续查找/读取/Git diff；断流半成品不派发，完成的读取结果恢复可追溯，已有生成流程回归通过。
2. 修改与检查：复用 `gateway-actions.ts`、`files/file-changeset.ts` 与 `cli-worker/cli-adapter.ts`，落地本次任务范围授权、普通编辑/检查 AUTO、删除 ASK、一次无副作用冲突适配及 Git/非 Git 文件差异。真实 PG/磁盘/子进程覆盖撤权、取消、基线变化、同目录写冲突、重复投递及写后保存回执前崩溃；UNKNOWN 保留原身份并阻止绕行，检查绑定实际变化集及配置。
3. 对话与结果呈现：复用协作工作区及现有 API 查询入口，显示工具进度、确切文件差异、检查结果、审批/冲突/恢复状态。组件与浏览器验证后，再以匹配源码的确切 Windows 包完成「查文件 → 修改 → 看差异 → 检查 → 修正」真实路径验收；业务完成仍走原验证/接受/提交入口。

每片自检与必要独立复核通过后再进入依赖片；实际成绩只写统一功能验收表。此节是规格和推荐顺序，文档检查通过不代表运行时工具能力通过。

完整执行输入见[内部文件与 Git 工具循环实施提示词](../../prompts/agent-native-tools.md)。2026-10-03 用户选择只生成提示词；用户随后实际下发该提示词，实施按本节顺序推进。

### 2.3 内部工具循环的对象、身份与恢复（2026-10-03 实施设计）

本节是按当前源码核定的最小实现设计，Owner 与取舍归本节，能力范围归[工具适配器 §1.3](tool-adapters.md#13-首批内部工具范围2026-10-03)。

**循环位置。** 工具循环是固定 Workflow 的 DRAFT 步骤内部行为，不新增 Run 步骤、不新增第二套状态机：模型返回工具请求 → 同一 DRAFT Attempt 落库 → Gateway 准入执行 → 结果回传 → 下一轮模型调用。`BUILD_CONTEXT`、`PERSIST_CANDIDATE`、`VERIFY`、`COMPLETE` 与既有固定动作链不变；没有冻结工具信封的 Run 走原单次生成路径。

**冻结信封 `tool_loop_action`。** Delegate 时可选冻结 `{ intent_key:'tool-loop-v1', resource_id, connections, allowed_tools, max_rounds, max_tool_calls }`。它是模型可自主调用的**上界**，不是授权：resource 必须在 Task 的 Project 下 ACTIVE，每个 connection 必须是该项目绑定该 resource 的 ACTIVE 连接，`allowed_tools` 只能是首批词表。信封不含 `operation_id`——每次工具调用的动作身份在落库时产生，见下。`max_rounds`/`max_tool_calls` 是循环自身预算，不替代 `model_calls` 的调用与 token 预算。

**身份。** 新表 `run_tool_calls` 是一次「模型工具请求 ↔ 一个 Gateway 逻辑动作」的持久对应，行 id 直接作为该动作的 `logical_operations.id`。因此：Provider 的 `tool_call_id` 只是本轮内的关联标签，不承担跨 Run/轮次唯一性；同一已落库请求的重放沿用同一行与同一 operation_id，`prepareGatewayAction` 的既有幂等分支返回原记录；断流、半截 JSON、非法 schema、未知工具、超预算与取消在落库前即拒绝，不产生 Operation。

**轮次与恢复。** 行上带 `round` 与 `step_attempt_id`，按 `(round, ordinal)` 重建模型消息：assistant 工具请求来自 `arguments`，tool 结果来自原 Operation 的 `result_ref` 投影。2026-10-13 增加 migration 0073，每轮首行不可变 `assistant_message` 保存本轮完整响应的前置正文与可选实际 `reasoning_content`，重建时与该轮工具请求配对；旧 NULL 行只能恢复空正文/无推理字段，不能补造历史。LangChain 当前出站转换省略该 Provider 字段，端口只对确实已有字段的 assistant 消息作局部回填，仍经原 guarded fetch、取消与调用计量，不改 SDK 隐式重试策略。数据不进入计量账本或工具轨迹 DTO，不保存凭据。只读助手/学习循环在当前进程的续轮中也传递这两个字段，未扩展其跨重启恢复。已结算结果复用原证据，不重新生成同一动作；mock 请求体往返不代表真实 DeepSeek 兼容或收益已经验收。

**状态与图路由。** 行状态 `REQUESTED → (PREPARED | WAITING_APPROVAL) → SETTLED`，另有 `REJECTED`（未派发，携带类型化原因）与 `ABANDONED`。`advanceRunStep` 在领取步骤 Attempt **之前**检查本 Run 的未决工具调用：有未决行时返回 `TOOL_LOOP_ACTION_REQUIRED` 并交出 `tool_call_id`，由 `worker/run-graph.ts` 的 `toolAction` 节点执行 prepare/dispatch/结算；ASK 走既有 `awaitAction` interrupt。这样 Gateway 的 `WAITING_APPROVAL`（会释放 Worker claim、把 Run 置为 WAITING_APPROVAL）不会被步骤结算事务覆盖，与现有固定动作链的 `gatewayAction` 节点同一形状。`REQUESTED` 行不需要资源 claim；`FILE_QUERY`/`FILE_READ`/`GIT_READ` 的 claim 由 `prepareGatewayAction` 在准入事务内建立并在结算时释放。

**不做的事。** 不新增 Gateway origin 词表（仍只有 `RUN`/`USER_IMPORT`）；不引入通用工具转发 HTTP API；不开放任意 Shell；不建第二套模型调用账本；不让模型最终回复推进 Task/Run 状态。

**检查失败后的修正与恢复（2026-10-05）。** `resolveToolLoopPlan` 从同一 Run 的冻结授权生成 `run_check.check_id` 的 enum 和可用 ID 说明；模型不再依赖猜测 `check-1`，也不接收可执行程序或任意 argv。普通非零退出回执仍保存 `outcome: FAILED`、退出码及实际输出，`buildToolTurns` 将其标为工具错误；`SETTLED` 只表示取得回执，不表示检查通过。

只有同 Run 的 `run_check`、确切 Operation/Invocation、有效执行权下的正常子进程关闭、正整数退出码且没有中断原因，才释放原资源 claim。它不是「没有副作用」的证明：检查已经产生的文件保留。Worker 按原 Operation/Invocation 与已释放 claim 返回 `CHECK_FAILED`，LangGraph 保存 `TOOL_CHECK_FAILED` 并返回原 DRAFT 的下一轮；模型在原预算与权限内读取、修正后重新检查。其他 CLI 失败、取消、超时、准入拒绝、失权与 UNKNOWN 继续停止/隔离。

恢复不能把失败改成成功：已 `SETTLED` 的工具行仍核对原 Operation；普通失败只有原 Invocation 为 FAILED、claim 为 RELEASED 才继续。UNKNOWN 不落 SETTLED；旧版已误落 SETTLED 的未知动作在步骤领取前按权威未决 Operation 阻挡。最终回复仍只生成候选，实际 Verification、Review 与 CompletionRecord 的门保持。根因见[开发审计 §26](../development/design-audit.md#26-传统-agent-检查与修正闭环2026-10-05)，规格见[测试计划 §20.9](../testing/verification-plan.md#209-传统-agent-检查失败后的自主修正2026-10-05)。

**检查入口的信任摘要（2026-10-07 实施）。** 授权冻结时由 `computeCheckTrustBasis` 实测一份 `check-trust-v1` 依据（入口程序 + 第一个位置脚本参数 + 受管根顶层构建/测试配置）并随授权落库；`evaluateScopeGrant` 在 `CLI_RUN` 分支先比 `executable_sha256`、再比信任摘要，prepare 与 admit 两处同一判定。同一 `check_id`、同一路径、同一命令名，只要入口脚本、被参数引用的脚本或构建配置正文变了，就不再 AUTO，退回人工确认并把 `SCOPE_GRANT_CHECK_CHANGED` 写进该动作的 Review `evidence.scope_decision_reason`，前端因此能区分「检查材料变了」「策略本来就要人工」与「权限被拒」。**被检查的源文件不是材料**：工作集本来就要被读取、修改、再检查，把它算进材料会让 §2.3 的检查失败修正链不可用。材料集合刻意有限（后续位置参数与检查程序 import 的兄弟模块都不在内），这是本版明确的范围限制。`run_check` 的可信 exit0 只表示这一次检查对其受验输入正常结束，不表示业务验收 PASS、人工接受或 Task 完成。规则归[工具适配器 §1.5/§1.6](tool-adapters.md#16-写差异与检查工具2026-10-04-实施)，规格见[测试计划 §20.10](../testing/verification-plan.md#2010-检查入口的信任摘要与检查证据适用性2026-10-07-实施)。

**当前实现边界（2026-10-03 A 片）。** 已接入并有真实 PG 证据：冻结信封、工具词表与参数校验、`run_tool_calls` 持久对应、`FILE_QUERY` 只读能力（目录浏览/路径查找/内容搜索）、现有 `FILE_READ` 与 `GIT_READ` 的模型侧触发、图上的 `toolLoopAction` 节点与 `awaitAction` 复用、准备与派发两个阶段的授权拒绝都作为类型化结果回传模型。`GRAPH_LAYOUT_VERSION` 由 1 升到 2；旧检查点按既有布局重建路径处理，不删除任何历史。

模型端口这一侧的行为变化需要单独记下：完整工具请求不再被一律拒绝，而是成为 `TOOL_CALLS`；只有**未声明**工具、半截参数、参数非对象才拒绝。由于端口读完整个流才判定，Provider 在工具帧之后上报的 request id 与用量现在也会被保全——此前这些证据会随「立即拒绝」一起丢失。Assist、Skill 与语义检查不声明工具，因此它们的既有拒绝语义完全不变。

**正文与工具并存（2026-10-04 改）。** 真实 Provider 会边输出正文边调工具，把这一形态判成「不支持的块」会让整个工具循环不可用，因此对**已声明工具**的入口改为：`TOOL_CALLS` 携带 `preamble`（该轮伴随工具请求一起输出的正文），候选正文仍只来自没有工具请求的那一轮。文本增量照常流式发布，携带工具请求的那个 chunk 自身的文本不作为增量发布。`preamble` 目前只存在于本次调用内，**尚未持久化、也未在下一轮回放**——恢复时模型看到的是 `content: ''` 的 assistant 消息加工具结果；补齐需要一条 migration（`run_tool_calls` 无空闲 JSON 列，`model_calls` 亦无），与循环预算的可变事实一并落地。

**当前实现边界（2026-10-04 B 片）。** 在 A 片基础上已接入并有真实 PG 证据：`FILE_WRITE` 与 `CLI_RUN` 的模型侧触发（`apply_changeset` / `read_change_set` / `run_check`）、本次任务范围授权（`run_scope_grants`，随 Delegate 事务落库）、授权在 prepare 与 admit 两处的一致校验、未配置检查按类型化原因拒绝且不启动子进程、删除在授权内仍回落单动作确认、撤权与过期后不再放行、基线冲突保留用户改动。语义与失效条件归[工具适配器 §1.2](tool-adapters.md#12-本次任务范围内的工具授权2026-10-03)与 §1.5/§1.6，持久形态归[物理设计 §59](../database/physical-design-postgresql.md)。

已知取舍：写入类工具的准入判定在 Gateway 内部完成，工具循环自身不持有第二套判定。`run_check` 只按 `check_id` 点名冻结清单，模型无法提交任意命令字符串。一次基线冲突后的自动适配**已接入并有真实 PG 出口**：`decideToolAdaptation` 按已落库行判定「这一次请求是不是对某个已结算冲突的合法重新适配」——基线必须等于冲突回执实测值、目标内容必须与被拒那次不同、一次只针对一个明确冲突的路径、只适配原始请求（适配过的行自己不能再被适配）；不满足就按类型化原因拒绝，请求不连 Operation、不写盘，并把回执实测值写进 `TOOL_ADAPTATION_STALE_BASELINE` 的详情，否则模型只能反复盲猜同一个摘要。`run_tool_calls.adaptation_of`/`adapted_path` 留痕，恢复核对时能看出「这次写入是对哪一次冲突的重新适配」。验收出口见[测试计划 §20.3](../testing/verification-plan.md)。

**循环的终止条件（2026-10-04 实施）。** 一轮工具请求「没有任何可派发项」时不立刻判定失败，而是在同一次准备内再问一次模型，并把已落库的类型化拒绝原因作为本轮结果回传。拒绝分两类，处理方式不同：

- **可修正**（参数非法、未知工具、越界路径等）：把原因回传后继续下一轮，由模型自己改对。把它们当终止条件会让一次笔误直接烧掉整个 Run。
- **终止类**（`TOOL_LOOP_ROUNDS_EXHAUSTED`、`TOOL_LOOP_BUDGET_EXHAUSTED`，以及 §2.6 的冲突适配停止原因）：模型再问一次也不会不同。给一次收尾轮；收尾轮仍只要工具，就不再兜底，由提交事务把 Run 停在 `WAITING_APPROVAL`，`wait_reason` 取本次准备里**第一个**终止类拒绝（预算类 → `REPEATED_FAILURE`，冲突类 → `HUMAN_TOOL`），并记录真实的轮次、调用数与拒绝原因。执行权仍归 AI：Task 转 `WAITING` 但 `executor_run_id` 与 `ownership_epoch` 不动，用户可选择新预算（新委托、新 Run 带更大信封）、接手或停止。冻结信封里的 `max_rounds`/`max_tool_calls` 不可就地调整，因此本路径不创建 Review——`RETRY_BUDGET` 决定分支强绑验证 session 与产物版本，复用会造出假关联。

此前这条终止条件完全缺失：预算用尽后所有请求被拒，步骤却直接进入候选生成，模型端口回放工具请求后落到 `UNEXPECTED_MODEL_RESULT`，真实原因被掩盖成「模型返回了意外结果」并终态 FAILED。

**停止意图与工具派发（2026-10-05 实施）。** Gateway 的准备与派发两处本来就会读待处理控制意图并拒绝（因此暂停期间一个字节都不会写），但工具派发此前把这个拒绝当成**未分类异常**抛出：`claimRunForGateway` 在 `executeToolLoopStep` 的 try 之外，它抛的 `GATEWAY_RUN_NOT_READY` 也不在类型化拒绝词表内。后果是 Worker 分不清「用户按了暂停」和「工具坏了」，一次人为停止被报成执行失败。现在该码单独映射为类型化状态 `STOPPED`，图状态记 `CONTROL_PENDING`（落到图的 `END`，不推进下一轮，把停止交回原控制出口）。

被挡住时 `run_tool_calls` 行**保持 `REQUESTED`**，不落 `REJECTED`/`ABANDONED`：暂停是可恢复的，行 id 又是这一次写入的动作身份，销毁请求会让模型重新派生一次写入并产生第二个 Operation。恢复后仍走同一行、同一 `operation_id`。

**终态 Run 的遗留请求（2026-10-07 实施）。** 暂停不是终态，所以上面那条保持 `REQUESTED`；但取消、失败、完成是终态，恢复入口明确拒绝它们。旧 Worker 拿着一个尚未派发的请求走到派发前而被 `GATEWAY_RUN_NOT_READY` 挡住时，若该 Run 已是终态，这一行会落成 `REJECTED`（reason `RUN_TERMINAL`，带类型化 detail）而不是永远停在 `REQUESTED`：既证明「未派发、未落盘」，又给历史一个可读的终态归属，避免留下一条看起来仍可能完成的悬空请求。约束 `ck_run_tool_calls_operation_binding` 要求未连 Operation 的行只能取 `REQUESTED`/`REJECTED`，因此这里用 reject 而不是 abandon。验收出口见[测试计划 §20.6](../testing/verification-plan.md)。

**一次基线冲突的自动适配（2026-10-04 实施）。** `apply_changeset` 命中真实冲突（变化集逐文件结果里的 `CONFLICT`）后，模型可以重新读取并再提交一次；这次提交只有在三件事同时成立时才算适配，否则按类型化原因拒绝且不连 Operation、不写盘：

1. 针对的确实是一个**已结算**行报告的真实冲突，且一次只针对一个路径（同时涉及多个冲突路径按 `TOOL_ADAPTATION_AMBIGUOUS` 拒绝——这不是可明确区分的修改）；
2. 提交的基线等于该冲突回执里**实测到的** `actualBaselineSha256`（`TOOL_ADAPTATION_STALE_BASELINE` 拒绝原样重试）；
3. 目标内容与被拒那次不同（`TOOL_ADAPTATION_CONTENT_UNCHANGED` 挡住「新基线 hash + 旧目标全文」这种冒充适配）。

深度限制在应用层判定：适配过的行自己不再作为新的适配来源，原始请求被适配过一次后再次冲突落 `TOOL_ADAPTATION_REQUIRES_HUMAN`，按上面的终止类路径停下并把差异留给用户。冲突目标已消失（`actualBaselineSha256` 为 null）落 `TOOL_ADAPTATION_TARGET_MISSING`，同样不自动继续。合法适配落 `run_tool_calls.adaptation_of`/`adapted_path` 指回原始请求与那一个路径，因此恢复后仍能看出这次写入的来源；新行是新动作身份，**不继承**旧的单动作审批。

这里更正一处既有记录：`0056` 的迁移注释称「只适配一次由深度约束保证」，实际该表的 CHECK 只保证 `adaptation_of` 与 `adapted_path` 同在同缺，深度限制由上述应用层判定实现。已应用的迁移不改写。

尚未接入、不得据此声称具备：`preamble` 持久化与回放、真实 Provider 的 tool calling 兼容与质量、真实 Windows 人工路径。协作页的工具进度与差异呈现（C 片）已在 2026-10-05 接入只读投影 `GET /runs/{run_id}/tool-calls`（规则见[工作台 §18.8](../frontend/workbench-design.md#188-工具轨迹的呈现2026-10-04c-片设计)），但**只读**：用户可主动触发的目录浏览与 Git 只读入口仍未接入，轨迹里的结果是模型本次调用的产物、不是可点入口；协作页的工具轨迹订阅 Run 事件流，流不可用时降级为按 Run revision 重读并如实显示「上次读取」时间。验收规格见[测试计划 §20](../testing/verification-plan.md)。

### 2.4 会话执行计划的归属与持久更新（推荐设计）

2026-10-03，仅补充文档与实施提示词。产品范围归[总纲 §0.7](../../Personal_Workflow_OS_Master_Spec.md#07-会话内可折叠执行计划2026-10-03推荐设计)，机制来源归[研究 §1.3](../research/p00-source-study.md#13-会话执行计划机制对照2026-10-03)。接口、存储与具体追加 migration 在实施时按最新源码冻结，不把以下建议当作已存在的 API 或表。

**对象与 Owner。** 首片将执行计划作为已有 Run 的有界工作元数据，由 Workflow 拥有、Application 校验并提交；会话沿原执行请求关联只读投影。Task、固定 RunStep、CheckPlan、Artifact 和 CompletionRecord 的职责不变。纯讨论保留自然语言计划，不为清单制造执行对象。一个 Run 的当前计划只有一个逻辑写入 Owner，UI 与模型不能直接写存储；不另建 Planner、调度器或第二套 Run。

**工具类别。** 推荐内部工具名 `update_execution_plan`，仅对已关联、获准执行的当前 Run 暴露。它更新计划元数据，不访问文件或调用外部系统，不伪造 Connection、Gateway Operation、资源 claim 或 ACTION_APPROVAL。§2.3 当前 `run_tool_calls` 是与 Gateway 动作一一对应的账本，不能原样承载这种工具；须在原模型轮次中补最小的内部工具类别、持久结果和恢复投影，外部工具继续走原 Gateway。工具可见性、Worker/Attempt/claim epoch、租约、停止与预算检查仍适用；完整工具请求才可写入，更新清单也消耗原调用/轮次限额。

**快照、版本与幂等。** 首版按串行全量快照更新，严格验证标题、项数/字节上限、稳定 `plan_item_id`、状态枚举及至多一项进行中；同轮多个计划写请求明确拒绝。推荐项状态为 `pending/in_progress/completed/cancelled`，停止、审批、失败和 UNKNOWN 优先投影原 Run/控制/动作事实，不让模型另写一份控制状态。首次项身份由应用生成并回送，后续重排或改标题保留身份；拆分、取消或替换说明原因，保留必要历史来源，不用数组位置或文案 hash 关联证据。

推荐新项以本次请求内唯一的 `new_item_key` 输入，已有项提交原 `plan_item_id`，两种形态互斥；应用在首次提交时生成身份，并在持久工具回执返回 key→ID 映射和规范快照。重放同请求返回原映射，不再生成身份；下一次更新使用返回的 ID。未建计划以期望 revision `0` 创建，首次成功为 `1`，并发创建按同一 Run 唯一性与 CAS 处理。全量快照须保留已有项；退出当前有效步骤用显式 `cancelled` 和原因表达，拒绝直接省略旧项，不用缩小分母掩盖未完成步骤。具体字段/schema 在实施时冻结，但这些身份、重放与缺项语义不得省略。

每次更新带原模型调用/工具请求身份和期望 `plan_revision`；在既有锁顺序的短事务内复核执行权、先查原更新回执再处理 revision、原子保存新快照/修订与原事件通道的通知依据。同一身份同载荷返回原结果，异载荷或旧 revision 明确冲突；旧 Worker 的迟到更新不能覆盖当前计划。不为清单更新递增 Task revision、改验收条件、另开 StepAttempt、重建未变化的 Context 或重放已结算动作。模型正常消费计划工具结果后继续下一轮，仍遵守原预算。

**状态与依据。** `completed` 表达 Agent 对局部步骤的完成声明，不写 Task DONE、Run SUCCEEDED 或 Verification PASS。可关联当前 Run 的确切工具调用、动作回执、StepAttempt、Artifact 版本或检查结果；应用核对引用存在、归属、实际状态与可见性，拒绝跨 Run、伪造、越权和类型错配引用。无依据的分析步骤可保留声明，UI 明示“Agent 标记”；执行成功、检查结论与证据适用性由原 Owner 提供。检查只运行过、退出码为零或计划全勾选，都不能替代所需验证与人工接受。仅对已有版本/条件关系能判定的过期依据作提示，缺少依赖依据时显示待核对，不建设自动影响传播。

**持久化与恢复。** 复用 PG、原命令/调用身份、Run 事件与查询权限；首次快照与订阅必须通过已验证的序号衔接/重放闭合更新窗口，原通道仅提供 hint 时在订阅就绪后再次重读快照。断线/重开重读当前 `plan_revision`，旧 Run/会话/连接或旧 revision 的晚到结果不得覆盖当前页。下一轮模型消费同一已保存计划与已结算工具结果，checkpoint 仅引用这些事实。计划保存后回执丢失、事件丢失或进程重启按原身份恢复，不重复建立计划/项、不重放文件副作用。重读和展开均为只读，不自动 Resume、Delegate 或执行下一 Task。

首片包含上述计划工具、持久快照、基本依据链接和会话折叠呈现；跨任务计划、任意依赖 DAG、多 Agent 计划合并、自动重排、后台触发与强制每项独立验证不在范围内。详细交互归[工作台 §22](../frontend/workbench-design.md#22-会话内可折叠执行计划推荐设计)，实施顺序归[专项提示词](../../prompts/conversation-execution-plan.md)，未运行出口归[测试计划 §19](../testing/verification-plan.md#19-会话执行计划验收规格)。本增量沿用既有领域边界与主栈，不新增架构 Owner；实施中若实际改变持久化边界或执行权限，再记录必要 ADR。

### 2.5 有界子 Agent 的委派与会话关联

2026-10-05 接续 2026-10-04 已确认的[产品规则](../../Personal_Workflow_OS_Master_Spec.md#09-有界多-agent-与自动会话)。**本节是待实施工程设计，尚未实现/验收。** 取舍见[ADR-017](../decisions/ADR-017-bounded-multi-agent-conversations.md)，UI 与未运行出口分别归[工作台 §23](../frontend/workbench-design.md#23-主子会话与有界协作)、[测试计划 §21](../testing/verification-plan.md#21-有界多-agent-与自动会话验收规格)。

#### 2.5.1 对象、责任与复用差异

2026-10-23 范围导航：本节保留原临时只读子委派设计；当前已有生产接线与未验缺口见[§10.1](#101-现状分级与证据缺口2026-10-21-差距核对)，本节早期状态不覆盖该核对。新增长期项目成员与跨会话运行边界归[领域模型 §23](domain-model.md#23-长期-agent-成员与跨会话协作的应用边界)及 [ADR-034](../decisions/ADR-034-persistent-project-agent-team.md)，不将原两子一层或主子会话模型直接扩大为整个项目团队。

| 对象 / 责任 | 最小设计与现有入口 |
|---|---|
| 会话与消息 | Assist 原写入口保存持久历史；Application 协调主子关系、真实消息来源与执行关联。会话不等于 Task，一个主会话可关联多次实际执行，历史消息不改绑 |
| 角色配置 | 复用版本化执行配置的定义机制，首版只覆盖代码调查和独立审查；每次委派冻结角色版本、输入及输出要求。配置存储位置待核定，不设第二个配置 Owner |
| 委派与子尝试 | Workflow 管理原主 Run 内的有界工作身份、状态和尝试；Application 提交范围校验、投递及结算。子任务有独立上下文与领取凭据，不是第二个业务 Task/Run |
| 主 Run 与执行权 | 继续持有原 Task 的 executor_run_id/ownership_epoch；主 Agent 实施，子 Agent 不写代码、不申请第二份 Task 执行权。Verification、Review、Artifact 与完成用例保持原责任 |
| 权限与实际工具 | 子只读工具通过原 Gateway，绑定原 Run、实际权限/连接和委派来源；角色名称或父委派不能授予被撤销的权限 |
| 导航、进展与汇总 | UI 消费同一持久关系及 Run/委派事实，只读投影。汇总引用确切反馈和基线，不能成为第二套 Task/Project State |

当前 `AssistSessionRow` 仅有项目/任务关联，`RecentWorkRail.tsx` 展示 Task；现有会话创建、历史与重开可复用，但不能据此宣称已具备主子关系或委派执行。`run-graph.ts` 的主 Run 图尚无本增量的派发/汇合协议；不能对同一 Task 重复 Delegate 实现子 Agent，也不能把自由 Assist 对话包装成受控执行。

LangGraph 继续作为唯一通用图编排器，PG 只分发受控运行命令。先核定原图线程中最小分支或有界子图及 checkpoint 引用，保留旧 Run/checkpoint 兼容；不另起 Runtime。内部委派是受限应用命令，不访问外部系统，不伪造 Gateway Operation 或 ACTION_APPROVAL；如复用模型工具轮次，需与 §2.3 的外部动作账本明确区分，沿原身份保存内部请求与回执。

#### 2.5.2 身份、短事务与输入版本

每次委派持久保存原主会话、子会话、主 Run/执行权、稳定委派身份、角色配置版本、任务范围、显式来源版本、只读能力上界、必要审查标记、预算分配及输出要求。子尝试关联原委派、原模型调用/工具调用、独立 claim/epoch、状态和结果；具体字段及枚举在实施时核定，不把推荐设计写成已有表。

新主会话依据真实用户明确的新需求创建；同需求补充继续原会话，判断有歧义先澄清。创建只保存入口，不暗中调用 Apply/Delegate；确有执行请求时仍由原对话执行用例建立 Task 和冻结 Run。委派自动建子会话只在有效父 Run 的权限和预算内成立。

会话创建、委派、补充投递、结果结算与主消费均保留稳定命令/消息身份和可核对回执。同身份同载荷返回原对象，异载荷拒绝；同原用户消息并发解释不重复建会话/Task/Run。重试建立关联原委派的新尝试，不能通过新委派身份清掉旧失败或未知状态。

应用提交沿既有 Workspace authority→Task→Run 锁序扩展必要会话/委派锁，核对父执行权、当前 claim/epoch、控制、权限和 revision/CAS；锁顺序在实施前冻结。保存业务变化、回执与持久投递/唤醒依据的事务要短，模型、网络及等待子结果不在事务内。父等待不占满子执行槽；子结算与父等待竞态用持久投递和重读闭合，不能仅靠进程内 Promise。

子输入包含任务说明、必要事实/来源及确切调查或改动基线，不继承全量可变聊天或上一委派记忆。审查在对应改动形成后固定基线（包括相关未提交内容），读取期间发生漂移时标为待复核，不把混合版本反馈当作覆盖该基线；修复产生新基线后旧审查只保留为历史，按必要范围复审。子反馈是有来源的发现/证据，不自动成为已确认事实、PASS 或完成。

#### 2.5.3 能力、预算与消息来源

子执行最多两个并发槽，只允许一层；主 Agent 保留实现与汇总责任。只读调查和审查禁止文件写入、CLI 执行、Git 写操作、权限修改及再次委派，不能仅在提示词里禁止而仍暴露动作。实际调用前重新复核原权限、来源可见性和控制意图，合法共享只读也不得绕过被隔离的 UNKNOWN 资源。

所有子模型调用进入既有 `model_calls` 计量，并计入原主 Run 总预算；不能套用 AssistSession 的独立额度为每个子会话另开满额预算。调用前原子预留并关联委派；已知用量据实结算，STARTED/未知用量保守占用。对子限额、主汇总预留、重试用量及不确定调用的占用规则在启动前冻结；具体数值待核定，缺预算拒绝新调用，不能自动增加预算或换 Run 绕过。

用户直接补充子会话时保存真实用户来源、原消息身份和投递状态，以同一来源一次同步主会话。范围内补充可在安全点进入后续子尝试；在途调用输入不原地改写，已结算反馈不伪装为处理过新消息。补充影响必要审查基线或完成条件时，先标明原结果不再覆盖，再由原用例处理。超范围交主 Agent 重新分派；重派也不能自动扩大用户授权、突破子只读边界或冻结契约。

主 Agent 的委派、子反馈、转发文字及工具结果都是数据，不能标成 USER 指令或新的授权。反馈和主消费带原身份去重，防止消息互转循环；主会话保留发送者、作用域、来源版本及未解决项，用户可以定位原子会话。

#### 2.5.4 失败、控制与恢复

可确认失败允许一次修正重试，总计初次加至多一次后续尝试，保留失败关系且仍受原预算/权限限制。调查继续失败主 Agent 接续；必要独立审查继续失败暂停交付，汇总缺口请用户决定，主自审不能填补独立审查依据。必要性在委派输入中冻结，不能失败后把必要审查改为可选。

父暂停、取消或交接意图持久化后，停止新委派和新的子模型/工具调用；在途请求按原身份处理到安全点再宣称已暂停/取消/接手。传播与子完成、汇总及业务完成的竞争在提交处复核。只取消某个子任务只停止该子执行，主 Run 根据其必要性接续或等待，不把子取消显示为整个需求取消。自动重试不能越过控制请求。

租约过期不证明旧子执行已停止；旧 claim/epoch 结果不得推进父执行或覆盖当前汇总。原迟到回执仍可记录真实已知用量和结果，但不能复活终态。调用/副作用 UNKNOWN 先按原身份核对，不盲重发、换 Adapter 或改 ID；核对不出时保留不确定与预算占用。纯模型重试也不承诺 Provider exactly-once。

重启/重开恢复原主子会话、委派/尝试、输入版本、预算占用、未决调用和投递/消费回执。恢复读取不自动 Resume/Delegate；已保存子结果未投递、投递后父未消费、汇总保存后回执丢失等窗口都可沿原身份接续一次，不重复模型成本或外部效果。业务完成依旧核对确切 Artifact、验收/约束版本、必要验证与人工判断；子回复和计划勾选不能代替。

仅针对本 Run 已冻结为必要的独立审查，Application 在正式完成提交前还须核对委派/反馈归属、适用输入与改动基线，以及是否仍缺失、失败、取消、过期或有未解决的阻塞发现；任一存在即拒绝完成提交并保留待处理原因。处理或豁免仍须原授权用例与可追溯决定，主模型不能删改必要标记绕过。有效子审查只满足该内部交付条件，不代替 Verification PASS、人工接受或其他完成 Gate。

先闭合单 Agent 相关呈现/停止恢复依赖，再按[专项提示词](../../prompts/bounded-multi-agent.md)的持久协议→真实子执行与恢复→UI/Windows 出口实施。新增 API 的 DTO/错误/兼容、物理 schema/追加 migration、模型调用类别、子 claim/图布局及预算数字仍待工程核定；本轮不发布接口或修改数据库。

### 2.6 会话级只读工具轮次

2026-10-05 用户要求协作页聊天框有两档模式：A 档是既有普通 Agent，B 档是有固定人设、**可读不可写**的助手。产品取舍见 [ADR-018](../decisions/ADR-018-assistant-conversations.md)，本节只写工程责任；身份冻结的请求契约归[命令契约 §10.60](../api/http-command-contract.md)，物理形状归[物理设计第 62 节](../database/physical-design-postgresql.md)。**前端单选框与真实 Windows 出口未做**，这里记录的是已实现并有真实 PostgreSQL 证据的后端部分。

#### 2.6.1 为什么复用既有生成身份，而不是另建一条执行链

B 档要读真实文件，但既有 `run_tool_calls` 绑定 Run、Run 属于 Task，而 B 档明确不建 Task 与 Run。结论是**不新建执行链**：领取、心跳租约、`cancel_requested` 轮询与按 Worker 的 CAS 结算全部沿用 `assist_messages` 的既有机制。`runAssistGenerationTick` 只在读到助手模式会话时换掉三件事：

| 换掉什么 | A 档 | B 档 |
|---|---|---|
| 模型词表 | 不声明任何工具 | 只读子集，按**当前**连接每轮重算 |
| 工具事实落点 | 无工具 | `session_tool_calls`，按 `(session_id, message_id, round, ordinal)` 唯一 |
| Gateway 来源 | 不适用 | 第四种来源，自带 project 与受管资源，外加 session 与 message 身份 |

> **2026-10-15 更新（阶段 B）**：上表的「A 档 = 不声明任何工具」现在只适用于**词表为空**的情形
> （会话没有项目，或没有 `FILE_QUERY`/`FILE_READ` 连接）。普通 AGENT 会话在**确实有可用只读工具**时
> 走同一条读路径，来源是第五种 `AGENT_SESSION_READ`、目录取自 `assist_sessions.working_resource_id`
> （见 §2.7.1）。B 档三行不变；两种会话读取身份**必须可分辨**，这是 §2.6.3 的要求而不是实现细节。

模型端口相应扩展：Assist 请求新增可选的只读词表与已结算工具轮次，结果新增工具请求变体。A 档不传这两个字段，因此既有行为逐字不变；万一 A 档收到工具请求，按「未声明工具却收到工具请求」的类型化原因收敛，不把伴随正文当候选正文。

#### 2.6.2 只读动作仍然走 Gateway

绕开 Gateway 直调 file/git adapter 会造出第二条准入路径，违反「Permission/Gateway 控制动作准入」。因此该来源与 `RUN`、`USER_IMPORT`、`USER_ACTION` 并列，迁移 0060 逐条重述既有 CHECK 后追加它的分支。准入矩阵按 capability 判定，只放行 `FILE_READ` / `FILE_QUERY` / `GIT_READ` / `GITHUB_READ`；`FILE_WRITE` / `GIT_WRITE` / `CLI_RUN` / `WEB_FETCH` 一律不放开，写入口继续只有 `RUN`。`GITHUB_READ` 是 2026-10-17 F25 只读首片新增（`REAL`/`READ`，迁移 `0103`）：连接不绑定目录边界，目标取会话受管根，仓库身份由 adapter 在该目录内解析，见[工具适配器 §4.1](tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。

准备与准入都按来源分派：受管根来源（`RUN` 与助手来源）共用同一套目标规范化与资源判定。目标不要求等于受管根本身——`READ_FILE` 的目标是根内文件，目录查询的目标是根或根内子目录，只有 Git 只读动作才等于根；准入时按 capability 分别用严格包含或目录包含复核它仍落在**同一个**受管根内。

#### 2.6.3 两条容易被写错的边界

- **人设快照冻结文本，不冻结能力。** 快照只有 name、role_description、tone、read_scope 四个文本字段，迁移用 CHECK 挡住 capabilities / connections / permissions 出现在快照里。词表每轮按当前连接重算：连接被删或停用后，下一轮就少一个工具，模型收到的是类型化原因而不是静默。
- **两种执行身份不得互相冒充。** 绑定 Operation 时要求目标 Operation 的来源就是该来源，归属判定另行核对 project 与受管资源。B 档**不产生** `tasks`、`runs`、`run_scope_grants`、`run_tool_calls`、Review、`CompletionRecord` 与任何动作审批；它**会**产生只读的逻辑动作与调用记录，那是账本而不是授权。

#### 2.6.4 控制与停止

停止复用 `assist_messages.cancel_requested` 与既有 200ms 轮询，不新增停止列、停止端点或助手专属控制资源。暂停与 Handoff 在 B 档**不存在**——没有可移交的执行权，界面因此不渲染这些入口，而不是渲染成禁用加解释。

B 档不排队：一条在途时再发被明确拒绝，文案不得出现「排队」。助手归档后的检查排在在途检查之前——助手已归档时告诉用户「等上一条结束」是误导，因为等下去那条消息也永远不会变得可发。幂等仍排在最前：同一 `command_id` 在第一条在途时重放必须拿回原回执。

未知结果按原身份核对，不盲重试、不换 Adapter、不换动作 ID：状态为未知的行保留原 Operation，等人工核对。

### 2.7 普通 Agent 的连续工作轮次（2026-10-15，已确认、待重构）

目标不再固定运行“无工具聊天 + 执行解释 + 状态维护解释”三条模型分支。沿一次原用户消息形成连续轮次，必要读取返回原模型上下文，必要业务动作经原应用入口派生；完整 Owner、事务与兼容规则归[领域模型 §12.6](domain-model.md#126-普通-agent-主流程的应用边界)，模板选择与工作编排的区别归[提示词设计 §2.4](agent-prompt-design.md#24-普通-agent-主流程与模板选择的区别)。

**当前实现边界（2026-10-18，阶段 A/B/C 已实施，原消息 Run 摘要已回填）**：§2.7.1 的持久协议、**会话读取轮次**（来源 `AGENT_SESSION_READ`、目录取自 `assist_sessions.working_resource_id`、路由 `AGENT_MAIN_LOOP`）、**执行候选提交**、**状态维护提交**与**会话内 Run 排他**已落地——主流程收尾的那一次模型输出同时给出回复、可选的执行候选与可选的状态维护候选，两者都经既有确定性校验后落进**原**请求行，因此每条消息不再需要两次额外的解释模型调用。状态维护的基线在**这次模型请求之前**就由 `freezeStateInterpretationBaseline()` 冻结并原样传下去，模型在途期间的人工修改不会被吸收成原基线（R3）。**同一会话不并行推进两条执行链**：`applyConversationExecution()` 在建 Task 之前按 `findLiveRunForSession()` 问「这条会话上是否已有别的请求到了 DELEGATED、且那个 Run 还没收口」，有则按类型化 `EXECUTOR_CONFLICT` 拒绝并指回原 Run；活动状态集与 Task 级 `findLiveRunForTask()` 逐字一致，原 Run 收口后同一会话可再发起执行。Apply 后原用户消息现可读取同一 `request_id`/Task/Run 的摘要投影；更完整的 Run 详情继续由原 Run Owner 提供。旧状态维护解释仍使用独立请求 Owner，相关 UI/窗口及 Provider 范围见统一功能验收表。§2.6 中 A 档无工具/B 档只读的描述保留为当前实现事实。

**会话读取轮次的预算收尾（2026-10-19，真实模型跑通普通会话文件修改时补）**：`runSessionReadonlyRounds()` 在**最后一次轮次**或**工具调用预算已用尽**时，本轮不再向模型声明任何工具，并追加一条收尾指令要求用已有结果作答。此前只靠轮次计数在循环结束后返回 `SESSION_TOOL_ROUNDS_EXHAUSTED`：真实 Provider 会反复 find/list/read（同一文件连读两次），提示它收尾时仍会再请求一次工具，整条消息于是以失败收场，用户看到的是一次报错而不是答复。「不声明工具」是机制而不是劝导——模型没有可调用的工具，只能输出正文。同一轮把模型异常按 `MODEL_TIMEOUT`／`MODEL_TOOL_OUTPUT_INVALID`／`MODEL_BUDGET_EXHAUSTED`／`MODEL_FAILED` 分类，不再一律折叠成 `MODEL_FAILED`：只保留类别，不复制 provider 正文或凭据。

**执行候选的交付种类归一（2026-10-19）**：`expected_outputs.kind` 描述的是本次**可审查的交付说明**，不是被改动的文件。真实模型面对「把 greet 改成 X」会合理写成 `CODE_FILE`，而 `validateConversationCandidate()` 原来只认 `MARKDOWN_DOCUMENT`，整条执行请求因此被判成澄清，文件修改永远到不了 Run。现按同义表归一到当前工作流唯一可判定的种类，未知值仍然拒绝；`file_changes` 才是「改哪些文件」的唯一声明位置。提示词两处（主流程与独立解释模板）同步写清这条语义。

纯会话读取复用 §2.6 的 `session_tool_calls`、Gateway 与消息租约机制；新 AGENT 来源必须被明确校验，不能伪装成人设助手或拿到 RUN 写权限。Task/Run 执行继续使用 §2.3 的 `run_tool_calls` 和原图；逻辑主流程接续 Run 时引用其原身份和工具结果，不把同一副作用登记为两次独立调用。会话工具调用与 Run 调用各有确切来源，跨边界关联保存后才能恢复。

主流程须具备持久的领取与推进责任、预算和停止出口：结果保存前后崩溃按原调用/动作核对，不用重新问模型再生成一次动作；取消传到当前实际执行端，UNKNOWN 阻止盲重放。只读结果回放包含真实来源、截断与失败，不把工具正文当指令；历史轮次缺失的元数据保持未知。所有实际模型调用沿原计量记录，不能用移除分类调用的设计直接宣称已降低成本。

这里只定义必须满足的接续责任，不冻结新的表、端点、工具名或引入 Runtime 依赖；实施任务须先核对现有机制再决定最小协议差异。

#### 2.7.1 主流程的最小持久协议（2026-10-15 实施前核对结果）

实施任务书 §5 要求「修改前给出简短映射」，以下是按**当前源码**核对出的差异与本次采用的最小协议。每条都注明依据文件，规则本身仍归[领域模型 §12.6](domain-model.md#126-普通-agent-主流程的应用边界)。

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

产品规则归[工作台 §18.1.5](../frontend/workbench-design.md#1815-未选目录时的默认工作目录2026-10-18已确认未实施)，不变量归[契约 01 §5](../../contracts/01-facts-and-ownership.md#5-projectgoal-与-inbox)，取舍依据见[研究 §1.8](../research/p00-source-study.md#18-未选目录时的默认工作目录机制对照2026-10-18)，实施切片归[任务书](../../prompts/default-working-directory.md)，场景归[测试计划 §17.1.5](../testing/verification-plan.md#1715-未选目录时的默认工作目录2026-10-18已确认未实施)。2026-10-19 接续：**后端配置、创建事务继承与来源投影已实施，前端设置入口、创建后作用域读回与来源标记已接入**；本节标题保留原方案日期与链接锚点。实现协议见 [HTTP §10.96](../api/http-command-contract.md#1096-workspace-默认工作目录2026-10-19-后端实现)与[数据库 §104](../database/physical-design-postgresql.md#104-0117-workspace-默认目录2026-10-19)，运行结果只归统一验收表。

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

普通 Agent 会话里一条回复正在生成时，用户再发一条消息仍按既有路径落库为 `PENDING`（排队等这一轮结束）。本节的「插话」是同一批消息的**第二种投递方式**：用户要求它并入**正在生成的那一轮**，而不是等这一轮结束后另起一轮。交互归[工作台 §39](../frontend/workbench-design.md#39-排队消息的插话手势2026-10-19-已实施)，命令归 [HTTP §10.102](../api/http-command-contract.md#10102-排队消息的插话2026-10-19-源码实现)，物理列归[数据库 §106](../database/physical-design-postgresql.md#106-0122-排队消息的插话意图2026-10-19-源码实现)。

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

用户反馈覆盖文件工具、浏览器/电脑操作及任务/审批/验收步骤。调整遵循 [ADR-031](../decisions/ADR-031-session-direct-write.md) 的接续决定：日常文件工作不必制造正式任务；正式验收不因聊天回复而完成。

| 工作 | 当前推进路径 | 人工边界 |
|---|---|---|
| 查看文件、目录与已连接工具的只读状态 | 同一消息连续工具循环 | 无额外“开始读取”确认 |
| AUTO/FULL 目录的普通文件修改，包括明确 MODIFY 方法 | 同一循环直接写，保留基线与动作账本 | 不创建 Task/Run，不要求正式任务验收 |
| ASK 写入、AUTO 删除 | 原消息候选 → 已有自动启动 → Run/Gateway | 在确切动作处审批；不要求重述目标或手工建任务 |
| 修改后的检查 | 仅剩余检查进入 Run，已成功修改不再重复执行 | CLI 允许清单与冻结程序摘要仍有效 |
| 浏览器、电脑操作 | 候选 `interaction=BROWSER|COMPUTER` → 原 Run 工具循环 | 仅解析本项目 ACTIVE 连接；不因工具需求自动新增范围授权；提交与外部副作用仍按原审批 |
| 正式任务交付 | Artifact → Verification / Human Acceptance → Business Commit | 绑定确切版本；普通工具成功不等于业务完成 |

`planToolLoop` 在登记 Task 前核对所需连接；缺工具先报告具体能力缺口，不留下无法委托的任务。浏览器/电脑连接不需要文件根，文件/Git/CLI 的目录匹配规则不变。`interaction` 只传达本次需要哪组工具，不能成为新的执行权或批准来源。

限制：浏览器/电脑目前仍要求会话有项目与受管目录，尚未独立出无目录操作会话；会话自身没有异步动作审批恢复。自定义策略已经生成的 WAITING_APPROVAL 与 UNKNOWN 都按原动作核对，禁止用新候选绕过。真实模型选择质量与 Windows 操作效果需单独取证。

#### 2.10.1 推进 Owner 收归服务端与能力事实说明（2026-10-20 第二轮）

上一轮把「文件直写」留在了会话里，但「候选 → Task/Run」这一步仍由**前端 effect** 触发。
后果是可预期的：关掉页面、刷新错过时机、或请求由另一台设备发起时，一条已经明确授权、
已经落库的请求会停在 `READY` 等一次没有信息量的点击；同时前端与后台各自持有推进责任。

- **唯一推进 Owner 是 Worker**：`runConversationExecutionAutoStartTick()` 每个 tick 扫
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

每个采用片段最多 1600 个 JS 字符，保存实际 UTF-8 字节范围、片段 SHA-256、原完整来源 SHA-256、不可变版本、内容及 `UNTRUSTED_DATA` 标记；受管 ArtifactVersion 先在短事务外核对原文件 hash/size，缺失或损坏记 `SOURCE_UNAVAILABLE`，不把 `content_text=null` 当成空资料。当前估算为规范 JSON 的 UTF-8 字节数除以 3 向上取整，默认 8192 token，上限中预留 1536；估算值不是 Provider 计费或精确 tokenizer。Mandatory 超限以 `CONTEXT_REQUIRED_OVER_BUDGET` 使 BUILD_CONTEXT 失败，不裁剪契约；Relevant 超限可整段跳过并记 `BUDGET_TRIMMED`。第一方固定 Profile `run-default@1` 只定义当前允许的来源与界限，Run Manifest 保存 Profile 摘要、Builder/模板版本、Skill=null；Assist 的第一方 Skill/Pack 注册与冻结见 [Skill 专题](relay-skills.md)，不自动进入 Run Manifest。

独立 `context_revision` 随长期信息写入递增，Rule 写入也递增它但仍由 `rule_revision` 负责执行栅栏。Builder 在 authority→Task→Run 的提交事务中核对装配时的 authority/context 版本与 Project/Task revision，变化时不提交过时 Manifest。已成功的 BUILD_CONTEXT 在继续执行时按实际消费的 Task 标题、所属 Project 和验收版本，以及 authority/context/Project 修订判定来源是否过期；Task 行修订仍记录在 Manifest 中，但审批或状态变化本身不重做成功草稿。DRAFT 前且没有外部效果的来源变化可以重新 BUILD_CONTEXT，新片段生成新 hash，旧 Manifest 保留。

固定 Mock 图的 Gateway 动作在 Admit 的 authority→Task→Run 短事务内再次核对原 Manifest；审批等待期间来源过期时不执行 Fake 写入，保留原动作身份与拒绝依据。效果已发生而受管候选尚未发布时，后续来源变化阻断 BUILD_CONTEXT/DRAFT 重做，须按原动作身份核对。发布成功后不重放或抹掉效果证据，VERIFY/COMPLETE 仍依冻结 CheckPlan、当前验收与各自 Gate 判断，修正回路会重新装配。列表与详情读取当前范围、根状态、Memory 到期和受管文件可用性，过滤无权来源及其排除项，不返其 ID/名称/正文/数量；历史快照不授予新的动作准入。Verifier 不消费 Manifest 中的 Worker 自评。无 Project Assist 尚无 P12 端口，本段不为它制造 Run 或假资料。

2026-09-25 显式来源选择入口（M04 非凭据部分，开发自检）：Delegate 命令新增可选 `context_sources`（KNOWLEDGE/MEMORY/DECISION 根 + 具体不可变版本，最多 10 条），随执行契约冻结为 `context_sources`。Delegate 事务内校验根的 Workspace/ACTIVE/Project 作用域与版本存在性，失败不创建 Run；构建期根停用或版本缺失按 Relevant 既有语义记 `SOURCE_UNAVAILABLE` 排除。Builder 装配顺序按本节设计：显式选中资料优先（`EXPLICIT_SELECTION`，读取冻结引用的版本而非根当前版本），同作用域 `TITLE_MATCH` 检索保留，存在显式选择时不再做 `RECENT_SCOPE_FALLBACK` 最近资料补位（最小必要输入复核的第一步）。无显式选择的既有行为不变。尚无前端选源管理页；真实 Provider 外发仍关闭，`RECENT_SCOPE_FALLBACK` 仅在无显式选择时作为确定性降级保留。

## 4. 检查器与总判定

CheckPlan 由验收与规则映射确定，Worker 无写权。内置 checker 首先支持 Markdown 必需节、产物类型/数量、引用标识存在；每个都声明检测范围。Semantic checker 提交 PASS/FAIL/UNCERTAIN 和可定位证据，不接受无证据的高置信数值。

Checker ERROR 与结果 FAIL 区分；同 checker 两次连接重试仍不可用则 HUMAN/PAUSED 并保留未决。人类只可对允许 HUMAN 的项判断，不能通过“接受全部”覆盖 HARD 失败。完成前重新核对绑定集合与适用性。

检查器实现端口 `check(CheckInput) -> CheckOutcome`；registry 只注册内置 checker，不下载插件/执行用户表达式。规则 enforcement 与可用 checker 不匹配时不可 Ready/Delegate，不悄悄降级为建议。

P10 当前固定 Workflow 已在 Delegate 前解析有效 Rule 版本，并把来源引用与对应 criterion 冻结到同一 ExecutionContract；VERIFY/Review 继续从该快照重建 CheckPlan。HARD 的 POST_CHECK 只接受当前确定性的 Markdown 结构/引用检查器；HARD PRE_ACTION 尚无接入 Gateway 的 Rule 检查路径，HARD SEMANTIC 只有 Fake checker，均返回 `RULE_ENFORCEMENT_UNAVAILABLE` 而不授予 Run。Rule 更新由 Workspace authority 版本栅栏阻止旧 Run 的下一步/下一次 Gateway 准入，已发生的效果仍保存原结果；影响范围与代价见 [ADR-009](../decisions/ADR-009-rule-revision-fence.md)。

## 5. AI Assist 与提案

Task.mode 明确为 ME、AI_ASSIST、DELEGATE_AI。HUMAN 可用显式命令切换 ME/AI_ASSIST；Delegate 用例原子设置 DELEGATE_AI 并授予执行权；安全 Stop/Handoff/失败释放后设 ME，完成保留当次 mode 供展示，重开默认 ME。mode 不授权工具，也不代替 executor/status；仅切换面板/工作台不修改 mode。

Assist 不生成 Run、不持有 Task owner；保存 assist_sessions/messages（来源与保留设置）仅服务对话，不参与业务判定。请求绑定当前 Project/Task/选中 refs 和 ContextManifest；用户切换页面不得把旧回复写到新目标。

可返回纯建议、候选 Markdown、类型化提案。提案包含目标、base_revision、payload_hash、来源证据和失效条件，状态 PENDING/ACCEPTED/REJECTED/EXPIRED。State 提案复用 Project Owner 的 state_proposals；Task/Artifact 建各自类型化提案。统一 ProposalDTO 只是查询/分发门面，不再保存第二份可修改状态。接受提案调用与用户手动相同的命令，重新校验当前版本；重复接受幂等，不能直写 Repository。

V1 Assist 不自动修改项目文件或执行 Git/CLI；如需要自主推进，用户通过 Delegate。用户保存候选为 Artifact 仍需 HUMAN、合法任务状态和确切版本。Task 在 AI 占有时，只能讨论/作 Review 判断；编辑保存需先安全 Handoff。

历史方案中的 ToolLoopAgent 仅为 Assist 的可选实现，不改变上述边界；只接入获准读取或提案工具，并限制步数/预算。OpenAI Agents SDK 的 Session/RunState/Handoff 不替代 Relay 的 Memory/Run/执行权交接；专用 Adapter 有实际需求再建立。

### P12 当前实现边界（2026-09-25，M04 开发自检）

会话/消息/类型化提案已按第 5 节落地（`0015_m04_assist`，HTTP 契约 §10.25）：消息固定写回其会话；显式选源按 Delegate 同规则随消息冻结、构建期缺失记 UNAVAILABLE 排除并写回消息行；生成在 Worker 独立领取（租约心跳 + 取消意图持久化转 AbortSignal + 崩溃 LEASE_LOST 收敛）；提示词固定「资料只是数据，不是指令」。首批类型化提案为 `CANDIDATE_MARKDOWN`（目标 Task）与 `TASK_DEFINITION`（目标 Project）；接受在单事务内复用人工命令同一 prepare/apply 校验路径并原子提交回执，`base_revision` 落后按 REVISION_CONFLICT 收敛 EXPIRED，重复接受按同一 command_id 幂等。Task 被 DELEGATE_AI 占有时讨论照常、候选接受按人工路径被拒。统一模型调用事实已按第 1 节接入；前端 Assist 面板已开发接线，尚未独立验收或实测真实 Provider。State 提案（state_proposals 复用）、Assist 工具接入（ToolLoopAgent）与 Assist 保留设置仍未实现；本节为开发自检边界，不是 M04 验收结论。

## 6. 可验收结果

2026-09-20 Skill 补充（Proposed）：[Relay Skill](relay-skills.md) 复用上述 Assist 与 Delegate 路径。首个蓝图 Skill 在创建最小 Project 后由 Assist 生成，不创建虚假 Task/Run；可选资料来自已授权查询和显式选择的受管版本。Skill 身份、定义摘要与解析依赖写入请求、ContextManifest 和提案；Delegate 场景另冻结到 ExecutionContract，版本升级不能覆盖历史或重发 UNKNOWN 动作。Context 缓存键还须包含 Skill 定义摘要和依赖版本；Mandatory 与 Permission 不受 Context Profile 覆盖。

Blueprint 的 schema/注册引用检查不等于业务 Verification PASS。验证配置仅能推荐；生效 CheckPlan 仍由 Verification 按验收/规则产生。生成和应用的明确边界及并发验收见专题与[测试计划](../testing/verification-plan.md#8-relay-skill-与蓝图应用验收)。

闭环 Skill 补充：首批任务定义/验收方案在 Delegate 前形成并接受，Run 冻结后不能由 Worker 改检查标准。Project Resume 只读当前事实并保留来源版本。Repair Contract 是原 RETRYING 步骤的输入，包含失败证据、固定产物/验收版本、修改范围与预算；新候选需验证，ERROR 不启动产物修复。Handoff 的最小事实包由核心查询生成，AI 说明失败不阻塞安全控制；确定性 State delta 不经模型生成或 Skill 调用，仍在 CompleteTask 事务计算。完整职责见[闭环目录](relay-skills.md#7-首批闭环能力与后续目录)。

Fake 场景固定涵盖合法输出、结构错误、缺资料、必需 Context 超限、checker 超时、修正耗尽、审批等待、延迟结果、取消。模型成功示例不能代替这些测试。A04–A06、B01–B08、C01–C09 与 D01–D06 是业务依据。

Context 历史重放只能证明“输入可重建”，不保证随机模型产生相同输出，不提供模型私有思考的展示或审计。Provider 协议要求的必要回传字段与普通摘要分开处理，目标边界见第 8 节；不能把本条当作丢弃协议必需字段的理由。

## 7. 产品 Agent 提示词与输入协议

2026-10-03，用户确认产品 Agent 采用有判断的项目搭档、范围内自主决策及显式连续授权边界；行为定义归[产品总纲 §0.6](../../Personal_Workflow_OS_Master_Spec.md#06-agent-协作行为2026-10-03已确认设计)。完整目标模板草案、消息/资料分层、工作模式、Skill/工具说明、输出追溯及当前源码差距只在[Agent 提示词设计](agent-prompt-design.md)维护；运行程序不加载该设计文件。

用户随后明确授权接入，现有 Assist 对话/提案、第一方 Skill、DRAFT 与请求解释已引用 [agent-system-prompt.ts](../../apps/api/src/workflow/agent-system-prompt.ts) 的固定公共核心；语义检查保持独立窄提示词。专用规则继续限制各入口实际职责和原输出 schema，DRAFT 仅调整既有 CANONICAL 工作约束标签，资料/工具正文仍是数据。未引入通用工具循环或跨任务授权。评价规格见[测试计划 §18](../testing/verification-plan.md#18-agent-提示词与输入协议评价目标设计)，工程结果只见统一功能验收表，真实模型评价未运行。

## 8. 会话压缩与消息文件恢复

2026-10-11，产品目标与控制边界已确认。2026-10-19 接续普通 AGENT 的持久短期摘要与长期确认事实召回，工程边界见 [ADR-028](../decisions/ADR-028-memory-layers.md)、协议见 [HTTP §10.99](../api/http-command-contract.md#1099-长短期记忆接口2026-10-19)。本次不实现 Run 中途压缩、Provider 原生压缩、思考协议完整持久恢复或消息发送前文件恢复；文件检查点与 LangGraph Run 检查点仍各归原 Owner。阶段和实际成绩分别归 CODEX_NEXT_STEP 与统一验收表。

### 8.1 模型容量、工作预算与压缩时机

用户偏好模型上下文窗口为 **256K–512K tokens**，该值不表示压缩阈值，也不假定所有 DeepSeek 型号、服务商或接入方式都支持此容量。实施时分别核定模型实际窗口、应用允许的工作上下文预算、输出及必要增长预留、自动压缩触发策略；当前 `max_call_tokens` 和 Context Builder 的片段预算均不能冒充物理窗口。

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

当前模型仍来自[进程配置](../../apps/api/src/workflow/model-port-config.ts)，[ExecutionContract](../../apps/api/src/workflow/execution-contract.ts) 未保存 Provider/模型配置快照。`/model` 的会话覆盖与活动 Run 模型冻结是新增目标，不是现有保证；实施须补齐冻结与调用绑定，并核定旧 Run 缺少快照时的兼容/继续策略，不能伪造其“原冻结模型”或随会话设置静默切换。

实施前核定实际 Provider/模型能力、计数与余量、协议字段和持久恢复、检查点并发/CAS、预算与成本口径。以真实 DeepSeek 长任务对照未压缩或现有截取基线，观察接续成功率、约束遗漏、工具链错误、缓存命中、全部调用成本和延迟后冻结参数；不能以摘要变短或单次调用通过宣称收益。

### 8.5 消息发送前文件基线与恢复 Owner

文件撤回到所选用户消息**发送前**，范围为该消息及其后续本会话关联文件动作的实际影响，恢复这些文件在基线时的内容/存在性；与消息无关的路径及其他来源修改不被覆盖。Application 协调原会话/消息 → 执行请求 → Task/Run → 原 Operation/Invocation/ChangeSet 的来源关系，文件恢复仍经 Gateway 和 Files Adapter；不新增可直接写目录的 UI 或 Skill 旁路。

必须在消息发送前建立与消息身份关联的可恢复文件基线，保存原字节或可验证的不可变字节引用、路径/存在性和受管资源身份。当前动作准备时的 hash/有限文本差异不代表发送前快照，hash 也不能还原已删除或二进制内容。快照一致性、读取权限、大文件/二进制覆盖、存储预算与保留期实施前核定；基线未建立或已不可用的消息明确不支持恢复，不显示成功。

点击先持久化恢复意图、冻结确切目标和范围，停止相关执行并阻止排队/迟到 Writer 继续写，再核对原未决动作。租约到期、AbortSignal 或 UI Loading 不证明旧进程已停；与受管资源相关的写者未排除、`UNKNOWN` 未核对时不进入恢复。恢复前及各写入安全点检查当前文件和来源，人工或其他任务的后续修改、来源不明或版本不匹配作为冲突处理，不盲目覆盖。

恢复按原恢复请求和独立动作身份持久核对、幂等续接；不重用原成功写入作为“重试”，不换身份绕过未知结果。FS 恢复与数据库提交不假装原子；中断、部分成功和冲突逐项保存实际状态。文件恢复发生而业务回执未提交时继续核对，不能因响应丢失再覆盖目录，也不宣称全部恢复。

若本次恢复确实撤销已完成任务的当前完成成果，Application 复用 [ReopenTask](../../apps/api/src/application/completion-commands.ts) 的版本核对和领域入口重开受影响任务：进入新验收周期，保留历史 Completion/Verification/ArtifactVersion，任务回到 READY，不自动启动 Run，不继承旧 PASS。不可变 Artifact 历史不随工作目录恢复删除；无关 DONE 任务不批量重开。文件已恢复但重开遇到 revision 冲突或失败时分别显示结果，不能显示整个操作完成。

交互归[工作台第 27 节](../frontend/workbench-design.md#27-内置-skill-与聊天命令)，未运行规格归[测试计划第 26 节](../testing/verification-plan.md#26-内置-skill命令压缩与消息文件恢复验收规格)。API、持久化字段、migration、兼容/回滚及精确锁序均待实施设计，本节不虚构已接线端点。

### 8.6 模型目录、会话选择与免费调用边界

2026-10-15 目标设计；2026-10-16 目录/选择数据面与守卫已有部分源码，生产免费调用与下述自动接续仍未闭环。产品范围与同步时机只在[后续路线 §9.1](../requirements/post-v1-roadmap.md#91-免费模型分组与自动同步)维护；本节定义目标责任边界，实际成绩归统一验收表，接续 [ADR-019](../decisions/ADR-019-builtin-methods-and-conversation-checkpoints.md)。

- Application 中单一模型目录/选择用例拥有目录同步、当前快照发布和会话选择写入；Infrastructure 负责 OpenRouter 目录读取，Repository 保存完整成功快照、来源、目录版本、成功时间与最近失败状态。UI 只消费投影，不直接访问服务商或维护第二套免费名单。读取目录不创建 Task/Run 或模型生成账本。
- 目录发布是短事务，网络请求在事务外；完整校验成功才替换当前快照。同步去重与有序发布必须覆盖多客户端及多进程：旧请求的迟到响应不能盖掉新快照，失败不更新成功时间。首次失败无缓存、合法空结果、旧缓存与部分/非法响应明确区分；刷新频率限制与有界重试避免故障时每次打开都请求。
- 模型连接保留服务端 endpoint 和凭据引用，客户端只能选择已登记的连接/模型。复用原模型端点边界，不允许目录内容引入新请求主机、读取密钥或覆盖规则；服务商名称、描述、能力声明均是外部数据。原默认连接与 OpenRouter 连接分别解析凭据，不复用其他平台密钥，不建立通用凭据管理 UI。
- 会话配置通过 revision/原命令幂等入口更新。新请求在准入时冻结有效连接、模型、调用参数/预算、免费约束和目录依据；Workflow 在创建 Run 时保存非密钥模型快照，后续轮次、重试与重启按该身份恢复，计量指向实际所用连接/模型。密钥仅在服务端按引用解析，失效或撤销后不能借快照继续。普通会话与 Run 共用解析逻辑，不重写工具循环或业务 Owner。
- 旧会话无覆盖时保留原默认行为；旧 Run 无快照时，只能从可核对的历史依据建立明确兼容策略，不能把升级时的当前配置假称原冻结配置。缺乏足够依据时停止续跑并给出处理入口，不静默改模型。模型切换不授予权限，也不改变只读会话身份。
- 免费资格与模型身份分开：所有外呼入口读取各自请求/Run 的冻结约束；仅携带“仅免费”约束的每次模型外呼（含续轮、重试和该免费选择的连接验证）走同一免费准入。原默认或其他无此约束的连接保持原行为，不受免费目录故障影响。免费目录过期先刷新核对；未知/失败不能按零价放行。对具体免费型号附服务商端零价格硬限制，适用输入/输出/请求等价格上限全部覆盖；新增收费插件、搜索和媒体功能默认不启用。实施时核实 SDK 确实透传限制，并用实际 HTTP 请求体证明；不能只在 UI 标免费。目录检查和远端计价并不原子，远端硬限制是请求时的补充防线，无法证明时不宣称零收费保证。
- 活动 Run 的初始模型与契约快照不可被目录/会话更新改写；2026-10-16 新规则允许在其冻结策略内有界切换免费候选。当前候选通过独立的持久切换记录投影，不覆盖初始快照。未触发额度接续时首选失效则停止；已经因确切单模型额度拒绝进入接续后，才排除失效的后续候选继续。所有实际尝试仍过免费准入；已在途按原身份结算，UNKNOWN 和半截流不触发额度切换。新目录声明不能让不兼容调用继续。

首版调用绑定具体目录模型，不采用 `openrouter/free`；该路由会随机选择具体模型，不能兑现可核对的候选顺序和每次尝试身份，依据[官方说明](https://openrouter.ai/docs/guides/routing/routers/free-router)。零价约束参考[官方 Provider 价格上限](https://openrouter.ai/docs/guides/routing/provider-selection)；目录单价与请求上限可能采用不同单位，须分别解析，不用浮点舍入把极小非零价格判零。已有目录/选择协议见 HTTP §10.81–82、迁移 0088–0089；尚未接入的冻结/自动接续接口、错误码和存储需实施时另行冻结，本节不冒充已有运行能力。

2026-10-16 阶段 0 整改（源码实现，规则仍只归本节）：**来源完整性**判定收紧——非空但一条身份完整条目都解析不出的结果、带续页游标或自报总数大于实收的分页结果、同一模型 id 给出互相矛盾记录的重复条目，一律**不发布**并保留最近成功快照与成功时间（合法空数组仍如实清空可选集合）；未知计价项只有**明确为零**才放行，null/空值/非法值不再等同免费。**能力解析按官方真实结构**：`supported_parameters` 在模型对象顶层，`input/output_modalities` 在 `architecture` 内，缺值保留三态。**同步并发**：TTL/退避/刷新间隔的判定除无锁预检外，必须在**领取租约的同一行锁内**按当前发布头复核，堵住「两个请求读同一旧状态、首个发布成功后第二个仍按旧判断再外呼」的竞争。物理对象、migration 与回滚风险归[数据库设计 §90](../database/physical-design-postgresql.md)。

2026-10-16 自动接续补充，2026-10-17 实施中，产品规则只归[后续路线 §9.1.1](../requirements/post-v1-roadmap.md#911-免费额度耗尽自动接续)：Application 统一拥有候选选择、额度错误分类与切换回执；Workflow 协调同一 Run 的安全调用边界，模型端口只执行已确定的确切型号，不在 fetch 包装或 SDK 隐藏重试里偷偷换模型。

- 请求/Run 准入冻结有序候选、各项非密钥配置引用与能力/目录依据、策略版本和尝试上限。每次尝试具有独立模型调用身份、实际型号、失败作用域和预算结算；逻辑请求身份及原工具回执保持。切换不重新创建任务、不清空预算或对话，不把 SDK 内多次外呼合并成一条原调用记录。
- 原尝试明确终结后，短事务以当前候选/状态 revision CAS 提交切换和原失败依据，再发下一次网络请求。记录原/新模型、触发来源、尝试序号、冷却/恢复依据；并发 Worker 至多推进一次，响应丢失与重启按已提交尝试恢复，不重试已成功调用或重置候选游标。租约/控制/权限检查仍成立，暂停/取消先于新外呼。
- 限额状态按连接凭据引用/模型及服务商作用域隔离并持久恢复，不保存密钥。OpenRouter 接续须组合核实 HTTP 429、结构化上游限流依据、无平台限流头及独立 `/api/v1/key` 的共享免费日额度仍大于零；这是当前模型上游受限的有界接续依据，不是每模型剩余额度证明。账户/平台共享限制及未知证据停止同范围接续，保留 Retry-After/重置时间；不靠字符串或测试自造 scope 猜测。错误详情须最小化、脱敏，不能写入任意远端正文或凭据。
- 每个候选都重新核对现行免费资格、请求能力和输入/输出预算；原上下文必须装得下，不删 Mandatory、已成功工具依据或借切换偷偷压缩。存在活动工具协议链、Provider 专有 reasoning/压缩数据不可移植、半截输出或 UNKNOWN 时停止，不能把前一模型的私有协议直接灌入另一模型或重跑写工具。
- 不直接启用服务商宽泛 `models` fallback 代替该协议：官方 fallback 会在多类错误后切模型，且不自动提供 Relay 每次失败尝试的持久身份与控制边界。候选已冻结也不代表运行时价格、凭据或权限永远有效。实际协议/表/migration 随后实施时归原 API/数据库文档，不在本轮预造。

2026-10-17 官方协议核对纠偏：当前 [OpenAPI `PublicPricing`](https://openrouter.ai/openapi.json) 只要求 `prompt`/`completion`，`request` 为可选字段。免费判定保留原始缺项，不把缺失请求费写成零，也不因该可选字段缺失而排除明确零输入/输出项；声明的请求费及其他适用收费项仍须合法零，未知或非法不放行。实际请求继续附请求费在内的零价格上限。该变化修正旧夹具对所有费用字段必需的假设，不能推广为缺少必需文本价格也默认免费。

## 9. 聊天目标与计划模式的运行边界

2026-10-20，产品行为已确认；工作区已接入 `0127` 迁移、应用用例、Worker 推进和会话 UI。以下区分源码事实与仍需验证的恢复出口，不将基础接线视为整体交付。产品定义归[总纲 §0.15](../../Personal_Workflow_OS_Master_Spec.md#015-聊天目标与计划模式)，实际成绩及未闭合项只归统一功能验收表的「聊天 `/goal` 与 `/plan` 完整实施」行。

- 会话/消息模式、计划版本、活动目标、轮次结算与显式扩额账本已持久化；`assist-plans.ts` 保存计划版本，`assist-goals.ts` 处理目标命令，`goal-advance.ts` 是目标轮次推进 Owner，由 Worker tick 调用。目标轮次投递回既有会话生成队列，不建立第二个模型执行框架。正式 Task/Run、权限、验证、人工判断和业务完成仍归原 Owner。
- 2026-10-21 修正推进扫描的候选范围（DEV-0094）：控制落定只查 `PAUSING/CANCELLING`（有在途轮次的取消排到无在途目标之后），轮次结算只查「最新一条已结算消息尚无 `assist_goal_rounds` 行」的非终态目标。此前两个阶段共用「全部未终结目标按 `updated_at` 取 50 条」，历史 PAUSED/WAITING_USER 行会长期占满窗口，使较新的暂停/取消与待记账轮次永远轮不到；暂停目标上未记账的轮次也会因此丢失。每处理一条即离开候选集，单 tick 仍然有界；不提高页大小、不改无关目标时间戳，也没有新增推进 Owner。CAS、消息幂等、UNKNOWN 与暂停/取消优先语义不变。
- 2026-10-21 修正取消目标时排队轮次的收口语义（DEV-0102）：`markMessageCancelRequested` 与既有 `assist-repository.setCancelRequested` 对齐——PENDING 轮次还没有调用模型，收到取消意图即直接结算为 `CANCELLED`；RUNNING 仍只记录停止意图，由生成方结算。此前 PENDING 行只被置 `cancel_requested=true`，仍留在领取队列中，生成 Worker 领走后按失权拒绝；目标轮次分支的返回未 await，拒绝会逃出 `runAssistGenerationTick` 并终止 Worker。目标状态仍只由推进器在轮次记账后置 `CANCELLED`；written→UNKNOWN、外部效果不撤销、不自动重放语义不变。
- `/plan` 的只读约束须在工具准入落实，不能只写提示词。进入 `/goal` 不增加权限；执行必须沿受控入口。选定计划绑定版本，但计划接受本身不等于所有未来新增行动已获授权。
- 服务端承担关闭页面后的推进；重启、继续和重复请求先读取原持久状态，核对执行权、现场及在途效果，再沿原身份接续。租约过期不证明旧进程停止，UNKNOWN 不得盲重试或新建动作绕过。暂停、取消、切换先持久保存控制意图并安全处理在途行动。
- 产品不设额外的总时间、总轮次或总调用上限，不代表取消单次请求限制、权限或异常保护。当前目标推进保留共享模型预算闸门与显式扩额账本，不自动绕过服务商限额；未知额度不记为零或无限。额度耗尽保存现场，恢复后须用户点击继续；真实阻塞及无进展不能用无限重试掩盖。
- 新消息须区分补充、进度询问、控制和冲突；更新不能静默改变冻结契约，迟到结果不能覆盖暂停或新版本。当前源码有暂停/取消的中间态、轮次幂等结算及完成前等待人工确认；不据此推定真实 Provider 的插话理解、进程重启恢复或全部竞态已验收。具体命令归 [HTTP §10.108](../api/http-command-contract.md#10108-聊天目标与计划模式2026-10-20-源码实现)，存储归[数据库 §109](../database/physical-design-postgresql.md#109-0127-聊天目标与计划模式2026-10-20-源码实现)，测试范围归测试计划 §41。

## 10. 七种 Agent 模式的实现映射

2026-10-20 源码核对。产品用途和能力边界唯一归[总纲 §0.16](../../Personal_Workflow_OS_Master_Spec.md#016-七种-agent-执行模式与产品能力边界)；本节只维护实现责任与定位入口，不重复运行成绩。当前组合为普通会话工具循环与正式 Run 图编排，计划/目标在应用层复用原生成与工具链。

| 模式 | 当前实现入口 | 工程边界 |
|---|---|---|
| ReAct | [会话循环](../../apps/api/src/application/assistant-readonly-round.ts)、[Run 步骤](../../apps/api/src/application/run-steps.ts)、[工具轮次与历史](../../apps/api/src/application/tool-loop.ts) | 模型请求与工具结果交替，准入、预算和持久化由应用处理；`assistant-readonly-round.ts` 的历史文件名不代表普通 Agent 当前只有只读能力 |
| Plan and Execute | [计划版本](../../apps/api/src/application/assist-plans.ts)、[目标命令](../../apps/api/src/application/assist-goals.ts)、[目标推进](../../apps/api/src/application/goal-advance.ts)、[Worker](../../apps/api/src/worker/main.ts) | 计划绑定确切版本，Worker 组织目标轮次；进度步骤不等同于每步已有独立 claim、产物验证和恢复协议 |
| Reflexion | [Run 反馈与修正上下文](../../apps/api/src/application/run-steps.ts)、[工具历史回传](../../apps/api/src/application/tool-loop.ts) | 当前是工具/检查反馈驱动的局部纠错；未建立独立反思器与跨任务经验应用闭环。`learning-round.ts` 面向用户学习，不能作 Agent 自学习的实现依据 |
| Workflow | [运行图](../../apps/api/src/worker/run-graph.ts) | 使用 LangGraph `StateGraph`、审批 `interrupt`/恢复与 PostgreSQL checkpoint；checkpoint 不代替业务状态和外部效果核对 |
| Multi Agent | [ADR-017](../decisions/ADR-017-bounded-multi-agent-conversations.md)、本文件 §2.5 | 有界委派链（migration `0128` 与 `application/subagent-delegation.ts`）已进入生产会话链，但尚无一条真实跑完「主→子→汇合」的产品链证据；不得把普通 `DelegateTask` 业务命令解释为子 Agent 派发 |
| Agent and Tool | [工具准入与派发](../../apps/api/src/application/assistant-readonly-round.ts)、[Gateway 应用入口](../../apps/api/src/application/gateway-actions.ts) | 单次调用复用原工具路径，无单独运行引擎；工具可用性按真实连接、当前权限和能力重算 |
| Code as Action | [文件变更工具](../../apps/api/src/application/tool-loop.ts)、[CLI 适配器](../../apps/api/src/cli-worker/cli-adapter.ts)、[适配器边界](tool-adapters.md) | 受控程序与结构化参数，`shell:false`；没有通用代码解释器或 OS 沙箱。CLI 结果丢失时按原动作核对，不能盲重放生成代码 |

上述映射不引入新 Runtime、业务状态机、API 或 migration，也不改变现有权限和完成契约。新增架构能力仍需单独设计与验证，不以术语映射作为开发授权。

### 10.1 现状分级与证据缺口（2026-10-21 差距核对）

分级口径：**A** 有代码且已接入生产路径；**B** 有代码但未接线或缺运行证据；**C** 产品规则已确认、尚未实现；**D** 产品行为尚未定义。分级只描述实现与证据状态，**不是验收成绩**——成绩唯一归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；C 与 D 未经产品确认不得当作开发授权。

| 模式 | 分级 | 已具备的证据类 | 还缺的证据类或未闭合接线 | 待产品决定（均为推荐/待确认，未实施） |
|---|---|---|---|---|
| ReAct | 会话链 **A**；正式 Run 内工具链 **B** | 真实 PG 的多轮工具循环与结果回传落在生产 tick，真实模型端到端通过 | 正式 Run 内的 Provider 审批往返、Windows 出口 | 无新增。既有未决项（会话发起的 Run 是否携带「非交付」标记、浏览器与电脑动作的资源身份）归 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md) |
| Agent and Tool | **A** / **B** | 工具可用性、参数与权限全部由服务端按真实现场重算；单步即循环的短路 | 「简单调用不无故增加规划与确认步骤」这一产品验收维度没有基准 | **需决定**：`check` 与 ASK 写都建 Task 并要求人工验收是否维持。维持则简单动作必然带正式交付步骤，与总纲 §0.16 的承诺冲突；不维持则需给会话发起的 Run 加「非交付」标记 |
| Workflow | **A** / **B** | LangGraph 图、审批 `interrupt` 与身份恢复、epoch 复核、UNKNOWN 核对全部生产接线，另有指定模型只读独立复核 | 总出口：Windows、浏览器与电脑资源的身份 | 无新增 |
| Plan and Execute | **A** / **B** / 局部 **C** | 服务端双闸门只读、计划版本不可变、执行绑定确切版本、Worker 推进与类型化停止原因；真实 PG 集成通过（含 2026-10-21 计划内容读写形状修复） | 真实 Provider 的计划质量、重启后接续、独立验收 | 额度含义、识别来源与未知处理（总纲 §0.15 明写待工程核定，现按冻结快照、未知不记为零或无限）；无进展阈值（现为硬编码 3）与扩额幅度是否改走产品口径；计划卡步骤是否升级为具备独立执行与恢复的任务节点 |
| Reflexion（当前任务内） | **A** | 检查失败→失败事实入库并回传→模型定位→原权限内修改→复检→据实结算，两个执行面都通，含真实 Provider 与只读独立复核 | — | — |
| Reflexion（跨任务） | **D** | 无代码入口 | 「提炼什么经验、谁确认、何时召回、如何处理失效、如何衡量收益」尚未定义。`learning-round.ts` 面向用户学习，不能当 Agent 自学习的实现依据 | 只交最小方案。未确认前不新增反思记忆库、不自动修改 Skill、规则或用户偏好 |
| Multi Agent | **B** ＋ 多项 **C** | 有界委派链已在生产会话链内（工具闸门、子执行只读、最多两子且仅一层、有界重试、epoch CAS、tick 恢复核对） | **没有一条真实跑完「主委派调查→主实施→委派独立审查→汇总交付」的产品链**：集成测试未调用 `createDelegation`／`runDelegationAttemptFlow`，`listSessionDelegations` 无生产调用方；开发环境由外部工具派发的子代理不算本产品证据 | C：主子共享预算并为主汇总预留额度、必要独立审查作为完成前置、子→主补充同步及真实来源保留、角色配置版本化 |
| Code as Action（受控基础） | **A** / **B** | 文件修改、`run_check` 冻结标识、`shell:false` 子进程、动作账本与 UNKNOWN 核对生产接线 | 结果丢失的**真实进程级**故障注入（现有注入点是 test-only，需确认覆盖 `CLI_RUN` 而不只 `FILE_WRITE`）、真实 Windows 子进程的窗口与取消行为 | — |
| Code as Action（通用解释器） | **D** | 无代码入口 | 产品行为与安全边界均未定义 | 推荐复用 `cli-adapter` 与 Gateway `CLI_RUN` 账本，不另立第二套外部效果 Owner；任何文案不得把「当前工作目录＋参数白名单＋子进程」写成 OS 沙箱 |

关系结论（只记录事实，不重做实现）：七种模式不是七套引擎。当前只有两条真实执行体——会话工具循环（`assistant-readonly-round.ts`，由 `assist-runner.ts` 在生产 tick 内驱动）与正式 Run 图（`run-graph.ts` 加 `run-steps.ts`）。Agent and Tool 是会话循环的一次调用，Plan and Execute 是同一生成链的信封分支加一个推进 Owner，Reflexion 是两条链共享的失败回传，Multi Agent 是会话循环内一个额外的应用内工具，Code as Action 是同一批受控工具与 Gateway 动作。这与总纲 §0.16「可组合，不代表七套独立引擎」一致。

跨模式共同缺的证据类只有五样：真实 Provider 下的模型选择与措辞质量、真实浏览器、真实 Windows/WebView2 窗口、安装态、独立验收。已具备的静态检查、fixture、真实 PG 集成与真实 HTTP 证据不能替代其中任何一项。

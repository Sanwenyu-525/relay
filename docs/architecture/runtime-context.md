# Runtime、Workflow、Context 与 AI Assist

> 当前接续（2026-09-24）：[ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)选择的 LangGraph.js 1.4.17 与官方 PostgresSaver 1.0.5 已接入 M03 固定 Mock Workflow，后端固定图分片已独立验收，整体验收仍待 G01–G08。PG 持久 command/outbox 负责分发；一个 Run 只使用一个图线程，节点复用既有 `advanceRunStep` 业务入口。旧的 AI SDK Core/ToolLoopAgent 推荐仅保留历史解释。M03 Mock 创建、SSE、审批、取消和故障恢复整体验收通过后才进入真实 Provider。Run/Review/Gateway/完成仍归既有 Owner，检查点不能替代业务事实或外部效果核对。

日期：2026-09-19。状态：Proposed。状态迁移唯一事实源：[契约 02](../../contracts/02-state-and-execution.md)；验证：[契约 03](../../contracts/03-verification-and-approval.md)。

## 1. 运行职责与模型端口

本文件描述业务需要的职责，不要求每层自研。按[复用策略](reuse-strategy.md)优先选用现成 SDK、Agent loop 或 runtime；P00 验证后明确唯一执行 Owner。当前 StepResult/ModelPort 是候选边界，只实现实际调用需要的适配，不为所有候选预建通用插件层。

Application 调用 Workflow 决定下一步，Runtime 只执行一次有界步骤。返回 StepResult（结果类型、产物/工具请求、证据、耗时、用量），不能修改 Task 状态。模型输出先按 schema 解析、校验引用和作用域，再变成受约束命令；自由文本中出现“已完成”不触发完成。

ModelPort 输入：模型配置版本、实际 ContextManifest、输出 schema、时间/令牌限制、取消信号。输出：结构化内容或 typed failure、provider request id、可获取的用量、结束原因。密钥通过 secret_ref 解析，不进入 Context/Trace。具体 SDK 在 P12 兼容验证时选择；第一实现是 FakeModelPort。

历史推荐为 AI SDK Core（已由 ADR-010 接续），当时选型状态见 [ADR-006](../decisions/ADR-006-typescript-first.md)。Delegate 由 Workflow 驱动单次 generateText/streamText：完整模型响应与工具意图先持久化，再经 Gateway 执行；不注册可绕过该顺序的自动 execute。恢复加载原参数和工具结果，不靠重跑模型生成“同一个”动作。必要 Provider 协议数据只在 Adapter 映射，断流半成品不执行。

每个模型请求保存 model_calls：run/step/attempt（Assist 可为空）、manifest_id、配置版本、request_id、状态、用量是否未知、错误类别。超时可有限重试纯生成，但保留每次成本与候选，不承诺供应商只计费一次。纯模型调用不绕过随后工具请求的 Gateway。

## 2. 固定 Workflow

内置 `markdown-deliverable-v1`：BUILD_CONTEXT → DRAFT → PERSIST_CANDIDATE → VERIFY → COMPLETE。CREATE Run 时冻结 ExecutionContract；BUILD_CONTEXT 只装配/复核，不修改冻结的验收内容。修正回路由 Workflow 的 RETRYING 处理，不引入任意图结构。

M03 当前源码以一个官方 `StateGraph` 编排该固定流程：`advance` 节点每次只调用一次 `advanceRunStep`；实际 OPEN 的验证类 Review 进入 `awaitCommand` interrupt，固定 Mock 工具意图在 DRAFT 后、PERSIST 前进入 `gatewayAction`，ASK 的 ACTION_APPROVAL 进入 `awaitAction` interrupt。两个 interrupt 都核对当前 Review 的确切 ID、类型及原决定，工具路径还核对冻结的原 `operation_id`；旧 RESUME 遇到后继 Review 只能确认自身投递，不能唤醒新 Review。Gateway 准入、动作身份、效果核对和 Run/Task 变更仍由原 Owner 负责，图只保存 Run ID 与路由提示。`thread_id=run_id`；LangGraph 1.4.17 的根图实际写入空 `checkpoint_ns`，版本隔离使用固定物理 schema `relay_graph_v1`，不依赖传入 namespace。官方 Saver 与业务提交是两个事务：崩溃后按原 command/attempt/operation 身份重入，不能将图状态视作已发生效果的凭据。Worker 启动前只读核对 Saver schema，不执行 DDL；安装见[部署设计](../deployment/local-deployment.md)。固定图与 Mock Gateway 节点已通过列明范围的分片独立复验，剩余限制见[M03 独立验收](../testing/m03-independent-acceptance.md#windows-action-context-修复与新版-mock-试用链独立复验)。

M03 在途 Mock 取消由独立 Worker 观察 PostgreSQL 中已提交的 `PENDING` 控制请求，并向当前图、FakeModelPort 与 Gateway 传递 `AbortSignal`。DRAFT 模型等待在业务事务外；步骤结果写入前仍在 Task→Run 短事务里复核控制，未发生外部效果时不把中止结果写成成功。Worker 停止后，监督器须先观察子进程 `close` 并 fence 旧 epoch；若没有未决效果，恢复用例才把旧纯计算 `RUNNING` Attempt 结清，再应用控制。已派发或结果不明的效果保留原 `operation_id` 和资源隔离，继续按既有核对路径处理。Windows 强制终止子进程不能假定模型在进程内收到可处理信号；只有停机证据可用于恢复。真实 Provider 的取消仍属 M04。

| 步骤 | 输入 | 持久输出 | 重试/恢复 |
|---|---|---|---|
| BUILD_CONTEXT | 契约、当前合法事实、所需资料 | 不可变 Manifest | 必需内容缺失/超预算停下，不删除约束硬凑 |
| DRAFT | Manifest、输出结构 | 模型尝试记录、候选内容 | 纯生成最多 2 次基础设施重试，指数退避且可取消；这是推荐预算，可版本化配置 |
| PERSIST_CANDIDATE | 完整候选 | ArtifactVersion | 按稳定来源尝试 ID 去重；未知存储状态先核对 |
| VERIFY | 版本集合、验收与规则绑定 | Session/CheckResult | Checker 故障重试 checker，不重复生成；改产物产生新版本/Session |
| COMPLETE | 适用证据、执行权 | CompletionRecord、Task/Run/State | 只重做短事务，绝不重跑成功工具 |

Run 默认修正预算 2 次，与模型连接重试分开统计；总调用/成本上限由执行配置提供。耗尽进入 Review，不自动增预算。所有默认值进入版本化配置和 UI，不隐含为不可更改业务事实。

Development 增加 `change-and-verify-v1`：读取固定基线 → 生成变化集 → 隔离副本应用 → 受控验证 → 人工审批应用/commit/push（仅任务需要时）→ 验证证据 → 完成。复用同一 Run/Gateway/Review 机制，不创建第二个 Agent 系统。

执行器实现由 P00 复用验证决定，有界线程池只是一种候选。业务执行先按 DB 协议取得合法执行权；排队不等于持有资源写权。外部 harness 的 session/thread/turn 与产品 Run 显式关联，重复事件去重，不把 SDK 状态当第二套业务事实。每轮下一步前核查控制请求；进程退出时保存控制/核对信息，不能强行标记成功。框架 checkpoint 与业务完成事务不默认原子，恢复必须处理两边提交不一致。

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

每个采用片段最多 1600 个 JS 字符，保存实际 UTF-8 字节范围、片段 SHA-256、原完整来源 SHA-256、不可变版本、内容及 `UNTRUSTED_DATA` 标记；受管 ArtifactVersion 先在短事务外核对原文件 hash/size，缺失或损坏记 `SOURCE_UNAVAILABLE`，不把 `content_text=null` 当成空资料。当前估算为规范 JSON 的 UTF-8 字节数除以 3 向上取整，默认 8192 token，上限中预留 1536；估算值不是 Provider 计费或精确 tokenizer。Mandatory 超限以 `CONTEXT_REQUIRED_OVER_BUDGET` 使 BUILD_CONTEXT 失败，不裁剪契约；Relevant 超限可整段跳过并记 `BUDGET_TRIMMED`。第一方固定 Profile `run-default@1` 只定义当前允许的来源与界限，Manifest 保存 Profile 摘要、Builder/模板版本、Skill=null；尚无可选 Skill/Pack 注册调用方。

独立 `context_revision` 随长期信息写入递增，Rule 写入也递增它但仍由 `rule_revision` 负责执行栅栏。Builder 在 authority→Task→Run 的提交事务中核对装配时的 authority/context 版本与 Project/Task revision，变化时不提交过时 Manifest。已成功的 BUILD_CONTEXT 在继续执行时按实际消费的 Task 标题、所属 Project 和验收版本，以及 authority/context/Project 修订判定来源是否过期；Task 行修订仍记录在 Manifest 中，但审批或状态变化本身不重做成功草稿。DRAFT 前且没有外部效果的来源变化可以重新 BUILD_CONTEXT，新片段生成新 hash，旧 Manifest 保留。

固定 Mock 图的 Gateway 动作在 Admit 的 authority→Task→Run 短事务内再次核对原 Manifest；审批等待期间来源过期时不执行 Fake 写入，保留原动作身份与拒绝依据。效果已发生而受管候选尚未发布时，后续来源变化阻断 BUILD_CONTEXT/DRAFT 重做，须按原动作身份核对。发布成功后不重放或抹掉效果证据，VERIFY/COMPLETE 仍依冻结 CheckPlan、当前验收与各自 Gate 判断，修正回路会重新装配。列表与详情读取当前范围、根状态、Memory 到期和受管文件可用性，过滤无权来源及其排除项，不返其 ID/名称/正文/数量；历史快照不授予新的动作准入。Verifier 不消费 Manifest 中的 Worker 自评。无 Project Assist 尚无 P12 端口，本段不为它制造 Run 或假资料。

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

## 6. 可验收结果

2026-09-20 Skill 补充（Proposed）：[Relay Skill](relay-skills.md) 复用上述 Assist 与 Delegate 路径。首个蓝图 Skill 在创建最小 Project 后由 Assist 生成，不创建虚假 Task/Run；可选资料来自已授权查询和显式选择的受管版本。Skill 身份、定义摘要与解析依赖写入请求、ContextManifest 和提案；Delegate 场景另冻结到 ExecutionContract，版本升级不能覆盖历史或重发 UNKNOWN 动作。Context 缓存键还须包含 Skill 定义摘要和依赖版本；Mandatory 与 Permission 不受 Context Profile 覆盖。

Blueprint 的 schema/注册引用检查不等于业务 Verification PASS。验证配置仅能推荐；生效 CheckPlan 仍由 Verification 按验收/规则产生。生成和应用的明确边界及并发验收见专题与[测试计划](../testing/verification-plan.md#8-relay-skill-与蓝图应用验收)。

闭环 Skill 补充：首批任务定义/验收方案在 Delegate 前形成并接受，Run 冻结后不能由 Worker 改检查标准。Project Resume 只读当前事实并保留来源版本。Repair Contract 是原 RETRYING 步骤的输入，包含失败证据、固定产物/验收版本、修改范围与预算；新候选需验证，ERROR 不启动产物修复。Handoff 的最小事实包由核心查询生成，AI 说明失败不阻塞安全控制；确定性 State delta 不经模型生成或 Skill 调用，仍在 CompleteTask 事务计算。完整职责见[闭环目录](relay-skills.md#7-首批闭环能力与后续目录)。

Fake 场景固定涵盖合法输出、结构错误、缺资料、必需 Context 超限、checker 超时、修正耗尽、审批等待、延迟结果、取消。模型成功示例不能代替这些测试。A04–A06、B01–B08、C01–C09 与 D01–D06 是业务依据。

Context 历史重放只能证明“输入可重建”，不保证随机模型产生相同输出，也不保存或暴露模型私有思考链。

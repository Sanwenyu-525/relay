# Agent 生成的领取、停止与生命周期

日期：2026-10-30。当前测试结果归[Agent 主链验收](../testing/acceptance-details/part-11.md#条目-191)，不替代真实 Provider 或桌面验收。

## 已复现的问题

1. 宿主 AbortSignal 在 tick 开始前已经停止，仍会领取 PENDING 消息并生成 COMPLETED 回复。原因是仅监听后续 abort 事件，没有检查信号当前状态。
2. 同会话第一轮模型还在等待时，第二个 Worker 能领取并完成排队消息。原领取语句只排斥同一消息的重复领取，没有排斥该会话已有的 RUNNING 消息，会破坏回复顺序及插话的投递目标。
3. Agent 主流程异步返回时，外层 finally 提前清理心跳和停止监听。用户取消与宿主停止不能及时中断在途模型请求，长生成也失去续租。原因是 try/finally 内直接返回 Promise，而没有 await 生成结束；同一入口的人设和学习分支存在相同结构。

## 修复与边界

- 进入 tick、异步维护之后及领取前检查宿主停止；领取后注册监听时也同步当前信号，停止后的宿主不再启动新调用。
- 生产 Application 在原短事务内领取：先选择并锁定可领取的会话，再用下一条语句的新快照核对 RUNNING 并更新消息。会话锁持有到领取事务提交；第二次核对防止并发语句使用旧快照。已有生成的会话继续排队，其他会话仍可领取，不引入全局串行锁。
- 三种生成分支等待实际结算后才运行 finally。用户取消仍先写 cancel_requested；仅宿主停止时不伪造用户取消，保留原领取事实供租约恢复核对。
- 不修改 Task/Run 执行权、不重试未知副作用，也不新增 migration 或 HTTP 字段。Breaking Change: No。

## 回归落点

- `assist.integration.test.ts`：已停止宿主零领取/零调用；同会话排队、其他会话可推进及前轮结束后续跑。
- `agent-conversation-main-loop.integration.test.ts`：模型在途时用户取消与宿主停止都能中断请求，分别保持 CANCELLED 与待恢复的 RUNNING 事实。
- 连续工具和执行候选测试的主流程夹具显式关闭独立自动记忆提取，仍保留历史记忆/召回；否则提取模型调用会覆盖测试端口记录的最后一轮工具与上下文。自动记忆默认行为不改，由其独立集成套件及基础聊天调用账本测试覆盖。

关键实现为 [assist-runner](../../apps/api/src/application/assist-runner.ts) 与 [assist-repository](../../apps/api/src/assist/assist-repository.ts)。共享大文件中的 `AGENT_STOP_CLAIM_FENCE`、`AGENT_GENERATION_LIFETIME`、`AGENT_SESSION_GENERATION_FENCE` 是本轮定点修改锚点。

## 模型响应流与计量接缝（2026-10-30 接续）

后续沿 OpenAI-compatible 流接缝复现三处缺陷：SSE 超长完整行与换行符同块到达时绕过原有长度检查；校验失败只终止包装流而不取消上游、释放 reader；已收到的 SDK 缓存用量被后续未携带该字段的 metadata 覆盖成 null。

修复保留既有单行上限，同时检查完整行与未结束的行；正常 EOF、主动取消和校验失败均释放上游 reader，失败时发起上游取消，不等待不可信上游完成清理才向消费者报错。缓存字段按「缺省保留已知值、显式 0/null 更新」处理，不伪造未上报的用量，也不能恢复 SDK 在端口收到数据之前就丢弃的字段。

对应实现为 [模型端点流守卫](../../apps/api/src/workflow/model-endpoint-policy.ts) 与 [模型端口](../../apps/api/src/workflow/openai-compatible-model-port.ts)。回归包括超长完整行、持续打开的上游取消、正常 EOF/调用方取消，以及 SDK metadata 的缺省/0/null；受控本地 HTTP 另验证 SDK→Assist→PG→独立 API 的失败分类、零部分正文及上游 HTTP 响应关闭。取消夹具等待模型调用入口后再触发取消，因为消息 RUNNING 本身不保证 model_call 已创建；保留原账本断言。当前成绩归[调用诊断验收](../testing/acceptance-details/part-16.md#条目-297)，不代表真实 Provider、计费或 TLS/DNS 验收。请求/响应结构不变，Breaking Change: No。

## 普通会话统一工具循环后的异常出口（2026-10-31）

真实免费文件用例暴露并接续修复的边界：目录 AUTO 允许模型看见 `apply_changeset`，但 Gateway 原先
对无 Run 范围授权的非 passthrough 写动作仍降级为 ASK；会话入口返回
`SESSION_WRITE_NEEDS_APPROVAL`，原动作等待批准而不会自动接续。不得因此改动作身份重试，
也不能为了取得通过将该用例改称 FULL 下成功即代表 AUTO 已闭合。修复前真实模型测试分别记录
AUTO 的拒绝/零磁盘改动和预先明确授予 FULL 的独立合成目录；修复后重新独立验证两种档位
的读写回读，不能继承旧成绩。自定义策略已经产生的等待审批仍须沿原
Operation 身份或既有 Run 机制核对。普通 AUTO 修改按 ADR-031 的既定目录授权补接，
prepare/admit 同一函数现读档位；只覆盖会话来源的无删除变更集。删除、ASK/DENY、其他
能力与 Run 的范围授权保持原边界，不通过改用 FULL 或新动作身份绕过待审批动作。

执行后的追问接续：此前只有插话后才读取在途 Run 提示，普通后续追问没有当前正式执行
状态。现复用原会话执行请求、Run 与 Task Repository，在每轮 Context 装配时重读原身份
的状态和 revision，不写业务状态、不自动重试。AM-06 新增反例确认旧代码缺少状态块；
修复后覆盖首次追问、Run 状态变化后再问、其他会话隔离及聊天不驱动 Run。状态事实不能
替代产物、文件、检查或人工验收证据。

同一接续随后补齐验证摘要：此前即使原 Run 已有验证，后续追问仍看不到确切受验版本和
检查结果。现通过既有 Verification/Artifact Owner 只读投影最近一份验证及每项最新尝试，
保留版本摘要、验收版本匹配和撤销标记；过滤不同 Task/Workspace 的产物，限制摘要条数，
不注入原始日志。AM-06 用旧 PASS→最新 ERROR、新产物版本、撤销适用性和验收要求变更
核对不冒充当前通过；这不代表执行了新的检查、读取了文件正文或完成了人工验收。

检查修正后的 CLI 回执此前没有进入原会话摘要，导致即使生产图已实际经历退出 1→修正→退出 0，
追问仍只能看到 Verification 的最终状态。现在同一只读投影补原 Run 最近五条 run_check 的
身份、Operation 状态及已知退出码，不注入原始输出或命令参数。回执以当前 Operation 为准，
UNKNOWN 不借旧工具行的退出码判成功，不重试。图修正、真实 CLI/磁盘、等待 HUMAN 与重放
不新增效果的既有断言保留；原消息关联在该定向图测试中受控建立，不宣称自由模型决策已验。

预览协议边界接续：最终解析允许简短前言后接信封，因此预览中的普通文本一旦遇到 `{`
就停止在此前的说明文字，避免把后续 execution/maintenance 当普通正文发布。这是保守
降级，普通正文中的花括号也会停止预览，最终完整正文不受影响。首字段 reply 的信封
另支持标准 JSON/无语言代码围栏（包括分块的围栏与 CRLF）；未知语言仍等待完整解析。
这替代下文“所有代码围栏均等待完整回复”的早期限制，不增加任何执行准入或状态写入能力。

后续功能接续：结构化回复支持增量预览。`AgentReplyPreviewProjector` 仅解码以首字段
`reply` 开始的 JSON 字符串，按完整转义边界输出增量；字符串结束即停止，不读取
`execution`、`maintenance` 或其他后续内容。普通文本保留原预览；代码围栏、数组、
非首字段 reply 等不确定形态不预览，最终回复仍沿原完整解析与结算入口。投影输入上限
131072 个 UTF-16 code unit，超限停止预览，最终正文不截断；可见前缀仍由既有 Publisher
限制 UTF-8 字节数。这接续替代下文早期“结构化 reply 暂不增量解码”的限制。

取消响应也须保留调用事实：工具循环收到正常返回的 CANCELLED 时，累计该次已知用量并保存请求 ID，不能只保留此前成功轮次的计量。未提供用量时仍保持未知；这不表示取消成功回滚了模型消耗或外部动作。回归位于 `session-todo-tool-loop.integration.test.ts` 的合成取消响应场景。

无目录的普通会话也因 `todo_write` 进入主循环后，原单次生成分支的异常与预览保护不再覆盖它。
真实 PG 回归复现：工具循环把原始异常折叠为失败结果时丢掉已知请求 ID 与用量；持久取消与
Provider 拒绝竞争时落成 FAILED；普通文本的预览回调缺失，使本地预览写入故障无法沿原出口归因。

修复仍复用现有调用账本、预览 Publisher 和生成 catch：每次实际调用绑定自己的 callId，
默认连接使用解析后的冻结预算端口，OpenRouter 使用已有逐调用入口，不再包第二层账本。
只有整个路由调用最终失败才把原异常交回生成出口，不能把免费候选中途失败、后续候选成功
误判成消息失败。持久取消、宿主停机与失权 Worker 继续分别核对；原始请求身份和已知用量
保留，不将本地预览写入错误归为 Provider 网络故障。

普通文本增量恢复原预览与首文本计时；以 JSON/代码围栏开始的结构化输出仅记首文本，待完整
解析后显示正文，不把执行候选 JSON 直接发布到预览。预览最终缓冲在调用结算前刷新，本地
写入故障因此仍可将该调用记为失败。结构化信封内的 `reply` 暂不做增量解码。

回归沿用 `assist.integration.test.ts` 的失败证据与取消竞争反例，并覆盖独立 API 预览、SSE、
来源撤销、租约失效、结构化信封不外露及免费路由。预览夹具关闭独立自动记忆提取，避免它
干扰回复调用的时序断言；撤销来源后的下一轮检查实际请求不含旧来源与旧回复，符合当前
历史来源排除机制。实际结果及未验边界只归[Agent 主链验收](../testing/acceptance-details/part-11.md#条目-191)。

同轮还复现待办恢复批次被永久 REQUESTED 的未提交调用占满，导致后续已提交调用无法补结算。
恢复查询现在先筛选存在已提交事件的原身份，再应用批次上限；无事件记录保留原状，不重新
执行。TL-41 用批次上限 1 复现并检查补结算不新增事件或版本，规则归[ADR-038](../decisions/ADR-038-session-todo-list.md)。

## 自定义 ASK 会话写的审批路由与原动作重放（2026-10-31）

反例复现：FULL 目录遇自定义 ASK 策略时先产生 AGENT_SESSION_WRITE 的 Operation/Review，
但会话没有审批推进器，既有 Review resolver 也不接这种无 Run 来源。新动作现于最终 ASK
判定后、创建 Operation 前返回 SESSION_WRITE_REQUIRES_RUN；工具回执保留类型化原因，
原消息提交尚未执行的变更候选，经原 Run 审批与真实恢复命令执行，不新增审批 Owner。

核对旧动作时另复现 prepare 重放误查 USER_ACTION 来源，导致同一会话 Operation 重复插入
主键冲突。现会话来源按原 operation_id 查回并核对意图、归属、目标和参数；已有状态如实
返回，异载荷冲突拒绝。读取旧待审批状态不代表已经支持其异步恢复，不自动重放或造替代。

回归覆盖原消息→类型化工具拒绝→零会话写动作→唯一 Task/Run→单次动作审批→持久化 RESUME
命令→原工具/Operation 写入一次，重复 Apply/批准/派发不新增效果；原准备动作重放和旧待审批
状态保持原身份。实际结果统一归[条目 191](../testing/acceptance-details/part-11.md#条目-191)。

## 目标轮次的证据完成门（2026-10-31）

真实 PG 反例复现：目标轮次报告 COMPLETE，必需条件标 MET 但 evidence=null，推进器仍进入
AWAITING_ACCEPTANCE。根因是完成门只检查状态，未核对证据是否存在。

`goal-advance.ts` 现在把没有非空证据的 MET 报告约束为 PENDING，完成门同时检查必需条件的
状态与证据，兼顾历史条件没有新报告的情况。null、空字符串和纯空白均不能放行；原始模型
报告仍保留在消息 goal_outcome，应用裁决体现在目标条件和轮次账本。人工完成命令仍只接受
待验收目标；非空证据不代表其内容已被独立验证，也不代表正式 Task/Run 已完成。

回归与真实免费模型接续的结果、未验边界归[条目 083](../testing/acceptance-details/part-05.md#条目-083)。

## 目标接续缺少明确请求与 JSON 格式约束（2026-10-31）

免费模型实测完成读写回读后只输出“目标已完成”的普通文字，消息生成成功但 goal_outcome.goal
为 null，推进器按 NO_STRUCTURE 保持 ACTIVE；不能把这类正文直接翻译为完成。受控反例还确认
自动续轮的历史以旧助手回复结尾，缺少明确的本轮推进请求。模型目录要求 JSON 能力，但
DISCUSS 请求没有把该协议落实为 Provider 的 response_format，单靠 system 提示并不可靠。

修复沿原生成链传递显式 responseFormat：计划和目标请求使用 json_object，普通聊天保持原行为。
目标每轮追加带固定标识的服务端调度请求，明确继续原目标、核对现场、按 reply/goal 信封结算；
这不是新增用户授权，不改变暂停、取消、额度与完成 Owner。JSON 格式只约束语法，缺失目标
字段或缺证据仍走既有未完成出口，不做自然语言补判或无限重试。结构化 reply 仍可沿原投影预览。

定向回归锁住实际请求的末尾角色、调度标识、冻结计划版本及 Provider JSON 参数；结果统一归
[条目 083](../testing/acceptance-details/part-05.md#条目-083)。

## 生成中的 Token 进度接缝（2026-11-01）

实时 Token 读数复用既有生成预览链路，不新增 Runtime 分支：模型端口在请求发出前与每个 chunk 后上报一份可丢弃进度（输入估算 = UTF-8 字节 / 3，输出估算 = 正文 + 推理 + 工具参数的累计字节 / 3，Provider 已上报字段单独携带）；Assist 侧的 `AssistLiveUsagePublisher` 约 500ms 一档写入 `assist_message_previews.usage`，写入失败只丢这一帧，不中断生成，所有者失权仍按既有 `PREVIEW_OWNERSHIP_LOST` 收口。读侧按 `call_id` 合并：只有仍为 `STARTED` 的调用估算参与，结算后 `model_calls` 优先；辅助外呼按 `purpose='PRIMARY'` 排除。Estimates never enter the ledger, and unknown fields stay null rather than becoming zero. 规则与状态口径归 [HTTP §10.130](../api/http-command-contract/part-08.md#10130-会话回复的实时-token-读数2026-11-01-源码实现迁移-0155)，界面归 [工作台 §28.10](../frontend/workbench-design/part-10.md#2810-agent-回复的实时-token-读数2026-11-01)。

## 等待阶段的流式观测（2026-11-01 AGENT_STREAM_VISIBILITY）

用户此前只能看到「三个点一直在跳」，无法区分排队、上下文准备、模型等待与前端延迟。本轮不新建执行状态机，只把既有 `model_calls` 账本的四枚时间事实接到消息投影与界面：

- **首流事件接线**。`first_stream_event_at` 原先只有免费路由的包装写着；默认兼容端口的 A 档、普通主循环、工具续轮、人设助手只读轮次（B 档）、子 Agent 与学习轮次都没有传 `onStreamEvent`，该列对默认路径恒为 null，因此无法区分「请求已登记」与「Provider 已响应」。现在这些路径在每次真实调用上补传 `onStreamEvent`，由 `observeModelFirstStream()` 做一次条件 UPDATE；免费路由自身已有包装，重复调用因 `first_stream_event_at is null` 守卫成为空操作。
- **证据写入不改变业务结果**。观测是证据，不是业务动作：写不进去（调用已结算、租约已失、数据库瞬时错误）只丢这一枚时间，不把一次成功的模型调用改判为失败；免费路由的首文本记录同样改为 best-effort。
- **B 档补账本**。人设助手的默认兼容端口此前直接调用 `modelPort.assist`，没有 `model_calls` 行，因而既没有调用计量，也没有「请求已登记/首流/首正文」。现按 A 档、主流程与子 Agent 的同一形态补 `recordModelInvocation`，免费路由仍不包第二层。
- **只读阶段投影**。`GET /assist-sessions/:id/messages` 对每条 `RUNNING` 的助手消息返回 `generation_progress`：`phase ∈ PREPARING_CONTEXT | WAITING_MODEL | MODEL_STREAMING | MODEL_OUTPUT | PROCESSING`，`call_count` 与最近一次调用的 `status`/`started_at`/`first_stream_event_at`/`first_text_delta_at`/`first_preview_persisted_at`/`settled_at`。阶段只由「消息已领取 + 最新 PRIMARY 调用的事实」派生：没有调用行是准备上下文；调用 STARTED 且无首流是等待模型；有首流无首文本是「模型已响应，等待正文」；有首文本是「已收到模型输出」；最新调用已结算而消息仍 RUNNING 是处理工具/续轮。辅助外呼按 `purpose='PRIMARY'` 排除。
- **客户端只读**。`generationStageView()` 把阶段翻成一句等待文案；PENDING 只说「等待处理」，没有阶段读数（旧服务端、未知枚举）只回退到「正在生成」，不按等待时长猜测模型是否已响应。阶段行只在「没有可见草稿、没有工具主进度、没有取消意图、没有核对中」时渲染，正文或工具接手后整行卸下，同一时刻只保留一组动效；`generationStageDiagnostics()` 只提供可展开的延迟读数。
- **无迁移**。阶段需要的四枚时间列均在既有 `model_calls` 上；本轮不新增列，也不伪造「领取时刻」。诊断把「提交 → 模型请求登记」明确标为含排队与上下文准备的合并区间，Worker 领取时刻标为未记录，前端首次绘制标为本机未观测，避免把消息总耗时当作模型推理耗时。

回归：单元 `assist-generation-progress`（阶段派生与 DTO）、真实 PG/HTTP `assist.integration.test.ts` 的流式观测用例（首流/首文本/首预览/结算四枚时间落库、辅助外呼排除）、组件 `generationStage` 与 `assistStage`、真实 Chromium `assistStageVisibility`（阶段推进、诊断展开、窄窗、减少动效）；成绩归[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行。Breaking Change: **No**——消息 DTO 新增可选只读字段，旧客户端忽略即可；不改命令、表、权限或结算。

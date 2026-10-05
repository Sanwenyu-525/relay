# 会话内可折叠执行计划：实施提示词

日期：2026-10-03。用途：交给执行 Agent 的专项任务。本轮仅编写文档和提示词；文件的编写、链接或被动阅读不代表开工。用户实际下发下方任务后，才在本范围内实施，不重做在途内部文件/Git 工具循环。

产品范围、工程 Owner、交互与验收分别归[总纲 §0.7](../Personal_Workflow_OS_Master_Spec.md#07-会话内可折叠执行计划2026-10-03推荐设计)、[运行架构 §2.4](../docs/architecture/runtime-context.md#24-会话执行计划的归属与持久更新推荐设计)、[工作台 §22](../docs/frontend/workbench-design.md#22-会话内可折叠执行计划推荐设计)与[测试计划 §19](../docs/testing/verification-plan.md#19-会话执行计划验收规格)。上游机制只在[研究 §1.3](../docs/research/p00-source-study.md#13-会话执行计划机制对照2026-10-03)维护。本文负责实施顺序与交付，不复制第二套需求或验收成绩。

复制下方整段交给有本仓库访问权的执行 Agent：

~~~text
你在 D:/Develop/Relay-Agent 工作，所有说明、进度与交付用中文。实现「会话内可折叠执行计划」：模型在有界执行中维护结构化步骤，应用持久保存与回送，用户在原会话看到当前步骤、真实 Run 状态与基本执行依据，重开后可按原身份读取。

用户实际发送本提示词即授权本范围内必要设计、实现、测试、构建和文档维护。按下面两片完成自检、独立验收、修复复验，通过后自动继续下一依赖片，不为例行工作重复确认。不能只展示硬编码清单、解析 Markdown 复选框或回复设计。没有对应运行证据的项保持未验收，不用文档检查或静态图片替代。

一、开工与当前事实

先读 AGENTS.md、CODEX_NEXT_STEP.md、docs/README.md 与统一功能验收表顶部，确认共享工作区及在途工具循环的 Owner、接口和受验基准。按范围读取：
- Personal_Workflow_OS_Master_Spec.md §0.7、docs/requirements/v1-scope.md 的会话执行计划补充。
- docs/architecture/runtime-context.md §2.3–2.4、agent-prompt-design.md、domain-model.md。
- docs/frontend/workbench-design.md §18、§22、design-system.md、design-tokens.json。
- docs/testing/verification-plan.md §19、contracts/01–04、prompts/README.md 的公共约束。
- docs/research/p00-source-study.md §1.1、§1.3、ADR-005、ADR-010；按清单对照已有 Codex/LangChain 源码与官方 OpenCode 固定提交，不安装新框架或复制整仓。
- prompts/agent-native-tools.md 只作为依赖工作包读取，不能把它的完整范围再次当作本次任务启动。

当前定向核对到的代码入口，实施前重新确认，不当作冻结实现保证：
- apps/api/src/workflow/tool-catalog.ts、application/tool-loop.ts、run-steps.ts、worker/run-graph.ts、worker/tool-loop-action.ts。
- apps/api/src/run/run-tool-call-repository.ts、migrations/0054_m04_agent_tool_loop.sql：当前工具调用账本与 Gateway Operation 对应。
- apps/api/src/application/lock-task-run.ts、conversation-execution.ts，以及对应仓储：原执行权、原消息和会话/Task/Run 关系。
- apps/api/src/api/run-api.ts、run-events-api.ts、application/run-queries.ts：真实查询与 SSE 刷新提示。
- apps/workbench/src/views/AssistView.tsx、CollaborationView.tsx、RunView.tsx、components/RunTracePanel.tsx、api/runEvents.ts、relayClient.ts。
- apps/api/src/application/complete-run.ts、workflow/check-plan.ts：完成与验收 Owner，计划不取得其写权。

工作区存在其他 Agent 的未提交代码与文档，不能覆盖、回退或清理。保留 React/Tauri/Fastify/Kysely/PostgreSQL/LangChain/LangGraph 主栈；不另建 Agent factory、通用 Planner、独立循环或第二套 Run。确需子代理时先划清文件所有权和验收职责，使用 gpt-6.1-sol，接口支持 model 时显式指定；不选择锁定其他模型的角色、不静默降级。

二、范围与依赖

首片服务已经通过原执行请求关联到正式 Run、且实际支持工具请求/结果协议的会话。计划是 Run 工作元数据，会话只读投影；正式 Task、固定 RunStep、CheckPlan、Artifact 和 CompletionRecord 不改变职责。无计划旧 Run 保持原行为，纯讨论保持自然语言，不为清单建立 Task/Run。

包括：内部计划工具、严格 schema、稳定步骤身份、revision/CAS、原调用幂等、持久快照及恢复、基本真实依据关联、读查询、原事件刷新、会话折叠 UI、相关测试与文档。推荐工具名 update_execution_plan；具体 schema/表/DTO/端点由当前代码核定后记入所属主文档。

不包括：完整重做内部文件/Git/CLI 能力、外部 Coding Agent 主路径、跨 Task 计划调度、多 Agent 合并、依赖 DAG、自动重排、后台触发、N04/N06、任意 Shell、自动影响传播、每个步骤强制生成 Artifact 或独立验证器、论文实验。计划建议不能成为新的执行授权或改变冻结契约。

依赖现有持久模型工具轮次。若相关代码仍由其他 Agent 修改，先确认接口与基准再接线；可独立完成计划用例/存储与测试，但依赖未通时必须报告具体缺口，不接第二套 loop、不用 fixture 冒充已接入。新增项的局部通过不解除在途工具循环及 M04–M07 的未完成出口。

三、设计和后端硬约束

先按对象/Owner→用例与短事务→身份/版本/幂等→持久化与恢复→API/UI 核定薄设计，更新已有主文档后实施。实际 API 与数据库变更说明 Breaking Change、兼容旧 Run/checkpoint/调用及必要追加 migration；已应用 migration 不修改，迁移编号核对当前工作区和数据库后选择，不能预占与并行任务冲突的编号。

计划工具属于内部元数据类别，由 Application 校验提交，不需要额外文件 Connection，也不制造 Gateway Operation/Invocation、资源 claim 或 ACTION_APPROVAL。外部读写/CLI 工具继续走原 Gateway。当前工具词表强制 actionType/capability、SETTLED 强制绑定 Operation，历史结果仅从 Operation 投影：不能仅加工具名、填假 Operation 或把 JSON 塞进 result_ref 就声称接通。补最小类别区分、持久内部结果、结算及消息重建，保持外部动作约束，不整体放宽旧账本。不将新工具直接写进旧不可变执行契约；新 Run 的内部工具可见性和旧 Run 的兼容路径明确区分。

计划 schema 要有最小严格校验：有界标题与项数/字节、稳定且唯一项身份、有限状态、期望 plan_revision、受限依据引用、禁止额外字段。现有 validateToolArguments 只支持 string/integer/boolean，需要给此数组/嵌套对象补实际校验，无须自建通用 JSON Schema 引擎。拒绝半截 JSON、未知工具/状态、重复项、多项进行中、超限及模型传入的权属身份。

首版串行全量快照更新，同轮多个计划写请求明确拒绝。应用生成新项身份并在工具结果回送，后续改名/重排保留身份；拆分、取消、替换可查原因与必要历史。模型不得用位置、同名文本或文案 hash 绑定依据。控制状态来自原 Run，不能让模型自行宣称已暂停、审批通过或 UNKNOWN 已解决。

推荐输入明确区分新项与已有项：新项传本请求内唯一 new_item_key，已有项传原 plan_item_id，二者互斥；应用的持久回执返回 key→ID 映射和规范快照，同请求重放复用原映射。首次创建期望 plan_revision=0，成功为1，后续按当前 revision/CAS 更新。全量快照保留已有项，取消/替换须显式标 cancelled 并给原因；遗漏旧项直接拒绝，不能静默删除后缩小分母。具体字段在实施时冻结，语义保持。

在既有 Workspace authority→Task→Run 锁顺序下复核当前 Task.executor_run_id/ownership_epoch、Run worker/epoch、Attempt claim_epoch、有效 invocation/租约、持久控制意图及预算。终态、过期执行者或停止后的新请求拒绝；旧成功请求的只读回执不改变当前事实。内部计划更新同样受原调用/轮次限额约束，不能借不断改计划绕过 max_rounds/max_tool_calls。

每次更新绑定已保存的模型调用/工具请求身份与规范载荷摘要；Provider tool_call_id 仅是轮内关联。事务内先核对原幂等回执，再处理 plan_revision/CAS：同身份同载荷返回原结果、异载荷拒绝；新身份旧 revision 明确冲突。计划快照、更新回执和原事件通道的刷新依据在同一短事务提交。外部 IO/模型等待不进入事务。现有普通 INSERT 或唯一约束不能冒充已经实现“原回执返回”。

completed 仅记录局部步骤完成声明，不修改 Task DONE、Run SUCCEEDED、CheckPlan 或 Verification PASS。依据链接只接受确切当前 Run 的工具结果、动作回执、Attempt、Artifact 版本或检查记录；应用校验存在、归属、状态、可见性和类型。拒绝伪造/跨 Run/越权引用，失败、UNKNOWN、未运行及旧版本不显示为通过。无依据的分析步骤可显示“Agent 标记”，不能编造检查结果。依赖关系不足时保留待核对，不建设自动传播。

保存后的回执丢失、事件丢失或重启按原身份恢复，下一轮模型使用同一计划快照和已结算结果，不再生成“同一个”更新或重放外部副作用。不因清单更新递增 Task revision、改验收条件、另开 Attempt 或重建未变化 Context；正常下一轮模型调用仍走原预算。checkpoint 仅引用权威记录。

四、查询、事件与会话 UI

沿原权限与会话/执行请求关系读取确切 Run 的计划；同会话多个 Run 不用“最新一条”猜当前对象。新查询只读，不调用模型或建任务；失权隐藏正文、引用名称和数量。复用原 Run SSE 的 hint/seq/重连处理，提交后提示刷新并重读快照；SSE 不成为计划事实源。

首次快照与订阅的更新窗口必须闭合：复用有证据的 seq 衔接/重放；仅有 hint 的通道在订阅就绪后再次读取快照。验证“首次读取完成后、订阅前提交唯一一次计划更新”仍能最终读到新 revision，重连同样适用；晚到旧查询不得覆盖它。

按 workbench-design §22 做输入区附近的紧凑折叠列表，直接消费持久计划，禁止硬编码十二项、解析聊天复选框或用固定五步冒充动态清单。显示已完成/当前有效项数、当前步骤及真实 Run 状态；取消项另计，计数不冒充工作量百分比。步骤复选框只读，计划全勾选时仍保留原验证/完成状态。

暂停中、已暂停、取消、失败、等待审批、UNKNOWN 及原核对/控制入口始终可达。依据展开复用原 Trace/成果/检查阅读组件，确切版本可定位；折叠偏好只在本设备保存，不改业务状态，不抢输入焦点或阅读位置，不另造一套 tokens。

Loading、错误、重试、断线和读取时点可见。切会话/Task/Run/连接后清理旧对象投影，晚到响应按对象/连接 epoch/revision 丢弃；同对象的旧快照若保留须明示。重开只恢复阅读，不自动 Resume/Delegate 或进入下一任务。保留现有草稿、未决命令及离页守卫 Owner。

五、两片实施与验收

A 片：持久计划与真实工具闭环。
完成内部工具类别及 schema、计划用例/存储、幂等与 revision、内部结果回送/消息重建、基本依据校验、权限查询和事件刷新。对照 EP-01–EP-08、EP-10 的后端出口，用可控模型实际发工具请求并消费持久结果；真实 PG 验证重复投递、异载荷、并发 CAS、过期 Worker/停止竞争和计划提交后回执前崩溃，故障恢复不重复文件动作。无计划旧 Run 与原外部工具/完成 Gate 回归必须保留。
自检后由协调 Agent 或独立上下文的验收 Agent 核查当前基准与反例；修复复验通过后进入 B 片。既有未相关失败独立标明，不能删除失败检查或拼接旧成绩当当前整轮通过。

B 片：会话呈现与实际恢复体验。
接通真实查询/SSE、折叠清单、当前项、Run 控制状态、基本依据链接、错误与重开。覆盖 EP-06–EP-12 的组件和实际浏览器反例：全项完成但验证失败、同名项重排、同会话多 Run、迟到旧响应、SSE 重连、失权、长列表/短窄窗及草稿保护。用匹配最终源码的确切 Windows 包验证原会话中的计划更新、读取/修改/检查、依据查看和重开恢复；记录键盘、中文 IME 与 DPI 实际范围，不能继承旧 EXE 成绩。

真实 Provider 只在既有有效授权和配置下使用合成测试材料，记录模型/模板、调用身份、已知用量及失败；缺条件列为未运行，不外发额外用户材料。Fake/组件/浏览器/PG/Windows/Provider 分层报告，不能用一条顺利演示证明稳定能力。构建输出不与其他 Agent 的同一 release/target 并发写，不擅自结束未知桌面或数据库进程。

六、文档与最终交付

执行与变更相关的单元、真实 PG/HTTP、恢复、组件、浏览器、类型和构建检查，命令先核对当前 package.json 与实际脚本，不虚构测试数。完成 Documentation Impact Check：需求、架构、ADR、API、数据库、测试、README、路线图、变更记录、已知问题，仅更新受影响的现有主文档。重要真实架构取舍再记录必要 ADR，不为清单创造无调用方模块或重复文档。

当前阶段只更新 CODEX_NEXT_STEP；功能成绩只更新 docs/testing/overall-acceptance-2026-09-28.md 的对应行；完整过程输出按 docs/README §6 留在忽略目录，普通复跑不新建报告、不导出全仓 hash。运行 node scripts/check-docs.mjs 并人工核对链接、当前/历史与设计/已实现边界。

最终说明：实际修改文件、机制复用及 Relay 差异、两片验收结论、实际命令/结果与受验基准、未运行项、文档同步和剩余依赖。明确计划状态不等于检查通过或正式完成；不自动 push、部署、向外部聊天发材料或启动论文实验。
~~~

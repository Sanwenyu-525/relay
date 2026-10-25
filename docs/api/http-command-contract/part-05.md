# HTTP 与应用命令契约：分册 05

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.65 内置工作方法与聊天命令解析（2026-10-11 源码实现）

Skill 专题 §9 与 ADR-019 的首批后端切片，追加迁移 `0071`：

| 端点 / 变更 | 命令类型 | 说明 |
|---|---|---|
| `GET /chat-commands` | 只读查询（无 `command_id`、无回执） | 200；返回菜单登记项：三条内置方法（`review`/`diagnose`/`docs`）在前，五条系统命令（`clear`/`new`/`model`/`undo`/`compact`）在后；英文固定名与中文别名共用同一条目 |
| `POST /chat-commands/resolve`（body `{text}`） | 只读查询（无 `command_id`、无回执） | 200；返回 `kind` ∈ `NOT_COMMAND`/`MENU`/`METHOD`/`SYSTEM`/`UNKNOWN_COMMAND`/`INVALID_ARGUMENT`。方法返回冻结身份与本次 `action`/`scope`；普通文本附 `detected_method`（含 `discussion`）；未知命令与非法参数只给类型化说明。**不写存储、不调模型、不执行动作**——因此「菜单选中未发送」零副作用 |
| `POST /assist-sessions/{session_id}/chat-commands`（body `{command_id,text}`，2026-10-13） | `/clear`、`/new`：`ExecuteChatCommand`；`/undo`：`WithdrawStateMaintenance` | 200 命令信封。新会话结果 `kind=NEW_SESSION`，含原/新会话、项目/任务、冻结身份/人设版本；原会话与历史保留，不复制消息、不改变原执行权。撤回结果 `kind=STATE_WITHDRAWAL`，含会话、原请求、状态、revision、原 `undo_command_id`。菜单/方法命令不在此入口执行，`/model`/`/compact` 409 `CHAT_COMMAND_UNAVAILABLE` |
| `POST /assist-sessions/{id}/messages` 新增可选 `method_ref {id, version, action?}` | `RequestAssistMessage` | 显式选择内置方法；不传时由正文的 `/命令` 或自然语言识别决定。消息正文为系统命令、未知命令或非法参数时按 400 `VALIDATION_FAILED` 拒绝且不落库；只读 `ASSISTANT` 会话请求 `MODIFY` 方法按 409 `INVALID_TRANSITION` 拒绝 |
| `assist_messages` 新增 `method_snapshot`/`method_action`/`method_argument` | — | 方法身份在**发起那一刻**冻结（定义 + `sha256`）；消息读投影新增 `method`（含 `definition_availability`）与 `method_argument`。方法定义被替换后只显示 `HISTORICAL_ONLY`，不按当前注册表补造 |
| 方法命令行动与普通执行接续（2026-10-13） | `RequestAssistMessage` / 原执行解释与 Delegate | `/diagnose 修好…`、`/docs 更新文档…` 的参数可得到 `MODIFY`；谈方法仍为 `INSPECT`。执行候选由应用绑定 `execution_method`，随 Run 冻结，含原方法快照/行动/参数/会话及用户消息身份，不接受模型自造方法身份；只读方法的写候选退回澄清。只有 `AGENT` 会话能创建执行请求，`ASSISTANT`/`LEARNING` 返回 409 `INVALID_TRANSITION`，须沿既有转执行入口 |
| **身份优先级（2026-10-12 整改 R1）**：显式 `skill_ref` 决定这条消息的处理入口 | `RequestAssistMessage` | 正文整体是 Skill 输入，**不再**进入自然语言方法识别，也不接受正文里的 `/方法` 命令；因此同一条消息不会同时写出 `skill_snapshot` 与 `method_snapshot`（那会撞 `0071` 的 `ck_assist_message_method_exclusive` 并整单 500 回滚）。同时传 `skill_ref` 与 `method_ref` 的 422 拒绝、未知命令/非法参数/菜单前缀/系统命令的 422 拒绝都保留；**没有**显式 Skill 时自然语言方法与 `/命令` 解析逐字不变。身份进入原命令幂等摘要与冻结快照：同命令重放返回原结果，异载荷 409 `COMMAND_ID_REUSED` |

Breaking Change：**No**——追加基础入口与可选元数据；原普通 Agent 的请求体及既有合法调用保持兼容，没有方法的旧 Run 契约不新增字段。方法的 Assist 回答仍不是修改结果，实际修改沿原执行链。`SKILL.md` 个人/项目定制、会话级模型选择、压缩、消息文件恢复及前端命令菜单仍未实现；未运行出口见[测试计划 §26](../../testing/verification-plan/part-05.md#26-内置-skill命令压缩与消息文件恢复验收规格)。

基础控制范围：`/clear` 与 `/new` 在原会话有在途消息时拒绝，需先沿既有停止入口安全结束；保留同项目/任务及 AGENT/ASSISTANT/LEARNING 身份，人设助手继续使用原冻结配置，不因新会话升权。`/undo` 的 `command_id` 必须来自该会话具体状态调整投影的 `undo_command_id`，按原身份精确定位并复用整组补偿用例；未选目标返回 409 `UNDO_TARGET_NOT_FOUND`，不猜最新一条，不做文件恢复。其原成功回执持久化，可从 `GET /commands/{command_id}` 重读；撤回与回执间中断按相同原目标重入，不重新选择目标。两类回执资源链接分别指向新会话/原调整请求。这里只实现后端端点，前端输入命令接线仍后置。

### 10.66 学习模式的会话身份与个人学习记录（2026-10-11 源码实现）

依据 ADR-020、领域模型 §13.4、工作台 §26 与提示词工作包 A。学习身份是**建会话时冻结的第三种受限身份**：对项目只读，只多一项经专门入口写个人学习记录的能力。

| 端点 | 命令/语义 | 结果与错误 |
|---|---|---|
| `POST /assist-sessions` 的 `conversation_mode` 增加 `LEARNING` | `CreateAssistSession` | 与人设四列必须同时缺席（`LEARNING` 不由配置文本获得能力）；不传仍为 `AGENT`。同一 `command_id` 换模式重放按异载荷拒绝 |
| `POST /assist-sessions/{id}/messages` 新增可选 `record_learning`（默认 `true`） | `RequestAssistMessage` | 只在学习会话上有意义；随命令体持久到 `assist_messages.learning_record_disabled`，因而进入幂等摘要。学习会话请求 Skill、`MODIFY` 方法或提案意图按 409 `INVALID_TRANSITION` 拒绝 |
| `GET /learning-records` | 只读查询（无 `command_id`、无回执） | 200；返回 `epoch`、`cleared_at` 与按主题归组的知识点/证据投影（含 `kind`/`scenario`/`detail`/`disposition`/`source_kind`/`observed_at`）。**读状态不调用模型** |
| `GET /learning-sessions/{id}/state` | 只读查询（2026-10-13 基础入口） | 200；返回 `session_id`、会话级 `records_enabled`、`revision` 和最近 200 个轮次（`message_id/status/rejection_reason/record_enabled`）。缺控制行等价开启、revision 0；不返回模型候选、冻结基线或已删评估正文。非学习身份 409，跨 Workspace 404 |
| `GET /learning-sessions/{id}/continuation` | 只读查询 | 200；返回上次目标（会话标题）、最后依据时间、主题归组与待处理项（`PENDING_REVIEW` 或 `GAP`）。仅因时间过去**不**降级，不启动后台复习。非学习会话 409 `LEARNING_SESSION_REQUIRED` |
| `POST /learning-records/corrections` | `CorrectLearningRecord` | 200；明确 UI 纠正可省略 `source_message_id`；给出时必须是该学习会话中一条**已完成的用户消息**。必填 `session_id/concept_id/scenario/detail` 与命令身份。写入 `USER_CONTROL` 自述证据（不伪造聊天引用），递增概念代次；旧轮次不得覆盖新纠正。模型增量不走本命令 |
| `POST /learning-records/deletions` | `DeleteLearningEvidence` | 200；单项删除并递增概念代次；`expected_generation` 落后按 409 `REVISION_CONFLICT` |
| `POST /learning-records/clearances` | `ClearLearningRecords` | 200；清掉本 workspace 的评估内容、失活在途轮次并递增 `epoch`。清除范围是**学习记录**，不声称删除原聊天、Provider 历史或项目事实 |
| `POST /learning-sessions/{id}/record-control` | `SetLearningRecordControl` | 200；会话级「后续不记录」，`records_enabled` + 可选 `expected_revision`（CAS，落后 409）。首次操作以缺行版本 0 原子插入为 revision 1；已有版本不被旧 0 覆盖。非学习会话 409 `LEARNING_SESSION_REQUIRED`；跨 Workspace 404 零写入 |

类型化错误：`LEARNING_SESSION_REQUIRED`（非学习身份）、`LEARNING_RECORD_DISABLED`（本轮或会话已关闭记录）、`LEARNING_ROUND_UNAVAILABLE`（轮次不存在、已结算，或领取身份已失效/取消先提交）、`LEARNING_ROUND_STALE`（冻结代次已变化，含明确哪些增量未应用）、`LEARNING_INCREMENT_REJECTED`（候选形状/字段不合法）、`LEARNING_EVIDENCE_REF_INVALID`（依据缺失/不存在/不属于本轮/性质不符）、`LEARNING_CONCEPT_AMBIGUOUS`（无法可靠确定同一概念）。既有 `COMMAND_ID_REUSED`、`REVISION_CONFLICT` 与维护门语义不变。

**结算不在这里**：教学轮次的有限增量由应用在模型返回后经 `SettleLearningRound` 结算（工作包 B），它不是 HTTP 命令——客户端不能直接提交学习增量，这保证「模型不能伪造用户答题、自述或确认」。

**依据绑定（2026-10-12 整改 R8）**：模型不挑选依据，只提出候选；`source_message_id` 由**应用**按候选性质绑定（`EXPOSE` → 本轮助手消息；`SELF_REPORT`/`OBSERVE`/`GAP`/`CORRECT`/`RESOLVE_REVIEW` → 本轮用户消息），再在结算的同一短事务里逐条校验：引用存在、属于本轮、性质匹配，且本轮确实有可依据的真实用户输入。缺引用、引用不存在的消息、跨轮/跨会话、用助手消息冒充用户发言一律 422 `LEARNING_EVIDENCE_REF_INVALID` 且零新增；用户输入只有「跳过」或仅为自述理解（固定短语表，规范化后精确匹配）时不产生 `OBSERVED`/`GAP`，也不升级或降级，但合法的 `SELF_REPORT` 照常保存。这是**应用侧**校验，不靠提示词里的一句「不要编造」，也不新增常规评估调用。

**领取身份与取消（2026-10-12 整改 R2/R3）**：`SettleLearningRound` 在**同一事务**内核对轮次对应的消息仍归本 Worker（`RUNNING` + `worker_id` 匹配）且 `cancel_requested` 未持久化；失权（租约过期）或取消先提交时零新增，轮次分别收敛为 `REJECTED/LEASE_LOST` 与 `CANCELLED/LEARNING_ROUND_CANCELLED`，不长期留 `PENDING`。增量先合法提交、取消后到：先前提交的证据保持不倒删，消息按 `CANCELLED` 收口。

**基线冻结范围（2026-10-12 整改 R4）**：轮次依据在调用模型前冻结该 workspace **全部**既有知识点（`concept_id → generation` 加保留键 `$identities` 的 `slug → generation`），不是「证据最近 20 条涉及的知识点」。结算对不在基线内、但身份在轮次开始时已存在的知识点保守拒绝（`LEARNING_ROUND_STALE`），挡住「删除后以同名重建再复活」；本轮合法新建的知识点照常写入。

**清除边界（2026-10-12 整改 R6）**：全清与结算取同一把 workspace 级 epoch 事务锁（`pg_advisory_xact_lock`），保证只有「全清先提交 → 旧轮次 `LEARNING_ROUND_STALE`」或「结算先提交 → 全清随后清掉新证据」两种结果；清除回执重放不重复推进 `epoch`，新 `epoch` 下用户重新开始的合法教学照常保存。

**纠正/删除与写入的临界区（2026-10-12 整改 R7）**：证据写入在 `learning_concepts` 行 `for update` 锁内重新读取代次并与冻结值比对；校验通过之后发生的人工纠正/删除提交会让旧轮次类型化失败（`LEARNING_ROUND_STALE`），不产生部分写入。

**已解除缺口（2026-10-12 整改 R5）**：`GET /learning-sessions/{id}/continuation` 与教学 Context 的 `open_items` 一律以**当前处置状态**为准——只有 `PENDING_REVIEW` 才算未决，`SUPERSEDED`/`WITHDRAWN` 保留为可追溯历史但不进入未决项。

Breaking Change：**No**——新增枚举取值、可选请求字段与追加端点；2026-10-13 增加只读状态投影，UI 纠正允许省略原消息引用，既有带引用请求保持校验；没有新 migration。学习入口、记录控制及明确转执行的基础 UI 已接入，当前转执行使用按钮新建普通会话，不自动转发学习对话中的执行语句。教学轮次（工作包 B）走 `runLearningRounds`（结构化信封 + 逐次 `recordModelInvocation`）。真实 Provider/Windows/成本与学习效果出口未验；实际结果见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)。

### 10.67 Task 验收材料参考关系（2026-10-14，基础协议）

Breaking Change：**No**。追加 migration `0074_task_acceptance_materials.sql` 与三个端点。材料正文仍由 Knowledge Owner 保存，参考关系由 `application/task-acceptance-materials.ts` 唯一写入；导入/关联不创建 CheckResult、PASS、Review 或 CompletionRecord，不改变 Task/Run 状态。

| 端点 | 基础行为 |
|---|---|
| POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials | 200 命令回执。传 `command_id`、`expected_acceptance_revision`、`knowledge_id`、`knowledge_version`；可选 `criterion_id`、`tested_artifact_version_id`、`source_label`、`note`。沿既有 Knowledge 导入文本后引用确切版本；同项目、当前验收修订、条件存在、被测产物属于该 Task 才允许关联。不完整关联可保存，查询标明缺项。 |
| GET /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials | 同一 Task 的材料投影：原验收修订、条件、确切资料版本/SHA、被测版本、参考关系状态、材料可读性、当前验收/产物是否匹配与缺项。证据性质恒为 UNVERIFIED_REFERENCE；读取不调用模型。 |
| POST /api/v1/workspaces/{workspace_id}/tasks/{task_id}/acceptance-materials/{material_id}/withdrawals | 200。传 `command_id`、`expected_revision`；只撤销参考关系，保留历史和材料正文，不撤回正式验证或业务完成。 |

正文导入复用 `POST /knowledge`，纯文本/Markdown 按原 256 KiB 与正文读取协议；导入与关联为两个独立命令，关联失败不删除已收录正文，按原命令回执核对后可继续关联，不声称两步原子。来源标签是用户声明，不证明日志由 Relay 执行。Knowledge 新版不替换旧引用，验收新版或被测产物更新后旧关系保留并显示不匹配。所有写入沿 NORMAL 维护准入、命令幂等与 Workspace/Project 守卫；跨作用域 404、版本冲突 409、无效条件或格式 422。基础功能不包含 UI 重构、计时/收益评价或自动正式验收。

### 10.68 Task 验收试用计时与人工补录（2026-10-14 基础协议）

Breaking Change：No。Workspace 下新增 `POST/GET /tasks/{task_id}/acceptance-trials`、`POST /tasks/{task_id}/acceptance-trials/{trial_id}/transitions` 与 `/observations`。所有写入复用 NORMAL 维护准入、命令回执和 revision；不改变 Task/Run/权限或正式验收结果。Task 验收试用应用入口独占计时及补录，使用数据库时间，短事务保存记录与审计。

开始请求：`command_id`、`expected_acceptance_revision`、`mode: ORIGINAL|EVIDENCE_VIEW`、`sample_label`，可选 `material_ids`（最多 64 个确切关联 ID，同 Task、ACTIVE、当前验收修订）。ORIGINAL 无需导入材料且不带材料 ID；EVIDENCE_VIEW 可先空选，保存用户选定范围而不自动补选。开始冻结验收修订和材料 ID，状态 RUNNING、revision 1。

转换请求：`command_id`、`expected_revision`、`action: PAUSE|RESUME|FINISH`。RUNNING 可暂停或结束，PAUSED 可继续或结束，FINISHED 不再转换。暂停/结束累积找证据有效毫秒，暂停不计有效时间；继续重新开始有效段。读回返回有效、暂停及总经过毫秒，运行中的数值按服务器时间计算，结束后固定；页面关闭不自动暂停，重启读取持久状态。旧 revision 返回 409，原命令重放返回原结果。

补录请求：`command_id`、`expected_revision`、`preparation_ms: 整数|null`、`total_acceptance_ms: 整数|null`、`source_note`（用户说明，1–4000 字）。这两项都由人工明确声明；总验收耗时口径已经包括准备成本，响应 `total_includes_preparation: true`，不再相加。未填项保持 null，不用找证据计时推算总验收；已知总耗时不得小于已知准备耗时。每次补录追加观察并递增试用 revision，纠正通过新观察保留旧值和来源，读回全部历史及最新观察。暂不接自然语言意图、UI、对比阈值冻结或收益结论。

### 10.69 验收试用冻结基线与基础对比（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/acceptance-comparisons`。写入复用 NORMAL、命令回执和审计，比较应用入口独占不可变基线；不调用模型或改变 Task/Run/Verification。

冻结请求：`command_id`、`baseline_trial_id`、`expected_baseline_revision`、`target_reduction_percent`（用户明确选择 1–100 整数百分比）、`sample_scope`（1–4000 字，样本可比范围、规模及熟悉效应等说明）。基线须是本项目已结束的 ORIGINAL 试用，验收修订仍当前；冻结该试用 revision、当时最新人工观察 ID 和声明口径。200 返回 `comparison_id/project_id`，同命令重放复用；基线 revision 冲突 409，跨作用域 404，未结束或模式错误 409。记录不可改写，要改口径创建新基线。

原 `POST /tasks/{task_id}/acceptance-trials` 可选追加 `comparison_id`，只允许 EVIDENCE_VIEW 且同项目、冻结基线仍当前；绑定由开始命令持久，无既有试用事后补挂。允许一个基线下多次试用，读回全部试用（包括未完成、失败及未知），不挑有利样本。已有不带字段的计时命令体与回执身份保持兼容。

原人工补录可选追加 `correctness_outcome: UNKNOWN|NO_ISSUE_REPORTED|ISSUE_REPORTED`，默认 UNKNOWN。它是用户自述正确性，来源仍 USER_REPORTED，不是正式 PASS；来源说明随观察保留。基线人工记录更新后，旧基线不自动取新版，历史值仍读回并标 STALE。

查询返回冻结基线时长/观察/目标/说明、关联试用及原始指标：`finding_reduction_percent`、`total_reduction_percent`、`preparation_difference_ms`、`finding_target_met`、`overall_time_saved`。百分比仅在已结束且基线大于零时计算，显示两位小数；未知和零基线返回 null。人工总耗时已含准备，不重复加；准备差值可为负。`assessment` 是单样本数据状态：IN_PROGRESS、INSUFFICIENT_DATA、STALE、CORRECTNESS_ISSUE、TARGET_MET、TARGET_NOT_MET。只有完整人工口径、双方无问题自述、当前基线/验收/材料适用、找证据达到冻结目标且总耗时下降才为 TARGET_MET；不证明普遍收益或替用户作投入决定。材料/验收变化保留原数值并标 STALE，缺材料条件/被测版本为数据不足。
### 10.70 会话一句话补录验收耗时（2026-10-14 协议）

Breaking Change：No。复用既有 `assist-sessions/{id}/state-maintenance-requests`、`conversation-state-requests/{id}/applications` 及回执/澄清/决定入口，不新增 HTTP 端点。增加候选 `REPORT_ACCEPTANCE_TIME`：可空 `task_title/sample_label`，可选非负整数 `preparation_ms/total_acceptance_ms`，至少一项；模型不携带 ID。只接受明确登记指令，讨论仍 DISCUSS，数字、单位或总耗时口径不明先 CLARIFY。

解释前在原请求 JSON 基线冻结本项目试用的身份、revision、任务标题和样本标签；模型上下文只带标题/标签/状态，不赋予授权。候选按冻结列表精确匹配，未指定时仅允许唯一试用，0 条或多条均返回聚焦澄清，不按最近位置猜。用户原文的阿拉伯数字与毫秒/秒/分钟/小时按确定性换算核对，缺单位、重复口径或模型数字不一致不落补录；其他数字表达先询问明确数字与单位。当前基础语句支持“准备用了 3 分钟，整体验收用了 12 分钟”等形式。

应用使用冻结 Task/试用 revision，沿原 RecordTaskAcceptanceObservation Owner 写入，原命令重放不重复记录；未提到的耗时保持该试用原观察值，首次缺项仍 null。原消息为同项目 AGENT 的 USER 消息，来源消息 ID 保存在观察中并读回；只读 ASSISTANT/LEARNING 身份不获得写入权。不自动暂停计时、创建 Run、完成 Task 或自述正确性为通过。纠正走新明确补录，保留全部观察；没有删除/撤销观察入口，整组撤回如实返回不可撤回，不伪造删除。
### 10.71 项目基础假设记录与用户结论（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/hypotheses`、`GET /hypotheses/{id}`、`POST /hypotheses/{id}/versions`、`/observations`、`/suggestions`、`/confirmations`。假设应用入口独占假设定义、观察和结论，不写 Task/Run/CheckResult/Review/Decision。写入沿 NORMAL、项目归档守卫、revision、原命令回执及同事务审计。

创建请求须 `command_id`、`confirmed:true`、`title`（1–200 字）、`claim/method/criterion`（各 1–4000 字），可选 `source_knowledge_version_id`（本项目可读确切 KnowledgeVersion）。创建 revision/version 1；修改定义带 `expected_revision` 和三项定义，新建不可变版本、不覆盖历史。资料正文沿 Knowledge Owner，引用只保存 ID，不复制正文。

观察请求带 `command_id/expected_revision/summary`（1–4000 字），可选 `knowledge_version_id`。追加到当前定义版本，来源性质为用户自述或外部参考，材料不形成正式 PASS；观察和所有后续写入递增假设 revision。读回全部定义、观察与结论，缺来源不补造；新观察、定义变化或资料版本/可用性变化让旧结论不再适用于当前基准。

建议请求带 `command_id/expected_revision/outcome: SUPPORTED|NOT_SUPPORTED|INCONCLUSIVE/rationale/evidence_sufficient/method_reliable`。这是调用方提供的候选判断，不声明发生过模型调用；冻结当前定义版本及观察 ID 集合。无观察、证据不足、方法不可靠或资料不再适用时强制 INCONCLUSIVE、建议补充证据；可靠充分但 NOT_SUPPORTED 时建议 STOP_NEXT_STAGE，不自动停止任何任务/投入。建议保存不会设置当前用户结论。

确认请求带 `command_id/expected_revision/suggestion_id/confirmed:true`，只能确认仍适用的建议。保存独立 USER_CONFIRMED 结论和原建议引用，更新当前用户结论指针，旧判断保留。当前结论是用户确认的假设判断，不是功能 PASS、需求接受或 Task 完成。版本冲突/过期建议 409，跨作用域 404，不完整参数 422。

原会话状态维护追加 CREATE_HYPOTHESIS（title/claim/method/criterion），用户明确“把这个想法记成假设”才进入 MAINTAIN；建议/讨论不自动建档，缺主张、方法或标准先澄清。原应用入口调用创建 Owner，来源原用户消息保存在定义版本；ASSISTANT/LEARNING 仍只读。客户端提供查询、写入和会话建档方法，本片不做 UI 或自动模型分析；没有假设撤销 Owner 时如实报告不可撤回。
### 10.72 决定前提与基础复审候选（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /decisions/{id}/premises`、`GET /projects/{project_id}/decision-reviews`、`POST /decision-reviews/{id}/resolutions`。前提/候选由 Decision Review 应用入口独占写入，Decision 正文、状态与替代关系仍归原 Information/Decision Owner。

登记请求：`command_id/expected_decision_revision/confirmed:true/statement`（1–4000 字），二选一 `knowledge_version_id` 或 `hypothesis_id+expected_hypothesis_revision`。首片仅本项目 ACTIVE Decision 与同项目资料/假设；Knowledge 需确切当前可读版本，Hypothesis 需匹配 revision。冻结决定 revision、前提说明和来源基线，200 返回 premise_id/decision_id/project_id/revision；不推测旧决定理由。

Relay 记录 Knowledge 新版本（含事务内组合入口）/归档，以及 Hypothesis 新定义/观察/用户确认时，在原短事务内对已登记相关前提准备候选。Knowledge 更新也核对通过该资料关联的 Hypothesis 前提；假设仅保存未确认建议不触发复审。候选冻结原决定 revision、前提 revision、before_ref/after_ref、来源命令与变化指纹，唯一键防重复。实际新增候选时，资料/假设相关回执追加字符串 `decision_review_count`，项目内另提供 `decision_review_candidates_ref`；原字段不变，重放回读原数量，不重新准备候选。

项目查询保留全部候选和处理历史，返回当前可行动 pending_count、来源变化、原前提说明/决定标题及需用户重新判断的问题。再次变化时旧候选 applicable=false，原值不替换。读取不写事实、不调用模型；未登记前提的决定不生成候选。

处理请求：`command_id/expected_revision/action: KEEP_DECISION|DISMISS/reason`（1–4000 字）。只处理仍适用的 PENDING 候选；KEEP_DECISION 保存用户理由并把该前提的来源基线更新到已核对 after_ref，DISMISS 只登记本次不处理。两者不更改 Decision 状态/正文或 Task/Run。候选或决定/来源/前提基线变化返回 409，跨作用域 404。需要替代决定仍调用原创建/替代 Decision 入口；替代后的旧候选不可行动。本片为前后端数据功能，无 UI、后台监控或自动模型分析。
### 10.74 基础下一段工作计划（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /tasks/{id}/time-estimates`、`POST/GET /projects/{project_id}/period-plans`、`GET /period-plans/{id}`、`POST /period-plans/{id}/items/{item_id}/resolutions`；写入沿原 command_id/事务回执，均返回 200，跨作用域不可见。PersonalPlanning 拥有估时历史、固定容量窗口、候选与逐项选择；Task 创建仍归原 Owner。

估时请求为 `command_id/confirmed:true/expected_task_revision/expected_estimate_revision/source_note` 与 `elapsed_ms/execution_ms/waiting_ms/review_ms/human_ms`，时长均为非负安全整数或 null，五个字段明确传入；初次估时 expected_estimate_revision 为 `0`。同项目 Task 当前验收修订被绑定，不改 Task revision、状态或验收；更新追加不可变估时版本。GET 返回 current（含 applicable）及全部历史；验收变化后原估时不再用于容量。elapsed 是用户声明的执行、等待与审阅整段时间，允许分项重叠，不能把分项或人工投入重复相加；分项已知也不能推算未知 elapsed。

计划请求为 `command_id/title/available_ms/diagnostic_ms/task_ids/mainline_task_ids/goal_ids`。标题 1–200 字，容量 1–604800000 毫秒，诊断预算为正且不超过容量；task_ids 为 1–64 项不同的当前项目任务，主线 ID 是所选任务子集，目标需是项目已关联活动 Goal。自动读取同项目未完成 BLOCKS 必要前置，总范围不超过 64 项；跨项目前置返回 409，需人工另行安排；INFORMS 不占硬前置。DONE 不排新工作，非 INBOX/READY 项保留 TASK_NOT_IDLE 延后原因，不改在途契约。

数据库时间在生成时固定 started_at/ends_at，GET 只递减 remaining_ms，不重置窗口。冻结 Task/验收/估时修订、Goal 引用、优先级、截止日期、依赖与已登记阻塞；按所选目标/明确主线及必要前置优先，再按原优先级、截止日期安排独立项。缺优先级/截止日期保持 null。本片用保守串行 elapsed 容量，不推测跨任务并行收益。TASK 候选保存预算与单列人工估时；未知关键估时只生成有预算/阶段输出的 DIAGNOSTIC，下游不承诺完成；无估时独立项、容量不足、阻塞或未安排前置逐项 DEFERRED。资料与权限是否满足未由本片核验，返回 `permission_gaps:CHECK_AT_EXECUTION/execution_admission:NOT_GRANTED`，人工事项沿已登记 blockers 和原 Task 验收读取，不能冒充准入通过。

处理请求为 `command_id/expected_revision/action:ACCEPT|REJECT/reason`。每次仅一项，读回该项状态/理由/created_task_id，其他候选保留；必要前置先接受。接受既有 TASK 只保存计划选择；接受 DIAGNOSTIC 在同一短事务复用原 Task 创建入口，创建 ME/HUMAN/INBOX、独立诊断输出与验收，记录原任务引用和预算；原命令重放不重复创建。诊断预算用完仍交证据、排除项、未知与下一步候选，不宣布原修复完成或自动延长。DEFERRED 不可直接接受；依据变化、修订冲突或窗口结束返回 409，旧候选仍可读/拒绝，更新输入后重新发起。估时是建议：候选恰好排满固定容量时仍可在窗口内接受，读取 `time_warning:ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW|null` 提示审阅后剩余时间与尚未拒绝候选预算的缺口，不据此承诺完成时刻。读取 expired 不暂停 Run，接受不 Delegate 或批准工具动作。本片不新增 UI、日历、会话解释候选或自动重排后台。

### 10.73 基础工作段预期与产出复盘（2026-10-14 协议）

Breaking Change：No。新增 Workspace 下 `POST/GET /projects/{project_id}/work-segments`、`GET /work-segments/{id}`、`POST /work-segments/{id}/finishes`、`POST /work-segments/{id}/events`、`POST /work-segment-events/{id}/resolutions`，以及只读 `POST /projects/{project_id}/retrospectives`（无历史工作段时的临时回顾）。工作段入口拥有预期/时间/结束快照和用户事件记录，不创建 Task/Run、不应用计划或宣布完成。

开始带 `command_id/confirmed:true/title/expectation`（标题 1–200 字、确认预期 1–4000 字）及 `tasks`（1–64 项，task_id/expected_revision/expected_acceptance_revision）。仅同项目既有 Task，开始冻结任务身份/标题/状态、验收 objective/criteria/expected_outputs 和已有完成引用。原用户消息可以作为来源；会话 START_WORK_SEGMENT 沿原状态维护确认链，缺范围/预期先澄清，不按实际结果倒造预期。

结束带 `command_id/expected_revision`。数据库时间记录开始/结束与经过毫秒，结束保存不可变实际快照：只有本段中新提交、当前 DONE 且匹配冻结验收修订的 CompletionRecord 计入本段已验收产出；记录确切 completion_id/artifact_version_ids，其他情况保留未完成、基线变化、已有完成或缺依据标记，原因沿真实状态/阻塞/执行权，不推断原因。读回历史快照与后续事件纠正分别呈现，不把后续完成算成本段产出。需要核对文件正文可沿原完成证据入口。

模型用量只选已登记 Task 的 Run 步骤或明确 Task 绑定会话、调用开始时间在本段区间的既有 model_calls。返回原调用 ID/状态/用量及覆盖范围；缺项保持 null，已知用量与完整用量分开，无记录不宣称实际零用量。现有账本没有金额字段，monetary_cost 恒 null，不按当前价格补历史金额，不加入额外模型分析。

事件候选带 `command_id/expected_revision/kind: REWORK|HUMAN_INTERVENTION/description`，可选 task_id/source_run_id/duration_ms。记录为 CANDIDATE，不纳入确认统计；任务/Run 必须属于已选范围。用户处理带 `command_id/expected_revision/action: CONFIRM|WITHDRAW/reason`；原命令去重，状态/理由留历史，确认后计入，撤回后排除。多次 Run 不自动生成返工；耗时缺失未知，统计覆盖范围仅确认记录。结束后可补事件确认/撤回，结束事实快照保持不变。

临时回顾只读请求 task_ids（1–64 个既有同项目 Task），按任务当前验收周期读取最近登记的工作段基线并返回段身份/原预期；没有匹配的项为 UNKNOWN，混合为 PARTIAL，全部有记录为 RECORDED。各任务预期不合成过去总预期或时间，顶层 expectation/model_usage/work_time 保持 null，不创建或伪造历史工作段。客户端支持全部基础入口，本片不做 UI、固定周期报表、自动疑似事件提取或收益结论。

### 10.79 任务链受控修改与检查（2026-10-14 协议）

Breaking Change：No。沿 §10.77–10.78 原创建/查询/授权/控制端点扩展每项 execution，无新端点或 migration。工具循环可选原注册词表中的目录/文件读取、git_status/git_diff/git_log、apply_changeset/read_change_set/run_check；连接可选 FILE_QUERY/FILE_READ/GIT_READ/FILE_WRITE/CLI_RUN，须同项目 ACTIVE 且具备对应能力。工具名与能力仍由原词表核对，预算沿原 12 轮/48 次工具上限，资源配置/身份与资料基线不变。

可选 scope_grant 为 `{resource_id,allowed_actions,checks,expires_at?}`，资源须与循环一致，allowed_actions 是 APPLY_CHANGESET/CLI_RUN 的非空不同子集，每个动作必须对应本项允许工具。checks 复用原 Delegate 的最多 32 项 `{id,executable,args,executable_sha256,max_output_bytes?}`：id 唯一非空，入口摘要为实际程序 SHA-256，参数最多 64 个、输出上限最多 1 MiB。服务端沿原信任材料入口冻结程序、执行脚本与直接配置；创建仅保存规格，不创建 Run 或签发有效授权。run_check 必须有明确 CLI_RUN 范围和至少一项配置，只能用 check_id 点名，模型不能提交新程序或命令字符串。

明确授权后，原 Delegate 在创建本项 Run 的事务中沿原 RunScopeGrant Owner 签发本 Run 的范围授权。有效期取本项可选期限与本链授权期限的较早者，不跨 Run 终态；下一项仍独立创建自己的授权，链续期不延长既有 Run 授权。原 Gateway 取权限与授权交集，DENY 不被覆盖；没有范围授权的修改仍走原 ACTION_APPROVAL，等待期间不落盘。删除、撤销、检查材料变化及未决结果沿原控制/审批/恢复协议，不由链自动批准。

原方法来源允许 INSPECT 或明确 MODIFY。INSPECT 不能与 apply_changeset 并存，MODIFY 必须有本项修改工具；仍冻结原会话定义、行动、参数和用户消息，不由链改写方法意图。范围内普通修改必须携带实际读取基线；第一次检查正常失败可沿原工具循环读取、修正、再检查，失败不等于通过，检查结果仍来自实际子进程。下一项继续要求原人工验收与确切完成凭据。

原 ready/Delegate 准入再次核对已冻结检查材料；变化保留旧规格并阻止新准入，原 Delegate 与任务链共用检查冻结函数，有原 trust_basis 时只核对、不重新绑定新脚本。读取 execution_spec 增加 scope_grant 与服务端冻结 trust_basis；前端原客户端增加对应输入映射，不增加 UI。空规格及旧只读调用保持原行为。真实 Provider/Windows 使用、自定义方法、活动无缝续期、并发故障全矩阵与完整 N06 按后续范围接续。

### 10.78 任务链只读执行规格与来源（2026-10-14 协议）

本节记录先前只读切片；当前可选修改/检查范围见 §10.79，以下只读输入与来源协议继续有效。

Breaking Change：No。复用 §10.77 创建/读取/授权/控制端点，创建 tasks 每项可选 `execution`，未提供保持原 Markdown 空规格与旧命令摘要。`execution` 支持可选 context_sources、file_read_action、tool_loop_action、method_message_id；固定读取与循环互斥，不支持 write/CLI/scope_grant 或任意执行代码。

context_sources 为最多 10 个 `{kind:KNOWLEDGE|MEMORY|DECISION,root_id,version}`；确切版本须存在，资料根 ACTIVE 且属于当前 Workspace/Project 或同 Workspace 共享范围。保存原引用与根 revision/current_version 基线，不复制正文、不自动切到新版本；正文/产物来源可用性仍沿原 Context Builder/成果入口，不因引用存在宣称内容已核实。

file_read_action 复用 `{connection_id,resource_id,relative_target}`（1–1024 字受管根内路径），tool_loop_action 复用 `{resource_id,connections,allowed_tools,max_rounds,max_tool_calls}`。连接仅 FILE_QUERY/FILE_READ，工具仅 list_directory/find_paths/search_text/read_file 非空不同子集，循环 1–12 轮/1–48 次工具调用，沿原共享上限。受管资源/连接需同项目 ACTIVE、能力对应；冻结资源 identity_key/配置 revision/canonical_root 与连接 version/capability。resource_epoch 属于实际资源领取/隔离出口，不作为配置基线；正常原读取推进 epoch 不误使后项失效，原 Gateway 仍负责每次实际准入/占有。

method_message_id 指向同项目普通 AGENT 会话的已完成原 USER 消息，若会话绑定 Task 则须匹配本项；下一条已完成 ASSISTANT 必须已有可核对的冻结方法定义与 INSPECT 行动。保存原 RunMethodBinding 的定义/摘要、消息/会话和参数，不由方法名新建修改权限；MODIFY、助手/学习身份、缺定义或未完成消息拒绝，不编造消息来源。

创建只保存执行规格。原 ready/Delegate 准入时再次核对资料头版本/可用状态、资源配置/身份、连接版本/能力和原方法；变化保留旧规格并阻止新准入，需重新圈定。非空规格的规范 JSON 摘要随专用链绑定进入原 ready/Delegate 命令，原空规格无新增摘要。原 Delegate 冻结同一输入到 Run；实际工具、资料读取、缓存/来源、拒绝、等待批准、UNKNOWN 与恢复仍归原 Owner，链不跳过权限、不复制动作或自动批准。DENY 在准备前返回原 REJECTED 工具回执，没有已派 Operation/Invocation；此结果不能当成功读取或自动启动下一项。

GET 每项增加 execution_spec，显示确切来源、连接/资源和原方法定义/出处；前端原 createTaskChain 输入与读取客户端接续，不新增 UI。累计任务/调用预算、有效期、停止/重开和人工完成保持 §10.77。本只读切片不包含写入；后续 §10.79 已接受控修改/检查，自定义方法/来源编辑器、真实 Provider/Windows 或并发/故障全出口仍后置。

### 10.77 基础有限 Markdown 任务链（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /projects/{project_id}/task-chains`、`GET /task-chains/{id}`、`POST /task-chains/{id}/authorizations`、`POST /task-chains/{id}/controls`。创建 201，授权/控制 200 原命令信封；旧 ready/Delegate/resume 的公开请求不新增链参数，专用绑定仅由可信应用协调器提供，旧命令摘要无条件字段不变。

创建为 `command_id/title/confirmed:true/tasks`（1–16 项不同 task_id/expected_revision/expected_acceptance_revision）。仅同项目 INBOX/READY、HUMAN 所属既有 Markdown Task；每项还须有至少一个必需验收条件、声明当前支持的 `MARKDOWN_DOCUMENT` 预期产物，且任务/项目无未解决 blocker。未完成 BLOCKS 前置必须在队列更早项，已完成前置可在外部。条件不足或顺序无效时以 `409 INVALID_TRANSITION` 拒绝，不生成 DRAFT。冻结 Task/验收/依赖/目标/规则依据及顺序，创建 DRAFT 不 Delegate。空规格 tool_scope 为 INTERNAL_MARKDOWN_ARTIFACTS_ONLY；可选只读执行规格及 BOUNDED_READ_ONLY_FILES 见 §10.78，不接写入或任意 Shell。

授权为 `command_id/expected_revision/confirmed:true/max_tasks/max_model_calls/expires_at`，任务上限 1–16、调用上限 1–100，有效期为带明确时区的未来实际时刻、至多 24 小时。确认是本链的执行请求，计划接受不替代授权；每次上限按本链累计总额核验，重新确认不重置 task_reservations/calls_started。只有非 ACTIVE/PAUSING/REVOKED/COMPLETED 状态可确认，原执行失败/取消或用量未知不能自动换 Run 重试；任务/目标/规则基线变化需重新圈定，不静默更新原授权范围。

API 存活期间仅做短接续协调。原 ready/Delegate 逐项再查 Task、条件/规则、依赖、执行权和权限，原 Delegate 事务同时绑定原 Run/START 回执和任务预留；剩余项不创建 Run。下一项只在上一项原 Run COMPLETED、Task DONE 且当前 CompletionRecord.run_id/acceptance_revision 确切匹配后准入，模型回复、候选或仅 Run 结果不能完成链。人工验收/Review 保持原入口。item 的 RUNNING 只代表已绑定 Run，实际 CREATED/运行/待审/暂停/完成由 current_run_status/current_task_status 读回。

调用数在原 model_calls STARTED 事务内预留，本链所有已绑定 Run 的步骤调用累计；单 Run 原调用/token 预算仍成立。未发调用的事务失败回滚，已开始调用永不因重开或新授权扣回；STARTED、缺输入/输出用量均保留占用并禁止后续调用/Task 准入。实例 VERIFY 探针及用户独立会话不计为本链调用。model_usage 返回已登记数量、未知数量、已知 token 与完整总量（缺失 null），monetary_cost 恒 null；不把受控 Fake 用量或空账本当真实成本。

控制为 `command_id/expected_revision/action:PAUSE|REVOKE/reason`。关闭新准入后沿原持久控制请求当前 Run 安全暂停，PAUSING 与实际 PAUSED 分开；终态/已经暂停且已核对的原执行不重发控制，不作用于后来独立 Run。到期同样阻止准入并请求原 Run 暂停，未应用前不显示已停，完成事实保持；停止命令可走原维护排空控制白名单。原 API 重开把旧活动链转 WAITING_RESUME，用户明确确认后才接续；必要时沿原 resume 恢复同一 Run，保留原委托/调用/产物身份，未决结果与原执行槽仍由原 Owner 核验。

状态 DRAFT/ACTIVE/WAITING_RESUME/PAUSING/PAUSED/REVOKED/EXPIRED/BLOCKED/COMPLETED，GET 保存授权历史、原因、原控制 ID、当前每项/Run/完成引用与累计用量。ACTIVE 仅表示授权有效，完整执行仍可能等待人工；BLOCKED 不自动宣称所有业务任务失败。原命令重放返回原效果，控制请求或新授权不复活 REVOKED。前端只接五个方法及 §10.78 可选只读规格，无新 UI、会话任务链解释、文件写入/CLI 或实际收益验证；完整 N06/PV06/PV08 按剩余出口接续。

### 10.76 基础一次性继续项目提醒（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /projects/{project_id}/reminders`、`GET /project-reminders/{id}`、`POST /project-reminders/{id}/edits`、`POST /project-reminders/{id}/status-changes`、`GET /reminder-occurrences`（可选 project_id）、`GET /reminder-occurrences/{id}`、`POST /reminder-occurrences/{id}/resolutions` 与 `POST /project-reminders/notifications/claim`。创建返回 201，其余命令 200 原信封；通知领取为普通 200 投递数据，不是业务命令回执。

创建请求 `command_id/confirmed:true/title/due_at/timezone`，标题 1–200 字，due_at 为有 Z 或明确偏移量的 ISO 实际时刻（秒必填、毫秒最多三位），timezone 为有效时区名称。拒绝无时区钟点和不存在的日期；DST 重复钟点由显式偏移量区分，不猜。保存 UTC 实际时刻与原设置时区，GET/设备显示时区变化不写配置。可明确登记已过时刻，运行扫描将形成同一待处理，不自动补跑计划。

编辑请求 `command_id/expected_revision/confirmed:true/title/due_at/timezone/reason`；状态请求 `command_id/expected_revision/status:ENABLED|PAUSED|DISABLED/reason`。配置 revision 每次命令更新，history 追加完整设置、原命令和理由；schedule_generation 只在实际时刻变更时推进。暂停/禁用/继续、同一实际时刻的标题/时区编辑不重置已发生身份，编辑不自动启用被禁用配置。已形成事项保存原标题/实际时刻/设置时区/config_revision/generation，不因后续配置或通知设置消失。跨作用域不可见，旧 revision 返回 409。

API 生命周期扫描默认每秒一次，Schema 可用且原维护准入为 NORMAL 才写；停机停止计时并等待在途短扫描，不运行独立常驻服务。数据库时钟比较当前 ENABLED 配置，归档项目不产生新事项；UNIQUE(reminder_id,schedule_generation) 保证本次发生最多一次，扫描/重开不重新生成已发生代次。启动基准由数据库取得，启动前到期的有效提醒标 missed；到时只在同一短事务写事项和 SYSTEM 审计，无模型/Task/Run/计划创建。

事项为 PENDING/HANDLED/DISMISSED、独立 revision；处理请求 `command_id/expected_revision/action:HANDLE|DISMISS/reason`。处理只标该事项及来源理由/时间，原命令重放不重复，不改变配置或已创建计划。GET 读回当前项目归档/revision、can_plan、原 N04 plan_entry 和 execution_admission:NOT_GRANTED；读/通知点击不处理事项、创建计划或批准执行，用户需另行输入容量并主动发起原计划命令。

通知领取只取未处理且项目未归档事项，复用 attention_notification_receipts 的稳定 `project-reminder:{occurrence_id}`/change_key:`1`，DISPATCHED/DENIED/FAILED 结算继续调用原 `POST /attention/notifications/settle`，只传 item_key/change_key/status。通知失败/拒绝不撤销 PENDING；聚合投递时身份仍独立。前端只补原轮询的功能：必须介入事项优先，项目提醒领取/投递另走原宿主权限；旧通知点击先读取当前事项/项目再导航，不凭旧载荷做业务写入。没有新增设置/待处理页面、样式或布局；Windows 原生投递和完整 PV05/PV08 仍按各自出口验证，不用受控通知对象冒充实际窗口证据。

### 10.75 基础固定容量范围推演（2026-10-14 协议）

Breaking Change：No。Workspace 下新增 `POST/GET /period-plans/{id}/scope-simulations`、`GET /scope-simulations/{id}`、`POST /scope-simulations/{id}/selections`；写入均返回 200 原命令信封。PersonalPlanning 拥有推演记录；计划和诊断创建继续复用 §10.74 原 Owner/逐项应用。前端只接四个功能客户端，不做 UI。

用户主动创建：`command_id/expected_revision/keep_task_ids/defer_task_ids/unreliable_task_ids`。来源为未应用、未过期且依据有效的既有本段计划。保留项/推迟项各 1–64 个不同 Task ID，不可靠项可空；均须来自原计划范围（含必要前置）。创建冻结同一原计划/Task/验收/估时/Goal 基线、可用容量、开始/结束时刻和具体估时来源；不提供增加时间或资源参数。原命令重放返回原推演。

三种 options 为 ALL/SHRINK/DEFER。ALL 保留完整范围，即使超容量也展示总估时和容量缺口；SHRINK 仅保留用户选定任务并补足已登记 BLOCKS 前置，报告 retained_prerequisite_ids 与 SCOPE_EXCLUDED；DEFER 移出指定任务及受影响下游，报告 DEFERRED_BY_USER/DEFERRED_WITH_DEPENDENT。每项展示原任务/依赖、候选或延后原因、预算、未知和人工估时；consequences 保留主线是否被移出、直接受影响下游与 OUT_OF_THIS_SCOPE/NEXT_WINDOW_UNSCHEDULED，不为推迟项编造下一段日期。本片缩小的是任务集，不改任务内验收范围。

源估时是 USER_DECLARED_UNVERIFIED；用户显式标不可靠时保存 USER_MARKED_UNRELIABLE，并在该推演中按未知处理，原估时历史不被改写。requested_elapsed_ms/requested_human_ms 任一分项缺失则为 null，容量缺口无法计算则 null；planned_ms 仅计当前可排 TASK/DIAGNOSTIC 预算，不能当原范围全部完成时间。feasibility 为 NO_WORK_SELECTED/UNKNOWN/EXCEEDS_CAPACITY/HAS_BLOCKERS/FITS_ESTIMATE，FITS_ESTIMATE 仅按已登记用户估时比较，不证明实际完成。completion_date 恒 null；material_gaps/permission_gaps 为 CHECK_AT_EXECUTION，已登记阻塞沿冻结基线读取，不冒充资料/权限已满足。序列预算仍为保守串行，不推断跨任务并行收益。

选择请求 `command_id/expected_revision/option:ALL|SHRINK|DEFER/confirmed:true/reason`（1–4000 字）。原计划、估时、任务/目标依据或窗口变化返回 409；原比较保留，GET 提供 stale_reasons。选择在同一短事务经原计划 Owner 创建新候选，保存原窗口/容量/选项来源和每项身份，再提交选择、审计及回执；不应用任何 Task/Run，不更新原计划。原选择重放返回同一 selected_plan_id，已选推演不可另选。用户随后调用原计划逐项接受/拒绝，GET 推演 selected_plan 读回当前 revision/items/实际诊断 Task ID，部分应用不被整体“选择成功”掩盖。旧候选与原任务保留，不以计划选择改变活动执行或验收条件。本片无会话解释、模型自动建议或收益验证。

### 10.80 普通 Agent 会话工作目录绑定（2026-10-15 源码实现）

总纲 §0.5.1 / ADR-022 / [运行架构 §2.7.1](../../architecture/runtime-context/part-02.md#271-主流程的最小持久协议2026-10-15-实施前核对结果) 的持久协议落点。此前「这条会话绑定哪个工作目录」只存在于浏览器组件状态，服务端因此没有任何可信来源可读（只能按项目取第一个受管资源）；迁移 `0087` 给 `assist_sessions` **只增一列** `working_resource_id`（可空、外键 `managed_resources`），不回填历史行——升级前建的会话为 `NULL`，按「未绑定目录」处理，不会因为升级就获得新的读取能力。

| 端点 | 命令类型 | 说明 |
|---|---|---|
| `POST /assist-sessions/{session_id}/working-directory` | `BindAssistSessionDirectory`（body `command_id`、`resource_id`） | 200；回执 `{session_id, working_resource_id, revision}`，同 `command_id` 重放返回原回执。`resource_id` 必须是 uuid |
| `GET /assist-sessions/{session_id}` | — | 投影新增只读字段 `working_resource_id`（null = 未绑定） |

**绑定是作用域，不是准入。** 这条命令只确定「这次读哪个目录」，不授予任何能力：能不能读、能不能写仍由每次动作经 Gateway 按连接与权限判定（§10.6 助手只读来源同一边界）。因此客户端**不得**据此显示「已获读取/写入权限」。

拒绝条件（`INVALID_TRANSITION` 409 / `NOT_FOUND` 404）：

| 情况 | 结果 | 理由 |
|---|---|---|
| 会话已归档 | 409 | 归档会话不接受新的作用域 |
| 会话尚未归入项目 | 409 | 没有 `project_id` 就无法核对目录归属，不允许「先绑再说」 |
| 受管资源不属于该会话的 Project | 409 | 跨项目借用目录等于让一段会话读到别的项目的文件；按**会话行上的** `project_id` 核对，不采信客户端值 |
| 受管资源已停用（`status ≠ ACTIVE`） | 409 | 停用过的目录不靠重新绑定获得准入，也不换资源 ID 绕过停用 |
| 所属项目已归档 | 409 | 归档项目不作为工作目录 |
| 该会话还有在途消息（`PENDING`/`RUNNING`） | 409 | 在途消息已按发送时的作用域开始生成，中途换目录会让这一次读取落到与用户所见不同的目录 |

换绑是允许的：用户换目录就是换作用域，下一轮立即按新目录解析，不保留旧目录的缓存。目录与连接状态**每次工具请求前重查**，因此停用、撤权与换绑在下一次读取就生效。

**来源身份。** 迁移 `0087` 同时给 `logical_operations` / `invocation_attempts` 的三条 CHECK 各追加一支 `AGENT_SESSION_READ`，与 `ASSISTANT_READ`（§10.60）同形：自带 project 与受管资源、会话/消息身份用于核对归属、`task_id`/`run_id`/`step_id`/`import_job_id` 四列全 `NULL`，capability 词表同样只放行 `FILE_READ`/`FILE_QUERY`/`GIT_READ`。**不复用人设助手的来源名**：`SessionToolCallRepository.attachOperation()` 按来源核对，两种会话读取身份在库层面必须可分辨（运行架构 §2.6.3）。写入口继续只有 `RUN`。

Breaking Change：**No**——本节为**新增端点**与会话投影的**新增只读字段**；既有端点、表、CHECK 的既有分支与 `conversation_execution_requests` 原样保留。迁移 `0087` 只增一列与三条 CHECK 的追加分支，`relay_app` 新增该列的 UPDATE 授权。真实 PG 集成覆盖见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)；未运行规格见[测试计划 §17.2](../../testing/verification-plan/part-03.md#172-普通-agent-连续工具主流程)。


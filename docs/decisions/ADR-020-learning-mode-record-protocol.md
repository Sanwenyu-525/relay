# ADR-020：学习模式的会话身份与个人学习记录协议

## 状态

Accepted（**工程协议已冻结**；实现未完成、未验收）。产品规则由用户在 2026-10-10 分轮确认并写入[总纲 §0.12](../../Personal_Workflow_OS_Master_Spec.md#012-学习模式)，实施输入为[完整实施与验收提示词](../../prompts/learning-mode.md)。

本 ADR 冻结的是**对象、Owner、命令、版本/幂等、持久化与恢复边界**；具体 SQL 字段名、HTTP 请求体、错误码与迁移在实施时按本文件落实，落地后由[物理设计](../../docs/database/physical-design-postgresql.md)与 [HTTP 契约](../../docs/api/http-command-contract.md)各自拥有。**本 ADR 不声称任何代码、测试或验收已通过。**

## 日期

2026-10-11。

## 背景

学习模式需要一件本项目此前没有的能力：**应用可写、但只写用户自己的学习记录，对项目保持只读**。现有两种会话身份都不能承担：

- `AGENT` 可写项目事实，权限过宽；
- `ASSISTANT`（[ADR-018](ADR-018-assistant-conversations.md)）是纯只读身份，且其"只读工具轮次"路径**没有**接入 `recordModelInvocation` 计量，结算只把 usage 汇总到消息行——不能照抄。

同时有三个已确认的产品约束直接决定工程形状：记录要能表达"接触过 / 用户自述 / 实际表现 / 具体缺口"四类**性质不同**的证据；讲解、自述、跳过、答错必须可区分，不许压成一个掌握度分数；删除与全清之后旧轮次不得复活记录，但原聊天仍按原会话规则保留。

## 候选方案

| 决策点 | 候选 | 取舍 |
|---|---|---|
| 会话身份 | ① 复用 `ASSISTANT`，加写工具 | 违背 ADR-018 的"普通助手纯只读"，且把配置文本变成能力 |
| | ② 不建会话，挂到 `AGENT` 会话的开关上 | 权限随轮次漂移，违反"身份在会话建立时冻结"的既有不变量 |
| | ③ **新增独立 `LEARNING` 身份** | 需要一条新迁移放宽 CHECK、一套新词表与一批旧 parser 同步；但身份可预判、旧档零影响 |
| 记录形态 | ① 单一"熟练度枚举"字段 | 掩盖证据性质，无法表达矛盾与待复核，直接违反 §5 |
| | ② **证据行 + 知识点身份两张表** | 行数随实际接触增长；但四类证据天然可分、可单独纠正与删除 |
| 增量来源 | ① 保存前再发一次"请评价刚才整段聊天" | 增加常规评分调用，违反 §8/§10 |
| | ② **扩展本轮教学响应，带有限类型化候选增量** | 需要模型端口结构化输出与严格校验；但零额外常规调用 |
| 结算依据 | ① 结算时读当前记录 | 在途期间的纠正/删除会被旧轮次吸收，违反 §9.1 |
| | ② **调用模型前冻结代次与相关 revision**（复用 NLS 的 `interpretation_baseline` 形状） | 多一次写入；但旧轮次无权覆盖新事实 |

## 最终决策

选「③ 新增独立 `LEARNING` 身份」＋「② 证据行」＋「② 同轮有限增量」＋「② 事前冻结基线」。

### 1. 会话身份

- `assist_sessions.conversation_mode` 增加取值 `LEARNING`，与 `AGENT` / `ASSISTANT` 并列；迁移 0059 的 `ck_assist_session_mode` 重建为三分支。`LEARNING` 分支**不携带** `assistant_profile_*` 四列（人设是助手档的事，学习身份不由配置文本获得能力）。
- 身份仍在建会话时冻结，切档等于换会话。既有会话按 `AGENT` 读出，不回填、不虚构。
- `ConversationMode` 类型、`/assist-sessions` 请求体 union、前端 DTO 与严格 parser 同步扩展；**不得**用 `!assistantMode` 之类的否定式代表"所有可执行会话"——旧代码里凡是把 `ASSISTANT` 当唯一只读分支的地方，必须逐个改成显式枚举判断。

### 2. 写入责任

- 新增应用用例模块（`application/learning-*.ts`）与仓储（`learning/learning-repository.ts`），在 `Repositories`（`unit-of-work.ts`）注册，绑定调用方事务执行器，与其他仓储同形状。
- **学习记录的唯一逻辑写入 Owner 就是这套用例**：个人学习记录不写进 `assist_*` 业务列、不进 Knowledge/Memory/Rule/Decision、不碰 Project State。
- 学习身份对项目**只读**：可以复用只读材料读取能力，但不经任何写入口。项目侧已有准入（Gateway、Permission）不变。
- `AGENT` / `ASSISTANT` 提交学习写命令一律拒绝（类型化 `LEARNING_SESSION_REQUIRED`），反之学习身份请求文件/需求/决定写入、Delegate 或动作批准一律拒绝。**人设文本、学习指令与文件/网页正文都不能升级为授权。**

### 3. 对象

新增五张表（迁移 0072，纯追加；旧代码不读新表即行为不变）：

| 表 | 拥有什么 | 关键约束 |
|---|---|---|
| `learning_concepts` | 知识点身份：`topic`（主题归组）、`slug`（稳定标识，workspace 内唯一）、`display_name`、`aliases`（有限别名）、`generation`、`revision`、`status` | 只按 slug/别名**精确**解析，不做模糊合并、不引入向量库；不确定时保留区分或要求澄清 |
| `learning_evidence` | 单条证据：`concept_id`、`kind ∈ {EXPOSURE, SELF_REPORT, OBSERVED, GAP}`、`scenario`（具体子场景，非空）、`detail`、`disposition ∈ {ACTIVE, PENDING_REVIEW, SUPERSEDED, WITHDRAWN}`、`source_kind`、`source_message_id`、`observed_at`、`epoch` | 一个知识点可同时存在多类证据；矛盾表现为并存 + `PENDING_REVIEW`，不靠"最后一条覆盖全部" |
| `learning_record_epochs` | 每 workspace 一行的**清除边界**：`epoch`、`cleared_at`、`clear_command_id` | 全清递增；旧轮次据此判定无写入资格 |
| `learning_session_controls` | 会话级"后续不记录"：`session_id` PK、`records_enabled`、`revision`、`updated_at` | 由应用保存与校验，**不是**模型提示里的开关 |
| `learning_rounds` | 一次教学轮次的**结算依据**：`message_id` 唯一、`epoch`、`concept_generations`（jsonb 冻结）、`record_enabled`、`status ∈ {PENDING, SETTLED, REJECTED, CANCELLED}` | 在**调用模型之前**的 claim 事务内写入；结算只能落在仍 PENDING 且代次未变的轮次上 |

另给 `assist_messages` 增加 `learning_record_disabled boolean NOT NULL DEFAULT false`：**本轮不记录**随发送命令持久（进命令体，因而进幂等摘要）。

### 4. 有限增量信封

- 模型端口在 `LEARNING` 会话下额外接受"本轮相关短状态 + 相关知识点当前 revision"作为输入，并在结果中返回**可选、有限、类型化**的 `learning_increments`；`AGENT` / `ASSISTANT` 不传不收，行为逐字不变。
- 每个候选只允许：`op ∈ {EXPOSE, SELF_REPORT, OBSERVE, GAP, CORRECT, RESOLVE_REVIEW}`、目标主题/概念名/子场景、短描述、以及**必须指向本轮**的依据引用。信封里**没有**任意存储路径、项目命令、SQL、全量档案替换或其他记录的无依据删除。
- 依据性质由 `op` 决定，不允许模型把"讲解过"写成表现、把"我懂了"写成已验证、把跳过写成不会。
- 保存前应用逐条校验（见 §5）；不合法的候选**不落库**，保留可读教学回答并如实显示未更新，不用追加模型调用去"修分"。

### 5. 保存前校验（Application，同一短事务）

1. 会话确为 `LEARNING`；轮次为 `PENDING`；轮次冻结的 `epoch` 等于当前 epoch，目标概念的 `generation` 未变——否则 `LEARNING_ROUND_STALE`，明确哪些增量未应用。
2. 本轮记录控制允许保存：消息未 `learning_record_disabled`，会话 `records_enabled`，且没有被停止/清除使旧增量失效。
3. 依据引用存在且属于**本轮**的用户输入或表现（`source_message_id` 必须落在本轮的 user/assistant 消息上）；模型不能伪造用户答题、自述或确认。
4. 四类证据各自合法；跳过与无实质回答**不产生**任何升级或降级。
5. 变化大小、条数与引用范围受控；不复制全量聊天或项目正文。
6. 概念解析：精确命中 slug/别名则复用；否则新建；命中多个候选且无法确定时**保留区分**，不猜。

保存与回执在**同一事务**提交；模型、工具、网络与人工等待在事务外。回执只保存最小身份与结果元数据（`epoch`、`changed_refs`、`revision`），**不保存可复原评估的正文**。

### 6. 用户控制（同一 Owner）

| 命令（HTTP 形状，全部 `POST` + `command_id` 幂等） | 语义 |
|---|---|
| `POST /learning-records/corrections` | 用户明确纠正，绑定可信原用户消息或明确 UI 操作；及时影响当前可读状态 |
| `POST /learning-records/deletions` | 单项删除：`evidence_id` + 期望 `generation` |
| `POST /learning-records/clearances` | 全清：递增 workspace `epoch` |
| `POST /learning-sessions/:id/record-control` | 会话级记录开关，作用范围与生效时间持久 |
| `POST /assist-sessions/:id/messages`（扩展体） | `record_learning?: boolean`，关闭本轮记录 |
| `GET /learning-records` | 轻量查看：默认摘要，可展开；**读状态不调用模型** |
| `GET /learning-sessions/:id/continuation` | 返回接续：上次目标、相关短状态、具体缺口、路线 |
| `GET /learning-sessions/:id/state` | 重读持久会话记录开关及最近轮次的最小状态；不提供候选正文或恢复已删评估 |

模型说的"用户允许了"不作为授权；所有控制都由应用校验。

2026-10-13 基础 UI 落地：纠正请求的 `source_message_id` 可省略以代表明确 UI 命令，给出时仍严格核对原学习会话的已完成用户消息；证据始终为 `USER_CONTROL` 自述，模型结算的本轮依据要求不变。会话控制缺行表示 revision 0，首次 CAS 以原子插入推进到 1；旧 0 不覆盖已有非零版本。修正了「默认状态可读但首次开关必报冲突」的根因，无新存储或迁移。详细请求形状归 HTTP 契约，成绩归统一验收表。

### 7. 版本、幂等与未知结果

- 写命令一律走既有 `runIdempotentCommand`（`command_receipts`）：同 `command_id` 同载荷重放返回原回执元数据，不重复创建证据或变化计数；同 ID 异载荷按既有 `COMMAND_ID_REUSED` 拒绝。
- 学习 `result_ref` 设计上**不含评估正文**，因此复用全局回执表不违反 §9.3 的"删除范围不得借回执保留可复原评估副本"。删除/全清清除的是评估内容（`learning_concepts` / `learning_evidence` 与相关缓存）；命令回执与 `learning_rounds` 只保留**最小控制元数据**（命令身份、代次、状态），用于阻止旧请求复活并给出"依据已过期"这一可核对原因——它们本身不含任何评估正文。
- 提交成功但回执丢失：按原身份查结果，不换 ID、不重复评估。**旧成功回执只证明当时提交**，展示与 Context 一律查当前有效状态，不以原 `result_ref` 恢复已删内容。
- 牵涉既有外部动作 UNKNOWN 时保留其原动作与准入路径，不借学习身份绕过。

### 8. 停止、重启与迟到结果

- 停止沿用 `assist_messages.cancel_requested` 与既有轮询，不新增停止通道。停止意图持久化后：已提交的照实说明，未结算的旧轮次**无写入资格**（`LEARNING_ROUND_STALE`），Provider 迟到正文与工具迟到结果分别呈现，不冒充"继续"或"保存成功"。
- 重启后读真实消息、控制状态与回执，恢复查询或合法未完成提交；不自动重放旧聊天重新评估，不因进程重启撤销先前提交。失效的旧 worker/生成身份不得结算。

### 9. Context 与成本

- 每轮只带：当前目标/主题 → 本轮相关知识点 → 简短状态/具体缺口 → 当前必要来源。选择与裁剪用**可测试的应用规则**，不新增"选知识点"的模型调用。
- 不默认加载全量跨项目状态、全部路线、全部旧证据与整段历史；超预算按优先级裁剪并保留被省略范围可查询。不得为省 token 删掉当前用户问题、必要来源身份、用户纠正或关键安全控制。
- **每一次学习相关的模型调用**（教学轮、工具续轮、用户要求深入、必要查证、重试）都进 `recordModelInvocation` 与调用账本——这里**明确不照抄**助手只读轮次的"直接调用 + 消息汇总 usage"。缺失 usage 记未知，不按 0 计。
- 预算阈值在实施时按实测冻结；冻结前成本验收保持待核定，不宣称节省比例。

### 10. 来源与跨项目

- 项目带学复用当前获准的代码/文档/有效决定读取入口，仍经既有 Gateway 准入，不直调 adapter。
- 来源保留身份与版本依据；引用历史材料标明历史性；失权/删除/版本不可确认的来源显示不可用，**不静默换成相似资料并称已验证**。
- 个人短状态跨项目复用，但不带他项目代码、聊天全文或私密正文；读取旧依据时重新按当前权限核对。

### 11. 转执行

- 只有用户**明确**说"按这个方案实现"才转入执行；"我懂了""这个方案不错""检查答对了"不触发。
- 转入走既有会话创建 / `conversation-execution` / 提案与任务入口，**新建普通执行会话**并携带执行所需摘要（原指令、目标、已选方案、关键约束、未决项、必要来源、项目/目录归属、可追溯学习会话）；不把全部个人学习状态发给执行模型。
- 原学习会话**不原地升权**；学习阶段的"方案可行"不构成动作审批、验证或完成证据；缺目录/权限时沿原机制聚焦补齐，不猜路径、不默认起 Shell。

### 12. 错误与兼容

新增类型化错误码：`LEARNING_SESSION_REQUIRED`、`LEARNING_RECORD_DISABLED`、`LEARNING_ROUND_UNAVAILABLE`、`LEARNING_ROUND_STALE`、`LEARNING_EPOCH_STALE`、`LEARNING_EVIDENCE_REF_INVALID`、`LEARNING_INCREMENT_REJECTED`、`LEARNING_CONCEPT_AMBIGUOUS`。既有 `COMMAND_ID_REUSED`、`REVISION_CONFLICT`、维护门语义不变。

Breaking Change：**No**（新增枚举取值、新增可选请求字段、纯追加表与端点；不传新字段即旧行为）。迁移 0072 纯追加，回退应用后旧代码不读新表。

## 代价

- 一条迁移要重建 `ck_assist_session_mode`；所有按 `conversation_mode` 分派的位置（后端 runner、`conversation-state` 的拒绝分支、前端 parser/单选框/深链分组）都要逐个核对，漏一处就会把学习身份当成可写会话。
- 五张新表 + 一条消息列；证据行随实际接触增长，需要轻量查看与裁剪规则，否则上下文会膨胀。
- 模型端口要新增结构化增量输出与严格校验；Fake 端口与真实 Provider 的兼容需要单独验证。
- 同一学习会话内的排队沿用既有 Agent 行为（**不新增**「在途即拒」的限制）：每条在途消息各自成为一轮，结算按 `message_id` 唯一。跨会话并发谈同一知识点由概念代次与轮次冻结边界保证，不靠串行化。

## 影响范围

Assist/Application、学习领域与仓储、Gateway 只读来源（复用，不新增）、模型端口与调用账本、API/数据库兼容、Context 选择、工作台协作页与轻量查看。工程责任归[领域模型 §13](../architecture/domain-model.md#13-学习模式的状态与权限边界)，交互归[工作台 §26](../frontend/workbench-design.md#26-学习模式)，未运行规格归[测试计划 §25](../testing/verification-plan.md#25-学习模式验收规格)。

## 与 ADR-018 的关系

**新增第三种会话身份，不修改助手档语义。** `ASSISTANT` 仍然纯只读、仍然不建 Task/Run；学习身份不是"可写的助手"，也不是"助手加一个开关"。ADR-018 的"人设快照冻结文本不冻结能力"继续成立：学习身份的能力同样来自代码与准入，不来自任何配置文本。

## 实施范围与责任映射

编制时（2026-10-11）核对的现状差异与本次补齐目标。**执行前需按最新代码复核**。

| 主文档条目 | 当前入口 | 本次缺口 | 负责文件（协议阶段登记） | LM |
|---|---|---|---|---|
| 会话身份冻结 | `assist_sessions.conversation_mode`，只有 `AGENT/ASSISTANT` | 增加 `LEARNING` 并重建 CHECK；后端/前端枚举与 parser 贯通 | `migrations/0072_*.sql`、`infrastructure/database-schema.ts`、`api/assist-api.ts`、前端 `api/dtos|parse/assist.ts`、`ConversationModeSwitch.tsx` | LM-01/08 |
| 纯学习零执行 | `AssistView` 无 Skill 消息可能触发 `requestExecution`；`conversation-state` 只排除 `ASSISTANT` | 学习身份在**前端、命令与服务端**三层隔绝自动业务执行与状态维护 | `views/AssistView.tsx`、`application/conversation-state.ts`、`application/assist-runner.ts` | LM-01/08 |
| 记录 Owner | 无 | 五张表 + 仓储 + 用例，注册进 `Repositories` | `learning/learning-repository.ts`、`application/learning-*.ts`、`application/unit-of-work.ts` | LM-05/06/09/13 |
| 同轮增量 | 助手档只汇总 usage，无结构化增量 | 模型端口 `learning_increments` + 应用校验 | `workflow/*model-port*.ts`、`application/learning-settlement.ts` | LM-09/12 |
| 逐次计量 | 助手只读轮次**不**走 `recordModelInvocation` | 学习每轮/每重试进调用账本 | `application/learning-runner.ts`、`application/model-call-recorder.ts` | LM-11 |
| 记录控制 | 助手 `remember` 只是 UI 状态、请求未携带 | 持久"本次不记录"（消息级 + 会话级），应用校验 | `assist-commands.ts`、`learning-session-controls` 用例 | LM-13 |
| 轻量查看/接续 | 无 | 记录查询与接续端点 + 组件 | `api/learning-api.ts`、`components/Learning*.tsx` | LM-03/15 |
| 转执行 | `conversation-execution`、提案/任务入口 | 学习 → 新建普通执行会话并携带摘要，不原地升权 | `application/learning-handoff.ts` | LM-04 |
| 联网查证 | 助手词表无 `WEB_FETCH` | 学习权威查证单独核定获准入口，不扩大普通助手工具 | 协议阶段核定 | LM-07 |

## 实现落点（2026-10-12 整改 R1–R8）

2026-10-11 后端独立验收的 8 个真实反例逐项落地。**全部只改实现与测试，不改协议、不加迁移、不放宽既有约束**；`ck_assist_message_method_exclusive`、数据库维护准入、既有迁移与 hash 校验都保持原样。

| 反例 | 协议条款 | 落点 |
|---|---|---|
| R1 显式 Skill 与自然语言方法双写 | §4 身份 | `application/assist-commands.ts`：显式 `skill_ref` 时走 `resolveMethodFreeRequest`（只保留 `/命令` 输入校验，不绑定方法身份）；无显式 Skill 时原路径不变。修复前同一条消息写 `skill_snapshot` + `method_snapshot`，撞 `0071` 互斥约束整单 500 |
| R2 失权 Worker 的迟到结算 | §8 停止与迟到 | `application/learning-records.ts` `applySettlement`：结算事务内核对消息仍 `RUNNING` 且 `worker_id` 匹配；失权 → `REJECTED/LEASE_LOST`，零新增 |
| R3 持久取消被迟到 CONTENT 绕过 | §8 | 同上：同一事务内核对 `cancel_requested`；取消先提交 → `CANCELLED/LEARNING_ROUND_CANCELLED`，零新增且消息不冒充 `COMPLETED`；增量先提交则保留既有事实 |
| R4 最近 20 条之外的删除被旧轮复活 | §5 保存前校验 | `beginLearningRoundInTransaction` 冻结**全部**既有知识点（含 `$identities` 身份分区）；`insertEvidence` 在 `for update` 内按期望代次写 |
| R5 已解除 GAP 仍进未决项 | §6 用户控制 | `readLearningContinuation` 与 `readLearningRoundState` 统一按 `disposition === 'PENDING_REVIEW'` 判定未决 |
| R6 清除扫描与 epoch 推进之间的并发结算 | §7 版本与幂等 | `LearningRepository.lockRecordEpoch`：全清与结算取同一 workspace 级 `pg_advisory_xact_lock`，统一「先锁再碰轮次行」的顺序 |
| R7 generation 校验后的人工纠正被旧轮越过 | §5 | `insertEvidence` 的 `expectedGeneration` 与 `for update` 重读把「校验」和「写入」放进同一临界区 |
| R8 无可信依据仍写「实际表现」 | §5.3 依据绑定 | 应用按候选性质绑定 `source_message_id`；结算校验存在、属于本轮、性质匹配，且本轮有真实输入（跳过/仅自述理解不产生 `OBSERVED`/`GAP`）。缺依据一律 422 `LEARNING_EVIDENCE_REF_INVALID` 且零新增 |

**已核定的语义边界**：跳过识别是固定短语表 + 规范化后精确匹配（不是自由措辞理解），因此「跳过」以外的自然语言跳过表述不在被核定场景内；`RESOLVE_REVIEW` 只作用于已存在的知识点且不新增证据；同一轮内 `CORRECT` 造成的代次递增不回判本轮后续增量过期。

## 后续

本 ADR 冻结协议后，按提示词 §14 工作包 A→B→C→D 推进：A 身份与最小持久闭环 → B 教学/Context/计量/恢复 → C 产品入口与转执行 → D 独立复验与真实环境。实现落地时补[物理设计 §72+](../database/physical-design-postgresql.md)、[HTTP 契约](../api/http-command-contract.md)新节、[测试计划 §25](../testing/verification-plan.md#25-学习模式验收规格)的形式化落点，并只更新统一功能验收表受影响行。

**未验证范围**：本 ADR 为协议冻结，无代码、无测试、无真实 PG/前端/Windows/Provider 证据。指定子代理模型（`gpt-6.1-sol`）在当前账号不可用，本轮由协调者独自承担实施与复验，不虚报独立复核。

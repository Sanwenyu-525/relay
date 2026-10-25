# PostgreSQL 物理设计：分册 04

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../physical-design-postgresql.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 72. 0071 内置工作方法与聊天命令（2026-10-11 源码实现）

依据 Skill 专题 §9、ADR-019 与测试计划 §26 BC-02–BC-04。只给 `assist_messages` 追加三列，不改既有列、不回填历史行：

* `method_snapshot jsonb`：内置工作方法的冻结定义与摘要（形状与校验见 `apps/api/src/skills/builtin-methods.ts` 的 `inspectFrozenMethodSnapshot`），发起时冻结，注册表替换后只显示历史身份；
* `method_action text`：`INSPECT`（只读报告）或 `MODIFY`（用户明确要求修改）；
* `method_argument text`：用户补充的目标文本（与 `skill_input` 分开，不参与提案解析）。

两条约束：`ck_assist_message_method` 要求三列同时齐备或同时缺席（缺行动会让回执无法解释本次做了什么），且 `method_argument` 不超过 2000 字符；`ck_assist_message_method_exclusive` 要求 `method_snapshot` 与 `skill_snapshot` 互斥（方法与第一方 Skill 是两种身份）。

迁移 `0071` 与并行的 `0072`（学习模式记录）互不依赖。回滚风险：纯追加可空列与 CHECK，回退后旧代码不读这三列；已写入的方法身份不会因为回退而被删除，只是不再投影。

## 73. 0072 学习模式的会话身份与个人学习记录（2026-10-11 源码实现）

依据 ADR-020、领域模型 §13.4 与提示词工作包 A。三处改动，都是**纯追加**，旧代码不读新列/新表即行为逐字不变：

* **会话身份**：`assist_sessions.conversation_mode` 增加取值 `LEARNING`。0059 的 `ck_assist_session_mode` 重建为三分支：`AGENT` 与人设四列全空、`ASSISTANT` 与人设四列全有、`LEARNING` 与人设四列全空（学习身份不由配置文本获得能力）。既有会话仍按 `AGENT` 读出，不回填、不虚构。
* **消息级记录开关**：`assist_messages.learning_record_disabled boolean NOT NULL DEFAULT false`。随发送命令的命令体持久，因而进入幂等摘要；`false` 即照常记录。它只管「本轮」，与下面 `learning_session_controls` 的会话级开关分开。
* **五张记录表**：
  * `learning_concepts`（`UNIQUE(workspace_id, slug)`）：知识点身份，`slug` 是跨轮次找到同一概念的稳定标识，`aliases jsonb` 是有限别名，`generation` 是概念代次。
  * `learning_evidence`：单条证据。`kind IN ('EXPOSURE','SELF_REPORT','OBSERVED','GAP')` 区分接触/自述/表现/缺口；`disposition IN ('ACTIVE','PENDING_REVIEW','SUPERSEDED','WITHDRAWN')`；`ck_learning_evidence_source` 要求 `LEARNING_MESSAGE` 行必须绑定本轮消息、`USER_CONTROL` 行不得绑定模型消息——这一条同时挡住「模型伪造用户答题/自述」。
  * `learning_record_epochs`：每 workspace 一行的清除边界（惰性建立，缺行等价 epoch 0）。
  * `learning_session_controls`：会话级「后续不记录」，带 `revision` 供 CAS。2026-10-13：缺行按开启/revision 0 读取；首次 `expected_revision=0` 用原子 INSERT/ON CONFLICT（只允许已有 revision 0）写为 1，已有非零版本返回冲突，避免首次操作永远失败。没有表/列/约束变化，不新增 migration；旧不带期望版本的请求保持原行为。
  * `learning_rounds`（`UNIQUE(message_id)`）：一次教学轮次的结算依据，**在调用模型之前**写入，冻结当时的 `epoch`、相关知识点 `concept_generations` 与记录控制；结算只落在仍 `PENDING` 且代次未变的轮次上。`concept_generations` 的形状（2026-10-12 整改 R4 后）：顶层是 `concept_id → generation`，覆盖该 workspace **全部**既有知识点；保留键 `$identities` 另存同一批知识点的 `slug → generation`。冻结身份分区是为了把「本轮合法新建知识点」与「既有知识点被删除后以同名重建」区分开——后者会拿到新 `concept_id`，只有身份基线能识别，从而挡住「靠新建绕过删除代次」。**不改列类型、不加列、不加迁移**：`jsonb` 对旧轮次缺 `$identities` 时按空表处理。
* **授权**：五表 `SELECT, INSERT, UPDATE, DELETE`（DELETE 只服务单项删除与全清）。`assist_sessions`/`assist_messages` 的既有表级授权已覆盖新增列。
* **清除与结算的序列化（2026-10-12 整改 R6）**：不新增表或列，用 `pg_advisory_xact_lock(hashtextextended('learning-record-epoch:<workspace_id>', 0))` 把「全清」与「轮次结算」排成一致序列。两处都**先取该事务锁再碰 `learning_rounds` 行**（统一锁顺序，避免与概念行 `for update` 死锁），因此只有两种合法结果：全清先提交 → 旧轮次读到新 `epoch` 判 `LEARNING_ROUND_STALE`；结算先提交 → 全清随后把新证据一并清掉。锁随事务结束自动释放，不落任何持久元数据。

**删除范围**：全清/单项删除清掉 `learning_concepts` 与 `learning_evidence`（评估内容）；`learning_rounds` 只改状态（`CANCELLED`）并**保留**为最小控制元数据——它只有冻结代次与概念代次、不含任何评估正文，保留它才能让迟到轮次得到「依据已过期」这一可核对原因，而不是笼统的「依据不存在」。命令回执沿用全局 `command_receipts`，学习 `result_ref` 设计上不含评估正文。

回滚风险：纯追加表、可空列与 CHECK 重建。回退应用后旧代码不读新表与新列；`conversation_mode='LEARNING'` 的会话在旧代码下会被当成未知模式读出，因此回退前应先确认没有学习会话。真实 PG 出口见[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「学习模式：协议冻结与工作包 A」行。

## 74. 0073 工具续轮的 assistant 协议数据（2026-10-13）

Migration：`0073_model_tool_turn_assistant_message.sql`，在既有 `run_tool_calls` 增加可空 `assistant_message jsonb`，仅每轮 `ordinal=0` 行保存 `{content, reasoning_content?}`。字段为实际完整模型响应的前置正文及可选 Provider 推理内容，用于把工具结果接回同一轮 assistant 消息；不作为用户授权、业务结论或新的计量数据，不通过工具轨迹 HTTP DTO 暴露。其余工具行不复制内容，`model_calls` 仍只保存原计量与调用状态。

约束要求对象只有上述键、值为字符串、正文与推理合计不超过 512 KiB，非首行只能 NULL。`relay_app` 原表级 INSERT 覆盖新列，既有列级 UPDATE 不包含此列，因此协议数据首次插入后不改写。旧行保留 NULL，恢复只能按空正文/无推理字段读取，不能补造历史响应。

兼容：纯追加可空列，无历史回填；旧应用忽略新列，新应用运行前先应用 0073。回滚删列会丢失已保存的续轮协议信息，后续恢复无法再取得该字段，不应在有依赖该协议的活动 Run 时回退。方法执行的 `execution_method` 另在既有执行请求 candidate 与 Run 契约 JSON 中追加，无新表或列：没有方法的旧契约形状及摘要保持不变。

## 75. 0074 Task 验收参考材料（2026-10-14）

Migration：`0074_task_acceptance_materials.sql`。新增 `task_acceptance_materials`，由 Task 验收材料应用用例独占写入。关联冻结 Task、验收 revision、可空条件、确切 KnowledgeVersion 和可空被测 ArtifactVersion；正文与摘要继续由 Knowledge Owner 保存。缺项合法但显式返回，不转成正式 CheckResult、Review 或完成依据。

外键约束 Task/验收修订/条件和两个版本身份；同项目与 Workspace、材料可用性及被测产物属于该 Task 由应用入口核对。`status` 为 ACTIVE/WITHDRAWN，撤销只更新状态、时间和 revision，保留原关联。审计与关联同一短事务提交，命令复用现有回执。索引覆盖 Workspace/Task 列表，应用角色只有 SELECT/INSERT/UPDATE，无 DELETE。

兼容：纯追加表，无旧数据回填，Breaking Change：No；新应用先应用 0074。应用回退后新表可保留；删表会丢失引用与撤销历史，正文仍留在原 Knowledge，不在材料写入期间回退。
## 76. 0075 Task 验收试用记录（2026-10-14 基础协议）

Migration：`0075_task_acceptance_trials.sql`。`task_acceptance_trials` 保存 Task/验收修订、ORIGINAL/EVIDENCE_VIEW、样本标签、冻结材料 ID JSON、RUNNING/PAUSED/FINISHED、数据库开始/活动段/结束时间、累计有效毫秒与 revision；试用计时应用用例是唯一写入 Owner。原流程无需材料，证据流程逐项核对既有关系，不复制正文或业务状态。

`task_acceptance_trial_observations` 追加人工准备/总验收毫秒、来源说明和创建时间，全部历史保留，最新一条为当前人工观察；两项可空，未知不写零，总耗时已经包含准备且不能小于已知准备。新观察与试用 revision、审计同事务提交。应用角色试用表 SELECT/INSERT/UPDATE，观察表只有 SELECT/INSERT；无 DELETE。

兼容：两张纯追加表，无回填，Breaking Change：No；旧应用忽略新表，新应用先迁移。回退应用可保留数据；删表丢失计时与纠正来源，不在活动试用期间回退。接口归 HTTP 契约 §10.68。
## 77. 0076 验收试用冻结比较（2026-10-14 协议）

Migration：`0076_task_acceptance_comparisons.sql`。新增 `task_acceptance_comparisons`，保存 Workspace/Project、已结束 ORIGINAL 试用 ID/冻结 revision、可空确切人工观察 ID、目标整数百分比、样本口径和冻结时间；比较应用入口唯一写入，应用角色只 SELECT/INSERT，无改写或 DELETE。基线时长沿已结束试用读取，人工观察沿不可变观察 ID 读取；基线后续纠正只标旧比较过期，不替换引用。

`task_acceptance_trials` 追加可空 `comparison_id` 外键，只在开始时写入，旧试用不回填。`task_acceptance_trial_observations` 追加非空 `correctness_outcome`，默认 UNKNOWN，约束为 UNKNOWN/NO_ISSUE_REPORTED/ISSUE_REPORTED；旧观察只是未知，不回填成功判断。全部新增值是试用记录，不形成 Task 完成或正式 CheckResult。

兼容：纯追加表/字段，Breaking Change：No，新应用先迁移；旧客户端不带可选字段仍可用，旧应用忽略新表/列。回退应用可保留数据；删表/列丢失比较基线、样本归属及正确性自述，不在活动试用期间回退。API 归 HTTP 契约 §10.69。
## 78. 0077 会话验收耗时补录（2026-10-14 协议）

Migration：`0077_conversation_acceptance_time.sql`。既有 `conversation_state_changes` 白名单追加 REPORT_ACCEPTANCE_TIME；候选、原用户消息、阶段命令身份和适用基线继续由 Conversation State Owner 保存。请求既有 `interpretation_baseline` JSON 追加 `acceptance_trials` 轻量身份/revision/标题快照，在模型前冻结，不另建请求表。

既有 `task_acceptance_trial_observations` 追加可空 `source_message_id` 外键到 assist_messages；只有原试用观察 Owner 在校验同 Workspace/Project、USER/COMPLETED、AGENT 会话后保存。普通手动补录为 null，旧行不回填。关联仅用于来源，不把消息状态当正式验收或执行权。

兼容：追加候选值/可空列，无数据删除，Breaking Change：No；新应用先迁移，旧应用不支持新候选。回退应用可保留来源列；缩回约束前必须确认没有新候选行，删来源列丢失可追溯引用，不在状态请求应用过程中回退。
## 79. 0078 基础假设记录（2026-10-14 协议）

Migration：`0078_project_hypotheses.sql`。新增 hypotheses（项目内身份、当前定义版本、revision、当前用户结论指针）、hypothesis_versions（不可变主张/方法/标准、可空 KnowledgeVersion/原用户消息来源）、hypothesis_observations（按定义版本追加摘要与可空资料版本）、hypothesis_conclusions（SUGGESTION/USER_CONFIRMED、判断/理由、可靠/充分声明、冻结观察 ID、原建议引用）。Hypothesis 应用入口是唯一 Owner，观察/版本/结论应用角色只 SELECT/INSERT，身份表 SELECT/INSERT/UPDATE，无 DELETE。

所有观察与结论通过 (hypothesis_id, version) 外键绑定定义；当前用户结论引用独立结论行，原建议不冒充确认。观察集合和资料适用性在查询/确认中核对，未知或旧资料不被替换。会话状态候选白名单追加 CREATE_HYPOTHESIS，仍沿原请求/回执/授权，不另建聊天事实源。

兼容：纯追加表与候选值，无旧数据回填，Breaking Change：No，新应用先迁移；回退应用可保留表，旧应用不识别新候选。删除表丢失假设、来源和判断历史；缩回约束前必须确认没有新候选行，不在状态请求/假设写入期间回退。HTTP 契约 §10.71；不新增正式验收或业务完成关系。
## 80. 0079 决定前提与复审候选（2026-10-14 协议）

Migration：`0079_decision_review_candidates.sql`。decision_premises 保存明确登记的决定/项目、决定 revision、说明、互斥的 Knowledge/Hypothesis 来源 FK、来源基线 JSON 和前提 revision；决定复审入口独占。KEEP_DECISION 更新来源基线及 revision，原基线仍保留在候选 before_ref/after_ref 和用户理由中。

decision_review_candidates 保存前提/决定 revision、变化指纹、前后引用、原变化命令、PENDING/KEPT/DISMISSED、处理理由/时间与 revision；UNIQUE(premise_id,fingerprint) 去重。应用角色两表 SELECT/INSERT/UPDATE，无 DELETE；复审不改 Decision、Task/Run 或正式验收表。

Knowledge 与 Hypothesis 变化在原事务中复用复审准备入口，只有明确登记的关联参与；未确认假设建议不是已确认依据变化。无通用事件总线或第二套来源正文。兼容：纯追加两表，无旧前提回填，Breaking Change：No；新应用先迁移，回退可保留表，删除会丢失基线/候选/用户判断历史，不在来源写入或候选处理期间回退。
## 82. 0081 基础下一段工作计划（2026-10-14 协议）

Migration：`0081_personal_planning.sql`。task_time_estimates 保存 Task/确切验收复合 FK、独立估时 revision、五个可空时长和用户来源说明；UNIQUE(task_id,revision)，应用角色只 SELECT/INSERT，新估时追加而不覆写原记录。elapsed 独立声明，分项不自动求和；旧记录不回填未知时长，不写 Task 执行事实。

period_plans 保存 Workspace/Project FK、标题、可用容量、数据库起止时刻、冻结依据 JSON、当前逐项选择 JSON 与 revision。依据不因读取或接受重建；只更新候选选择/理由和诊断 Task 引用。PersonalPlanning 为唯一逻辑 Owner，应用角色 SELECT/INSERT/UPDATE，无 DELETE。诊断接受的 Task/验收创建、选择、审计和原命令回执同事务提交，沿原 Task Owner；不新建 Run 或权限记录。

兼容：纯追加两表，无旧行迁移或新依赖，Breaking Change：No；新应用先迁移。回退可保留两表，删除会丢失估时历史与计划选择；已创建诊断 Task 是原领域事实，不能通过删除计划撤销，不在计划应用时回退。

## 81. 0080 基础工作段复盘（2026-10-14 协议）

Migration：`0080_work_segments.sql`。work_segments 保存项目内身份、确认预期、只含既有 Task/验收/完成引用的 baseline JSON、可空原用户消息、数据库起止时间、OPEN/FINISHED、revision 和结束结果 JSON；结束快照不再改写。工作段应用入口是唯一 Owner，JSON 只服务当前选定 Task 范围，不建立通用计划/统计平台。

work_segment_events 保存 REWORK/HUMAN_INTERVENTION 候选、范围内可空 Task/Run FK、描述、可空人工 duration_ms、CANDIDATE/CONFIRMED/WITHDRAWN、revision 和处理历史 JSON。用户确认/撤回追加历史，保留原候选，不删除；工作段及事件均 SELECT/INSERT/UPDATE，无 DELETE。Task/Run/Completion/ModelCall 仍归原 Owner，复盘只读其确切事实，不补金额或未记录时间。

兼容：纯追加两表与 START_WORK_SEGMENT 会话候选，旧行无回填，Breaking Change：No；新应用先迁移。回退可保留表，删除丢失预期、结果和纠正历史；缩回会话约束前确认没有新候选，不在工作段/会话写入过程中回退。

## 86. 0085 任务链执行规格（2026-10-14 协议）

受控修改/检查接续：复用该 JSONB 列保存 scope_grant、确切检查清单/服务端 trust_basis 和原 MODIFY 方法，无新表/列/迁移。创建只是候选规格；有效 Run 范围仍由既有 run_scope_grants Owner 在原 Delegate 同一事务创建，期限收窄到本链期限且不跨 Run 终态。旧项/旧 Run/既有授权不回填、不改写，链续授权不更新已签发的 Run 授权。协议归 HTTP §10.79，Breaking Change：No；回滚需先停止新规格准入并保留原授权/动作账本。

Migration：`0085_task_chain_execution_specs.sql`。task_chain_items 追加 execution_spec JSONB NOT NULL DEFAULT `{}`，旧项为空，不回填来源、文件或方法。创建保存确切资料版本/根基线、只读资源/连接依据、固定读或有界工具循环及可选原会话方法绑定；只读查询不重算/升级规格，不修改当前 Task 或原资料。TaskChain 应用入口独占，原 Run/动作/Permission Owner 不变。

资源冻结配置 revision/身份键/根路径，不冻结 resource_epoch：该 epoch 是 Gateway 领取执行权的栅栏，正常读取会推进，不能冒充业务配置版本。连接冻结 version/capability，资料引用保留不可变版本和原头基线；规格规范 JSON 摘要绑定专用原命令，空旧规格不改变原摘要。没有新增库、事件总线、模型调用或权限授权表。

兼容：纯追加列，无旧来源伪造、新依赖或公开旧请求必填变化，Breaking Change：No；应用/Worker 先迁移。降级保留列和新规格/原 Run/回执，旧代码不应重新解释新规格；删列会丢失来源和执行范围，不能用删除规格回滚已完成业务或外部操作。

## 85. 0084 基础有限任务链（2026-10-14 协议）

Migration：`0084_task_chains.sql`。task_chains 保存 Workspace/Project、固定依据 JSON、队列协调状态/revision、内部运行实例元数据、明确累计任务/调用上限与已预留数、有效期、停止目标/原 control_request FK、恢复命令身份和授权历史。运行实例字段只控制重开后接续，不作为业务身份或 Worker 已停证明。

task_chain_items 保存有序既有 Task/验收复合 FK、冻结依据、当前准入 Task revision、原 ready/Delegate 命令 ID、唯一 Run FK 和确切 Completion FK；UNIQUE(chain_id,ordinal/task_id) 固定范围，原 Run/完成仍由原 Owner 写。两表应用角色 SELECT/INSERT/UPDATE，无 DELETE。链绑定/任务预留沿原 Delegate 事务；调用预留通过专用链仓库与原模型账本 STARTED 共用事务，失败回滚，未知不清零。

兼容：纯追加两表，无历史链回填、新依赖或外部效果；Breaking Change：No，新应用先迁移，API/Worker Schema 就绪后接新协议。降级先停止链接续与在途准入，保留表/原 Task/Run/回执/账本；删除会丢失授权、累计预算和接续依据，不能靠删除链回滚已完成事实或通知在途动作已停。

## 84. 0083 基础一次性项目提醒（2026-10-14 协议）

Migration：`0083_project_reminders.sql`。project_reminders 保存 Workspace/Project FK、标题、timestamptz 实际时刻、原时区、ENABLED/PAUSED/DISABLED、配置 revision 与独立 schedule_generation、追加配置 history；当前代次只因明确改实际时刻变化，不按显示或暂停/恢复生成第二次发生。

project_reminder_occurrences 保存稳定 ID、Reminder/Workspace/Project FK、代次/config_revision、原标题/时刻/时区、missed、PENDING/HANDLED/DISMISSED、revision、处理理由/时间。UNIQUE(reminder_id,schedule_generation) 防止扫描/重开重发；配置后续编辑不改原事项。两表应用角色 SELECT/INSERT/UPDATE，无 DELETE，提醒应用入口唯一逻辑 Owner。触发事务只写事项和审计；通知复用已有 attention_notification_receipts，领取/投递结果不成为事项处理事实，不另建通知库或业务完成记录。

兼容：纯追加两表，无旧提醒回填、新依赖或自动模型调用，Breaking Change：No；新应用先迁移，扫描在 Schema 未就绪时跳过。回退保留两表；删除会丢失确认设置、发生/处理历史与去重依据，降级前停止该版本扫描，不在发生/编辑/处理期间回退。已发通知属于外部投递，不能伪称与数据库原子或用删行撤销。

## 83. 0082 基础范围推演（2026-10-14 协议）

Migration：`0082_plan_scope_simulations.sql`。plan_scope_simulations 保存 Workspace/Project、原 period_plan FK/修订、冻结基线与来源 JSON、三方案 JSON、PROPOSED/SELECTED、选项/理由/新计划 FK、revision 与创建时间。只更新选定引用和状态，冻结来源及方案不在读回时重算；应用角色 SELECT/INSERT/UPDATE，无 DELETE，PersonalPlanning 唯一逻辑 Owner。

选择经原计划事务内应用入口写 period_plans 新候选，再保存选择/审计/原命令回执；原计划及业务 Task/Run 不改变。逐项应用和诊断创建继续沿 0081/Task Owner，推演 GET 读取所选计划当前每项状态，不另存第二份应用结果。估时可靠性声明仅属于推演，不覆写 task_time_estimates；来源变化标不适用而保留旧比较。

兼容：纯追加一表，无旧行回填或新依赖，Breaking Change：No；新应用先迁移。回退可保留该表；删除会丢失比较和选择历史，已生成计划/诊断 Task 不能由删除推演撤销，不在方案选择/计划应用期间回退。

## 87. 0088 免费模型目录快照与同步状态（2026-10-15 源码实现，阶段 B）

Migration：`0088_model_catalog_snapshot.sql`。两张**全局**表实现 `prompts/free-model-catalog.md` 阶段 B 的目录同步与严格免费判定，进程级事实不隶属 Workspace，不回填、不触碰 `model_calls`/`assist`/`runs` 契约。协议归 HTTP §10.81，物理边界归[运行架构 §8.6](../../architecture/runtime-context.md)。

`model_catalog_sync_state` 是单例发布头 + 跨进程同步租约 + 失败退避：`boolean PRIMARY KEY CHECK (singleton)` 强制一行，迁移由 `relay_migrator` 预置 `(true,'openrouter')`，运行期应用角色只 UPDATE 不 INSERT。`directory_digest` 无成功快照时 `NULL`、有则 `~ '^[0-9a-f]{64}$'`（绝不伪造）；`snapshot_seq bigint CHECK (>=0)` 每次成功发布 +1，领取租约记下基线、发布以 `snapshot_seq = base_seq` 做 CAS，推进后旧响应整体丢弃、旧快照不被较旧结果覆盖。`last_attempt_at`/`last_success_at`/`last_failure_at` 语义分离：失败保留旧 `last_success_at` 与旧快照条目，仅记 `last_failure_reason`（词表 `NETWORK/TIMEOUT/AUTH/RATE_LIMIT/PROTOCOL/INCOMPLETE/ENDPOINT_NOT_ALLOWED/NOT_CONFIGURED`）并递增 `consecutive_failures` 供退避。`sync_lease_token`/`sync_lease_expires_at` 同现同缺（`CHECK ((token IS NULL)=(expires_at IS NULL))`）：只有拿到未过期租约的执行体才外呼；租约过期不代表旧进程已停，迟到结果仍由 seq CAS 兜住。`revision bigint CHECK (>=1)`。

`model_catalog_entries` 保存当前快照的逐条判定：`source_model_id text PRIMARY KEY`（`:free` 后缀原样保留、判定不依赖此后缀）、`display_name`、`context_window integer NULL CHECK (>=0)`（未知 `NULL` 不写 0）、`pricing jsonb` 逐字保留来源字符串单价供核对、`capabilities jsonb`（tools/text_input/text_output 三态，`null`=未知不冒充可用）、`is_free boolean` 与非免费原因 `not_free_reason`。核心 CHECK `((is_free AND not_free_reason IS NULL) OR ((NOT is_free) AND not_free_reason IS NOT NULL))` 挡住「仅名称带 free 就入选」「缺价默认零」两类误判；原因词表 `MISSING_PRICE/INVALID_PRICE/NEGATIVE_PRICE/NONZERO_PRICE/UNKNOWN_BILLABLE_ITEM`。条目随成功发布**同事务整体替换**（CAS 更新发布头后 `DELETE` 全表再 `INSERT`），读取永远看到完整一份、不会读到半份；合法空目录替换后无行、可选免费集合清空。

权限：`relay_app` 对两表 `SELECT`；对 `sync_state` 只给定向列 `UPDATE`（`source/directory_digest/snapshot_seq/last_*/consecutive_failures/sync_lease_*/revision`），无 `INSERT/DELETE`；对 `entries` 给 `INSERT/DELETE`、**不给 `UPDATE`**（条目不可被单点改写，只能整体替换）。逻辑 Owner 是 `ModelCatalogRepository`（经 `unit-of-work` 登记），用例开事务绑定同一执行器，仓库不自开事务；网络拉取在事务外。

兼容：纯追加两张全局表，无历史回填、新依赖或外部副作用，Breaking Change：No；应用先迁移，未迁移时目录端点读不到表即如实报错、不影响既有流程。回退可直接保留两表（旧代码不读），删表只丢失目录快照与同步/退避状态、下次重新同步，无自动 down migration。会话模型选择、Run 模型冻结与免费调用硬保护属阶段 C，以 `0089+` 追加，本批不预建无当前调用方的表或列。

## 88. 0089 会话模型选择（2026-10-15 源码实现，阶段 C 首批）

Migration：`0089_session_model_selection.sql`。追加**一张会话作用域表** `session_model_selection` 实现 `prompts/free-model-catalog.md` 阶段 C 的「会话选择持久化」，纯追加、不回填、不改写任何既有迁移或 `model_calls`/`runs`/`assist_sessions` 列。协议归 HTTP §10.82，Owner 归[运行架构 §8.6](../../architecture/runtime-context.md)。该表只记录「本会话后续新发起的请求改用哪个模型」这一事实，**从不写回进程默认**（应用默认仍只由 `RELAY_MODEL_*` 决定），也不建 Task/Run、不发外呼、不写调用账本。

`session_id uuid PRIMARY KEY REFERENCES assist_sessions(id)`：每会话至多一条当前选择，随会话生命周期留存（归档不删行，保留可核对的失效来源）。`connection text CHECK IN ('default','openrouter')` 把可选连接钉死为两枚已登记对象——原默认与 OpenRouter 免费目录连接，目录内容不得引入第三主机。`model text CHECK (~ '^.{1,200}$')` 冻结确切模型 ID（续轮/重启按此恢复，不用 `openrouter/free` 随机选型）。`config_fingerprint text CHECK (~ '^[0-9a-f]{64}$')` 是所选连接当时解析出的非密钥配置指纹，连接配置变化后指纹不符即视为失效。`free_only boolean DEFAULT false` 为真才在每次外呼附服务商端零价硬限制；缺省/假保持原默认行为、不受免费目录故障影响。目录依据三列 `catalog_source NULL|'openrouter'` / `catalog_snapshot_seq bigint NULL CHECK (>=0)` / `catalog_model_id text NULL` 记录「免费判定来自哪版快照、哪个目录型号」。

核心 CHECK 挡住半截与矛盾记录：`(free_only=false OR (catalog_source='openrouter' AND catalog_snapshot_seq IS NOT NULL AND catalog_model_id IS NOT NULL))` 保证「仅免费」必带完整目录依据；`(connection='default' OR catalog_source='openrouter')` 保证非默认连接必来自目录；`(catalog_source IS NULL)=(catalog_snapshot_seq IS NULL) AND (catalog_source IS NULL)=(catalog_model_id IS NULL)` 保证依据三列同现同缺。`revision bigint CHECK (>=1) DEFAULT 1` 供 CAS：`selected_by_command_id uuid NOT NULL` 留存最近一次写入该选择的原命令身份。

写入是「CAS + revision 单调递增」：首次以 `INSERT ... ON CONFLICT (session_id) DO NOTHING` 建 `revision=1`，后续以 `UPDATE ... WHERE session_id=? AND revision=期望值` 收窄，冲突返回空由用例判 `INVALID_TRANSITION`，绝不覆盖更新的值。逻辑 Owner 是 `SessionModelSelectionRepository`（经 `unit-of-work` 登记）与用例 `select-session-model.ts`（复用命令回执/幂等基础，`command_type='SelectSessionModel'`）：用例开事务绑定同一执行器，仓库不自开事务；选择命令读目录快照是事务内 DB 读、无任何外呼。`/model` 与选择器共用此 Owner，只影响该会话后续新请求。

权限：`relay_app` 只有 `SELECT, INSERT, UPDATE`，**无 `DELETE`**（会话归档不删选择，保留历史）。

兼容与限制：纯追加一张会话作用域表，无旧数据依赖，Breaking Change：No；未迁移时 `/model` 执行入口与 `GET …/model-selection` 读不到表即如实报错，既有 `/clear`/`/new`/`/undo` 与普通消息发送不受影响。回退可保留该表（旧代码不读），删表只丢失各会话选择、用户需重选，不影响任何业务事实。**本批只接通「默认连接」这一枚当前可执行的聊天端口的选择持久化与 `/model` 写读接线；OpenRouter 聊天连接的实际外呼（携零价硬限制）与「所有生成/连接验证入口读取各自冻结约束、Run 非密钥模型快照列」尚未接线，命中目录免费项的选择本批如实拒绝（`OPENROUTER_CHAT_NOT_WIRED`），以 `0090+` 追加，不预建尚不可兑现的表列。**

## 89. 0091 输入框草稿辅助的调用证据（2026-10-16 源码实现）

Migration：`0091_composer_draft_assist.sql`。协议归 HTTP §10.84，交互归[工作台 §30](../../frontend/workbench-design/part-10.md#30-输入框自动分点与手动润色)。本迁移**不新建表、不加列、不回填**，只给既有 `model_calls` 的 `kind` 增加一个取值 `'COMPOSER'`，并补一条「无作用域」来源分支。编号说明：`0090`（会话行内控制：改名/置顶/归档/重开）属并行任务，本文档尚未登记它；本批只登记自己引入的 `0091`。

**为什么是扩展现有账本，而不是第二套账本。** 草稿辅助是一次真实模型调用（§30.4：不把「未发聊天」写成「没有模型调用」），所以必须计入真实用量与预算。既有四种 `kind` 都要求一个 Run 或 Assist 作用域——`DRAFT`/`SEMANTIC_CHECK` 要 `step_attempt_id`、`ASSIST` 要 `assist_message_id`、`VERIFY` 无作用域但语义是实例连通性探针。草稿辅助既没有 Run 也没有消息，若冒用 `VERIFY` 会让「验证探针」的统计把草稿调用算进去；因此按最小扩展新增一个明确表示「草稿处理」的无作用域取值。这与 §30.4 的「不新建第二套账本」一致：**证据仍只有 `model_calls` 一份**。

**约束形状。** 沿用 `0043` 的定位方式（凡同时提到 `DRAFT` 与 `SEMANTIC_CHECK` 的 CHECK 都是 kind 枚举或 kind↔来源配对约束，逐条丢弃后重建），避免按名字硬删漏掉历史改名。重建后的 `ck_model_calls_kind` 为 `kind IN ('DRAFT','SEMANTIC_CHECK','ASSIST','VERIFY','COMPOSER')`；`ck_model_calls_kind_origin` 在原有四支之外追加 `(kind = 'COMPOSER' AND step_attempt_id IS NULL AND manifest_id IS NULL AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)`，即草稿辅助**必须无任何 Run/会话/清单/验收作用域**——半截挂到某条消息上的行写不进去。`status` 约束、索引与列级 `UPDATE` 授权一字不改（本迁移不加列，故不追加 `GRANT`）。

**预算语义。** `ModelCallRepository.begin()` 把 `COMPOSER` 与 `VERIFY` 归入同一「实例级、无作用域」分支：不查询 Run/Assist 作用域、不占 Run 或会话的调用/令牌预算，也不受项目归档闸门约束（没有项目可归档）。用例侧仍写 `budget_reserved_tokens`（端口 `identity.budget` 的 `callReservationTokens`），使崩溃留下的 `STARTED` 行不会被读成零用量。草稿辅助的实例级节流（最小间隔 400ms、并发上限 4）在用例层用内存闸门实现，**不落库**——它是「不让辅助变成调用放大器」的保护，不是需要跨进程一致的事实。

**写入路径与事务。** 新增 `beginComposerInTransaction()`（与 `beginVerifyInTransaction()` 同一形态）：Application 用例先开准入事务，在同一事务内 `requireNormalAdmission(...)` 与写 `STARTED` 行，之后才发网络请求；`ModelCallRepository` 不自开事务。结算语义见 HTTP §10.84：Provider 返回即 `COMPLETED`（含协议畸形的情形），传输失败 `FAILED` + 统一错误分类，取消 `CANCELLED`。

**兼容与回滚。** 纯新增枚举取值与约束分支，旧行不受影响，按 `kind` 过滤的旧读取方看不到 `COMPOSER` 行，Breaking Change：**No**。回退需把两条约束恢复为 `0043` 的版本；此时 `COMPOSER` 行会违反枚举，因此回退前应先删除这些行（它们只是成本证据，不是业务事实），或保留新值继续前进。应用角色仍无 `DELETE`，调用证据行在产品运行中永不删除。

## 90. 0094 会话模型选择的来源组合约束修正（2026-10-16 源码实现，阶段 0 整改）

Migration：`0094_session_model_selection_source_guard.sql`。**只新增一条 CHECK**，不加列、不改数据、不新建表、不动授权，Breaking Change：**No**。协议仍归 HTTP §10.82，物理对象与 Owner 仍归本文档 §88。

**修正的已复现缺陷。** `0089` 的耦合 CHECK 只写全了后半句 `(connection = 'default' OR catalog_source = 'openrouter')`——它表达「openrouter 连接必须带 openrouter 目录来源」，但**没有**反过来禁止 `connection = 'default'` 且 `catalog_source = 'openrouter'`。真实 PG 反例（默认连接混目录来源）本应报 `23514`，实际被接受；这就是 2026-10-16 独立验收里「会话选择 5/6、数据库约束未拒绝错误来源组合」的那一项。

**为什么该组合不是无害的。** default 连接的模型来自进程 `RELAY_MODEL_*`，既不属于 OpenRouter 目录快照，也不该有目录依据。一旦允许它带上 `catalog_source`/`catalog_snapshot_seq`/`catalog_model_id`，读取方就会把「该会话的约束」误当成受某一版 OpenRouter 快照绑定——目录刷新后可能被误判为失效，或反过来把目录里的严格免费判定套用一个非 OpenRouter 模型。来源组合是「这次调用走哪枚连接、依据哪份事实」的一部分，必须互相自洽。

**为什么必须写成显式 `IS NULL`。** 不能用 `catalog_source <> 'openrouter'`：SQL 的 NULL 三值语义让该表达式在 `catalog_source IS NULL` 时求值为 NULL，CHECK 视 NULL 为通过——那恰好放行了我们要允许的「default + 无依据」，却无法把「default + 有依据」区分出来。同理 `0089` 的两条已有 CHECK 也不能靠 `=` 与 NULL 比较来补，它们只在非 NULL 分支上成立。

**为什么追加而不是改写 `0089`。** 迁移台账按内容 sha256 逐条校验（`migration-runner` 的 `verifyAppliedMigrations`），已应用迁移被编辑即 `MigrationIntegrityError`。因此只能追加；编号 `0090`–`0093` 已被 `assist_session_pin` / `composer_draft_assist` / `computer_use` / `assist_message_attachments` 占用，本迁移顺延 `0094`。

**新约束**：`ck_session_model_selection_default_no_catalog_source CHECK (connection <> 'default' OR catalog_source IS NULL)`，已覆盖默认连接不得带来源。**独立复验发现反向组合仍未闭合**：`connection='openrouter'`、`free_only=false`、目录三列全 NULL 时，0089 的 `(connection='default' OR catalog_source='openrouter')` 求值为 NULL，SQL CHECK 视为通过；0094 只限制 default，不会拒绝该组合。因此“合并后语义完备”的原说明不成立。**该反向组合已由同日追加的 [0095](part-04.md#92-0095-会话模型选择的-openrouter-来源反向约束2026-10-16-源码实现阶段-0-整改) 闭合**；本轮（0094 时点）只新增 [独立验收反例](../../../apps/api/test/integration/model-selection-source-acceptance.integration.test.ts)，不修改已应用迁移或产品实现。实际成绩只归统一验收表。

**升级与回滚风险。** 既有库若存在 default 带目录来源的组合，0094 会失败；当前选择 Owner 仅写默认连接且来源为空，但这不能证明所有部署库都不存在旁路或历史冲突行，升级前须实际核对。如确有，应先按业务纠正，不采用 `NOT VALID` 绕过。回滚可 `DROP CONSTRAINT ck_session_model_selection_default_no_catalog_source`，不删除数据。反向 OpenRouter/NULL 组合已由 0095 处理，并含只读预检与既有数据阻止策略。

## 91. 0093 Assist 消息图片附件（2026-10-16 源码实现）

Migration：`0093_assist_message_attachments.sql`。协议归 [HTTP §10.85](../../api/http-command-contract/part-06.md#1085-assist-消息图片附件2026-10-18-前后端接线)，交互归[工作台 §33](../../frontend/workbench-design/part-12.md#33-输入框粘贴图片与消息附件)。Breaking Change：**No**（全新表，无既有读取方）。

**定位**：粘贴/拖拽进输入框的图片是**会话输入快照**——不是资料（不进 knowledge/memory/decision 版本体系）、不是 artifact（不受管存储的版本目录与防篡改核对语义）、不是幂等命令（上传端点只暂存）。内容用 `bytea` 而非受管存储文件：附件必须与消息在同一短事务提交（契约 04），`bytea` 没有「写了文件没写库」的中间态，也无孤儿文件；单用户本机、体积由 CHECK 上限约束，DB 体量可控。

**表结构**：`assist_message_attachments`（`id uuid PK`；`workspace_id`/`session_id` 外键隔离；`message_id` 可空外键 `assist_messages(id)`，NULL=已上传未发送；`name` 1–200 字符；`media_type` CHECK 白名单 `image/png|image/jpeg|image/gif|image/webp`；`byte_length` >0 且 ≤2 MiB 且 `= octet_length(content)` 防元数据与实际字节错位；`content_hash bytea`；`content bytea`；`created_at`）。索引：`(session_id, created_at)` 与 `message_id` 部分索引（仅已绑定）。授权：只授 `SELECT/INSERT/UPDATE`，应用角色无 `DELETE`。

**不变性**：媒体类型与内容插入后不可变（没有任何 UPDATE 路径改写）；`message_id` 只允许从 NULL 绑定为非 NULL，由仓库层 `where message_id is null` 守住并发重复绑定。「每消息 ≤4 张、总量 ≤6 MiB」由 `RequestAssistMessage` 用例在事务内裁决，不写触发器；CHECK 只兜单行形状。

**升级与回滚风险。** 全新表，无数据回填。回滚直接整表丢弃——附件是会话输入快照，不是业务事实。与 `0094`（同日并行批次的会话选择来源约束修正）互不触碰：编号避让已在双方迁移注释中互相记录。

## 92. 0095 会话模型选择的 OpenRouter 来源反向约束（2026-10-16 源码实现，阶段 0 整改）

Migration：`0095_session_model_selection_openrouter_provenance.sql`。**只新增一条 CHECK 与一段只读预检**，不加列、不改数据、不新建表、不动授权，Breaking Change：**No**。协议仍归 HTTP §10.82，物理对象与 Owner 仍归本文档 §88。

**修正的独立反例（输入未放宽）**：`connection='openrouter'`、`free_only=false`、`catalog_source`/`catalog_snapshot_seq`/`catalog_model_id` 全 NULL。预期 `23514`，实际插入成功。反例固定在 [`model-selection-source-acceptance.integration.test.ts`](../../../apps/api/test/integration/model-selection-source-acceptance.integration.test.ts)，本轮先真实 PG 复现红灯再修。

**根因是两次同一类 NULL 三值语义漏洞，不是一次**：0089 的第二合取式 `(connection='default' OR catalog_source='openrouter')` 在 `catalog_source` 为 NULL 时求值为 NULL（`false OR NULL = NULL`，CHECK 视为通过）；0094 的 `(connection <> 'default' OR catalog_source IS NULL)` 在 `connection='openrouter'` 时左支为 true，同样放行。两条约束**各自**都在该组合上通过，因此必须再补一条。

**新约束**：`ck_session_model_selection_openrouter_requires_catalog CHECK (connection <> 'openrouter' OR (catalog_source = 'openrouter' AND catalog_snapshot_seq IS NOT NULL AND catalog_model_id IS NOT NULL))`。`connection` 非空且只两枚取值（0089），故 `<> 'openrouter'` 恒为确定布尔，不落 NULL 陷阱；非默认分支全部用显式 `IS NOT NULL` 与等值比较表达。

**合并后的完整语义**（至此才算闭合，本轮起不再宣称“完备”而无证据）：`default` → 目录依据三列全空（0094）；`openrouter` → 必带 `catalog_source='openrouter'` + 非空 `snapshot_seq` + 非空 `model_id`（0095）；`free_only=true` → 必带完整三列依据（0089）；三列同现同缺（0089）。推论：`default` 上 `free_only=true` 被 0094/0089 联合拒绝，不存在「默认连接却声称免费」。

**既有数据升级策略：明确阻止，不悄悄纠正。** 迁移在同事务内先做**只读预检**（用 `IS DISTINCT FROM` 显式处理 NULL，统计将违反新约束的既有行数），大于 0 即 `RAISE EXCEPTION ... ERRCODE='23514'` 并给出行数与纠正提示，让整个迁移回滚——不伪造来源、不默认改写 `catalog_source`、不删除用户数据。纠正只能走受控业务动作（重选或显式撤销），由人决定。就本功能历史而言，OpenRouter 选择在聊天连接接通前被 Owner 如实拒绝（`OPENROUTER_CHAT_NOT_WIRED`），从未落过 openrouter 行，预检应为 0；真实 PG 全量迁移已验证 95 项全部通过。

**不误伤合法组合（有真实 PG 断言）**：`default` 无来源可用；`openrouter` 带完整依据、`free_only=false` 可用（来源依据与「是否仅免费」无关）；`openrouter` 带完整依据、`free_only=true` 可用。见 `session-model-selection.integration.test.ts` 的「迁移 0094/0095 不误伤合法组合」用例——该用例用**独立会话**逐组合插入，因为应用角色没有 `DELETE`（0089 只授 SELECT/INSERT/UPDATE），测试同样不能用删除清行。

**升级与回滚风险。** 若库中确有 openrouter 无来源的行，迁移以 23514 失败并阻止，属预期行为；纠正后重跑即可，无部分提交（单事务）。回滚可直接 `DROP CONSTRAINT ck_session_model_selection_openrouter_requires_catalog`，预检 DO 块不残留任何对象。

## 93. 0103 GitHub 只读能力（2026-10-17 源码实现，开发自检）

Migration：`0103_github_read.sql`。协议归 [ADR-023](../../decisions/ADR-023-builtin-github-skill.md)，实现边界归[工具适配器 §4.1](../../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。Breaking Change：**No**（只新增能力行与放宽 CHECK；不新建表、不改既有列、不新增索引或授权）。

**能力登记。** `gateway_capabilities` 新增 `('GITHUB_READ','REAL','READ')`。动作词表为 `GITHUB_REPO_VIEW` / `GITHUB_PR_LIST` / `GITHUB_PR_VIEW` / `GITHUB_ISSUE_LIST`，逻辑动作不新建表；适配器在受管根内用本地 `git` remote 解析仓库身份，模型参数没有仓库名字段。

**资源约束。** `ck_logical_operation_resource` 按 0054/0060/0087/0092 的教训**逐条重述既有分支再追加**，新增唯一分支：

```sql
capability_key = 'GITHUB_READ'
AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ')
AND resource_id IS NOT NULL
```

`RUN`、`USER_ACTION`、`USER_IMPORT` 与无资源行均被数据库拒绝。`RUN` 不放行是刻意的：Run 工具循环信封的 `connections` 形状是冻结协议，开放它需要执行契约与审批链一起改，属于 GitHub 写动作片的前置。应用角色沿用既有 `gateway_capabilities` 读取授权，无新增 GRANT。

**为什么不复用 `CLI_RUN`。** 该能力是 `WRITE`、`approvalPassthrough=false`、`resumable=false`，失败恒隔离、核对恒 UNKNOWN，且入口必须是在连接上点名的绝对路径文件；把只读查询挂上去会让「查一下 PR」进入写语义与 UNKNOWN 隔离。依据与四条源码事实见 ADR-023 的「实施前核对与偏离」。

**验证。** 真实 PostgreSQL 迁移链应用成功（含 `0103`）；集成测试用 DDL 角色做原始 INSERT 正反例（应用角色对 `logical_operations` 无写授权），断言受管资源绑定与来源限制由数据库而非仅应用层守住；受约束重述影响的既有套件回归 85/85。具体场景归[测试计划 §35](../../testing/verification-plan/part-06.md#35-内置-github-skill-只读片0103)。

**升级与回滚风险。** 只新增能力行与 CHECK 分支，既有行不受影响；升级无数据回填。回滚必须在没有任何 `GITHUB_READ` 逻辑动作之前：先恢复 0092 版本的约束，再删除 `gateway_capabilities` 行，否则外键或既有账本会阻止删除。账本按既有规则不可改写，因此已产生 GitHub 读取后只做前向修复，不回退迁移。

## 94. 0104 会话未读标记（2026-10-17 源码实现）

Migration：`0104_assist_session_unread.sql`。**只给 `assist_sessions` 增加一列可空 `unread_at timestamptz NULL`**，不新建表、不回填、不改写既有迁移、不动索引与授权；Breaking Change：**No**。协议归 [HTTP §10.87](../../api/http-command-contract/part-06.md#1087-会话未读标记2026-10-17-源码实现迁移-0104)，交互归[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)。编号说明：`0090`（会话行内控制：改名/置顶/归档/重开）至今未在本文档登记，本批只登记自己引入的 `0104`。

**形状：时间戳而不是布尔。** `NULL` = 已读，非空 = 标记未读的确切时刻；取消未读写回 `NULL`，不留「曾经未读」的第三态——那一次改动留在命令回执里。它与 `0090` 的 `pinned_at` 同一性质：**近期工作栏的导航偏好，不是业务事实**——不改变能否发消息、绑定哪个目录、归哪个项目。**不建索引**：未读不参与列表排序（当时的排序键为 `pinned_at desc nulls last, created_at desc, id desc`；2026-10-18 起 `created_at` 那一档换成 `coalesce(last_message_at, created_at)`，见 §100），也不作筛选条件，只按主键读写单行；与 0090 对 `pinned_at` 的判断一致。

**Owner 与写入路径。** 唯一写入方是 `application/assist-session-controls.ts` 的 `setAssistSessionUnread`：`requireEditableSession`（归属、可见性与 ACTIVE 闸门）→ 仓库 `applySessionControl` 在同一事务内以行锁 + `where revision = expected_revision` 收窄写入并在成功时 `revision + 1`。它与改名／置顶／归档共用 `runIdempotentCommand` 的命令回执；归档会话在进入写入前即被拒，不会留下半截回执。**没有第二套并发机制**：上游 ZCode 用 `unread_at` + `last_unread_at` 两列，是为了让「点开自动清除」这个后台写入与人工标记各自 CAS；本项目当前只有人工 toggle 一个写入方，同一行的并发已经由 `revision` 裁决，提前加单调版本列没有当前调用方。

**权限。** `0015` 已对 `assist_sessions` 授表级 `SELECT, INSERT, UPDATE`，新列自动落在既有授权内，本迁移**不追加 GRANT**；应用角色仍无 `DELETE`。

**上游对照（用户要求的会话存储核查）。** Codex 把 rollout 以 JSONL 落在 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`（另有可重建的 SQLite 索引），其线程表没有未读概念；DeepSeek Harness 的 `completionUnread` 是进程内 Set，重启即丢；ZCode 持久化 `unread_at`（NULL=已读）并用 `last_unread_at` 单调版本做清除 CAS；OpenCode 用 SQLite 的 `time_updated`／`time_archived` 表达侧栏状态。本项目采用数据库行 + 命令回执作为唯一事实源，采纳 ZCode 的「NULL=已读」读法，不采纳其第二枚版本列（理由见上）与 Codex 的文件投影（会形成第二套会话事实；会话存储仍由数据库承担）。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（已读），旧响应与旧客户端不受影响。回退可直接保留该列（旧代码不读）；删除只丢失未读标记，不丢失会话、消息、命令回执或目录绑定。

**验证（如实）。** 真实 PostgreSQL 的 `assist-session-controls.integration.test.ts` **14/14** 经 `run-integration.ps1` 整体 PASSED，覆盖 `0104` 的列形状（可空、`timestamptz`、无默认）、标记/取消的修订推进、重放与 CAS、归档拒绝、跨 Workspace 不可见、列表逐字回显与排序不变；工作台定向 **10/10**（jsdom）与 **7/7**（真实 Chromium 伪造 API）。真实 Windows 窗口与多 DPI 未复验；桌面实机需重新暂存 API。

## 95. 0106 浏览器后端健康投影（2026-10-17 源码实现）

Migration：`0106_browser_backend_state.sql`。新建单行表 `browser_backend_state`（`id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)`），承载浏览器后端最近一次被实测的健康结论；Breaking Change：**No**。协议归 [HTTP §10.88](../../api/http-command-contract/part-06.md#1088-浏览器后端状态2026-10-17-源码实现迁移-0106)，设计与集成点归[浏览器自动化 V1](../../architecture/browser-automation-v1.md)。

**为什么是一张单行表。** 浏览器后端由 **Worker 进程**懒启动并持有，而读它的是 API 进程与桌面壳；三个进程之间只共享 PostgreSQL，因此「浏览器后端现在是什么状态」必须是库里的一行展示事实，而不是任何进程的内存单例——与 `0096` 的 `computer_control_state` 同一理由。**与 0096 的差异**：那是「是否有活跃操控会话」的单行（多任务只有一个前台会话），这一行是「后端本身健康吗」——后端是安装级资源，一个安装只有一份，单行正是它的真实基数。

**形状。** `status` CHECK 五态（`READY`/`CHROME_MISSING`/`BACKEND_MISSING`/`INCOMPATIBLE`/`DISCONNECTED`）；`backend_version`/`chrome_version`/`detail`/`remediation` 为 `text NOT NULL DEFAULT ''`（空串=无值，读取方投影为 `null`）；`tool_count integer CHECK (tool_count >= 0)`；`updated_at timestamptz NOT NULL DEFAULT now()`。没有行的语义是「从未使用过浏览器能力」（读取方投影为 `NOT_STARTED`），不预插一行占位。

**Owner 与写方。** 唯一写入方是 Worker 派发路径 `browserExecute`：每次动作前 `ensureStarted` 后 upsert。**上报失败不阻断真实执行**（try/catch 包住，与 0096 的操控状态上报同一纪律）。不做惰性过期——READY 的后端在 Worker 存活期间一直活着，按 `updated_at` 猜过期只会制造假阴性；进程退出时 Worker 写 `DISCONNECTED`。

**权限。** `GRANT SELECT, INSERT, UPDATE ON browser_backend_state TO relay_app`。**没有 DELETE**：后端状态永远不该被「删掉」，只应被改写。历史发现的 `0096` 未授 `relay_app` 权限问题由迁移 `0110` 修复，见下节；不修改已应用迁移的内容。

**兼容与回滚。** 纯新增表，不改既有列；回退可直接保留（旧代码不读）。`0105`/`0106` 都不改写历史迁移。

**验证（如实）。** 真实 PostgreSQL：`browser-read.integration.test.ts` **6/6**（`run-integration.ps1 -TestFile browser-read` 整体 PASSED，临时集群已删除）——覆盖投影的写入/读取/失败态与跨进程可见（含真实 API 进程经 HTTP 读同一行）；单测 `projectBrowserHealth` 锁定内存结论 → DTO 的形状。安装态未验。

## 96. 0107 浏览器任务状态（2026-10-17 源码实现）

Migration：`0107_browser_sessions.sql`。新建 `browser_sessions`（`owner_kind` + `owner_id` 联合主键），承载"现在有哪个任务在操作哪个页面"；Breaking Change：**No**。协议归 [HTTP §10.89](../../api/http-command-contract/part-06.md#1089-浏览器任务列表与停止2026-10-17-源码实现迁移-0107)，设计归[浏览器自动化 V1](../../architecture/browser-automation-v1.md)。

**与 0106/0096 的分工。** 0106 一行回答"后端本身健康吗"（安装级）；本表多行回答"哪些任务在操作哪些页面"；0096 同样是单行但语义是"是否正在操控电脑"。三者共用一个理由：读写方分布在不同进程，而进程之间只共享 PostgreSQL。**主键是 `(owner_kind, owner_id)` 而不是自增 id**：一个 owner 同时只有一个活跃页，upsert 就地改写不会累积历史行，也天然阻止同一任务出现两行互相矛盾的状态。`owner_kind` 与 Gateway 的 origin 词表一一对应（`RUN`/`SESSION`），不合成"任务表扩展"——那会迫使 Run 与会话两种身份互相冒充。

**形状与权限。** `state` 三态同 0096；`page_id` CHECK > 0（没有页的动作不写行）；`GRANT SELECT, INSERT, UPDATE` 给 `relay_app`，**无 DELETE**——停止是改写而不是删除。读取方按空闲阈值（30s）惰性把 `RUNNING` 落成 `STOPPED`，Worker 不留后台定时器。

**验证（如实）。** 真实 PostgreSQL：`browser-actions.integration.test.ts` **6/6**（与 `browser-read` 合计 12/12，`run-integration.ps1 -TestFile browser-read,browser-actions` 整体 PASSED）。

## 97. 0108 范围授权词表补全（2026-10-17 源码实现）

Migration：`0108_scope_grant_browser_actions.sql`。重述 `run_scope_grants` 的 `ck_run_scope_grants_actions`，把 `COMPUTER_INPUT` 与 `BROWSER_ACTION` 加入允许集合；Breaking Change：**No**（新集合是旧的超集，历史行全部仍合法）。

**这是"CHECK 必须逐条重述"那条教训的第三次实例。** 0092 把 `COMPUTER_INPUT` 写进源码 `SCOPE_GRANT_ACTIONS`、0105 把 `BROWSER_ACTION` 写进去，但本约束自 0056 之后从未更新，于是**插入授权行本身就以 23514 失败**，而代码路径看起来完全正常。顺带说明：`COMPUTER_INPUT` 的"本次任务允许操作电脑"自 0092 起就无法在库里落地，本迁移一并修正。

`BROWSER_COMMIT` **故意不在集合内**：提交表单与上传文件是不可逆外部效果，永远逐次单动作批准。

**同一轮修正的既有口径漂移。** `gateway-actions.ts` 的 prepare 用 `scopeGrantActionFor(actionType)` 归一授权动作名，admit 却直接传 `op.action_type`，导致 prepare 已放行的动作在派发时被判"不在授权内"，进而要一份从未创建过的批准（`GATEWAY_APPROVAL_REQUIRED`）。该漂移对 `COMPUTER_INPUT` 与 `BROWSER_ACTION` 这类合成动作必然触发；本片已把 admit 也改为同一个归一函数。

## 98. 0109 本地目录访问档位元数据（2026-10-18 源码实现）

Migration：`0109_local_directory_access.sql`。新增 `local_directory_access`，以 `resource_id`（主键并关联 `managed_resources`）表示一个受管目录的应用管理设置；保存 `write_tier`（`READ_ONLY` / `ASK` / `AUTO`）、必需的读取连接 ID、可空的写连接 ID、由本入口管理的策略 ID JSON 对象、单调递增的 revision 与更新时间。CHECK 约束限制档位词表、策略 ID 为 JSON object、revision 非负。`relay_app` 只获得 SELECT/INSERT/UPDATE，无 DELETE。**Breaking Change: No**；只新增表与授权，旧客户端/代码忽略它即可。

该表是档位与配置来源的管理元数据，不是第二套 Gateway 授权表。实际动作仍由原 `gateway_connections`、`gateway_policies`、Run 范围授权、Review 与 Gateway 准入判断。`policy_ids` 用于识别本入口有权维护的策略，不能据此绕过显式 DENY、停用、上层目录限制或历史动作约束。没有数据库回填；旧手工配置保持原身份。回退到旧代码时保留此表及关联 Gateway 行，不删除连接或策略；若以后移除该表，须先确认不再需要来源追溯并单独制定数据保留方案。

默认目录读取配置会通过现有 `gateway_permission_policies` 与 `gateway_permission_versions` 查询相同 Workspace/Project/能力/动作且覆盖当前根的历史目标；若没有当前活动匹配策略则不自动创建新的 AUTO。此历史核对不新增表或字段，也不改变迁移 `0109`。

## 99. 0110 电脑控制状态的应用角色权限（2026-10-18）

Migration：`0110_computer_control_state_privileges.sql`。为 `relay_app` 补授 `computer_control_state` 的 SELECT/INSERT/UPDATE，不授 DELETE，不新增表、字段或回填。`0096` 原迁移没有授权，真实应用角色读状态及 Worker 上报均会得到 `42501`；使用迁移 Owner 的检查不能发现此问题。

**Breaking Change: No**。保留 `0096` 内容以兼容已有迁移账本；旧应用可继续使用原表。回退应用版本无需删除数据或撤销授权；若显式 REVOKE，上报、状态查询及退出投影会重新不可用。控制意图和 STOP_REQUESTED 由应用用例在同一短事务提交，STOPPED 只在既有 Run 控制安全点确认后写入，不能以第二次请求代替停止确认。验证场景见 `computer-control.integration.test.ts`；结果唯一归统一验收表。


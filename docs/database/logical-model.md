# Personal Workflow OS：数据库逻辑模型

日期：2026-09-19。状态：Proposed。上游依据：[领域模型](../architecture/domain-model.md)、[实施契约](../../contracts/README.md)。本文保持数据库无关的逻辑语义，不是可执行 DDL；后续 [PostgreSQL 物理设计](physical-design-postgresql.md)细化存储结构，用户已确认允许本机 PostgreSQL。

## 1. 存储原则

业务事实、控制意图、动作记录、验证、审批、完成凭据与关键审计进入同一个事务数据库。大块产物内容可在受管存储中，数据库保存不可变位置及完整性信息。内容保存、模型调用、工具执行不占用长事务。

结构化列承载查询、唯一性、状态迁移和引用约束。JSON 仅适合版本化快照、受约束的参数/证据与展示配置，不用任意 JSON 替代关键关系。快照内容中涉及的关键实体和版本必须能进行明确的有效性检查。

以下列名为逻辑名称，ID 类型、时间类型、枚举存储方式、物理索引与锁语法待选型。可变根默认包含 id、revision、created_at、updated_at；不可变记录包含 id、created_at 和必要来源。外键默认限制删除，历史证据不级联删除；归档不等于物理删除。

## 2. 项目与任务

| 逻辑表 | 关键字段 | 约束 / 写入者 |
|---|---|---|
| workspaces | id、name | V1 作用域，不扩展团队租户模型 |
| projects | workspace_id、title、project_type、archived_at、revision | Project Owner |
| goals | workspace_id、title、status、revision | Goal Owner |
| project_goals | project_id、goal_id | 联合唯一；同 Workspace |
| tasks | workspace_id、project_id?、title、status、mode、acceptance_revision、executor_kind、executor_run_id?、ownership_epoch、current_completion_id?、revision | Task Owner；HUMAN 时 run_id 空，AI 时非空；Delegate 必须有 Project |
| task_explicit_goals | task_id、goal_id | 联合唯一；须为所属 Project 当前 Goal 的子集 |
| task_acceptances | task_id、acceptance_revision、objective、required_output_spec、source、created_at | 联合唯一，不可变；重开也创建新版本 |
| acceptance_criteria | task_id、acceptance_revision、criterion_id、statement、required、method、target_spec | 版本内 criterion_id 唯一；改动生成新验收版本 |
| task_dependencies | task_id、depends_on_task_id、dependency_kind | 联合唯一；禁止自身依赖；应用层检查环及作用域 |
| project_states | project_id、phase_key、next_action_task_id?、revision | project_id 唯一；State Owner；phase 来自 Project Type 词汇 |
| state_refs | project_id、ref_kind、target_id、target_version_id?、source_ref、created_at | 仅允许明确定义的完成/决定/产物引用；按类型验证目标与作用域 |
| project_blockers | project_id、target_kind、target_id、reason、source_ref、resolved_at? | 清除需明确依据；不把执行报错一律写成业务 blocker |
| project_risks | project_id、statement、source_ref、confirmation_ref、resolved_at? | 已确认风险；AI 候选保存在提案中 |
| state_proposals | project_id、base_revision、typed_changes、evidence_refs、status、resolved_command_id? | 类型化提案，不允许任意路径 patch |

State 的 in_progress 通过 tasks 查询；completed_highlight_refs 以历史凭据引用表达，但当前展示必须同时检查 Task 仍为 DONE、当前 acceptance_revision 与 CompletionRecord 匹配、current_completion_id 指向该 CompletionRecord。替代 Decision 或重开 Task 后不继续展示为当前有效事实；重开在同一短事务递增所属 Project State revision，使先前组合视图失效。非空 `SET_NEXT_ACTION` 也必须先锁并确认目标 Task 属于该 Project，再锁 State；清除 next action 时只锁 State。state_refs 的多态引用在物理设计时优先拆成有真实外键的类型关系，不能只存字符串却省略完整性约束。

tasks.executor_run_id 与 runs.task_id 构成逻辑互相引用。Delegate 的事务内先建立合法 Run，再 CAS Task 执行权；提交前保证 Run 归属匹配。是否使用延迟约束或复合外键由数据库能力决定，不能依靠跨事务“稍后补齐”。

## 3. Workflow 与执行控制

| 逻辑表 | 关键字段 | 约束 / 用途 |
|---|---|---|
| workflow_versions | workflow_key、version、definition、definition_hash | key + version 唯一；V1 为内置固定流程 |
| execution_config_versions | config_key、version、scope_spec、capability_refs、config_hash | 不可变；不保存明文密钥 |
| runs | task_id、project_id、status、execution_contract_id、retry_of?、current_step_id?、resume_phase?、wait_reason?、correction_budget、correction_used、revision | Workflow Owner；终态不可恢复；所有状态以契约 02 为准 |
| execution_contracts | run_id、task_id、acceptance_revision、workflow_version_id、execution_config_version_id、hard_rule_bindings、critical_input_bindings、snapshot、snapshot_hash | run_id 唯一；不可变；接受的内容与引用均可追溯 |
| run_steps | run_id、step_key、ordinal、status、revision | run_id + step_key 唯一；步骤标识由固定 Workflow 定义 |
| execution_attempts | step_id、attempt_number、reason、status、input_manifest_id?、result_ref?、claim_epoch、started_at、ended_at? | step_id + attempt_number 唯一；历史不覆盖 |
| step_result_consumptions | step_id、execution_attempt_id、result_kind、result_id | 消费身份唯一；关联步骤推进，在同一事务防止重复推进 |
| run_control_requests | run_id、request_id、type、requested_by、requested_at、status、result_ref?、supersedes_id? | request_id 唯一；PENDING 持久化后 UI 才报告请求已接受 |
| run_worker_claims | run_id、worker_id、claim_epoch、lease_until、heartbeat_at、revision | run_id 唯一；认领必须 CAS，epoch 单调增加 |
| context_manifests | run_id、attempt_id?、builder_version、template_version、manifest_hash、created_at | 每次构建不可变；不覆盖历史 |
| context_items | manifest_id、ordinal、source_kind、source_id、source_version、content_hash、range_spec、captured_content_or_blob_ref、availability | manifest + ordinal 唯一；有原始引用不等于能重放内容 |

P11 实际物理落点沿用 0004 的 `context_manifests.payload`，在其中保存有界 `sources[]` 与 `exclusions[]`，没有创建本表中的候选 `context_items`；不可变 Manifest 摘要覆盖实际片段及依赖快照。0010 只追加独立 `workspace_execution_authority.context_revision`，与 Rule 的 `rule_revision` 分开。P12 若需要显式来源选择/额外 Profile 或更大规模逐项查询，再评估是否拆出 `context_items`，不能把此候选表当成当前 DDL。

快照与 Run 的相互引用可通过预分配 ID、事务内插入顺序或延迟外键实现；物理设计必须给出可执行路径。不得为回避外键问题拆成可被 Worker 看到的半成品事务。

Worker 认领仅允许契约定义的可工作阶段；PAUSED、WAITING_APPROVAL 和终态不能被普通执行扫描器启动。恢复器独立检查控制请求、过期 claim、在途动作和待提交结果，而不是将所有非终态 Run 重新从第一步执行。

M03 首个运输切片的实际表为 `run_commands`（不可变 START 意图，引用现有 Run 和原 HTTP `command_id`）、`run_command_outbox`（PENDING/CLAIMED/DONE/BLOCKED 投递状态）、`run_invocations`（每 Run 一行的整条执行线程 epoch/Worker/租约）。`execution_thread_id` 直接取 `run_id`，没有另建 Run 状态；原有 `runs.worker_id`/`worker_epoch` 与 `step_attempts.claim_epoch` 继续保护单步。旧 Run 只补 `run_invocations=IDLE`，不补自动启动命令，避免迁移后突然执行历史工作。新 Delegate 同事务提交 Task/Run/冻结契约/START/outbox/回执。租约到期使旧 epoch 失去新的业务写入资格，但占有记录仍保留；受监督 Worker 子进程确已退出后，才核对旧单步 claim 和未决动作并重新投递原 command。此处是已落地物理切片，表内 `run_worker_claims` 仍是更早的候选设计名。

0013 为每个 Run 的命令增加不可变 `ordinal`，由持有 Task→Run 锁的应用用例分配；已存在的命令按创建时间和 ID 确定性回填。Review 唤醒命令以唯一 `review_decision_id` 绑定原决定，原 Review 仍保存 operation、目标 hash 与策略版本。投递必须先结清所有较小 ordinal；审批等待释放 invocation 后，新 RESUME 才可进入固定 Mock Worker。`ACTION_APPROVAL` 的 RESUME 暂只持久等待，固定 Worker 不领取，效果仍由原 Gateway 准入控制；正式图节点属于后续切片。

## 4. 资源与工具调用

| 逻辑表 | 关键字段 | 约束 / 用途 |
|---|---|---|
| managed_resources | workspace_id、resource_kind、canonical_identity、normalization_version、status | 规范身份唯一；重叠目录/别名在登记时检查，无法证明不重叠则拒绝并发登记 |
| resource_claims | resource_id、run_id、ownership_epoch、claim_token、status、lease_until、revision | 每资源最多一个未安全释放 claim；隔离中仍占用；历史可另留记录 |
| permission_policy_versions | policy_key、version、scope、policy_body、policy_hash | 版本不可变；当前生效引用单独 CAS 更新 |
| logical_operations | operation_id、run_id、step_id、intent_key、action_type、normalized_target、params_hash、content_hash?、resource_id?、status、revision | 同 Run/Step 的业务意图键唯一；语义改变新动作，但不得绕过未决 UNKNOWN |
| invocation_attempts | invocation_id、operation_id、attempt_number、status、approval_review_id?、admission_policy_version、ownership_epoch、worker_claim_epoch、resource_claim_token?、prepared_at、dispatched_at?、result_ref? | operation + attempt_number 唯一；准确区分 PREPARED 与 DISPATCHING |
| invocation_evidence | invocation_id、evidence_kind、source、content_hash、payload_or_blob_ref、observed_at | 追加证据；过期 Worker 结果也仅进入绑定调用的核对记录 |
| reconciliation_records | operation_id、invocation_id、evidence_refs、conclusion、resolved_by、resolved_at | 证明未执行、已成功或仍未知；普通“我知道了”不是成功证据 |

logical_operations 的汇总状态由调用记录与核对结论确定性更新，不另建第二套独立状态机。外部重试必须沿用原 operation_id，并证明未执行或具备可验证的幂等保障。新 invocation_id 不是重试安全性的依据。

审批绑定在准备调用时以唯一关联占用；后续合法重试是否可复用，取决于批准范围、有效期、目标内容未变和当前权限，不能把审批当永久能力。并发尝试不能各自消费同一批准。涉及多个资源时先按固定顺序取得全部必要 claim；取得不全不准入动作。

## 5. 产物、验证、Review 与完成

| 逻辑表 | 关键字段 | 约束 / 用途 |
|---|---|---|
| artifacts | project_id?、task_id、artifact_kind、title、revision | Artifact 逻辑身份；项目为空仅允许合法人工任务 |
| artifact_versions | artifact_id、version_number、storage_ref、content_hash、size、media_type、source_kind、source_ref、created_at | artifact + version 唯一；不可变，只有完整保存后才能登记 |
| verification_sessions | task_id、acceptance_revision、run_id?、execution_contract_id?、verifier_policy_version、status、verdict?、revision | 单次验证会话；结果不可借修改 session 绑定而转移 |
| verification_targets | session_id、artifact_version_id、content_hash | 精确版本绑定；组合验证允许多个目标 |
| check_results | session_id、criterion_id、check_attempt、checker_version、result、evidence_refs、created_at | 同检查尝试唯一；ERROR 不转 PASS，不算产物失败 |
| verification_applicability | session_id、revoked_at、reason、source_ref | 显式撤销适用性，保留原结果；不能悄悄改历史 PASS |
| review_requests | review_id、kind、run_id?、target_binding、target_hash、expires_at?、status、revision | 目标字段按类型验证；状态不替代实际业务应用结果 |
| review_decisions | review_id、decision_id、decision、actor、reason、created_at | 一次请求最多一个最终决定；更换目标需新请求 |
| review_effects | decision_id、effect_kind、command_id、result_ref、applied_at | 决定与 DB 业务效果同事务；不等于外部调用成功 |
| approval_reservations | review_id、operation_id、invocation_id、reserved_at | 防止跨动作重放或并发消费；同一逻辑动作重试按契约再次检查 |
| completion_records | task_id、acceptance_revision、run_id?、basis_kind、verification_session_id?、human_decision_ref?、state_delta、committed_at | task + acceptance_revision 唯一；不可变；自动/人工依据有互斥有效性校验 |
| command_receipts | scope_key、command_id、command_type、payload_hash、result_ref、created_at | scope + command_id 唯一；重放先比摘要，再返回原结果 |
| activity_records | actor、command_id、project_id?、task_id?、run_id?、event_type、fact_refs、created_at | 关键审计与业务事实同事务；不把它当事件溯源主存储 |

CheckResult 的检查尝试与执行产物的 ExecutionAttempt 是不同计数。会话内追加补验可以完成尚未满足的人工/自动项，但不得覆盖旧结果；最终判定使用哪个结果必须由确定的验收规则选择并保留绑定。已最终判定的会话如需重验，建立新会话。

所有 Review 目标均需可查询、可校验的绑定。动作批准需含 operation_id、action_type、normalized_target、params_hash、content_hash/scope、版本/有效期；产物接受需含 artifact_version_id、验收版本以及“固定版本”或“当前选用版本”的适用方式。不能仅存一个 display_text。

CompletionRecord 的周期唯一约束比 command_id 更强：两个不同命令也不能在同一周期完成两次。重开只更改当前 Task 与验收版本，不删除历史凭据；旧命令重放返回旧凭据，绝不能更新新周期。

## 6. 信息与用户选择

Knowledge、Memory、Decision、Rule 采用有类型的版本记录，最低保留 workspace/project 作用域、来源、创建者、版本与有效状态。Rule 另有 HARD/PREFERENCE、适用条件、执行方式；Decision 另有替代关系与 ACTIVE 状态。V1 不展开通用知识图谱或自动记忆分类表。

用户选择用 task_selections（task_id、pin、later_local_date、timezone、revision）与 focus_selections（scope、chosen_target、revision）表达。Workbench 展示配置单独版本化。Today 排序与默认 Goal 继承为查询结果，不为缓存建立第二个事实写入口。

这是完整边界的最低数据需求，不意味着首个 migration 就创建全部逻辑表。首版按 A–E 切片落地：A 优先人工闭环；B 增加固定 Workflow、验证与完成；C 加入恢复与互斥；D/E 再扩展真实适配器相关数据。不能提前开放自动执行而推迟其必要安全约束。

## 7. 事务访问与恢复查询

| 场景 | 必须同事务判断/写入 | 必要查询入口 |
|---|---|---|
| Delegate | Task revision/执行权、Run/快照、Task epoch、回执 | Task 主键、当前执行权 |
| 控制 vs 完成 | 同一 Task/Run 串行化；控制请求和完成不能相互越过 | run_id + 控制状态；Task 当前周期 |
| 动作准入 | Run 控制、执行权/claim、当前权限、资源 claim、审批占用、DISPATCHING | Run 在途动作、resource_id、approval review_id |
| 恢复 | 已提交步骤、调用状态、claim、控制请求和凭据 | Run 状态/租约到期、调用状态/时间、PENDING 控制 |
| 完成 | 有效验收、Review、无在途/未知动作、Task/Run/State/凭据/回执/审计 | 验收版本、验证绑定、未决 Review、未决动作 |
| 重开 | 新验收版本、Task 当前完成引用、所属 State revision 失效 | task_id + acceptance_revision |

索引至少覆盖外键常用查询，以及表中恢复入口；具体联合索引顺序由查询和数据库执行计划确定，不预先给每个字段建索引。普通执行扫描与 UNKNOWN 核对扫描分开，所有领取采用事务 CAS，而不是“扫描结果天然归我”。

多对象写入遵守统一顺序：Task → Run → ProjectState → Resource；涉及多个同类实体按 ID 排序。权限撤销与最终准入也需共享可验证的串行化机制，物理设计必须说明其线性化点。最终准入之后的撤销不能收回已发出的外部副作用。

回执唯一冲突发生时，失败事务回滚后读取已提交回执并比对请求摘要；不能在事务已失败的上下文继续写。时间到期用可靠统一的服务/数据库时间判断，业务 Later 日期另保存时区，不把本地日历日期当 UTC 截止时间。

## 8. 补充模块的逻辑扩展

[信息与计划](../architecture/information-planning.md)补充类型版本表、Goal 对齐模式、用户调度元数据及 Today 日期/时区选择；[运行设计](../architecture/runtime-context.md)补充 model_calls、Assist 与提案。完整字段由其唯一主设计定义，不在本文重复维护。

Gateway 原表的 run_id/step_id 是 RUN 分支；显式 URL 导入按 [ADR-004](../decisions/ADR-004-user-import-origin.md)增加 USER_IMPORT 与 import_jobs。来源必须类型化且带真实 FK/作用域，具体 CHECK/索引落点见物理设计，不用 nullable 字段绕过执行检查。

## 9. 物理设计前的核验清单

1. 选定数据库如何支持 CAS、唯一约束、外键、事务隔离及并发写入；SQLite 与服务型数据库不能直接套用同一锁语句。
2. 给出 Run/契约、Task/Run 循环引用的插入顺序与约束证明。
3. 给出资源唯一占用、批准占用、当前政策切换与动作准入的竞争测试。
4. 将多态 State/Review 引用细化为类型安全关系或明确验证路径。
5. 确定产物路径布局、持久化完成语义、孤儿清理宽限期和历史保留策略；未完成前不启用自动清理。
6. 基于 A01–D11 编写真实数据库测试与故障注入；本文不声称这些检查已经执行。

已形成[技术选型](../architecture/technology-selection.md)与[物理设计](physical-design-postgresql.md)。物理层将 execution_contracts 改为共享 run_id 主键、多资源关系改为关联表、批准占用与调用绑定拆开，并新增 Workspace authority 锁定点；这些是本逻辑语义的落实，不是第二套业务 Owner。物理层锁序在原顺序前增加 Authority，所有相关写入入口需统一遵守。

下游已形成 [API 契约](../api/http-command-contract.md)及[首条工程切片](../development/first-human-slice.md)；下一步建仓时生成 migration 并在 PostgreSQL 验证。原件差异见设计审计，不得把推荐技术写成已运行事实。

## 10. Skill 与蓝图的持久化补充

2026-09-20，Proposed，D 阶段设计；没有生成或执行 migration。依据 [Skill 专题](../architecture/relay-skills.md)。Skill 定义先随包注册，保留被引用的不可变定义/依赖快照，不预建通用安装市场表。

| 记录 / Owner | 最低新增信息 | 约束 |
|---|---|---|
| Assist 请求 / 原 Assist Owner | 可选 Skill id/version/definition_hash、依赖引用 | 非 Skill 请求保持原行为；不能把 Assist 伪装成 Run |
| ContextManifest / Context；ExecutionContract / Workflow | Skill 身份与解析依赖版本 | Manifest 按实际输入保存；Run 契约冻结，不被升级覆写 |
| ProjectBlueprintProposal / Project | workspace/project、来源请求、不可变候选 payload/hash、类型化基线集合、Skill 引用、检查证据、状态/revision、替代提案引用 | 每次修改新候选；目标引用与源均校验作用域；基线覆盖实际修改的 Project/State/View 和读取依赖 |
| Blueprint 应用来源 / Project | 唯一 proposal_id、command_id、Skill 身份、受影响对象/结果版本、新 Task 局部键到真实 ID 映射、应用时间 | 与所有效果/提案终态/回执/审计同事务；不同命令不能重复应用同提案 |

应用来源是历史记录，不是第二份 Project State。项目的 `applied_skill_version` 在查询时从相关应用记录展示；允许多次显式应用并保留旧记录，不能用一个可覆盖字符串充当全部来源。后续手工编辑按正常 revision 留痕，不再冒充原蓝图版本的输出。

Migration/兼容性：D 阶段按已落地 schema 追加迁移，不修改已执行的 V001；旧请求/Run 没有 Skill 来源应可读且不伪造回填。提案基线/结果关联需在物理设计中落实 FK 或类型化校验、proposal 应用唯一约束及全部写入口统一锁序；正式表名、序号与 SQL 待实施冻结。

数据迁移与回滚风险：只迁移结构，不自动套用新版 Skill 改项目。已应用蓝图产生的普通业务事实不能通过删除提案或降级包回滚；不兼容应用版本不得读取新 schema 后继续写。备份需包含历史定义快照和来源记录；删除被引用定义应保留历史可核对性，缺失明确报不可用。

扩展组合的逻辑补充：当来源为 Pack 时，在既有提案/应用来源及实际使用的配置引用中保存可选 Pack 身份、版本、定义摘要和解析成员清单；ContextManifest/ExecutionContract 记录本次真正采用的 Profile/Recipe/模板版本，不复制整包未使用内容。只读定义快照由应用组合入口保留，项目应用来源归 Project，各配置绑定仍由其 Owner 写入；不新增第二份 Pack 项目状态或可覆盖的“全部已升级”标记。上述为待实施字段要求，物理列/快照结构、引用约束与迁移序号在 D 阶段冻结；旧记录无 Pack 来源保持合法，不伪造回填。更新兼容校验失败不得改当前绑定，降级/禁用不级联删除业务事实，备份保留历史依赖定义。正式 SQL 尚未生成或执行。

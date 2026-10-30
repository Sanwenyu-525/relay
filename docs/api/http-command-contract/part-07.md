# HTTP 与应用命令契约：分册 07

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../http-command-contract.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

### 10.93 会话分叉（2026-10-18 源码实现，迁移 0113）

工作区前缀为 `/api/v1/workspaces/{workspace_id}`，沿用本机 API 鉴权。**Breaking Change: No**——新增一个命令与端点，既有会话投影只多一个可空只读字段。迁移与写入 Owner 见[数据库 §102](../../database/physical-design-postgresql/part-05.md#102-0113-会话分叉血缘2026-10-18-源码实现)，界面读法见[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)。

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /assist-sessions/{session_id}/fork` | `ForkAssistSession` | `201` | `{command_id, expected_revision}` | `{session_id, title, revision, updated_at, copied_messages}` |

`session_id` 是**新建的子会话**，不是被分叉的那一条；`links.resource` 指向它。`revision` 恒为 `"0"`（新资源），`copied_messages` 是搬进历史的已完成轮数。**2026-10-24 起没有可搬历史的讨论按 `409 INVALID_TRANSITION` 拒绝**（见下段），因此成功回执里 `copied_messages ≥ 1`；字段仍保留 `minimum: 0` 只为兼容历史回执。分叉是唯一新建会话行的行内命令，因此与 `Create*` 同为 `201`，不是对源会话的改写。

**源会话一行都不改。** `expected_revision` 仍然核对（陈旧基线返回 `409 REVISION_CONFLICT` 并带出 `actual_revision`，界面只重读、不自动重发），但它只用于挡住「界面看的是旧事实就按下分叉」；成功分叉**不推进**源会话的 `revision` 与 `updated_at`。源会话必须对当前 Workspace 可见（跨 Workspace 按 `404 RESOURCE_NOT_FOUND`）、状态为 `ACTIVE`（归档态 `409 INVALID_TRANSITION`，先重开），且没有 `PENDING`/`RUNNING` 消息（在途 `409 INVALID_TRANSITION`；正在生成的那一轮既不该进历史，也不该让子会话从半截开始）。**还必须至少有一轮可搬历史**：可搬历史为空（`status='COMPLETED' AND content IS NOT NULL` 一条都没有）时 `409 INVALID_TRANSITION`「这段讨论还没有可搬的历史，不能分叉。」——判据在插子会话之前读，被拒的分叉不落子会话行、不留回执（2026-10-24，用户截图：空会话被分叉成第二条空会话，点开只剩欢迎空态）。

**子会话的行形状。** 会话身份整行搬运：`workspace_id`、`project_id`、`task_id`、`conversation_mode`、`assistant_profile_id/revision/role_snapshot`、`remember`、`working_resource_id` 与源行一致；`status='ACTIVE'`、`revision=0`、`pinned_at`/`unread_at` 一律 `NULL`（导航偏好不继承）；`last_message_at` 按「消息落库即活动」这一口径推进到复制完成时刻——子会话确实刚写进历史，`2026-10-24` 起历史必非空，因此它不再存在「为 NULL」的分支（此前文档写的「一律 NULL」与实现不符，已更正）；`forked_from_session_id` 写入源会话 ID。来源是**一次性写入的历史元数据**：改名、置顶、未读、归档、重开都不会改写它，它也不参与任何准入判定。

**复制的是历史输入。** 只搬 `status='COMPLETED' AND content IS NOT NULL` 的消息，按子会话从 `seq=1` 重新编号（`UNIQUE (session_id, seq)`）；正文、`sources`、`skill_snapshot/skill_input/skill_output`、`method_*`、`learning_record_disabled` 与 `created_at` 原样保留，行 ID 全部新生成。图片附件逐张复制成新行（同一 `message_id` 绑定、内容与哈希字节不变，`bytea` 在库内搬运）。以下**不搬**：`assist_proposals`（接受一次会写业务事实，同一条提案不能在两条会话里各接受一次）；`provider_request_id`、usage 四列、`worker_id`、`cancel_requested`、`error_code`、`provider_error_kind`、`model_attempt_state`（子会话没有发生过那次外呼，留着就是伪造）；`model_selection_snapshot` 随尝试状态一起去掉——0098 要求两列成对非空，而复制后的历史一律 `COMPLETED`、不会再进生成路径，排队期的模型身份对子会话没有读方。

**标题由服务端排号。** 末位是 `（n）` 或半角 `(n)` 时加一，否则追加 `（1）`；编号跟着**被分叉那一条自己的标题**走，所以同一源会话分两次都得到 `（1）`（标题不是唯一键），分叉一条 `（1）` 得到的是 `（2）`。总长仍守 `TEXT_LIMITS.title=200`：超长时截正文前缀、保留完整编号，并按完整码点退让（不切坏 emoji）。

**幂等。** 同一 `command_id` + 同载荷重放返回原结果并附 `command-replayed: true`，不新建第二条子会话、不新增回执；同一 ID 换 `expected_revision` 返回 `409 COMMAND_ID_REUSED`。幂等作用域是 Workspace，与其它会话行内命令一致。

**投影。** `GET /assist-sessions`（含默认列表、`status=ARCHIVED|ALL`）与 `GET /assist-sessions/{session_id}` 新增只读字段 `forked_from_session_id`（`uuid | null`），只解释标题里的编号从哪来，不改变列表顺序或任何判定。

**证据（如实分层）。** 真实 PostgreSQL：`assist-session-controls.integration.test.ts` **22/22**（分叉 5 条：201 落库与源行零改动、历史/附件复制与提案不复制、同命令重放不产生第二条、在途/归档/陈旧修订/跨 Workspace 四道栅栏、标题排号与 200 上限、0113 列形状与列表投影）；入口栅栏单测 **6/6**；工作台 `sessionRowMenu.spec.ts` **19/19**。真实 Windows 窗口未点验。

### 10.94 会话物理删除（2026-10-18 源码实现，迁移 0116）

工作区前缀与鉴权沿用既有约定。**Breaking Change: No**——新增一个命令与端点，不改既有命令、投影或失败码；删除后的读入口按「不存在」处理。删除边界与取舍归 [ADR-027](../../decisions/ADR-027-session-physical-delete.md)，授权形状见[数据库 §103](../../database/physical-design-postgresql/part-05.md#103-0116-会话物理删除授权2026-10-18-源码实现)。

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /assist-sessions/{session_id}/delete` | `DeleteAssistSession` | `200` | `{command_id, expected_revision}` | `{session_id, revision, deleted_messages, deleted_attachments, deleted_at}` |

**不可撤销。** 这是全项目唯一删除会话的命令：没有回收站，没有「取消删除」反向命令，误删与重启都无法找回。界面必须先弹确认框、逐字写明不可恢复，**不给撤销条**；归档仍是可撤销通道，两者不合并成一个「移除」动作。

**删什么。** 只删会话自有账本，按子 → 父顺序在同一短事务内显式执行（不依赖 `ON DELETE CASCADE`）：消息、提案、附件（`bytea` 内容随行消失）、生成中预览、会话工具调用、模型选择、自然语言状态维护请求与其变更、未进入组合检查的影响检查与候选分组、辅助模型调用计量与已到期供应商冷却、会话 diff 基线，最后是会话行本身。`conversation_diff_baselines.session_id` 是普通列（0097 无外键），必须显式删，否则留下悬空账本。

**不删什么（阻断）。** 命令先查阻断项，命中任意一项即整条拒绝、零删除，返回 `409 SESSION_DELETE_BLOCKED`，`conflict.blocking_reasons` 逐项列出：

| 代码 | 含义 |
|---|---|
| `FORK_CHILDREN` | 存在以本会话为来源的分叉会话 |
| `TASK_ACCEPTANCE_CITED` | Task 验收观察把本会话的消息作为来源 |
| `HYPOTHESIS_CITED` | 项目假设版本把本会话的消息作为来源 |
| `WORK_SEGMENT_CITED` | 工作片段把本会话的消息作为来源 |
| `BLUEPRINT_CITED` | 项目蓝图提案把本会话的消息作为来源 |
| `EXECUTION_REQUESTS` | 本会话发起过执行请求 |
| `LEARNING_RECORDS` | 本会话有学习记录 |
| `ARTIFACT_IMPACT_COMMITTED` | 本会话的影响检查已进入组合检查 |
| `PROVIDER_COOLDOWN_ACTIVE` | 本会话的模型调用仍在未到期的供应商冷却里 |

另有与归档共用的在途栅栏：存在 `PENDING`/`RUNNING` 消息时返回 `409 INVALID_TRANSITION`。跨 Workspace 的会话按 `404 RESOURCE_NOT_FOUND`。

**并发与幂等。** 行锁 + `expected_revision` CAS 先于判定：陈旧基线返回 `409 REVISION_CONFLICT` 并带出 `actual_revision`，一行不动。删除成功后会话行已不存在，重放**不能**靠再读会话判定，而是读 `command_receipts`：同 `command_id` 同载荷返回原结果并附 `command-replayed: true`，换载荷返回 `409 COMMAND_ID_REUSED`。

**审计。** 命令回执之外，在同一事务写一条 append-only 的 `activity_records`（`event_type='ASSIST_SESSION_DELETED'`）。`fact_refs` 只记会话 ID、删除前修订与删除行数，不复制标题或正文——用户要求删除之后，审计不成为第二份保存。

**证据（如实分层）。** 真实 PostgreSQL：`assist-session-delete.integration.test.ts` **9/9**（账本删净且无悬空基线、行消失后回执重放、换载荷复用 ID 被拒、陈旧基线零删除、在途消息栅栏、分叉与学习记录两类阻断、跨 Workspace 不可见、0116 授权不外溢、删除后无只读恢复入口）；工作台 `sessionRowMenu.spec.ts` **19/19**（新增四条：确认与取消、确认后行从活跃区消失且无撤销条、阻断项留在确认框、回执不明锁死确认键）；`tsc --noEmit` 两侧对本片文件干净。真实 WebView2 窗口与多 DPI 下确认框的焦点与观感未复核。

### 10.94 周期定时启动任务（2026-10-18 源码实现，迁移 0115）

| 方法 | 路径（前缀 `/api/v1/workspaces/{workspace_id}`） | 命令 | 成功 | 请求体 | 回执 `result` |
|---|---|---|---|---|---|
| POST | `/projects/{project_id}/scheduled-tasks` | `CreateScheduledTask` | `201` | `{command_id, confirmed:true, title, template, repeat_rule, timezone, local_time, first_local_date, max_runs, authorization_expires_at, execution?}` | `{scheduled_task_id, project_id, status, revision, schedule_generation, next_due_at}` |
| POST | `/scheduled-tasks/{id}/edits` | `EditScheduledTask` | `200` | 同上 + `expected_revision, reason` | 同上 |
| POST | `/scheduled-tasks/{id}/status-changes` | `SetScheduledTaskStatus` | `200` | `{command_id, expected_revision, status, reason}` | 同上 |
| POST | `/scheduled-task-occurrences/{id}/resolutions` | `ResolveScheduledTaskOccurrence` | `200` | `{command_id, expected_revision, action:'RETRY'\|'DISMISS', reason}` | `{occurrence_id, scheduled_task_id, status, revision}` |

只读：`GET /scheduled-tasks?project_id=`、`GET /scheduled-tasks/{id}`（含最近 20 次触发与项目投影）。

**「定时任务」是模板 + 重复规则 + 提前授权，不是对某个 Task 的重复执行。** 每次触发新建一个 Task，再走原 `CreateTask → MarkTaskReady → DelegateTask`。Task 跑完即 `DONE`，终态不可复活，所以「周期」只能表现为「每次新建」；这也意味着重复执行的是**这套设定**，不是同一个任务。取舍与代价见 [ADR-026](../../decisions/ADR-026-scheduled-task-autostart.md)。

**模板在创建时就按 `CreateTask` 的口径校验。** `template` 的形状与创建任务一致（`task_title`、`objective`、`mode`、`expected_outputs`、`criteria[]`），创建命令内部调用 `prepareTaskCreation` 与 `checkDeclaredOutputs`，非法模板当场 `422`，不会等到首次触发才失败。`mode` 缺省 `ME`，`expected_outputs` 缺省 `{}`；`DELEGATE_AI` 仍按原口径 `CAPABILITY_DISABLED`。

**重复规则只有两种。** `{kind:'DAILY', interval_days:1..30}` 与 `{kind:'WEEKLY', weekdays:[1..7]}`（1=周一，去重后升序）。不做 cron 表达式、月/年规则、多时区混排。

**时刻是墙钟，不是固定偏移。** 请求传 `local_time`（`HH:MM`）+ `first_local_date`（`YYYY-MM-DD`）+ `timezone`，服务端算出绝对时刻并落 `first_run_at`/`next_due_at`。跨夏令时的「每天 09:00」仍是 09:00：春跳不存在的时刻顺延 +1 小时，秋回重复的时刻取较早一次。`first_local_date` 必须解析出严格晚于当前时刻的首次触发，否则 `422`。

秋回规则也适用于半小时回拨（如 `Australia/Lord_Howe`）；2026-10-29 修复候选偏移仅按整小时枚举而误选较晚一次的问题，改为读取目标日期前后实际时区偏移。Breaking Change: No；请求、响应及数据库结构不变，已保存的触发时刻不批量重算。

**授权一次性确认，到点只做准入。** `confirmed` 必须为 `true`；`max_runs` 取 1–100；`authorization_expires_at` 必须是带 `Z` 或偏移量的实际时刻，且在未来 90 天内（**这是对 N06 24 小时上限的有意偏离**，理由见 ADR-026）。触发不授予新权限：`delegateTask` 在**原命令事务内**核对触发发生身份、计划状态、代次、有效期与预算，未通过即拒绝且效果不落库。

**准入以 Task 终态为准，不是 Run 是否活跃。** Run 完成后 Task 停在 `WAITING` 等人工验收；此时本轮记 `SKIPPED`（`reason='PREVIOUS_TASK_NOT_ACCEPTED'`），不自动代答验收，也不堆出第二个待验收任务。跳过的时段不消耗 `max_runs`——预算是「最多真正启动多少次」，不是「过了多少个时段」。

**错过不自动执行。** 应用关闭期间错过的时段记 `BLOCKED`（`reason='MISSED'`，`missed=true`），**不建 Task**；用户在详情页选择「补跑一次」才把这条改回 `DISPATCHING` 重新准入。与 N05「最多形成一次待处理」同口径，区别是 N05 只形成待处理，本能力补跑后会真的启动。**补跑前准入（2026-10-25）**：补跑命令在事务内先做快照准入——计划已暂停/停用/到期、预算耗尽、项目归档、规则代次已变或上一轮未验收时返回 `409 INVALID_TRANSITION`，不重开发生、不建 Task。

**到期与预算耗尽不是静默停止。** 两者都把计划置 `EXPIRED` 并留一条 `BLOCKED` 触发说明原因；`EXPIRED` 的计划不能直接改回 `ENABLED`，须先通过编辑延长授权。

**执行范围在触发时冻结。** `execution`（资料引用 / 固定读取 / 工具循环 / 范围授权 / 原会话方法）与任务链共用同一份词表；用户选的只是意图，真正冻结发生在触发时、绑定到当次新建的 Task 上，并写入 occurrence 的 `frozen_execution`。依据漂移（连接停用、资料版本变化、范围授权到期）则这一次 `BLOCKED`，**不静默降级为无工具执行**。`scope_grant.expires_at` 被夹到计划授权到期时刻。

**任务模板与执行意图随发生落库冻结（2026-10-25，迁移 0138）。** occurrence 建立时把当时的 `template` 与 `execution_input` 冻结为 `frozen_template` / `frozen_execution_input`；分发与补跑一律使用冻结副本——分发中断后编辑模板，未提交的 `CreateTask` 不会读到新模板，编辑只影响未来时段；已提交过的 `CreateTask` 仍按原回执重放（见幂等段）。迁移前的存量发生保持空副本，分发回落计划当前值，不回填、不重算。

**幂等。** 四个命令都是 `command_id` 幂等，作用域为 Workspace；同一 ID 换载荷返回 `409 COMMAND_ID_REUSED`。触发链路的三步命令身份在 occurrence 落库时预生成，崩溃后重跑靠回执重放，不会重复建 Task；`expected_task_revision` 只取自前一步回执，读库重算会改变 `payload_hash` 并被判成 ID 复用。

**并发。** `DISPATCHING` 是租约：调度器用 `FOR UPDATE SKIP LOCKED` 取到期行、插入 occurrence 后，再按「待分发」逐个抢租约执行。同一时段有 `UNIQUE (scheduled_task_id, schedule_generation, sequence)` 与三个命令列的唯一约束兜底。与 N06 一致，本片假设单 API 进程运行调度器；多实例不在承诺范围。

**待处理投影。** `GET /attention/interventions` 与 `POST /attention/notifications/claim` 新增 `kind='SCHEDULED_TASK_BLOCKED'`，`item_key` 前缀 `scheduled-task:`，`target_url` 为 `/scheduled-tasks/{id}`，`change_key` 取 occurrence 的 `revision`。不新开第二条轮询通道，也不与 N05 提醒的去重键混用。

**一个已知的中间态（2026-10-25 收窄）。** `CreateTask` 尚未提交时，分发先做一次快照准入：计划已暂停/停用/到期、预算耗尽、项目归档、规则代次已变或上一轮未验收的触发**不建 Task**，直接记 `BLOCKED`（reason 取 `PLAN_NOT_ENABLED` / `AUTHORIZATION_EXPIRED` / `BUDGET_EXHAUSTED` / `PROJECT_ARCHIVED` / `SCHEDULE_GENERATION_STALE` / `PREVIOUS_TASK_NOT_ACCEPTED` / `EXECUTION_SCOPE_DRIFT`）。中间态只保留给快照准入之后、Delegate 原事务准入之前的并发窗口（或 `CreateTask` 已提交后的恢复分发）：此时会留下一个已经 `READY` 但从未启动的 Task，同时该次触发记 `BLOCKED` 并带原因。这是刻意的：不删除已落库的任务，也不假装它没发生——用户可以在任务列表里直接处理或取消它。

**证据（如实分层）。** 见[测试计划 §37](../../testing/verification-plan/part-07.md#37-周期定时启动任务验收规格2026-10-18)与统一功能验收表。真实 Windows 窗口、安装态与多实例并发未验。

### 10.95 撤销项目归档（2026-10-18 源码实现，迁移无）

| 端点 | 命令 | 状态码 | 请求体 | 回执结果 |
|---|---|---|---|---|
| `POST /projects/{project_id}/unarchive` | `UnarchiveProject` | `200` | `{command_id, expected_revision}` | `{project_id, revision, archived_at: null, archive_status: "ACTIVE"}` |

**只写一列。** 撤销把 `projects.archived_at` 写回 `NULL`，不恢复任何下游事实：归档成立的前提本来就没有活动 Task/Run/租约与未结算外部效果，所以撤销只是让既有读侧栅栏重新放行，不补写 Project State、不重开 Task，也不假装归档期间发生过事情。与归档共用 Project 排他锁与 `expected_revision` CAS；陈旧基线 `409 REVISION_CONFLICT` 带出 `actual_revision`。

**已是 ACTIVE 不造修订。** 若读到的 `archived_at` 已是 `NULL`，如实返回当前事实且**不推进** `revision`（与 `reopenAssistSession` 同一口径）；同 `command_id` + 同载荷重放返回原回执并附 `command-replayed: true`，换载荷 `409 COMMAND_ID_REUSED`。跨 Workspace `404 RESOURCE_NOT_FOUND`。

**审计。** 同一事务写 `activity_records`（`event_type='PROJECT_UNARCHIVED'`，`fact_refs` 记原归档时刻与前后修订），`PROJECT_ARCHIVED` 行不改不删。

**界面。** 项目详情的归档按钮单击即发（撤销条替代确认框，工作台 §13.2）：成功后浮层给「已归档这个项目 · 撤销」；撤销用**新的** `command_id` 与归档回执推进后的修订，成功后把项目读回进行中范围并撤掉就地回执。撤销失败升级为停留到关闭的 Notice，并指向「已归档」范围。**Breaking Change: No**。

**证据（如实分层）。** 真实临时 PostgreSQL：`project-archive.integration.test.ts` **14/14**（新增两条：撤销写回 NULL、推进修订、同命令重放、已 ACTIVE 不推进、陈旧基线零写入、活动范围重新放行、两条审计并存；跨 Workspace 404 且仍保持归档）；工作台 `projectArchiveLive.spec.ts` **4/4**（归档单击即发＋撤销发出第二发且修订取回执）与 `listViewCopy.spec.ts` 归档回执用例。真实 Windows 窗口未验。

### 10.96 Workspace 默认工作目录（2026-10-19 后端实现）

下列路径均位于 `/workspaces/{workspace_id}` 下，**Breaking Change: No**。

| 端点 | 命令 / 结果 |
|---|---|
| `GET /default-working-directory` | 只读 `{resource_id, canonical_root, display_name, write_tier, default_write_tier, status, reason, revision}`；`status` 为 `UNSET / READY / UNAVAILABLE` |
| `POST /default-working-directory` | `SetWorkspaceDefaultDirectory`，请求 `{command_id, expected_revision, resource_id}`，200 回执 `{workspace_id, resource_id, revision}` |
| `POST /default-working-directory/clear` | `ClearWorkspaceDefaultDirectory`，请求 `{command_id, expected_revision}`，200 回执同上，`resource_id=null` |
| `POST /default-write-tier` | `SetWorkspaceDefaultWriteTier`，请求 `{command_id, expected_revision, default_write_tier}`，200 回执 `{workspace_id, default_write_tier, revision}`；档位语义见 §10.110 |

未设置时修订为 `0`，其余投影字段为 null；首次设置或清除后修订递增，清除不删除配置行、不重置修订。设置只引用已经登记的受管资源，不调用 Open、不建立项目/连接/策略、不扩大权限。资源跨 Workspace 返回 404；停用、项目归档、活动重叠根、真实目录不可访问或路径身份变化返回 409，保留旧设置。陈旧修订返回 `409 REVISION_CONFLICT`；**例外**：请求值已等于当前值（同一 `resource_id`，或两者都为 `null`）时按已达成处理，返回当前事实且不改修订——打开目录可能已顺手登记同一个值，重复声明同一件事不算冲突（2026-10-19）。同命令同载荷返回原回执，即使后来已清除或目录已失效；同命令异载荷返回 `409 COMMAND_ID_REUSED`。并发首次请求复用原回执，并发不同命令以配置修订收敛。丢响应时按原 command_id 核对，不换 ID 重发。

`GET` 不修复配置；失效时返回 `UNAVAILABLE` 与原因 `RESOURCE_UNAVAILABLE / RESOURCE_DISABLED / PROJECT_ARCHIVED / RESOURCE_OVERLAP / DIRECTORY_UNAVAILABLE / DIRECTORY_IDENTITY_CHANGED`。可见资源仍返回原目录与档位；缺本目录档位记录时投影为 `READ_ONLY`，不因此创建任何权限事实，实际动作仍经原 Gateway 准入。

`POST /working-directories/open` 在 `READY` 且工作区**尚无**默认目录时，于同一事务内把该资源登记为默认（修订从 `0` 起递增），因此「打开过一次目录」即完成配置，不必再去设置页操作；已有默认目录时打开别的目录不覆盖它，`AMBIGUOUS` / `NOT_READY` 一律不登记（2026-10-19 用户要求「基础能力不该让开发者自己配置」）。

`CreateAssistSession` 仅对无 Project/Task 的普通 AGENT 在同一创建事务内继承有效默认目录，并保存资源所属 Project 与来源；显式 Project/Task、ASSISTANT、LEARNING 不继承。失效默认不阻断普通会话创建，也不猜其他根。创建命令回执保持既有形状；`GET /assist-sessions/{id}?include_context=true` 的 `context.working_directory` 增加可空 `source`：`USER_PICKED / WORKSPACE_DEFAULT / null`（历史未知）。显式绑定改为 USER_PICKED，分叉保留原来源，重设或清除默认不改历史会话。

前端设置入口（设置 › 基本设置）、建会话后的上下文读回与来源标签已接入；该增量不代表日常桌面配置流程整体交付，安装态、真实 Windows/WebView2 与真实 Provider 仍未验。相关运行结果只归统一功能验收表。

### 10.97 资料归档与记忆规则停用的反向命令（2026-10-19 后端实现）

均在 `/workspaces/{workspace_id}` 下，请求 `{command_id, expected_revision}`，返回 200 命令信封。**Breaking Change: No**；无数据库迁移。

| 端点 | 命令 | result |
|---|---|---|
| `POST /knowledge/{id}/unarchive` | `UnarchiveKnowledge` | `{knowledge_id, revision, status: "ACTIVE"}` |
| `POST /memories/{id}/reactivate` | `ReactivateMemory` | `{memory_id, revision, status: "ACTIVE"}` |
| `POST /rules/{id}/reactivate` | `ReactivateRule` | `{rule_id, revision, status: "ACTIVE"}` |

这些是[工作台 §13.2](../../frontend/workbench-design/part-03.md#132-危险操作的两条通道2026-10-18)的前向补偿命令：调用者使用新 command_id 与正向回执的 revision，不能重用归档/停用命令 ID。命令只将 ARCHIVED/RETIRED 恢复为 ACTIVE，递增根 revision 与 updated_at，不改正文、当前版本指针、确认主体或记忆有效期；不删除原命令回执和已有待核对候选，也不修改 Decision 或恢复任何外部权限。Memory 即使恢复 ACTIVE，已过期版本仍按原过滤规则排除；不可用来源也不会因恢复状态变得可读。

共用 Information 写入口，先取 Workspace authority UPDATE、按原根与 Project 归档栅栏核对。跨 Workspace 404，Project 已归档 409，陈旧 expected_revision 为 `409 REVISION_CONFLICT`。同命令同载荷及并发首次请求返回原回执，即使随后又被停用；同命令异载荷返回 `409 COMMAND_ID_REUSED`。已 ACTIVE 且修订匹配则返回当前事实，不递增任何修订、不重复审计。

成功变更与命令回执、审计同一事务提交。Knowledge/Memory 恢复递增 context_revision；Rule 恢复同时递增 rule_revision/context_revision，既有 Run 下一动作仍按原栅栏核对，不回退已发生效果。审计事件为 `KNOWLEDGE_UNARCHIVED / MEMORY_REACTIVATED / RULE_REACTIVATED`，只记录身份、版本、状态和前后修订。

本节最初仅交付后端，撤销条与永久恢复入口随后于同日接续（见下）；连接/资源停用的反向命令、权限撤销及 Decision 替代不在本片范围。运行成绩归统一功能验收表。

**2026-10-19 前端接续**：`KnowledgeView` 已接三条命令——正向归档/停用成功且回执核对通过后给「已归档资料 / 已停用记忆 / 已停用规则 · 撤销」，撤销用新 `command_id` 与正向回执的 `revision`；同一批反向命令也作为永久恢复入口，在对象详情里用**当次读回**的 `revision` 提交。客户端对回执核对 `command_id`、目标 ID、`status:"ACTIVE"` 与 `revision ≥ expected_revision` 四项，任一项不成立按「结果不明」处理，不承诺成功。

### 10.98 长期记忆有效状态与筛选（2026-10-19 后端接续）

`GET /workspaces/{workspace_id}/memories` 新增可选查询参数 `effective_status=ALL|ACTIVE|EXPIRED|RETIRED`，缺省 ALL。可与既有 `project_id` 组合：项目范围仍包含 Workspace 全局记忆与指定 Project，不含同 Workspace 的其他 Project；跨 Workspace 的 Project 参数返回 404。非法枚举值返回 422，其余信息类型不接该参数。响应继续为原数组，不引入新分页/信封形状。

列表和 `GET /memories/{id}` 的对象增加只读 `effective_status`，原持久 `status` 仍为 ACTIVE/RETIRED：

| effective_status | 数据库读取时的判定 |
|---|---|
| RETIRED | 根状态 RETIRED，优先于有效期 |
| EXPIRED | 根未停用，当前版本 expires_at 非空且小于或等于数据库 now() |
| ACTIVE | 根未停用，当前版本无到期时间或 expires_at 大于数据库 now() |

根状态、当前版本正文/确认/到期字段、有效状态与筛选在同一 SQL 快照读取，时间口径与既有搜索和 Context 的过期排除一致。时间流逝只影响投影，不写根状态、不递增任何 revision、不产生版本或审计；默认全部列表仍可用于管理和永久恢复。历史 revisions 不增加动态状态，保留不可变内容。

恢复过期 Memory 只恢复持久状态，effective_status 仍为 EXPIRED；续期或取消到期必须通过既有 AddMemoryRevision，明确确认并产生新版本。ACTIVE 只表示当前生命周期与有效期符合，不保证项目/权限可用或必定进入模型 Context；读取与选取仍按原作用域和权限核对。

**Breaking Change: No**。新增可选参数和响应字段，旧列表默认行为与原字段保持；无 migration。前端状态呈现与筛选已接线（[工作台 §13.3](../../frontend/workbench-design/part-03.md#133-长期记忆状态与筛选2026-10-19已确认前端已接)），真实浏览器与 Windows 未验，运行结果只归统一验收表。

### 10.99 长短期记忆接口（2026-10-19）
均位于 `/workspaces/{workspace_id}`，**Breaking Change: No**。新增端点；原消息、Memory CRUD 与历史接口保留。命令遵循原 command_id 回执与同 ID 异载荷 409 协议。

| 端点 | 请求与结果 |
|---|---|
| `GET /memory-settings` | `{workspace_id, revision, recall_enabled, automatic_compaction}`；缺配置为修订0、两个开关 true，GET 零写入 |
| `POST /memory-settings` | `{command_id, expected_revision, recall_enabled, automatic_compaction}` → 200 同形结果；修订 CAS |
| `POST /assist-sessions/{session_id}/messages/{message_id}/memories` | `{command_id, expected_session_revision, content_sha256, project_id, title, text, confirmed:true, expires_at?}` → 201 原 CreateMemory 结果；原消息须 completed、正文 hash 匹配；范围为全局 null 或原会话 Project，跨范围404 |
| `GET /memories/{id}/provenance` | `{memory_id,sources:[{memory_version,session_id,message_id,content_sha256}]}`；明确保存的不可变来源，手工创建可为空 |
| `GET /assist-sessions/{id}/memory` | `{session_id,session_revision,revision,remember,cleared_through_seq,checkpoint,requests}`，no-store；checkpoint 含 id/available/through_seq/summary/model_call_id/created_at/source_message_ids/sources，失效时 summary=null、足迹为空；requests 最近20条，仅公开状态/错误/控制/覆盖边界/调用身份/时刻 |
| `POST /assist-sessions/{id}/memory/compact` | `{command_id,expected_revision}`（会话修订）→ 202 `{session_id,request_id,status:"PENDING"}`；回执只表示受理，完成看 GET；有活动整理时复用请求，不产生平行调用 |
| `POST /assist-sessions/{id}/memory/requests/{request_id}/cancel` | `{command_id}` → 200 `{session_id,request_id,status,cancel_requested}`；PENDING 直接 CANCELLED，RUNNING 仅持久取消意图，安全结算前仍在运行 |
| `POST /assist-sessions/{id}/memory/clear` | `{command_id,expected_revision,expected_session_revision}` → 200 `{session_id,revision,session_revision,remember,cleared_through_seq}`；expected_revision 是工作窗口修订 |
| `POST /assist-sessions/{id}/memory/remember` | 同 clear 加 `remember:boolean`；每次控制都建立新窗口边界，实际切换时会话修订也递增；false 只发送当轮用户消息，不召回长期记忆；重新开启不吸收关闭期间轮次 |
| `GET /assist-sessions/{id}/messages/{message_id}/memory` | `{session_id,message_id,recorded,available,checkpoint_id,sources}`；读取本轮直接与传递使用足迹，重检后只返回安全来源身份，失效内容不回显 |

原 `POST /assist-sessions/{session_id}/chat-commands` 现接 `/compact` 与 `/压缩`，202 信封 result 为 `{kind:"MEMORY_COMPACTION",system:"compact",session_id,request_id,status:"PENDING"}`，沿同一 RequestMemoryCompaction Owner 与回执；无 expected_revision 的文本命令在会话锁内决定当前基线，重放不重新猜基线。原 /clear 与 /new 继续表示新建会话，不改成清除工作窗口。菜单选择/解析本身仍不执行动作，前端需接线后发送才生效。

短期写控制只支持有效 AGENT 会话，归档 Project/会话、跨 Workspace、旧修订或在途消息/整理分别按原404/409栅栏处理；手动整理需先等待或停止在途消息，过短历史409。清除只改变模型后续工作窗口，不删聊天/工具历史，不删除长期事实。长期来源引用阻止物理删除源会话；活动整理同样阻止删除，完成后的短期子记录可随会话清理。

已受理但尚未领取的整理，如果会话/Project 随后归档，Worker 以 `FAILED/MEMORY_SCOPE_CHANGED` 收敛且不调用模型，不让无效范围的 PENDING 请求永久挡住管理；该整理仍可通过取消命令提前收敛。

普通聊天自动召回最多3条、合计8000字符，与手工资料合计最多20来源；仅同 Workspace 全局与当前 Project、当前有效已确认版本。按有界字面匹配排序，零匹配时近期回退，消息 sources 附 `selection=AUTO_MEMORY`、`selection_basis=LITERAL_MATCH|RECENT_CONFIRMED`，不是语义向量召回。2026-10-30 修正：中英文混合查询按文字边界分词，显式来源在候选限制前排除，避免去重耗尽候选。关闭或来源失效时，历史自动来源与依赖该来源的旧摘要/答复不能匿名回流。

2026-10-30 压缩策略：有冻结有效调用预算 B 时，以与端口相同的 UTF-8 字节/3 估算，工作输入上限为 `floor(B × 0.75) × 3` 字节，为提示、工具及输出预留余量；旧摘要＋已结算增量达到该上限的 80% 时申请自动整理，不再仅因达到32条消息触发。保留最近8条原文，在完整轮次边界建立检查点；整理输入与普通生成最终组装均使用同一工作上限，真实端口仍单独检查完整请求及输出预算。B 取冻结调用预算（包含已知 Provider 容量限制），不直接把所选档位冒充模型窗口；无真实模型快照时优先使用会话档位，读不到会话才回退工作区默认；无任何预算的旧 Mock 路径保留32条/48000字节触发及128000字节保护。参数属于工程估算，不能证明 Provider 物理窗口、精确 tokenizer 或缓存收益。失败保留旧检查点和原文，同一覆盖边界自动失败不立即反复重试，可显式重新整理。typed errors 包括 `MEMORY_CONTEXT_TOO_LARGE / MEMORY_HISTORY_LIMIT / MEMORY_SUMMARY_INVALID / MEMORY_PUBLICATION_REJECTED / MEMORY_SOURCE_CHANGED / MEMORY_UNRESOLVED_TOOL_STATE / MEMORY_WORKER_LOST`，不可作为成功或自动换模型依据。请求/响应与档位整数不变，Breaking Change: No，无 migration。

整理请求冻结工作模型身份，使用既有 model_calls 与会话预算；call 以最后一条被覆盖的真实 assistant 消息作 ASSIST 计量锚点，整理请求的 model_call_id 区分用途，不修改原消息 usage。摘要严格 JSON `{summary}`，成功提交后才更换窗口；租约、取消、来源、权限/上下文/配置及窗口修订变化拒收迟到结果。未结算工具链不整理、不重放工具。真实 Provider 摘要质量、模型窗口与缓存效果须单独验证。

2026-10-30 分批接续：准备整理从有效检查点之后读取至多1001条增量，以完整已完成助手轮次为边界，保留至少8条近期原文；按旧摘要＋本批 JSON 信封估算选择不超过工作输入容量95%的前缀，另留序列化/标记余量，Worker 仍检查最终信封。增量页满也会提前申请整理，防止行数不断累积。每个请求只完成一批；自动生成链把原消息保持为 PENDING，在后续 tick 逐批推进到压力回落；手动受理的 COMPLETED 只表示该请求冻结的覆盖范围完成，不表示 Task 完成或全部历史清空。单个完整轮次仍装不下时明确返回 MEMORY_COMPACTION_INPUT_TOO_LARGE，不静默截断。

批次游标与父检查点身份放入现有请求的内部冻结 JSON，来源 hash 绑定本批确切增量，旧无游标请求按原规则执行。内部检查点以父链追溯先前前缀；`GET /assist-sessions/{id}/memory` 的 `source_message_ids` 继续返回累计覆盖身份，失效时仍隐藏正文和足迹。父检查点失效或窗口变化拒收旧增量请求，失败保留已提交窗口与原文。清除窗口仅查询最后历史序号，不再因累计正文超过10000条而无法清除。仍有过大的未整理活跃窗口保护，优先通过分批整理恢复，不把查询页截断冒充完整工作记忆。Breaking Change: No；无新端点、请求字段或 migration。

最终资料注入后的文本压力同样可触发整理；普通 Agent 工具循环按现有上下文构成统计检查系统、词表、历史、插话及已结算工具结果。接近工作容量时关闭新工具声明并请求收尾，硬超限则在外呼前以 MEMORY_CONTEXT_TOO_LARGE 收口，保留已执行工具账本；不在活动协议中压缩、删除或重放工具。统计不覆盖图片的真实图像 token，真实端口与 Provider 校验仍有效。无冻结快照时容量优先读取会话档位，无法读取会话才回退工作区默认。

有效预算过小、连保留段都超出工作容量时，会在创建 model_call 前以既有 MEMORY_CONTEXT_TOO_LARGE 收口；因此部分原先由端口返回 MODEL_BUDGET_EXHAUSTED 的输入现在更早被拒绝。客户端继续显示原记忆处理错误，不把它视为 Provider 故障或自动重试依据。

2026-10-30 调用诊断修正：压缩端口返回不受支持的 TOOL_CALLS 时，整理仍以 MEMORY_SUMMARY_INVALID 失败且不发布检查点，其关联 model_call 改记 FAILED / MEMORY_TOOL_CALLS_UNSUPPORTED，并保留请求身份和已知用量；不执行工具。Breaking Change: No，HTTP 结构和数据库不变。

### 10.100 模型端口的图片输入能力投影（2026-10-19）

**Breaking Change: No（`GET /model-port` 响应新增字段）。** 响应新增 `image_input`，取值 `SUPPORTED | DECLARED | MODEL_LACKS_IMAGE_INPUT | MODEL_NOT_IN_CATALOG | NOT_CONFIGURED | UNKNOWN`，以及 `image_input_source`（`CATALOG | DECLARED | ENV | NONE`）说明这次结论来自哪一层：

| `image_input` | 含义 | 发送图片命令的结果 |
|---|---|---|
| `SUPPORTED` | 模型目录条目明确 `image_input=true`（source `CATALOG`） | 放行 |
| `DECLARED` | 目录无条目，声明表（source `DECLARED`）或 `RELAY_MODEL_IMAGE_INPUT=true`（source `ENV`）声明支持 | 放行 |
| `MODEL_LACKS_IMAGE_INPUT` | 目录条目存在但 `image_input` 非 true（source `CATALOG`），或声明表明确声明不支持（source `DECLARED`） | 422 `VALIDATION_FAILED`，`field=attachment_ids` |
| `MODEL_NOT_IN_CATALOG` | 目录无条目且无任何声明（source `NONE`） | 同上 |
| `NOT_CONFIGURED` | 实例未配置真实模型端口（`provider=fake`） | 同上 |
| `UNKNOWN` | 本次读不到模型目录（数据库不可用） | 未知；闸门届时仍按实际目录裁决 |

**判定四层，顺序不可换**：目录条目 → 声明表 → `RELAY_MODEL_IMAGE_INPUT`（兼容期）→ 拒绝。目录是唯一准绳，人的声明不能把目录判定为不支持的模型改成支持；声明只补「目录里没有这个自建模型」这一处空白。判定实现在 `apps/api/src/application/chat-image-input.ts`，闸门与投影共用同一函数。

**声明端点**（实例级配置，不是业务命令）：

| 端点 | 语义 |
|---|---|
| `GET …/model-capabilities` | `{items:[{provider, source_model_id, image_input, note, declared_at, updated_at}]}` |
| `PUT …/model-capabilities/{provider}/{source_model_id}` | `{image_input, note?}` → 200 同形行。`provider` 仅接受 `openai-compatible`；`note ≤ 500` 字符，超长 422 不截断。同键再写是覆盖（last-writer-wins） |
| `DELETE …/model-capabilities/{provider}/{source_model_id}` | → `{removed: boolean}`。撤销声明回到「未声明」，不是记成「不支持」 |

**为什么没有命令回执**：一次声明没有状态机、没有修订，重发同体必然得到同一状态；回执要保护的是「同一命令是否已生效」的歧义，这里由 GET 直接回答。沿用 `/model-catalog/refresh` 的实例级先例。声明写入后**下一次读取立即生效**，不需要重启进程——这是它相对环境变量的全部价值。

旧服务端不返回 `image_input`/`image_input_source` 时，本仓客户端按 `UNKNOWN`/`NONE` 处理（不提前提示，也不冒充可用）。

验证：纯判定单测 `chat-image-input.test.ts` 5/5（四层优先级、声明压过环境变量、目录压过声明）；真实 PG/HTTP 集成 `model-capabilities.integration.test.ts`（声明前拒绝 → 声明后 `DECLARED` → 撤销回拒绝；声明为不支持压过环境变量；`fake` 与超长 note 422）；`model-port.integration.test.ts` 已同步新字段断言；工作台侧见[工作台 §33.2](../../frontend/workbench-design.md)与 `tests/composerImageAttachments.spec.tsx`、`tests/browser/attachmentHoverPreview.spec.ts`。

### 10.101 连接与权限沿用复制（2026-10-19 后端实现）

**Breaking Change: No（新增端点）。** `POST /projects/:project_id/gateway-settings/copy`，命令 `CopyGatewaySettings`，HTTP 201。

- **Body**：`{ command_id, source_project_id }`（均为 UUID，`additionalProperties: false`）；路径参数 `project_id` 是**目标**项目。
- **行为**：把来源项目登记的受管资源（ACTIVE）、连接（ACTIVE，含 `config` 边界与能力集合）与 ACTIVE 权限策略（**当前生效版本**的 capability/action_type/target_prefix/decision/max_payload_bytes）复制进目标项目，一个命令事务内完成，回执与业务事实同事务提交。文件族策略的 `target_prefix`（canonical_root）依赖同事务里先复制的资源行。
- **判重（跳过并计入 `skipped`）**：资源按 `identity_key`；策略按 capability+action_type+target_prefix；连接按「ACTIVE 且 config 与能力集合都相同」。判重只防用户连点类重复，语义幂等仍由 command_id 回执承担。
- **不复制**：DISABLED/REVOKED 行、策略历史版本；来源项目只读，目标项目已有其它配置不动。
- **Result**（全字符串）：`project_id` / `source_project_id` / `resources_created` / `connections_copied` / `policies_copied` / `skipped`。
- **错误**：`source_project_id === project_id` → 422 `VALIDATION_FAILED`（field=`source_project_id`）；来源项目不存在或不属于同一 Workspace → 404 `RESOURCE_NOT_FOUND`；任一项目已归档 → 既有归档守卫拒绝。资源登记走与 `CreateManagedResource` 同一把 advisory 事务锁（7162,9）串行。
- **动机与边界**：连接/策略按项目登记（`project_id NOT NULL`）是 authority 链与审计的基础，本命令只消掉「每项目重配一遍」的重复劳动，**不**把 `project_id` 改为可空。前端入口归[工作台 §32.10](../../frontend/workbench-design.md)。

验证：真实临时 PG 集成 `test/integration/gateway-settings-copy.integration.test.ts`（复制落库、判重、同 command_id 重放、只复制 ACTIVE、来源=目标与跨 Workspace 拒绝）。前端入口与验证要求见专用提示词（交付时给出）。

### 10.102 排队消息的插话（2026-10-19 源码实现）

2026-10-20 接续，**Breaking Change: No**，路径、请求、回执与 DTO 不变。生成方增加工具派发边界检查：新插话可阻止旧批次尚未执行的工具，模型收到明确的未执行结果后重新判断方向；已执行结果保留。连续插话的时序和理解规则归[运行架构 §2.9](../../architecture/runtime-context/part-02.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)，当前验证成绩归统一验收表，下文验证段保留初版范围。

**Breaking Change: No（新增命令与只读字段）。** `POST /assist-messages/:message_id/steer`，命令 `SteerAssistMessage`，HTTP 200，与 `/cancel` 同形（`{ command_id }` → `{ command_id, committed_at, result: { message_id, status } }`，`status = "STEER_REQUESTED"`）。

- **语义**：把一条**排队中**（`PENDING`）的回复并入当前正在生成的那一轮，而不是等这一轮结束后另起一轮。命令只持久化意图（`assist_messages.steer_requested = true`）；真正消费由生成方在下一次模型请求前完成（`drainSteerRequests`），并把该行收口为 `CANCELLED` + `error_code = 'STEERED'`。上下文位置与上游对照见[运行时上下文 §2.9](../../architecture/runtime-context/part-02.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。
- **受理条件**（任一不满足即拒绝，且**不改**任何状态）：消息存在且属于本 Workspace（否则 404 `RESOURCE_NOT_FOUND`）；会话是普通 `AGENT`（助手档/学习档不排队）；消息 `role=ASSISTANT` 且 `status=PENDING`（`RUNNING` 与终态都拒绝）；会话里确实存在 `RUNNING` 的回复（否则「插话」等于把一条还没开始的消息取消掉）；这条排队消息对应的用户原文没有图片附件（插话通道只送原文）。
- **幂等**：同一 `command_id` 重放拿回原回执；不同 `command_id` 对同一条已置位的行再请求仍返回 `STEER_REQUESTED`（置位本身是幂等的）。
- **迟到窗口**：意图已落库、那一轮恰好结算 → 意图留在行上，这一行随后按普通排队被领取（`claimNextPendingMessage` 在同一句里清零该列），消息照常得到自己的回复，不丢不重复。
- **只读投影**：消息 DTO 新增 `steer_requested: boolean`（`AssistMessageDto`，`strict`）。被消费的 `CANCELLED/STEERED` 行**不出现**在 `GET /assist-sessions/:id/messages` 的结果里，也不进入 `history()`：它不是一轮回复，只是一条没有答案的占位行；用户原文仍作为真实 USER 消息返回。
- **取消仍优先**：`cancel_requested = true` 的行不会被插话消费。
- **与「排队」的关系**：不插话时行为逐字不变——发送仍返回 202，回复按提交顺序逐条生成。

验证：真实临时 PG 集成 `agent-conversation-main-loop.integration.test.ts`（插话在下一轮模型请求前进入上下文、工具结果保留、只多跑一步不另起一轮、排队行收口为 `CANCELLED/STEERED` 且不出现在消息列表、没有在途回复时明确拒绝）；模型消息顺序单测 `assist-steer-context.test.ts` 3/3；工作台侧 `tests/assistQueueSteer.spec.ts` 3/3，交互规则见[工作台 §39](../../frontend/workbench-design/part-13.md#39-排队消息的插话手势2026-10-19-已实施)。

### 10.103 目录打开结果中的 Git 只读投影（2026-10-20 源码实现，迁移 0124）

**Breaking Change: No（结果新增可选字段）。** `POST /working-directories/open` 的 `result` 增加 `git_read: { state, repo_root, detail }`。

- **为什么放在打开目录这一步**：显式选择目录已经表达了对「这个目录」的读取授权（§10.86 的本地读取配置），Git 的 status/diff/log 读的是同一份工作区事实。此前 `planToolLoop` 只在项目里已存在 `GIT_READ` 连接时才给出 Git 工具，等于要求用户为同一个目录再手工登记一次连接与三条策略。
- **自动配置的范围**：只有被打开的目录**就是 Git 仓库根**时，才建立一条 `GIT_READ` 连接（`root_path` = 该根）与 `GIT_STATUS` / `GIT_DIFF` / `GIT_LOG` 三条 `AUTO` 策略，并把这些指针记进 `local_directory_access`（`git_connection_id` 与 `policy_ids` 的 `GIT_*` 键）。stage/commit/push 属于 `GIT_WRITE`，**不**随目录选择开放。
- **子目录不授权**：被打开的目录若是仓库子目录，`state = REPO_ROOT_REQUIRED`，`repo_root` 给出仓库根，**不**建连接也不建策略。理由是可证明的越界：`git log` 在子目录里仍返回整个仓库的历史与分支，按子目录授权等于把父目录的信息一并放出去。界面在原地提供「在仓库根打开」，由用户自己决定是否扩大作用域。
- **不自动恢复**：连接被停用 → `DISABLED`；策略被撤销或改成 `DENY`、或历史上明确设置/撤销过同一根 → `REVIEW_REQUIRED`。这两种都只报告，不新建一条连接绕过。
- **其他状态**：不是仓库（或本机没有可用 git）→ `NOT_A_REPOSITORY`；目录未就绪（归档、停用、歧义）→ `NOT_CHECKED`（「还没看」不能写成「不是仓库」）。
- **工具侧的双根隔离**：`GIT_READ` 的连接匹配改为**精确根**（`connectionRootCovers(..., exactRoot=true)`），文件能力仍按前缀。否则仓库根的连接会覆盖同项目下的子目录资源，而 Git 的输出并不受该子目录限制。
- **回放兼容**：字段为可选，0124 之前写入的 `OpenWorkingDirectory` 回执重放时照样合法；旧服务端不返回该字段时前端落为 `null`（未核对）。
- **数据**：`local_directory_access.git_connection_id` 只是应用的管理指针，不构成授权；准入事实仍是 `gateway_connections` 与 `gateway_permission_policies`。

验证：真实临时 PG 集成 `test/integration/local-directory-access.integration.test.ts` **8/8**：LA-11–LA-15（仓库根自动配置并复用同一条连接、不开放 `GIT_WRITE`、子目录只报仓库根、普通目录如实报告、撤销/停用后不自动恢复），**LA-16 端到端**——真实 `git init` 仓库 + 真实准入链：打开目录后 `GIT_STATUS` 读到真实分支 `main` 与未跟踪 `note.txt`、`GIT_DIFF` 读到真实改动、`gitGetLog` 读到真实提交，撤销 `GIT_DIFF` 策略后换一个 path 再读被权限类错误拒绝（同一 path 再读命中确定性动作身份，属于已结算结果的重放，不作为授权证据）；`tool-loop` 集成 **45/45** 未因「精确根」改动回归（其夹具的连接根与受管根相同）；根匹配单测 `test/unit/conversation-execution.test.ts`。产品行为归[工作台 §41](../../frontend/workbench-design/part-13.md#41-日常操作减负工具状态与高级配置分层2026-10-20-已实施实机未验)。

### 10.104 插件运行时状态（2026-10-20 源码实现）

**Breaking Change: No（新增只读端点）。** `GET /plugins/status`（Workspace 作用域，`Cache-Control: no-store`）。

- **回答什么**：三个内置插件（`computer` / `browser` / `github`）在这台机器上**能不能跑**：`state ∈ READY | NOT_INSTALLED | NOT_PAIRED | NOT_AUTHENTICATED | UNAVAILABLE`，附 `detail` 与可行动的 `remediation`。
- **不回答什么**：项目级授权。那仍由 `GET /projects/:id/connections`（连接登记）与策略版本回答。两者分开，界面才能只说缺的那一步——把「未登录」写成「未授权」会让用户去错地方补配置。
- **来源**：`computer` 读运行时模式与随包可执行文件（`RELAY_COMPUTER_RUNTIME`）；`browser` 复用 Worker 写下的后端投影（`readBrowserBackendState`，六态映射成同一套词表）；`github` 依次执行 `gh --version` 与 `gh auth status`（8 秒超时，显式环境白名单，不转发任何 Relay 进程里的凭据）。
- **2026-10-21 补**：探测用的子进程环境与实际 GitHub 适配器**共用同一份白名单**（`github/gh-env.ts`），含 `APPDATA`/`LOCALAPPDATA`——Windows 上 `gh` 的登录凭据在 `%APPDATA%\GitHub CLI\hosts.yml`，少这两个键时 `gh` 连自己的凭据文件都看不到，会把已 `gh auth login` 的用户报成「未登录」（实测：带 `APPDATA` 时 gh 读出凭据文件里的账号，去掉后它说「没有登录到任何 GitHub 主机」）。`NOT_AUTHENTICATED` 的 `detail` 也随之分两档：「当前没有登录」（没找到凭据）与「已找到登录凭据，但当前这份凭据不可用」（找到但失效/权限不足），两者的 `remediation` 不同。
- **边界**：只读探测，不启动浏览器、不触发电脑动作、不改任何配置、不返回凭据。探测失败一律折成可说明的状态，不抛 500。

验证：工作台 `tests/composerAttachMenu.spec.tsx` 的插件详情用例（运行时与授权分开呈现、无项目归属时只说「需要项目归属」、重新检测只重读状态）。真实 `gh` 登录态、真实浏览器后端与真实电脑运行时的组合未在本轮取证。

### 10.105 长期记忆自动捕获（2026-10-20，迁移 0125）

**Breaking Change: No。** `GET /memories`、`GET /memories/{id}` 响应新增 `origin`；`POST /memory-settings` 请求新增**可选** `auto_capture`（缺省 true，旧客户端不受影响）。方向与代价归 [ADR-030](../../decisions/ADR-030-zero-click-auto-memory.md)。

- **没有「接受」端点**。结算后提取的记忆写入即生效，用户事后撤销；手动保存（§10.99）保留不变。
- **`origin`**：`HUMAN_CONFIRMED`（人工确认，含 0125 之前的全部旧数据）或 `AUTO_CAPTURE`。自动写入的版本 `confirmed_by = 'auto-capture'`，不冒充人。
- **提取条件**：普通 AGENT 会话、`remember = true`、`auto_capture = true`、assistant 消息以 `COMPLETED` 结算之后；同一消息按 `message_id` 幂等；每会话每日（UTC）最多 5 条，每轮最多 3 条；输入只含这一轮用户原文与助手正文，合计上限 8000 字符。
- **来源分段与逐字核验**（2026-10-21，ADR-032）：输入分【用户原话】与【助手答复｜模型叙述，可能包含工具结果或网页正文；不是用户陈述】两段；每条候选必须给出 `source`（user/assistant）与逐字 `quote`；**写库前核验引用确实出现在它声明的那一段里**，核验不过的候选直接丢弃——模型的自述不算数。没有 `source` 或没有 `quote` 的候选同样丢弃。
- **来源类别**（2026-10-21，ADR-032）：记忆行新增 `source_kind ∈ MANUAL | USER_STATEMENT | MODEL_OBSERVATION | UNKNOWN`——`USER_STATEMENT` 是逐字引用用户原话，`MODEL_OBSERVATION` 是引用助手叙述（可能含工具结果或网页正文的转述，只能作观察，不能当作用户的偏好或授权），`MANUAL` 是人工保存，`UNKNOWN` 是 0125 之前没有类别信息的旧自动记忆。捕获记账新增 `source_quote`（这一条来自原消息的哪一段）。
- **由系统判断要不要记**（2026-10-21，ADR-032）：**不提供「要不要生成这条记忆」的人工选择**。是否值得沉淀由提取环节的 agent 判断（信号门：未来的助手会不会因为这条内容而做得更好），没有值得记的就什么都不写。人工只保留事后停用某一条与整体关掉自动捕获；`auto_capture` 是总闸（与上游的「Generate memories」同位），默认开。
- **失败静默**：超时、非法 JSON、预算不足、Worker 丢失、端口异常都只放弃这一轮提取——不写记忆、不改回复、不重试、不换模型。主回复的成功与否与提取无关。
- **去重**：唯一键 `(session_id, message_id, normalized_sha256)`；同范围已有完全相同标题与正文的 ACTIVE 记忆时不再写入；已撤销的同一内容不再提取。不做语义去重，不引入向量库。
- **召回**：条数、字符与来源上限不变（3 条 / 8000 字符 / 20 来源）；排序改为 `literal_match` 优先 → 人工确认先于自动捕获 → 类别（用户原话 → 来源未标注 → 模型观察），同等相关度下 `HUMAN_CONFIRMED` 先于 `AUTO_CAPTURE`。记忆来源的投影带 `origin` 与 `source_kind`，非记忆来源不带。
- **端点**：

| 端点 | 请求与结果 |
|---|---|
| `GET /memory-auto-captures?limit=20` | `{items:[{id, memory_id, session_id, message_id, title, text, origin, source_kind, status, source_sha256, source_quote, created_at, revision}]}`；只列 ACTIVE，按时间倒序，`no-store` |
| `POST /memory-auto-captures/{id}/retire` | `{command_id, expected_revision}` → 200 `{capture_id, memory_id, status:"RETIRED", memory_status:"RETIRED"}`；同一事务内停用 Memory 根、记 `decided_at`/`decided_by`、保留版本与来源 |

- **撤销语义**：停用而非删除，保留审计；已撤销的自动记忆不再参与召回；再次撤销按 409 拒绝；`expected_revision` 落后 409 并回执两个修订。
- **与短期窗口的关系**：提取在结算之后、独立模型调用；不改变 checkpoint、不进入工作窗口、不计入消息 usage。

### 10.106 规则键可由服务端生成（2026-10-20 源码实现）

**Breaking Change: No。** `POST /rules` 请求体的 `rule_key` 由必填改为**可选**；不传时服务端生成稳定唯一键。`POST /rules/{id}/versions` 的 `rule_key` 仍是必填（版本沿同一条规则的身份）。响应形状不变（`{rule_id, revision, version, status}`），回执与幂等语义不变。

- **生成规则**：缺省（或传空串）时取 `rule-<command_id>`。**按 command_id 派生，不用随机值**——同一 command_id 的重放必须算出同一份请求体，否则载荷哈希不一致，幂等重放会被判成 `COMMAND_ID_REUSED`；command_id 全局唯一，因此键也稳定唯一，创建后不再改变。
- **显式给出仍然生效**：值原样落库，不得裁剪或改写。跨范围同键的 HARD 覆盖与冲突判定（`resolveApplicableRules`）只按键比较，与键从哪来无关。
- **前端行为**：工作台在「范围与执行检查（高级）」里留一个可选输入（占位「留空由服务端生成」），普通入口只提交 `statement` 与 `strength`；见[工作台 §42](../../frontend/workbench-design/part-13.md#42-日常减负第二轮资料规则任务起步与记忆呈现2026-10-20-已实施实机未验)。
- **验证**：工作台 `knowledgeSimplify.spec.ts` 4/4（省略时不发 `rule_key`、显式时原样发）；API 侧 `information.integration.test.ts` 末条覆盖「键 = `rule-<command_id>`、同 command_id 重放不新增规则、显式键保留」，**本机无 PG，未运行**。

### 10.107 会话剩余执行与操作工具族（2026-10-20 源码实现）

Breaking Change: **No**。既有会话执行请求及 applications 入口不变；候选 JSON 增加可选 `interaction: BROWSER | COMPUTER`（省略/null 沿原文件与检查路径）。未知值校验失败，不静默丢弃。读取投影保留该字段；现有前端按标题、目标及 `auto_start` 消费，不新增手工建任务步骤。

- interaction 仅表达工具需求，按当前项目 ACTIVE 连接冻结对应 Run 工具；浏览器/电脑连接不要求 root_path。文件、Git、CLI 的根匹配与允许清单不变。
- 不产生隐式 COMPUTER_INPUT / BROWSER_ACTION / BROWSER_COMMIT 范围授权；提交/上传仍经原单动作审批。项目或目录缺失的会话仍不能进入该入口。
- 会话已成功直写后，如仍需检查，候选使用 writes_files=false、file_changes=[] 与原结构化 check；不重复声明已完成修改。ASK 写与 AUTO 删除由原 Run 审批接续。
- 所需能力在登记 Task 前校验。缺连接返回既有 INVALID_TRANSITION 与具体能力原因，不留下无法委托的新 Task；无新增 migration。
- 会话删除预检返回 SESSION_WRITE_REQUIRES_RUN 时尚未创建 Operation，可提交剩余候选。已有 WAITING_APPROVAL / UNKNOWN 必须核对原 Operation，不能换候选绕过。

#### 10.107.1 服务端自动推进与失败原因投影（2026-10-20 第二轮，源码实现）

Breaking Change: **No**。端点、请求体与 `applications` 语义都不变；变化只有两处投影语义。

- **`auto_start` 改为阶段感知**：`decision=PREPARE` 且 `candidate_status=READY` 之外，还要求
  `status ∈ {READY, TASK_PREPARED}`。`FAILED`（推进失败）与 `DELEGATED`（已有 Run）不再为真。
  旧客户端把该字段当「可进入原应用入口」读，语义更严格但方向不变——不会因此多推进一次。
- **推进 Owner 由服务端持有**：`applications` 由 Worker 的
  `conversation-execution-autostart` tick 调用，复用请求行上固定的
  `task_command_id`/`ready_command_id`/`delegate_command_id`。人工再提交同一个
  `request_id` 仍只重放原回执；重复与迟到扫描不产生第二个 Task/Run。
- **失败原因写入原请求**：推进失败时 `status=FAILED`，`clarification.questions[0]` 承载具体原因
  （缺哪个能力/目录，或会话已有在途 Run），`candidate_status` 与 `candidate` 一律保留。
  因此读取投影的 `questions` 在 `PREPARE` + `FAILED` 时也**有内容**，客户端应把它当失败说明
  显示，而不是当成新的澄清问题。补齐前置条件后可用同一 `request_id` 继续（建 Task 阶段的
  状态 CAS 接受从 `FAILED` 前进）。
- 无新增端点、无新增 migration。前端不再需要任何自动推进逻辑；撤除的本设备偏好
  `relay.workbench.planExecution` 是浏览器本地键，不属于 HTTP 契约。


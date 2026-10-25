# PostgreSQL 物理设计：分册 05

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../physical-design-postgresql.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 100. 0111 会话活动排序键（2026-10-18 源码实现）

Migration：`0111_assist_session_last_message.sql`。**只给 `assist_sessions` 增加一列可空 `last_message_at timestamptz NULL`**，不新建表、不回填、不改写既有迁移、不动索引与授权；Breaking Change：**No**。协议归 [HTTP §10.91](../../api/http-command-contract/part-06.md#1091-会话列表的活动排序键2026-10-18-源码实现迁移-0111)，交互归[工作台 §28.1](../../frontend/workbench-design/part-09.md#281-左栏recentworkrail)。

**语义：这段讨论最近一次真正说过话是什么时候。** `NULL` = 还没有任何消息；有值 = 最后一条消息落库或生成结算的时刻。不分发送方——用户说完与 AI 说完都算一次活动，因此失败或取消的那一轮同样上浮。它和 0090 的 `pinned_at`、0104 的 `unread_at` 同一性质：**导航排序键，不是业务事实**，不参与能否发消息、目录绑定、项目归属或任何准入判定。

**为什么不用 `max(assist_messages.updated_at)` 现算，也不复用 `updated_at`。** 列表每次读都要扫消息聚合，且生成中的逐帧预览会把它顶成「一直在动」；`updated_at` 同时是改名／置顶／归档那组命令的更新时间，用它排序会让「只是重命名过一次」的会话跳到活动序最前。上游正好有两派做法：ZCode 在 `saveMessage`/`savePart` 统一调 `touchSession` 并以 `time_updated = max(time_updated, ?)` 保持单调（本列采纳这一口径）；OpenCode 只在用户消息准入时 `Session.touch`，并用自引用 SQL 压制 `$onUpdate`，消息与 part 落库都不 touch 父会话；Codex 分两列——任何追加都推进的 `updated_at` 与只在用户新一轮开口推进的 `recency_at`；DeepSeek Harness 用 `max(header.createdAt, lastPromptAt)` 在内存算。本项目要的是「AI 说完这条也上浮」，取 Codex 的 `updated_at` 那一派而不是 `recency_at` 那一派。

**Owner 与写入路径（两个，都在 `assist-repository.ts`）。** ① `insertMessage` 尾部调 `touchLastMessage`：用户消息与发送时预插的 PENDING ASSISTANT 行都推进同一键，写入取 `greatest(last_message_at, now())`，并发结算不按提交顺序取时间时排序键只前进不回退。② `settleGeneration` 只在 CAS 命中（返回受影响行）后 touch 该行所属会话：迟到的旧 Worker 结算既不收敛消息也不推进排序键。ASSISTANT 行在发送时刻预插，其 `created_at` 早于真正说完的时间，所以结算这一 touch 是「AI 说完才上浮」的依据，不能省。**改名、置顶、未读、归档、重开、绑定项目与绑定目录都不写本列**；生成中的预览表 `assist_message_previews` 也不写——那是会被删除的临时前缀，每条增量都 touch 会让左栏在流式期间持续跳位。租约过期的 `failExpiredLeases` 与 `setCancelRequested` 同样不额外 touch：消息落库时该键已不早于这些事件。

**推进的是排序键，不是并发基线。** 本列的写入**不**推进 `revision`，也**不**推进 `updated_at`。会话行的修订号是上面那组人工控制命令的 CAS 基线；若每条消息都推进修订，在途生成会把置顶/改名打成 409，界面只能反复重读。测试把这条锁住：消息落库后 `revision` 与 `updated_at` 逐字不变。

**排序读法。** `listSessions` 用 `order by pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc`——置顶仍是第一排序键，活动序只在未置顶的组内生效；`coalesce` 让还没说话的会话按创建时间留在原位，不因本列为空而沉底或消失。左栏客户端在没有人手动排过序时按同一口径重排，两边不各猜一套。

**权限与索引。** 与其它批次一致：`0015` 已对 `assist_sessions` 授表级 `SELECT/INSERT/UPDATE`（无 `DELETE`），新列自动落在既有授权内，**不追加 GRANT**；**不新建索引**——单用户本机库会话量级小，列表读仍走 `ix_assist_sessions_scope` 的既有范围过滤，与 0090/0104 对 `pinned_at`／`unread_at` 的判断相同。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（无消息，回落 `created_at`），既有响应只多一个可空只读字段，旧客户端忽略即可。回退可直接保留该列（旧代码不读、旧排序键照旧用 `created_at`）；删除该列只丢失活动排序偏好，不丢失任何会话、消息、命令回执或选择事实。

**验证（如实，分层）。** 见[统一验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行：真实 PostgreSQL 定向套件、工作台 jsdom 与两端 `tsc` 分别报告，一种证据不代替另一种。

## 101. 0112 本地目录完全访问档位（2026-10-18 源码实现）

Migration：`0112_local_directory_full_access.sql`。**只放宽 `local_directory_access` 的档位 CHECK**：`ck_local_directory_access_tier` 的取值集合由 `('READ_ONLY','ASK','AUTO')` 扩为 `('READ_ONLY','ASK','AUTO','FULL')`。不新增表、不加列、不回填、不改写既有迁移、不动索引与授权（`0109` 已给 `relay_app` 表级 `SELECT/INSERT/UPDATE`）。**Breaking Change: No**——加值是兼容新增，既有行取值不变，旧界面把未知取值读成「待核对」而不是替用户猜一档。

`FULL` 仍然是[§98](part-04.md#98-0109-本地目录访问档位元数据2026-10-18-源码实现)意义上的管理元数据，不是第二套授权表：网关判定词表只有 `AUTO/ASK/DENY` 三值，所以选 `FULL` 落的是与 `AUTO` 完全相同的策略行，两者的差别只存在这一列里。因此实际准入必须回读本列（`gateway-actions.ts` 的 prepare 与 dispatch 各读一次同一个函数），不能只信策略投影，也不能由界面把档位传进来。档位投影的反向推导不产生 `FULL`：`READ_ONLY/ASK/AUTO` 仍由策略行回推，`FULL` 只能来自用户显式发出的这条目录命令。

**兼容与回滚。** 迁移不回撤。回退应用代码时库里的 `FULL` 仍受约束允许，旧代码读它当作一个非只读档位，准入退回「AUTO 目录 + 删除逐次确认」，也就是放宽前的行为，不会静默放大权限；旧代码写档位时不认识这个取值，只会拒绝新的一次设置。若以后要收掉这个取值，必须先把所有 `FULL` 行改写回 `AUTO` 再收窄约束——本迁移不提供自动降级，也不删除已发生的档位事实。

## 102. 0113 会话分叉血缘（2026-10-18 源码实现）

Migration：`0113_assist_session_fork.sql`。`assist_sessions` 追加一列可空自引用 `forked_from_session_id uuid REFERENCES assist_sessions (id)`；不回填、不改写任何既有迁移、不动消息/提案/附件/选择表的形状。

**这一列是来源，不是状态。** 分叉之后父子两条会话各自独立生长，父会话不因为被分叉而变化——标题、`revision`、`updated_at`、`last_message_at` 与 `status` 都不动，也不维护反向的子会话列表。唯一的写方是 `forkAssistSession`（`assist-session-controls.ts`）里的 `insertForkedSession`：按源行 `insert … select` 整行搬运会话身份列，`forked_from_session_id` 只在插入时写一次；改名、置顶、未读、归档、重开与消息写入都不读写它。界面上它只用于解释分叉标题末尾那个「（n）」从哪来，不参与任何准入判定。

**形状沿用 0006 的 `verification_sessions.parent_session_id`**：同表自引用、可空、无 CHECK。不加 `forked_from_session_id <> id`：子行 ID 由命令新生成，永不等于父行 ID；父子同 Workspace 由应用 Owner 的行锁读取保证（跨作用域的父会话按 `RESOURCE_NOT_FOUND` 拒掉）。不建索引：一张父会话可以有多个子会话（1:N），当前只有「按子行主键读它自己的父 ID」这一种读法，没有按父反查的读方；0006 的部分索引是配 UNIQUE「一个父只能派生一次」用的，本表既不反查也不唯一，照抄只会多一份写放大。若以后出现「列出某条会话的全部分叉」读方，再按 `(forked_from_session_id)` 增列索引也不迟。

**权限。** `0015` 已对 `assist_sessions` 授表级 `SELECT/INSERT/UPDATE`（无 `DELETE`），新列自动落在既有授权内，不追加 GRANT。

**与消息复制的关系。** 本列只记血缘；子会话里的消息与附件由同一命令用新 ID 复制（`assist_messages` 从 `seq=1` 重排、附件绑定到子会话的新消息行）。刻意不复制的是提案与过程/结局列（请求号、usage、worker、错误码、`model_attempt_state`）；`model_selection_snapshot` 一并不复制，因为 0098 要求它与尝试状态成对非空，而复制后的历史不会再进生成路径。协议见 [HTTP §10.93](../../api/http-command-contract/part-07.md#1093-会话分叉2026-10-18-源码实现迁移-0113)。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（不是任何会话的分叉），既有响应只多一个可空只读字段，旧客户端忽略即可，**Breaking Change: No**。回退可直接保留该列（旧代码不读）；删除该列只丢失「这条从哪来」的来源说明，不丢失任何会话、消息、附件、回执或选择事实。

**验证（如实，分层）。** 真实 PostgreSQL：`assist-session-controls.integration.test.ts` **22/22**，其中 0113 用例从 `information_schema.columns` 核对可空与类型、从 `pg_constraint` 核对自引用外键，并验证列表/单会话投影逐字返回来源。真实 Windows 窗口未验；迁移台账用例另有并行流的登记缺口（0114/0115 未进 `ALL_MIGRATIONS`），不是本迁移引入。

## 103. 0116 会话物理删除授权（2026-10-18 源码实现）

会话物理删除（[ADR-027](../../decisions/ADR-027-session-physical-delete.md)、[HTTP §10.94](../../api/http-command-contract/part-07.md#1094-会话物理删除2026-10-18-源码实现迁移-0116)）只需要应用角色对**会话自有账本**的 `DELETE`。0015 授的是 `SELECT, INSERT, UPDATE`，0050/0060/0062/0089/0093/0097/0100 同样没有 DELETE，因此 0116 是一次纯授权迁移：不改表结构、不加 `ON DELETE CASCADE`、不回填任何数据。

**授予 DELETE 的十五张表**：`assist_sessions`、`assist_messages`、`assist_proposals`、`assist_message_attachments`、`session_tool_calls`、`session_model_selection`、`artifact_impact_checks`、`artifact_impact_candidates`、`artifact_impact_candidate_groups`、`artifact_impact_candidate_group_items`、`conversation_state_requests`、`conversation_state_changes`、`model_calls`、`model_provider_cooldowns`、`conversation_diff_baselines`。逐表对应删除路径上的一次显式 DELETE；`assist_message_previews`（0028）与 `learning_*`（0072）已有 DELETE，不重复授予。

**刻意不授予的表就是阻断面**：`task_acceptance_trial_observations`、`hypothesis_versions`、`work_segments`、`project_blueprint_proposals`、`conversation_execution_requests`、`learning_evidence`、`learning_rounds`、`learning_session_controls`，以及 Task/Artifact/Project 主表。删除命令在发现这些引用时整条拒绝（`409 SESSION_DELETE_BLOCKED`），**不能**借 DELETE 授权把它们一并抹掉。`activity_records` 仍只有 `SELECT, INSERT`：删除命令写一条 `ASSIST_SESSION_DELETED`，但不允许改写或抹去审计。

**为什么不用级联。** 指向 `assist_sessions` 的 12 条外键全部是默认 `NO ACTION`；保留这个形状，删除顺序由仓储层逐表写出。顺序写错会当场撞外键失败并整条回滚，而不是让数据库按自己的规则扩大删除范围。`conversation_diff_baselines.session_id` 没有外键（0097），不在数据库的保护范围内，必须显式删。

**权限边界与回滚。** 授权只覆盖会话自有账本，不外溢到 `tasks` 等其它对象（`has_table_privilege` 在集成用例里逐项核对）。回滚只需撤销这批 GRANT，会话行与消息不会被带回；已删除的数据不在回滚范围内。

**证据（如实分层）。** 真实临时 PostgreSQL 18.6：`assist-session-delete.integration.test.ts` **9/9**，含账本删净与无悬空基线、删除后回执重放、阻断项（分叉、学习记录）、在途与陈旧基线栅栏、跨 Workspace 不可见、0116 授权边界。未在用户库验证 0116 是否已应用，也未做真实 Windows 安装态复核。

## 103. 0115 周期定时启动任务（2026-10-18 源码实现）

Migration：`0115_scheduled_tasks.sql`，新增 `scheduled_tasks` 与 `scheduled_task_occurrences` 两张表；`0138_scheduled_task_occurrence_freeze.sql` 给发生表补 `frozen_template` / `frozen_execution_input`（发生时配置冻结，2026-10-25）。取舍与代价见 [ADR-026](../../decisions/ADR-026-scheduled-task-autostart.md)，协议见 [HTTP §10.94](../../api/http-command-contract/part-07.md#1094-周期定时启动任务2026-10-18-源码实现迁移-0115)。

**计划表只存配置与授权，不存执行状态。** `scheduled_tasks` 有模板 `template jsonb`（`task_title/objective/criteria/expected_outputs/mode`，与 `CreateTask` 入参同形）、重复规则 `repeat_rule jsonb`（`{kind:'DAILY',interval_days:1..30}` 或 `{kind:'WEEKLY',weekdays:[1..7]}`，CHECK 只放这两个 kind）、`timezone`、`local_time`（`HH:MM` 正则 CHECK）、`first_run_at`、`next_due_at`、`status`（`ENABLED/PAUSED/DISABLED/EXPIRED`）、`schedule_generation`、`revision`、`max_runs`（1–100）、`runs_reserved`、`runs_started`、`authorization_expires_at`、`execution_input jsonb`、`history jsonb`。Task 状态、Run 生命周期与验收都不在这里——它们仍归原 Owner。

**两个计数列分工不同，不能合并。** `runs_reserved` 是「已产生的时段数」，只用于序号与顺序；`runs_started` 才是预算口径，因为用户理解的 `max_runs` 是「最多真正启动多少次」。跳过的时段（上一轮未验收）与阻塞的时段都推进 `runs_reserved`，但只有真正 Delegate 成功才推进 `runs_started`。约束只有 `runs_started <= runs_reserved`，刻意不加 `runs_reserved <= max_runs`：否则跳过次数会把额度吃光。

**发生表记录「这一次时段」，不复制业务事实。** `scheduled_task_occurrences` 有 `schedule_generation`、`sequence`、`due_at`、`timezone`、`missed`、`status`（`DISPATCHING/DISPATCHED/BLOCKED/SKIPPED/RESOLVED`）、`task_id`、`run_id`、三个预生成命令身份、`frozen_execution jsonb`、`reason`、`revision`。`UNIQUE (scheduled_task_id, schedule_generation, sequence)` 是第二道防线；三个命令列各自 `UNIQUE`，保证同一时段不会建出两个 Task。0138 起另有 `frozen_template` / `frozen_execution_input`（发生落库时的模板与执行意图副本，空对象表示迁移前行，分发回落计划当前值）；完成与失败写入都带 `status='DISPATCHING'` 条件（`markDispatched` / `markSettled` / `freezeExecution`）——重复完成不重复累计 `runs_started`，迟到失败写入不覆盖已确认的 `DISPATCHED`。

**`DISPATCHING` 是租约，不是终态。** 插入即置该状态，调度器用行锁 + `UPDATE … RETURNING` 抢租约后才执行三步命令；进程在分发中途崩溃时该行保持 `DISPATCHING`，下一次扫描从「待分发」重新取它，靠预生成命令身份回执重放，不会重复建 Task。人工「补跑」也是把 `BLOCKED` 改回 `DISPATCHING`，不新增行、不消耗额度。

**索引。** `scheduled_tasks(next_due_at) WHERE status='ENABLED'` 服务到期扫描；`(workspace_id, project_id, created_at)` 服务列表；`scheduled_task_occurrences(scheduled_task_id, created_at DESC, id DESC)` 服务详情页最近 20 条；`(workspace_id, created_at, id) WHERE status='BLOCKED'` 服务待处理投影。不建 `(due_at)` 索引：发生表按计划反查，没有按时刻全局扫描的读方。

**权限。** 末尾 `GRANT SELECT, INSERT, UPDATE ON scheduled_tasks, scheduled_task_occurrences TO relay_app`，无 `DELETE`——两张表都不删除，取消与作废靠状态列表达。

**时区与 DST。** 库只存 `local_time` 墙钟字符串与 `timezone` 名称，绝对时刻 `next_due_at`/`due_at` 由应用用 `zoned-time.ts` 现算。刻意不存固定偏移：跨夏令时的「每天 09:00」必须仍是 09:00。春跳不存在的时刻顺延 +1 小时，秋回重复的时刻取较早一次。

**兼容与回滚。** 纯新增两张表，不改任何既有表或列，**Breaking Change: No**。回退应用代码时旧代码不读这两张表，定时任务停止调度但已产生的 Task/Run 事实不受影响；迁移不回撤。删除这两张表只丢失「哪些时段被排定过」的记录，不删除已经建出的 Task、Run、回执或审计。

**验证（如实分层）。** 单元：`zoned-time.test.ts` **10/10**（上海/纽约春跳秋回/伦敦/Kolkata/Chatham/Kiritimati、跨 DST 的每日 09:00、关机三天只推进一次、严格晚于 now）、`scheduled-tasks.test.ts` **4/4**（规则/上限/到期/时刻/日期/时区/文本口径）。真实 PostgreSQL：`scheduled-tasks.integration.test.ts` 见[测试计划 §37](../../testing/verification-plan/part-07.md#37-周期定时启动任务验收规格2026-10-18)与统一验收表。真实 Windows 窗口与安装态未验。

## 104. 0117 Workspace 默认目录（2026-10-19）

Migration：`0117_workspace_default_directory.sql`。原方案编号 `0111` 已被活动排序键占用，使用当前空闲号；不修改任何已应用迁移。

`workspace_default_directories` 每 Workspace 一行，`workspace_id` 主键引用 workspaces，`resource_id` 可空引用 managed_resources，`revision bigint >= 0`，以及 `created_at / updated_at`。WorkspaceRepository 是存储入口，应用命令负责跨 Workspace、资源状态与路径核对；不复制目录或权限事实。`resource_id=NULL` 表示清除，保留修订以防旧请求覆盖清除后的选择。缺行的外部修订为 0，首次写入为 1；更新持有 Workspace authority 排他锁，配置 revision 为独立 CAS，不推进 Workspace 业务修订。只授 relay_app SELECT/INSERT/UPDATE，不授 DELETE。

`assist_sessions.working_directory_source text NULL` 与资源在创建/显式绑定事务内一起写入，取值 USER_PICKED 或 WORKSPACE_DEFAULT；CHECK 禁止无资源时带来源。历史绑定不回填，来源 NULL 表示未知；分叉复制源来源。已有会话不随默认设置变化，ASSISTANT/LEARNING 与显式 Project/Task 不继承。配置及继承按 authority→资源登记锁→Project 归档栅栏→资源锁核对，读取工具本身不查默认配置。

**Breaking Change: No**。纯新增表与可空列，兼容旧数据。回退应用后新表和列保留；直接删除列会丢失来源与配置追溯，不提供自动 down migration。没有回填或用户数据迁移，本轮仅在一次性临时库应用，用户库迁移和安装包升级另验。API 协议见 [HTTP §10.96](../../api/http-command-contract/part-07.md#1096-workspace-默认工作目录2026-10-19-后端实现)。

## 105. 0118–0119 长短期记忆（2026-10-19）

Migration：`0118_long_term_memory.sql`、`0119_short_term_memory.sql`、`0120_memory_usage_sources.sql`、`0123_memory_usage_scope.sql`；**Breaking Change: No**，新增表与使用足迹列，无历史正文回填，不更改原消息或 Memory 版本。0121/0122 归并行模型能力/插话功能，不属于记忆模块。Information 拥有长期事实与配置，Assist 拥有短期工作窗口。

- `workspace_memory_settings`：每 Workspace 一行，recall_enabled/automatic_compaction 默认 true，revision 用 CAS；应用仅 SELECT/INSERT/UPDATE。
- `memory_message_sources`：主键 memory_id/memory_version，引用确切 Memory 版本和原会话/消息，冻结 SHA256；仅 SELECT/INSERT。停用不删除来源，跨对象引用阻止源会话物理删除。
- `assist_memory_state`：每会话当前检查点指针、revision 与 cleared_through_seq；成功 CAS 后才更换，不改原聊天。
- `assist_memory_requests`：手动/自动请求、原文覆盖 IDs/hash、冻结模型、会话/权限/上下文/设置/窗口修订、PENDING/RUNNING/COMPLETED/FAILED/CANCELLED、worker/epoch/lease/cancel 与结果引用；每会话至多一条活动请求的部分唯一索引。租约丢失收敛失败，不自动重复网络调用。
- `assist_memory_checkpoints`：不可变摘要与确切覆盖边界/来源足迹、model_call_id 和作用域修订；提交新行再 CAS 指针，原行保留。
- `assist_memory_uses`：每条真实生成消息采用的检查点、窗口/权限/上下文修订；0120 增加直接及传递来源 sources、has_tool_context，0123 增加 project/task/working_resource 的 session_scope 快照，支持多轮派生答复和换目录后的隔离。旧使用行 scope=NULL 表示无法核对，不能给旧工具文本补当前授权。分叉仅继承来源/工具作用域足迹，不继承父 checkpoint 所有权和计量；无使用账本的旧工具答复不复制正文，改用明确不可用文本占位，父原文仍保留；不放宽原 COMPLETED 消息非空正文约束。

短期表仅请求/state 可更新，checkpoint/uses 不可更新；四表授 DELETE 仅供既有会话物理删除用例按 uses→state→requests→checkpoints 清理，再删原 model_calls/消息。活动整理、长期跨对象引用仍走原删除栅栏。摘要调用复用 ASSIST model_calls，锚点为真实已覆盖消息，独立请求保存实际 call_id，原回复 usage 不被覆盖。

兼容回退：旧应用不读取新表，但回退版本的旧物理删除代码不了解新 FK，不应执行带新记忆记录的删除。回退不删表、不抹新事实；直接 DROP 会丢失来源/窗口/调用关联并存在 FK 风险，无自动 down migration。用户库升级、真实安装态另验。协议归 [HTTP §10.99](../../api/http-command-contract/part-07.md#1099-长短期记忆接口2026-10-19)。

## 106. 0122 排队消息的插话意图（2026-10-19 源码实现）

`ALTER TABLE assist_messages ADD COLUMN steer_requested boolean NOT NULL DEFAULT false;`——纯追加一列，不改状态枚举、不回填、不动既有索引与授权（0015 的表级 SELECT/INSERT/UPDATE 覆盖新列）。

**语义**：普通 Agent 会话里一条回复 `RUNNING` 时，用户新发的消息仍落库为 `PENDING`（排队）。`steer_requested = true` 表示「已请求把这一条并入正在生成的那一轮」。它与 `cancel_requested`（0054）同一性质——先持久化控制意图，由生成方在安全点观察；区别是取消让这一轮停下，插话让这一轮多跑一步。

**写入方**（两处，互不覆盖）：

1. `SteerAssistMessage` 命令 → `setSteerRequested()`：只对 `role='ASSISTANT' AND status='PENDING'` 置位；`RUNNING` 与终态不改。
2. `claimNextPendingMessage()`：在把 `PENDING` 改成 `RUNNING` 的同一句里清零——一行自己开始生成后就不再是别人的插话对象。这是迟到意图的收尾路径：那一轮先结算、意图没被消费，这一行随后按普通排队被领取，消息照常得到自己的回复。

**消费方**：`drainSteerRequests(session_id, after_seq)`，唯一调用点是普通 Agent 主流程 `runSessionReadonlyRounds()` 每次模型请求之前。一条语句完成三件事：选中 `seq > after_seq AND role='ASSISTANT' AND status='PENDING' AND steer_requested` 的行；把它们收口为 `status='CANCELLED', error_code='STEERED', worker_id=NULL`；用 `LATERAL` 取各自紧邻的用户原文返回。收口后状态已离开 `PENDING`，同一行不会被第二次消费。

**读取排除**：`listMessages()` 与 `assistMemory.history()` 都排除 `role='ASSISTANT' AND status='CANCELLED' AND error_code='STEERED'` 的行——它不是一轮回复（没有答案），只是一条占位行；用户原文仍是真实 `USER` 消息，照常出现在转录区与后续上下文里。

**为什么不用新状态值**：`assist_messages.status` 的 CHECK 是既有枚举，加值要重建约束并波及所有按状态分支的读方；`CANCELLED` + 类型化 `error_code` 已是本仓表达「这一轮没产生正文」的既有形状（`error_code` 无约束，0046 也把 Provider 分类另立一列而不并进来）。

**索引**：不加。读取走既有 `UNIQUE (session_id, seq)`，单用户在途队列是个位数。

**兼容与回滚**：默认 false，旧行取 false；旧应用不读该列，行为退回「只排队不插话」。回退可保留列；删除列只丢失未消费的插话意图，不丢失消息、回执或状态事实。**Breaking Change: No。** 协议归 [HTTP §10.102](../../api/http-command-contract/part-07.md#10102-排队消息的插话2026-10-19-源码实现)，上下文位置归[运行时上下文 §2.9](../../architecture/runtime-context/part-02.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。

## 107. 0125 长期记忆自动捕获（2026-10-20，ADR-030）

三处纯追加：`memory_items` 加 `origin`、`workspace_memory_settings` 加 `auto_capture`、新表 `memory_auto_captures`。不改 0009 的 `memory_items` 状态约束与 0118 的设置表结构。

- **`memory_items.origin`**：`text NOT NULL DEFAULT 'HUMAN_CONFIRMED'`，CHECK 只允许 `HUMAN_CONFIRMED` / `AUTO_CAPTURE`。旧行全部落为人工确认——0125 之前不存在自动写入，回填值就是事实。索引 `(workspace_id, origin, status)` 供召回排序与后续筛选。
- **`workspace_memory_settings.auto_capture`**：`boolean NOT NULL DEFAULT true`，与既有两个开关并列。缺配置时应用层仍按「修订 0、三项 true」返回。
- **`memory_auto_captures`**：一次提取一行。
  - `source_sha256` 是**原消息正文**的 UTF-8 摘要（与 §10.99 手动保存同口径）；`normalized_sha256` 是 title+text 归一化后的指纹。
  - 唯一键 `(session_id, message_id, normalized_sha256)`：同一消息同一内容只写一次，重复触发是空操作（`on conflict do nothing`）。
  - `memory_id` 指向写入的 Memory 根，不复制正文——正文与版本仍在 `memory_versions`，来源仍在 `memory_message_sources`。
  - `status` 只有 `ACTIVE` / `RETIRED`，并用 CHECK 绑定「RETIRED 必须同时有 `decided_at` 与 `decided_by`」——撤销不能没有责任人。
  - 索引 `(workspace_id, status, created_at desc)` 供列表，`(session_id, created_at desc)` 供每日限频计数（UTC 日界）。
- **授权**：`GRANT SELECT, INSERT, UPDATE ON memory_auto_captures TO relay_app`。`memory_items` 的新列由 0009 的表级授权覆盖，不需要额外 GRANT。
- **为什么不用「候选表 + 接受」**：ADR-029 的候选方案被用户否决（确认成本只是换了个地方）；0125 因此没有 `PENDING` 态，写入即生效，撤销即停用。

## 108. 0126 会话内直接写文件来源（2026-10-20，ADR-031）

只改三条既有 CHECK，不新增表、不加列、不回填。三条均按**最新正文**逐条重述后追加新支：`ck_logical_operation_origin` 与 `ck_invocation_run_identity` 以 0087 为准，`ck_logical_operation_resource` 以 0105 为准（含 COMPUTER / GITHUB / BROWSER 分支）。

- **`ck_logical_operation_origin`**：追加 `AGENT_SESSION_WRITE`，四个执行身份列全 `NULL`。与 `AGENT_SESSION_READ` 同形——会话写没有 Run/Task/Step/ImportJob，防止「会话写动作挂到某个 Run 上」这种既冒充执行权、又让 Run 未决列表漏掉它的形态。
- **`ck_logical_operation_resource`**：追加 `(capability_key = 'FILE_WRITE' AND origin = 'AGENT_SESSION_WRITE' AND resource_id IS NOT NULL)`。`GIT_WRITE` / `CLI_RUN` / `WEB_FETCH` 不放开：会话写只改本会话绑定目录内的文件，不改仓库状态、不跑命令、不联网。
- **`ck_invocation_run_identity`**：追加一支，绑定受管资源但没有 Worker、`ownership_epoch`、资源 claim 与 claim token。排他不靠 claim（`resource_claims` 强制绑定 task/run/worker，会话两者都没有），靠 prepare 与 admit 各自按 `listOccupiedResources()` 拒绝在途目录——与 0058 的 `USER_ACTION` 同一口径。
- **能力与动作是两层判定**：CHECK 只钉到 `FILE_WRITE` 能力，应用层 `originAllows()` 再收窄到 `APPLY_CHANGESET` / `READ_CHANGE_SET`。同名能力下的 `WRITE_FILE`（全文覆盖、无基线）因此不可达——两个会话并发写同一文件时，唯一可靠的闸门是 SHA-256 基线。
- **为什么重述而不就地追加**：0060 的注释记录过 0054 重述 `ck_logical_operation_resource` 时漏掉 `WEB_FETCH` 与 `FILE_WRITE`，造成 9 例既有动作在下一次写入时违反约束。本次把三个分支逐条抄全再追加，不用「在上次版本上加一行」的写法。

## 109. 0127 聊天目标与计划模式（2026-10-20 源码实现）

三张业务表 + 两张账本表，全部挂在既有 `assist_sessions` / `assist_messages` 上：

- **`assist_sessions.chat_mode` / `assist_messages.chat_mode`**：行为模式（CHAT/PLAN/GOAL），
  与会话身份 `conversation_mode` 分开。会话列是「当前模式」，消息列是**发送时的模式快照**——
  之后切换模式不改写已排队消息的处理方式（与 `intent`、`method_snapshot` 的冻结语义一致）。
  两列都带 CHECK，缺省 `CHAT`，旧数据零迁移。
- **`assist_messages.goal_outcome`（jsonb）**：目标轮次的结构化结论（成功条件状态、步骤、
  下一步）。正文仍落 `content`（只落信封的 `reply`），推进器读这一列而不是重新解析正文：
  「模型说了什么」与「用户看到什么」各自可核对，压缩/截断也不会改变结算依据。
- **`assist_plans`**：计划版本行，**不可变**。`uq_assist_plan_version (session_id, version)`
  从 1 起严格递增；`uq_assist_plan_source (session_id, source_message_id)` 保证同一条消息
  只落一版，重放与恢复都按这条身份核对。修改＝插入新版本并把旧版本标 `SUPERSEDED`。
- **`assist_goals`**：会话内持久目标。状态机十一态；`uq_assist_goal_open_per_session`
  是**部分唯一索引**（`status NOT IN (COMPLETED, CANCELLED, FAILED)`）——一条会话最多一个
  未终结目标，`BUDGET_EXHAUSTED` 仍占位，额度耗尽后不会因为再发一条消息就悄悄长出第二个
  目标。`criteria`/`steps` 在执行开始时冻结；推进租约（`lease_owner`/`lease_expires_at`）
  保证同一目标同一时刻只有一个 Worker 组织下一轮；`ck_assist_goal_closed` 把终结态与
  `closed_at` 绑在一起。
- **`assist_goal_rounds`**：轮次结算回执。`uq_assist_goal_round_message (message_id)` 唯一
  ——一条目标轮次消息只结算一次，重启重扫按这条键幂等；`uq_assist_goal_round_index
  (goal_id, round_index)` 保证轮次连续不重号。
- **`assist_goal_budget_grants`**：额度耗尽后用户点「继续」的显式授权账本。
  `uq_assist_goal_grant_command (command_id)` 保证同一命令重放只加一次额度；应用层把它
  加在共享预算闸门的会话级上限上，因此每一次扩额都有账可查。

外键：`assist_messages.goal_id → assist_goals(id)`，索引 `(goal_id, seq)` 供推进器按序
读取轮次；`assist_goals.plan_version_id → assist_plans(id)` 记录「按哪一版计划执行」。
权限：`relay_app` 对两张业务表 SELECT/INSERT/UPDATE，两张账本表只 SELECT/INSERT——
轮次与授权一经写入不改写，修正只能通过新的行表达。

## 110. 0130 记忆来源类别与自动捕获写入修正（2026-10-21，ADR-032）

在 §107 之上纯追加两列，并修掉两处实现缺口。

- **`memory_items.source_kind`**：`text NOT NULL DEFAULT 'MANUAL'`，CHECK 只允许 `MANUAL` / `USER_STATEMENT` / `MODEL_OBSERVATION` / `UNKNOWN`。它回答「内容来自谁的哪一段」，`origin` 回答「谁写的」——两维不同：自动捕获的条目既可能只引用用户原话（`USER_STATEMENT`），也可能只引用助手叙述（`MODEL_OBSERVATION`）。回填：0125 之后写下的自动记忆（`origin = 'AUTO_CAPTURE'`）落 `UNKNOWN`——它们没有经过来源核验，不能假定是用户原话；其余行落 `MANUAL`。索引 `(workspace_id, origin, source_kind, status)` 供召回排序与后续筛选。
- **`memory_auto_captures.source_quote`**：`text NOT NULL DEFAULT ''`，记这一条来自原消息的**哪一段**（逐字片段）。来源类别由它核验而来，留在这里是为了事后能复核「这条记忆说的是哪一段」。
- **修正一：`ck_memory_version_values` 放宽**。0009 的 CHECK 要求 `confirmed_by = 'user:local'`，而 §107 的自动捕获写的是 `'auto-capture'`：真实 PostgreSQL 上每一次自动捕获写入都被这条约束拒绝，又被写入路径的失败静默吞掉——「自动记住」从未真正落库（此前只有不碰库的单测，没有暴露）。本迁移把取值放宽为 `in ('user:local', 'auto-capture')`，不新增第三个来源。
- **修正二：自动捕获显式写 `origin`**。写入路径此前没写这一列，落到了列默认值 `HUMAN_CONFIRMED`，自动记住的条目在召回排序与界面标注上冒充人工确认。改为显式写 `AUTO_CAPTURE`。
- **授权**：`memory_items` 与 `memory_auto_captures` 的新列由既有表级授权覆盖，不需要额外 GRANT。

## 111. 0132 消息文件撤回、前像、保护副本与单层撤销（2026-10-24）

> **2026-10-24 返工（用户拍板发送前基线口径）**：本节此前描述的 `assist_message_file_preimages`（首写前像）已由 `assist_message_baselines`＋`assist_message_baseline_files`＋`assist_message_snapshot_blobs`（内容寻址字节库，同内容跨消息去重；容量与保留按此计量）替代；前像表与 Gateway 写路径钩子移除。逐行字段描述中「前像」读作「基线条目」，`existed/sha256/content/source` 对应 `existed/blob_sha256/（字节库引用）/（已无）`；基线新增 `status(COMPLETE/INCOMPLETE)/reason/file_count/total_bytes` 与 `uq_assist_baseline_message`。下文按当时快照保留，不逐行改写。

新增五张表并给 `assist_messages` 加两列；对既有消息/会话只追加可空字段。**Breaking Change: No**。

- **`assist_message_file_preimages`**：逐消息、逐路径的**写入前像**。`PRIMARY KEY (message_id, relative_path)`＋写入端 `ON CONFLICT DO NOTHING` 实现首写优先，后续同消息同路径覆写不改写首份。`existed=false` 时内容全空；`existed=true` 时要么 `sha256/content/size_bytes` 齐备（`octet_length(content) = size_bytes`），要么只有 `unavailable_reason`（`CONTENT_TOO_LARGE / READ_FAILED / TARGET_NOT_REGULAR / PATH_UNSAFE / CAPACITY_FULL`）。`source` 只允许 `SESSION_WRITE / RUN_WRITE`。路径 CHECK 禁止绝对路径、盘符、反斜杠与 `..`。索引 `(session_id, message_id)` 供撤回按会话读取。
- **`assist_message_recalls`**：一次撤回的持久身份与结果摘要。`uq_assist_message_recall_message (message_id)` 保证一条消息只撤回一次；`uq_assist_message_recall_command (workspace_id, command_id)` 保证命令幂等。状态 `RUNNING / COMPLETED / PARTIAL / FAILED`，`ck_assist_message_recall_terminal` 把非 RUNNING 与 `completed_at` 绑在一起；`last_resumed_at` 是崩溃遗留 RUNNING 的认领心跳。`root_path` 记录本次唯一受管根，`planned/restored/skipped_files` 是计数摘要，逐文件事实在下一张表。
- **`assist_message_recall_files`**：逐文件预检/恢复结果。`PRIMARY KEY (recall_id, relative_path)`；`baseline_existed/baseline_sha256/baseline_message_id` 描述撤回目标基线，`expected_current_sha256` 是最近一次已确认写入应留下的内容（NULL＝应不存在），`observed_sha256` 是读取到的当前内容。状态 `PLANNED / RESTORED / ALREADY_RESTORED / CONFLICT / UNAVAILABLE / FAILED / SKIPPED / UNCERTAIN`；路径与哈希 CHECK 与前者同规。
- **`assist_message_recall_protections`**：首个恢复写入前保存的当前字节（单层撤销的依据）。`PRIMARY KEY (recall_id, relative_path)`；形状与 preimages 相同，`unavailable_reason` 另允许 `CAPACITY_FULL`。副本不可用时应用层让整次撤回不执行。
- **`assist_message_recall_undos`**：单层撤销回执。`uq_assist_recall_undo_source (source_recall_id)` 保证一次撤回至多一条撤销；`uq_assist_recall_undo_command (workspace_id, command_id)` 保证命令幂等。`files` 直接保存逐文件预检/恢复结果（jsonb），不再建第二张逐文件表；状态词表与终结约束同 recalls，`last_resumed_at` 支持过期 RUNNING 接续。
- **`assist_messages.withdrawn_at / withdrawn_by_recall_id`**：可空标记，终态撤回时同时写目标用户消息与其直接助手回复；部分索引 `ix_assist_messages_withdrawn (session_id, seq) WHERE withdrawn_at IS NOT NULL` 供方向规则与上下文占位读取。原文、附件、工具记录不删除。
- **保留与容量**：`created_at`＋`size_bytes` 支撑保留期清理与工作区占用投影；清理删除超过保留期且不被在途撤回/撤销引用的前像与保护副本（`sweepExpiredSnapshots`）。**授权必须含 DELETE**：前像与保护副本授 `SELECT, INSERT, DELETE`（内容本身不可改写，DELETE 仅供过期清理）；撤回/撤销回执授 `SELECT, INSERT, UPDATE`。缺 DELETE 会让清理被静默拒绝，RA-08 已锁住该形态。
- **回滚**：仅本功能未投入使用时可直接删表并移除两列；已产生撤回记录后回滚会丢失回执与撤回标记，需先导出。前像/保护副本字节直存 PG，未做内容寻址去重，容量按实际字节计。

## 112. 0135 会话活动键回填（2026-10-24，缺陷修复）

Migration：`0135_assist_session_last_message_backfill.sql`。**单条 `UPDATE`**，不建表、不加列/索引/授权、不改写既有迁移。**Breaking Change: No**。

- **缺陷**：0111 刻意不回填（兼容段写「旧行取 NULL（无消息）」），那个括号里的前提不成立——0111 应用**之前就已经有消息**的会话同样落在 NULL 上。当时只影响排序（回落 `created_at`），所以没人发现；2026-10-24 左栏把 `lastMessageAt === null` 读成「这段讨论还没有消息」之后，这些老会话被标成「未开始」，点进去却有完整正文。本机实例实测 5 条：2026-10-16 15:35 建的 6 消息会话（含一次 `MODEL_FAILED`）、2026-10-16 15:29 的 2 消息会话、2026-10-18 的「你好」、2026-10-15 的 4 消息与 6 消息（后者已归档）。
- **修复**：按 `assist_messages.created_at` 的真实最大值回填，只填 `last_message_at IS NULL` 的行，因此可重复执行（本机复跑 `UPDATE 0`）。用消息时刻而不是 `now()`：活动键说的是「最后一条消息是什么时候」，回填不该把 10-16 的会话记成今天。
- **不动 `updated_at` / `revision`**：本列自 0111 起就是导航排序键，回填属数据校准而不是人工控制命令；推进 `revision` 会打翻改名／置顶／未读那一组命令的 CAS 基线。
- **写入 Owner 不变**：仍只有 `insertMessage` 与 `settleGeneration`（0111 口径，`greatest(last_message_at, now())` 单调推进），本迁移不新增写入方。回填完成后 `NULL ⇔ 这条会话没有任何消息` 才真正成立——这是左栏「未开始」标记在 2026-10-24 之前的唯一前提。
- **读时派生、不改表（同日接续）**：会话投影另给 `has_messages`＝`exists(select 1 from assist_messages …)`（列表逐行附带，单条读取单独派生）。界面「未开始」与分叉入口改读这一枚事实，`last_message_at` 只保留排序职责；将来若有写入路径漏推进活动键，最坏后果退回「排序略偏」，不再把有正文的会话说成空会话。`assist_sessions` 无新列、无新索引、无新授权。
- **回滚**：不提供反向语句。把已填行改回 NULL 只会重新引入本缺陷；旧代码读到更精确的活动时刻只影响排序，属改善。

## 113. 0134 人工受管目录浏览与文件读取（2026-10-24）

Migration：`0134_user_action_file_read.sql`（apps/api 与桌面打包资源两处镜像）。机制与词表归[工具适配器 2026-10-24 段](../../architecture/tool-adapters.md)，HTTP 入口归[HTTP §10.112](../../api/http-command-contract/part-08.md#10112-人工受管目录浏览与文件读取2026-10-24-源码实现迁移-0134)。**Breaking Change: No**。

- **只放宽一条 CHECK**：`ck_logical_operation_resource` 以 0126 最新正文逐支重述，追加 `(capability_key IN ('FILE_READ','FILE_QUERY') AND origin='USER_ACTION' AND resource_id IS NOT NULL)` 一支；`ck_logical_operation_origin` 与 `ck_invocation_run_identity` 不动（USER_ACTION 的来源形状与调用身份自 0058 已成立）。不建表、不加列/索引/授权、不回填。
- **只影响新行**：既有行没有 USER_ACTION 的 FILE_READ/FILE_QUERY 动作，重述正文与既有约束等价；迁移正文的数据库级守卫由集成套件锁定（只读两能力×绑定资源可入，GIT_WRITE/CLI_RUN/FILE_WRITE 与脱离资源形态仍被拒）。
- **应用层双层词表**：`originAllows` 另收一层到「能力×动作」（FILE_QUERY×LIST_DIRECTORY、FILE_READ×READ_FILE）；数据库 CHECK 与应用词表各说各的边界，两层都在集成测试中证明。
- **回滚**：恢复 0126 版约束文本即可；已产生的 USER_ACTION 文件读取行会因收紧而违反约束，回滚前需先清理这类行（或接受不回滚）。

## 114. 0139 项目级长期 Agent 成员（2026-10-25，ADR-034 包 A）

Migration：`0139_project_agent_members.sql`，新增 `project_agent_members` 与 `project_agent_coordinators`。协议见 [HTTP §10.113](../../api/http-command-contract/part-08.md#10113-项目级长期-agent-成员2026-10-25-源码实现迁移-0139)，取舍见 [ADR-034](../../decisions/ADR-034-persistent-project-agent-team.md)。

**成员表只存身份与配置。** `project_agent_members` 有 `name`（`UNIQUE (project_id, name)`，撞名由应用翻译成 422）、`role_key`（应用层校验五个模板键）、`duties`（创建时从模板拷贝，此后与模板无关）、`status`（`ACTIVE/INACTIVE/ARCHIVED`，ARCHIVED 为留档终态）、`run_mode`（`BUILTIN/EXTERNAL`）、`model_selection jsonb`（CHECK 限 `INHERIT/EXPLICIT` 两 mode；EXPLICIT 保存解析结果与指纹）、`external_binding jsonb`（展示性标签，不构成授权）、`revision`、`created_at/updated_at`。Task/Run/会话身份不在这里。

**协调者表一项目一行。** `project_agent_coordinators` 以 `project_id` 为 PK：指派/更换走 `INSERT … ON CONFLICT DO UPDATE` 且 `revision + 1`，更换前由应用核对当前修订；不加「成员行上的布尔位」，避免同一事实两处维护。

**权限。** `GRANT SELECT, INSERT, UPDATE`（无 DELETE）：取消与终止靠状态列表达，成员记录不物理删除。

**回滚。** 两表为新增、无回填与触发器，回滚迁移直接 DROP；已产生的成员身份与协调者指派随回滚消失，须先确认没有下游包（消息、执行权）开始引用。

## 116. 0136 Artifact 与 Task 的 Workspace 复合范围约束（2026-10-25）

Migration：`0136_artifact_task_workspace_scope.sql`。**Breaking Change: No**；没有新增业务字段、表或 API。

- `artifacts(workspace_id, task_id)` 现在以复合外键引用 `tasks(workspace_id, id)`。Artifact 继续可关联项目内 Task 或 `project_id IS NULL` 的 Inbox Task，但两者必须属于同一 Workspace。
- 迁移先统计由 `task_id` 找到、但 Workspace 不一致的既有行；发现冲突即以 `23514` 终止并要求人工核查，不自动改归属或清理数据。通过预检后新增 `NOT VALID` 外键并立即 `VALIDATE`。
- 真实 PostgreSQL 测试覆盖：同 Workspace 的 Inbox 与项目 Task 可写，跨 Workspace 的 Inbox 与项目 Task 被外键拒绝。迁移预检对既有冲突数据的失败分支尚无独立集成用例。
- 回滚可删除该外键；这会重新允许跨 Workspace 关联，回滚前应确认没有重新开放该写入路径的风险。

## 115. 0140 成员私聊、群聊与消息（2026-10-25，ADR-034 包 B）

Migration：`0140_project_member_conversations.sql`，新增 `project_member_conversations` 与 `project_member_messages`。协议见 [HTTP §10.114](../../api/http-command-contract/part-08.md#10114-成员私聊群聊与消息2026-10-25-源码实现迁移-0140)。

**会话表用部分唯一索引表达「一线程」。** `(project_id, member_id) WHERE kind='DIRECT'`、`(project_id) WHERE kind='GROUP'`；`CHECK` 保证 DIRECT 必有成员、GROUP 必无。`close_reason` 是受限词表（六种终止原因），关闭保留记录、可重开，revision 走 CAS。

**消息表只存协作记录。** `sender_kind ∈ {HUMAN, MEMBER}`（MEMBER 回信路径随包 C）；`recipient_member_ids jsonb` 数组是定向事实（私聊恒对方、群聊空集＝未定向由协调者接住）；`intent` 六种，`HANDOFF` 携带键词表封闭的 `handoff_payload`（只引用，`linked_task_id`/`linked_run_id` 为外键）；`processing_status` 词表已含 `CLAIMED/PROCESSED/FAILED` 但消费循环未实现（包 C），当前只落 `RECORDED`。`UNIQUE (conversation_id, seq)` 兜底 seq 竞争。

**权限。** `GRANT SELECT, INSERT, UPDATE`（无 DELETE）：讨论与消息不物理删除，终止靠状态列。

**回滚。** 纯新增表、无回填；DROP 前须确认包 C 尚未开始消费（processing_status 尚无 CLAIMED 行）。

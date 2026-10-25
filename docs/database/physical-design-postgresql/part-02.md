# PostgreSQL 物理设计：分册 02

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../physical-design-postgresql.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 18. 0007 持久控制与受控 Fake 恢复（2026-09-23 P08）

实际 DDL 见 [0007_v003_recovery_control.sql](../../../apps/api/migrations/0007_v003_recovery_control.sql)。它是 V003 的 P08 最小切片：保持 0001–0006 的 SHA 不变，新增控制意图、Run 级 Worker fence 和唯一受控的候选 Markdown 发布动作；不宣称通用资源排他或真实工具 Gateway 已具备。

- `tasks.status` CHECK 增加 `WAITING`、`BLOCKED`；`runs` 增加 `worker_epoch`、`worker_id`、`worker_lease_until` 及成对约束，`resume_phase` 允许 `WAITING_APPROVAL`。Worker 领取使 epoch 增长；旧 epoch 不能提交步骤或 Task 完成。Task/Run/Review 的入口统一先锁 Task 再锁 Run；效果发布前再以此顺序检查当前 Worker、epoch、执行权与 PENDING 控制。
- `run_control_requests` 保存 PAUSE/CANCEL/HANDOFF/CANCEL_TASK、状态 PENDING/APPLIED/REJECTED/SUPERSEDED、revision、决定时间和 `result_ref`；`uq_run_control_pending` 保证每个 Run 最多一个待处理意图。请求提交与安全点应用是不同短事务；冲突拒绝或显式 supersede，不能从 202 推断已暂停。HANDOFF 的 `result_ref.handoff` 保存步骤位置与可用候选/验证事实 ID；未写入数据库的发布文件不伪装为候选版本。
- `run_effect_actions` 以 `operation_id=step_attempts.id` 保存不可变的目标相对路径、SHA-256 参数摘要、PREPARED/DISPATCHING/SUCCEEDED/FAILED/UNKNOWN、派发次数与结果。`(run_id,step_id)` 与 `(attempt_id,step_id)` 复合外键把 Run→Step→Attempt 绑定，避免跨 Run 拼错动作身份。受管 Fake 发布到 `artifacts/<run_id>/<attempt_id>/content.md`（修正轮沿用原 Artifact ID），DB 只保存受管相对路径；新文件不会覆盖旧版本。
- 领取、效果派发与步骤提交分别使用短事务；Fake 模型生成和受管文件读取/发布在事务外。派发前控制先提交则不发布；派发先提交则控制保持 PENDING，待目标核对/提交或显式处理后才 APPLIED。成功步骤不重放。成功发布但步骤事务尚未提交时仍视为未决；若内容丢失/损坏，动作降为 UNKNOWN，不放行控制。若已核对成功且控制在等待，未提交的尝试标记为被控制抢占，发布文件保留为可追溯孤儿，控制才可应用。
- 内部 `scanRecoveryCandidates` 只报告租约到期或有持久 fence 记录的未决动作，当前没有生产调度器自动调用它。内部 `recoverStoppedWorker` 要求调用方提供旧 Worker 已停止的依据；用例提升 Run epoch，并写入 `run_worker_fences`（旧 Worker ID、该依据、新 epoch 的结构化事实，0129 起；同时保留 `activity_records` 追溯记录），再次重启可用该表、Attempt worker ID 与当前 epoch 复核。生产进程管理器自动确认退出尚未实现。只有同一目标确实不存在、当前无新 claim 且有持久 fence 证据，才将原动作重置为 PREPARED，下一次仍使用原 `operation_id`。`UNKNOWN` 或成功日志与目标文件不符不能仅凭租约重发；租约到期本身不等于进程已停。
- **兼容与回滚**：旧 HUMAN Task 的状态与既有 Run 行满足新 CHECK，新增 Worker 列有默认/NULL，旧数据可升级；旧应用版本不理解新增控制状态与 WAITING，部署需与 API 同步升级。迁移只追加/替换约束，已应用文件不能改写；没有 down migration，回退依赖备份及相容版本。P08 只覆盖同机受管 Fake 文件动作，尚无跨 Task 工作目录资源 claim、实际工具准入、通用操作核对报告/孤儿清理和断电持久性证明；这些是后续独立边界。
- **0129 结构化 fence 事实（2026-10-21）**：追加 [0129_run_worker_fences.sql](../../../apps/api/migrations/0129_run_worker_fences.sql)。`run_worker_fences` 以 `(run_id, worker_epoch)` 为主键，保存 `stopped_worker_id`、`stopped_evidence` 与 `created_at`；CHECK 拒绝空 Worker ID 和非正 epoch，索引支持按 run 与旧 Worker 查询；`relay_app` 只有 `SELECT/INSERT`，审计记录仍只增不减。恢复扫描与重入改为按表匹配 run/epoch/worker，不再依赖 `activity_records.fact_refs` 的 JSON 文本：审计被裁剪、字段改名或写入格式变化都不影响 fence 判定。迁移从既有 `RUN_WORKER_FENCED` 审计回填格式合法（UUID 与正整数 epoch）的记录并 `ON CONFLICT DO NOTHING`；已被裁剪或格式损坏的历史 fence 无法还原，只能人工核对。没有 down migration；回退需备份和能理解新表的应用版本，旧版本忽略该表时仍可按原审计路径工作但会失去结构化保障。

## 19. 0008 Fake Gateway 与权限准入（2026-09-23 P09）

实际 DDL 见 [0008_v003_gateway.sql](../../../apps/api/migrations/0008_v003_gateway.sql)。本迁移追加在已应用的 0001–0007 后，不改写其内容或摘要；现有 Run、Review 与 P08 受管发布数据不用重填。没有 down migration，回退依赖备份和能理解新表的应用版本。

- `gateway_capabilities` 固定 Fake 写/公共读两项；`gateway_connections` 保存所属 Project、状态和递增 version，`gateway_connection_capabilities` 单独保存能力。P09 Fake 的 `config` 和 Operation/Invocation 连接快照有数据库 CHECK，只能是 `{}`，不能用这些列存 token 或 secret。真实适配器的 `secret_ref` 与配置格式需后续迁移和准入再设计。
- `gateway_permission_policies` 是可撤销根，`gateway_permission_versions(policy_id,version)` 保存不可变目标范围、Capability、AUTO/ASK/DENY 和字节上限，根上的 `active_version/revision` 是当前指针。策略更新和 Connection 停用先取 Workspace authority 写锁并递增其 revision；Admit 先取 SHARE，在同一短事务重读活动版本、实际目标、参数、连接能力与 Review。准备时冻结 connection version、空配置快照、policy version、规范目标和 SHA-256 参数摘要，批准目标也含这些身份；新版本或撤销使旧批准失效。
- `managed_resources` 保存 realpath 规范根、大小写规范 identity_key、状态、resource_epoch/revision；同 Project 的完全重复根唯一，跨 Project 或 Workspace 可以登记相同/父子根。`resource_claims` 保存 Task/Run/Worker epoch、资源 epoch、唯一 claim_token 与 HELD/QUARANTINED/RELEASED。单 resource_id 的部分唯一索引阻止双占用；不同 ID 的父子根由同一个 PostgreSQL advisory 事务锁与全部已占用根扫描串行。租约过期不释放 QUARANTINED。当前以 realpath 和路径段比较做同机 Fake 演示，不能证明对 Windows junction、挂载变化或宿主外进程的完整隔离。
- `import_jobs` 绑定真实 Workspace/Project、用户主体、配置版本、来源 URI 和请求 command_id，状态为 QUEUED/RUNNING/SUCCEEDED/FAILED；P09 只建立内部固定 Fake 公共读来源，不宣称已生成 KnowledgeVersion。`logical_operations` 以 RUN 或 USER_IMPORT 明确来源，复合 FK 绑定 Project/Task/Run/Step/Resource/ImportJob/Connection/策略版本；`invocation_attempts` 绑定来源及完整 claim 身份，约束 USER_IMPORT 无 Run/claim、RUN 必有 Worker/claim。一个 intent_key 只能表示同一逻辑动作，新的 Invocation 可复用原 operation_id；未决状态有部分唯一索引。Run 或 ImportJob 的另一未决动作会阻止换 ID 绕开 UNKNOWN。
- `approval_reservations` 以 Review/Operation 复合 FK 把批准占用限定为原 Review 所指动作，`invocation_approval_bindings` 每次尝试独立记录消费，同一 Review 的两次并发决定由 Review revision/唯一决定约束裁决。Admit 先成功提交 DISPATCHING 才调用一次 Fake；效果和数据库不假装原子。PREPARED 且有旧进程停机依据可记 NOT_EXECUTED 并以原 Operation 新建 Invocation；DISPATCHING/UNKNOWN 时目标缺失仍保持 UNKNOWN，因为文件可能先写入再被移除。旧 Worker 结果只作为核对证据，不推进新 owner。
- 应用角色仅对这些表具有所需 DML，无迁移 DDL 权；当前 Invocation/批准记录须保留历史而不是覆盖。内部 reconcile 需要调用方提供旧进程已停依据，尚无生产进程管理器自动证明；真实工具、任意本地文件写、断电持久性和孤儿效果处理留后续阶段。

## 20. 0009 长期信息与规则栅栏（2026-09-23 P10）

实际 DDL 见 [0009_v004_information_rules.sql](../../../apps/api/migrations/0009_v004_information_rules.sql)。这是追加迁移，不改已应用的 0001–0008 或其 SHA；旧 Workspace authority 以 `rule_revision=0` 补齐，旧 Run 的冻结契约无此字段时按 0 解释。没有 down migration，回退需备份与能读取新表的应用版本。

- `knowledge_items/versions`、`memory_items/versions`、`decisions/decision_versions`、`rules/rule_versions` 各有类型化根、当前版本指针和不可变版本。根的 `current_version` 有延迟外键指向本根版本，创建事务可先写根后写 v1；应用角色对版本表只有 SELECT/INSERT，没有 UPDATE/DELETE。Memory 版本的确认主体固定为 `user:local`；Rule 有 Workspace/Project/Task 真实外键，Task Rule 还以复合 FK 核对所属 Project。
- Knowledge 的 NOTE/MANAGED_TEXT 正文直接作为不超过 256 KiB 的不可变 PostgreSQL 文本保存，SHA-256 与媒体类型同版本；本阶段不使用受管文件目录保存这两类正文。ArtifactVersion 来源只保存确切版本 FK、原内容 hash 和类型化 `source_refs`，不复制正文；同 Workspace 的来源版本有唯一约束。应用以事务级 advisory 锁串行同来源并发提升，返回同一 Knowledge 身份。`scope_key` 生成列与复合 FK 防止版本行错连另一 Project 的 Knowledge 根；Artifact 复合 FK 防止把 Project A 的来源直接挂到 Project B，Workspace 全局根目前不接受 Project Artifact 的提升。文件实际可用性仍须在读取 Artifact 内容时核对，Knowledge 元数据不能证明文件没有损坏。
- Decision 根上的 `superseded_by_id` 保留替代链；应用用例以 authority 写锁串行替代、要求同 Project/Workspace 范围和活动状态、拒绝自指与已有替代链形成环。数据库直接 DML 没有递归无环触发器，模块写入口是该业务不变量的 Owner。Rule 版本保存 key、strength、applicability、enforcement、method 和 target_spec；`workspace_execution_authority.rule_revision` 在 Rule 创建、追加版本、退役时递增，Delegate 持 authority SHARE 冻结当前值与所有适用来源引用。
- 活动 Run 的步骤领取/提交、P08 受管发布派发、P09 Gateway Worker 领取/Prepare/Admit 先取 authority SHARE 并核对冻结 `rule_revision`。更新先取 UPDATE，因此规则更新与 Delegate/准入具有确定提交顺序。栅栏目前是 Workspace 全局版本：更新其他 Project 的 Rule 也可能使旧 Run stale，换取本阶段单一串行点；后续可在保持来源版本绑定的条件下缩小影响范围。已发布或已 Admit 的效果仍保存原 Attempt/Invocation outcome，不能因新规则抹去已发生动作；后续动作拒绝。
- 搜索读取只用 Workspace/Project、状态和当前版本，游标包含匹配级别、完整 PostgreSQL 更新时间、ID 与类型，避免同毫秒内翻页丢项。当前索引支持作用域/状态筛选，中文字面 `ILIKE` 仍可能扫描该作用域记录；没有 pg_trgm、向量、标签或正文提取索引，实际规模与性能需 P21 测量。URL 抓取、`import_jobs.knowledge_version_id` 完成绑定和提取器版本属 P17；本迁移不回填或声称这些来源已可用。

## 21. 0010 Context 来源版本与 Manifest（2026-09-23 P11）

实际追加 DDL 见 [0010_v005_context_revision.sql](../../../apps/api/migrations/0010_v005_context_revision.sql)：仅给 `workspace_execution_authority` 增加非负 `context_revision`，旧 Workspace 默认 0；0001–0009 内容和 SHA 不改。Knowledge/Memory/Decision 的创建、追加版本、退役/替代先取 authority UPDATE 再写根与版本，完成时递增该列；Rule mutation 在原 `rule_revision` 外也递增 Context 版本。Gateway Permission/Connection 变更使用原 authority `revision`。Builder 领取、提交仍按 authority→Task→Run 锁序，并在提交时核对两类 authority 版本和 Project/Task revision；Project 在 Task/Run 后取 SHARE 复核，避免构建途中标题等实际来源改变。

沿用 0004 的 `context_manifests` 不可变表及 `(run_id,manifest_hash)` 唯一约束，不新增第二个 Context 事实表。P11 的 `payload` 保存真正送给 FakeModelPort 的来源片段、UTF-8 字节范围、片段/全文 SHA-256、来源版本、选择/裁剪原因、预算估算、模板/Builder/Profile 摘要及当前依赖版本。文本资料与确切 ArtifactVersion 来源分开：后者在事务外通过受管内容存储复核原 hash/size 后才选入，缺失/损坏不冒充空正文。来源更新导致新 hash/新 Manifest；旧 Manifest 保留原字节作为历史证据，但公开详情按当前 Workspace/Project、根状态、Memory 到期和 Artifact 可用性重新过滤，受限来源的 ID/名称/正文及逐条排除项均不返回。无 down migration；回退需备份及能识别新增 authority 列/Manifest payload 的应用版本。

## 22. 0011 Run 命令、投递与整线程领取（2026-09-24 M03 首片）

实际 DDL 见 [0011_m03_run_dispatch.sql](../../../apps/api/migrations/0011_m03_run_dispatch.sql)。`run_commands` 以 UUID 为内部命令身份，记录 `workspace_id/run_id/source_command_id/kind`；应用角色只有 SELECT/INSERT，`(workspace_id,source_command_id)` 唯一。原 HTTP `command_id` 仍由 `command_receipts` 的 payload hash 判定同/异载荷；内部投递 UUID、图线程 `run_id` 和工具 `operation_id` 互不替代。`run_command_outbox` 只保存 PENDING/CLAIMED/DONE/BLOCKED 及领取 epoch；通知可丢，扫描 PG 才是恢复入口。`run_invocations` 每 Run 一行，`epoch` 递增；ACTIVE/STOP_REQUIRED 在租约过期后继续占位，不凭时间自动改回 IDLE。旧 Run 只补 IDLE 行，不创建 START，故旧工作不会在升级时自动执行。

Delegate 延用现有 Task 行锁、Run/契约/步骤写入、Task CAS 和回执事务，新增 START/outbox/invocation 也在同一事务；注入 outbox 后异常的真实 PG 测试确认这些事实整体回滚。独立 Worker 从 PG 选候选，先锁 Run，再锁 outbox 和 invocation，只有 IDLE 可领；旧 `runs.worker_id` 是单步 claim，不能充当整线程锁。Worker 续租与业务步骤开始、效果派发、结果提交均核对 invocation epoch 和数据库租约；逾期结果被拒绝。受监督的 Mock Worker 子进程 `close` 才提供停机事实，随后调用原 `recoverStoppedWorker` 核对单步 claim 与原 `operation_id`，无未决动作时重新置同一 outbox 为 PENDING。监督器若自身死亡而未观察到退出，保留占位等待可信处置；本协议尚未对任意外部工具子进程提供停机证明。

独立源码审查后补齐了两个短事务栅栏：长时间准备后新增 PREPARED 效果意图、以及已有 DISPATCHING/UNKNOWN 的效果结果更新，均在 Task/Run 锁下重新核对单步 Worker/epoch、Task 执行权与当前整线程 invocation/租约。旧 Worker 迟到时不写业务效果状态；已经发生的外部发布仍由可信停机后的恢复入口按原 `operation_id` 核对，目标损坏保持 UNKNOWN。启动前取消不领取；领取期间取消而尚未执行的 claim 等监督器观察子进程退出再重排。真实 PG 红灯与修复证据见 [M03 首片记录](../../development/m03-run-dispatch-slice.md#独立源码审查后的失租修复)。

本迁移只追加新表、索引与应用角色最小权限，不改 0001–0010 的内容摘要；无 down migration，回退依赖备份及能读新表的应用版本。首片未增加可靠事件表、图 checkpoint 或完整恢复命令；它们属于 M03 后续切片。

第二片桌面私有监督协议不改变 0011 DDL。宿主证明旧 Windows Job 整组停机后，监督器只扫描带该 `launchId` 的 ACTIVE/STOP_REQUIRED invocation；每 Run 持有 PostgreSQL session advisory 锁，在锁内重新检查 worker/epoch/command/status、核对原效果、条件式重排同一 outbox。锁跨受管内容核对，但不打开长业务事务；它只串行并发监督器，不能代替 OS 停机证明。若 `SUCCEEDED` 效果的 Attempt 仍为 RUNNING，恢复先核验受管目标 hash/size；完整时可保留原 Attempt/`operation_id` 重新入队，由下一 invocation 完成业务提交，损坏时转 UNKNOWN 并阻断。DISPATCHING/UNKNOWN 仍按原 `operation_id` 核对，不能凭目标缺失换动作身份重发。具体进程反例见 [M03 第二片记录](../../development/m03-run-dispatch-slice.md#桌面私有监督与旧-launch-恢复第二片)。

## 23. 0012 Run 刷新事件（2026-09-24 M03 SSE 后端片）

实际追加 DDL 见 [0012_m03_run_events.sql](../../../apps/api/migrations/0012_m03_run_events.sql)。`run_events(run_id,seq)` 是每 Run 持久刷新提示，首序号为 1，`kind` 只标识改变的事实类型，不保存正文、凭据、来源 ID 或业务快照。已有 Run 不回填历史事件；初次订阅仍须读取权威 Run 快照。此迁移不改 0001–0011 内容/SHA，新增表只授予 `relay_app` SELECT/INSERT，没有 UPDATE/DELETE；无 down migration，回退仍依赖备份和相容应用版本。当前事件不裁剪、不设 TTL；静默删除历史会让游标断续，因此保留规模和清理协议须先经过独立设计与测量。

每个业务事实的 AFTER trigger 在**原写入事务**中先取对应 Run 行 `FOR UPDATE`，再读取 `max(seq)+1` 并插入事件。Run 行锁使同一 Run 的分配和提交顺序一致，事务回滚连同事件一起回滚，不留下序列空洞。触发器不成为 Run/Step/Review/Control/Effect 的第二个写入 Owner：它只发 UI 重读提示。Run 创建时触发 `RUN_CHANGED`；Run 状态、revision、当前步骤、等待原因或终止时间真实改变时发事件；Step、Attempt、Run Review、Control、受管 Effect 的可见状态或结果真实改变时分别发对应事件。无变化 UPDATE、Run/Attempt lease 心跳不发事件。State 提案 Review 没有 Run ID，故不发 Run 事件。

原业务路径的锁序仍以 Task→Run 为主：Delegate 先锁 Task 后插 Run，Step/Attempt/Review/Control 写入先锁 Task/Run，触发器取得的是当前事务已经持有的 Run 锁。恢复路径中原有两个直接 `resolveEffect` 写点已改为先锁 Task→Run 再写 Effect，避免触发器从已锁 Effect 反向等 Run；其余 Effect 准备、派发和结果写入沿原 Task→Run→Effect 栅栏。真实 PG 受控竞争测试让另一事务持 Task→Run 再等 Effect，验证恢复核对不会造成反向死锁。`run_invocations`、outbox 的领取和续租是内部运输状态，当前 Run HTTP 投影不暴露它们；这些写入不触发刷新提示。API 空批定期再查 PG 已提交事件，不能从通知或单次查询推断历史已完整。

## 24. 0013 每 Run 命令顺序与 Review 唤醒（2026-09-24 M03 后端片）

追加迁移见 [0013_m03_run_command_order.sql](../../../apps/api/migrations/0013_m03_run_command_order.sql)。`run_commands.ordinal bigint NOT NULL` 按既有 `created_at,id` 在每个 Run 内确定性回填，新增正整数检查和 `(run_id,ordinal)` 唯一约束；新命令由 Task→Run 短事务内锁住 Run 行后分配 `max(ordinal)+1`。`review_decision_id` 可空且唯一，外键指向不可变 Review 决定，只允许 `RESUME` 使用；此前 START 无需伪造 Review 关联。应用角色继续只有 `run_commands` SELECT/INSERT，不能改写 ordinal 或决定绑定。0013 不改写 0001–0012 的 SQL/SHA；无 down migration，回退依赖备份及相容应用版本。

Review 决定事务先锁 Task→Run→Review，在同一事务写决定、业务状态、RESUME/outbox、活动和 HTTP 回执；写 outbox 失败时这些事实整体回滚。手工 PAUSED→可运行状态同事务写 RESUME/outbox/回执；PAUSED→WAITING_APPROVAL 只恢复等待，不生成可运行命令。轮询与领取短事务均检查较小 ordinal 的 outbox 已为 DONE，且整线程 invocation 为 IDLE；BLOCKED 前驱不能被后继越过。旧 START 在 Review 形成后若进程于结清前退出，可信停机恢复只重排原 START；新的 Worker 在 Task→Run 锁内发现已提交的后继命令后仅将旧 START 结清，不执行审批后的 COMPLETE。本顺序片当时固定 Worker 排除 `ACTION_APPROVAL` 的 RESUME；随后接入的固定 Mock Gateway 图节点见第 26 节。无论哪一阶段，队列本身都不授予外部效果。

已批准的 ACTION_APPROVAL 若在未 Admit 前被 PAUSE/CANCEL/HANDOFF 安全点撤回，应用在同一 Task→Run 事务中锁住原 `review_decision_id` 对应的 outbox，将仍为 PENDING 的 deferred RESUME 标为 DONE，并将原 operation 标为 DENIED、提交控制和 Run/Task 状态。任何一步失败均回滚；CLAIMED/BLOCKED 的异常投递使控制失败关闭，不伪造效果成功。`run_commands`、Review 决定与 operation 身份不修改；此处 DONE 是运输结清而非外部效果结果。待处理控制优先于旧 START 的后继命令判定，否则旧 invocation 可先退出而让控制永久 PENDING。Gateway claim 和 Admit 分别重核有效期、Connection、Permission；两事务间撤权后，仅无 Invocation 的 WAITING_APPROVAL 原 worker/epoch 可释放，DISPATCHING/UNKNOWN 保持占有及原身份对账。该修复无需改写 0013 或新增迁移。

## 25. 官方图检查点的独立安装（2026-09-24 M03 后端分片已独立验收）

图检查点没有追加 Relay 业务 migration；受信 `install-graph.js` 在业务迁移完成后，以 `RELAY_MIGRATION_DB_URL` 调用官方 PostgresSaver 1.0.5 的 `setup()`。安装入口持有会话级 advisory lock 跨越官方 Saver 自己的连接/DDL，再核对官方整数迁移版本恰为 `0`–`4`，最后授予 `relay_app` 固定 `relay_graph_v1` schema 的 USAGE、迁移台账 SELECT 与三张 checkpoint 表 SELECT/INSERT/UPDATE。官方整数台账不继承 Relay migration 的 SHA 与单事务保证；代码不改写既有 `0001`–`0013`。根图写入空 `checkpoint_ns`，因此以物理 schema 固定图契约版本；未来升级图结构必须另评估兼容性或使用新固定 schema，不靠改变 thread ID 掩盖旧历史。

API 不需要 Saver；Worker 与 supervisor 在领取前只读核对业务 schema、图整数台账与角色权限，并调用官方 Saver 对不存在的保留 thread 执行 `getTuple`，以发现缺表或列损坏。运行角色不能运行 `setup()` 或写台账。图 checkpoint 是可重放的编排证据，仍应随 PG 备份；当前不清理活动、Review 等待、恢复中或 UNKNOWN 的 thread。业务效果和 checkpoint 分属不同事务，业务提交后而 checkpoint 前退出时按原 attempt/`operation_id` 重入；不得为重放另造效果身份。失败安装或不兼容表结构使 Worker 在 claim 前失败关闭。回退依赖备份及兼容应用版本，不提供自动 down migration。

## 26. 固定 Mock Gateway 动作接入现有图（2026-09-24，开发自检中）

此片不追加业务 migration，也不改写 0011–0013 或 PostgresSaver 官方表。可选 Delegate 意图在既有不可变 `execution_contracts.frozen_snapshot` 保存唯一 `operation_id`、连接/资源 ID、目标与内容；Review、`logical_operations`、`gateway_invocations`、资源 claim、Run 命令和 outbox 继续使用原表。DRAFT 提交后图在 PERSIST 前以原意图调用 Gateway；ASK 的 Review、operation、旧 START 与批准后 RESUME 保留各自身份。批准本身不执行效果；仅确有同 `operation_id` 冻结 Mock 意图的 Review 才自动插入图 RESUME，旧 P07 预留审批与 P09 直接 Gateway 不形成无法领取的命令。RESUME 必须绑定原 Review 决定，且此前命令为 DONE、外层 invocation 为 IDLE；准入时仍核对批准有效期和当前 Connection/Permission/目标。DENY 或确定的准入前撤权将冻结 Mock 的原 operation 记 DENIED，必需动作的 Run 变 FAILED、Task 返 READY；DISPATCHING/UNKNOWN 不走这条无效果路径。

外层 command/epoch 与 Gateway 内层 worker/epoch 在 Task→Run 业务写点同时受栅栏保护；Admit 后至 Fake WRITE_MARKER 前还在短 Task→Run 事务重核内层 `worker_lease_until`、原资源 claim 与外层 invocation。租约已过期时不进入 adapter；效果已发出但结算时内层租约过期则只写原 Invocation/operation UNKNOWN，并将原 claim 置 QUARANTINED。外层续租不代替内层租约，过期本身也不授权新的 Worker 抢占。崩溃后的 PREPARED/DISPATCHING 只能在可信旧进程停止后按原 Invocation 和原 `operation_id` 核对；NOT_EXECUTED 才可在授权仍有效且无 PENDING control 时用原 ID 重试，SUCCEEDED 不重发，UNKNOWN 隔离。Graph checkpoint 与业务/效果事务不原子；旧 ACTION RESUME 在后继验证 Review 处退出重投时，只能结清旧投递，不能唤醒新 Review。控制在外层 invocation ACTIVE/STOP_REQUIRED 时保持 PENDING；命令结清释放后尝试应用，supervisor 对 PG 中空闲的 PENDING 控制分页补查，覆盖两次提交之间的进程退出。应用仍以 Task→Run 锁复核真实状态，不以扫描结果直接改事实。

## 27. 0015 Assist 会话、消息与类型化提案（2026-09-25 M04 开发自检）

`0015_m04_assist` 新增三张 Assist 专属表，全部授予 `relay_app` `SELECT/INSERT/UPDATE`（无 DELETE；Assist 行不删除，归档/决断用状态表达）。`assist_sessions`（Workspace/Project/Task 可空外键、ACTIVE/ARCHIVED 状态、revision）按 Workspace 作用域过滤；绑定 Task 时作用域由应用用例跟随 Task 归属，SQL 层不强制 project/task 一致（跨作用域一致性是用例校验，不是行约束）。`assist_messages` 以 `(session_id, seq)` 唯一递增，`role` 分 USER/ASSISTANT；USER 行恒为 COMPLETED 且必须带正文，ASSISTANT 行按 PENDING/RUNNING/COMPLETED/FAILED/CANCELLED 生命周期受 CHECK 约束（未结算状态无正文、COMPLETED 必有正文）。`intent` 记录生成意图（DISCUSS/PROPOSE_CANDIDATE/PROPOSE_TASK），`sources` jsonb 保存冻结的显式来源引用及生成后写回的实际发送状态（SENT/UNAVAILABLE + 截断与 hash）；0015 当时用量列以 0 为缺省，后续 `0018` 已改为可空并新增统一调用事实（第 30 节）。领取用部分索引 `ix_assist_messages_claim`（仅 PENDING）+ `for update skip locked` 单语句原子领取；RUNNING 行靠生成心跳续 `updated_at`，租约清扫只收敛超时行（LEASE_LOST）。

`assist_proposals` 由 CHECK 固定两类形态：`CANDIDATE_MARKDOWN` 必须指向 TASK（`target_id=task_id`），`TASK_DEFINITION` 必须指向 PROJECT（`target_id=project_id` 且无 task）；`base_revision` 保存提案冻结时的目标 revision，`payload_hash` 为规范 JSON 摘要，`status` PENDING/ACCEPTED/REJECTED/EXPIRED 由 CAS 结算（`decided_at` 只在首次决断写入）。接受提案不另设第二套写入路径：`AcceptAssistProposal` 在单事务内以 FOR UPDATE 持锁贯穿，复用 `CreateArtifactWithVersion`/`CreateTask` 抽出的 `prepare*`/`apply*` 事务内效果（与人工 HTTP 命令同一校验路径），回执（`(scope_key, command_id)` 主键，命令类型 `AcceptAssistProposal`）与提案状态同事务提交；base_revision 落后时业务校验的 REVISION_CONFLICT 在同事务先收敛 EXPIRED、提交后再抛出，避免「结算被回滚」的中间态。提案接受不产生底层命令自己的回执（效果证据在 accept 回执 `result` 与 `decision` 中）；State 提案仍复用既有 Review/State 机制，未在本 migration 引入。

## 28. 0016 WEB_FETCH 公共网页只读适配器（2026-09-25 M04 开发自检）

`0016_m04_web_fetch` 只放宽受守卫形态：`gateway_capabilities` 新增 `('WEB_FETCH','REAL','READ')`；`gateway_connections` 的 REAL 形态放宽为 `root_path` 与 `allowed_host` 两种互斥配置（WEB_FETCH 可附 `allow_private: true` 显式登记允许保留地址，`false` 不落库——缺省即拒绝，SQL 形态拒绝显式 false）；`logical_operations`/`invocation_attempts` 的 connection_config 形态同步放宽。WEB_FETCH 逻辑动作目标为 URL 而非文件系统工作区，`ck_logical_operation_resource` 新增 `resource_id IS NULL` 形态，`ck_invocation_run_identity` 新增「RUN + 无资源 + 无 claim」形态（ownership/worker 身份仍必填）；资源 claim、`rootsOverlap` 排他与文件读写路径完全不受影响。

执行边界在 `src/web/web-fetch.ts`：逐跳 scheme/主机校验 + DNS 全地址保留段检查 + 直连已校验地址（防重绑定）；连接不活跃 10 秒、总请求 30 秒、响应体 5 MiB、正文提取截断 128 KiB 字符；结果（原/最终 URL、状态码、hash、提取正文）进 Invocation `result_ref`。读取语义与 FILE_READ 同构：类型化失败结算 FAILED 并释放（无 claim 可释放即无副作用）、reconcile 安全重读；UNKNOWN 只属于进程不确定，不属于网络失败。

## 29. 0017 URL 导入与 Knowledge 结算（2026-09-26 M04/P17 开发自检）

追加迁移 [0017_m04_web_import.sql](../../../apps/api/migrations/0017_m04_web_import.sql) 放宽 `logical_operations.ck_logical_operation_resource`，允许 `USER_IMPORT + WEB_FETCH + resource_id IS NULL`；`knowledge_versions` 增加受约束的 `WEB_PAGE` 形态：不可变正文、`source_uri` 非空、媒体类型为 `text/plain` 或 `text/markdown`、UTF-8 正文不超过 256 KiB。`import_jobs.connection_id` 以 Workspace 复合外键绑定 Gateway Connection，`knowledge_version_id` 指向成功版本；`review_requests.import_job_id` 指向等待批准的 Job，并建立查询索引。既有迁移文件不改写，无 down migration；回退依赖备份和兼容应用版本。

创建命令的 `command_id` 回执与 Job 插入同事务。Worker 扫描 QUEUED，以及状态已改 RUNNING 但尚无 operation 的崩溃遗留 Job；同一 Job/intent 使用稳定 `operation_id`，Gateway 的唯一 intent 约束阻止并发重建动作。已成功的 WEB_FETCH Operation 与 Knowledge 根/版本、Workspace Context revision、Job SUCCEEDED/`knowledge_version_id` 在一个短事务结算；若此事务失败，下一 tick 只按原 Operation 证据重试结算。已失败的 Operation 同样按原结果补结算 Job FAILED。`DISPATCHING` 未结算 Invocation 不在自动重扫范围，仍要求可信旧进程停机后以原 Invocation 核对；扫描不能把租约到期当停机证明，也不能重发新动作身份。真实 PostgreSQL 定向集成覆盖这两个 RUNNING 崩溃窗口、单版本结算和 Workspace 隔离查询；属于开发自检，不替代 M04 独立验收。

## 30. 0018 统一模型调用事实（2026-09-26 M04 开发自检）

追加迁移 [0018_m04_model_calls.sql](../../../apps/api/migrations/0018_m04_model_calls.sql) 新增 `model_calls`，每次 DRAFT、SEMANTIC_CHECK、ASSIST 的 Fake/真实端口调用各用独立 UUID 主键。DRAFT 绑定 `step_attempt_id` 与 `manifest_id`；语义检查绑定 `step_attempt_id`、`criterion_id`、`check_attempt`，其 CheckResult 证据另存 `model_call_id`；Assist 绑定 `assist_message_id`。关联列为外键并以形态 CHECK 限制互斥；Workspace ID 来自原 Run 或 AssistSession。`provider`、`model` 只保存非敏感标识，`config_fingerprint` 是不含密钥与 endpoint 的模型参数 SHA-256；不保存提示词、响应正文、endpoint 或凭据。按 StepAttempt/AssistMessage 和 Workspace 时间建立查询索引，应用角色可 SELECT/INSERT，UPDATE 仅限结算字段，无 DELETE；原调用身份与关联不能由应用角色改写。

调用前以独立数据库写入提交 `STARTED`，得到响应后只允许从 STARTED 一次结算为 COMPLETED/FAILED/CANCELLED；已知的 Provider request id、输入/输出 token 数分别记录，未知列为 `NULL`，不能以 0 冒充。Provider 已返回但提案 JSON 未通过业务 schema 时，调用可为 COMPLETED 而 AssistMessage 为 FAILED；VERIFY 外层业务事务回滚时，已经发生的调用仍留痕，不伪造 CheckResult。崩溃遗留 STARTED 不自动变为成功、失败或零用量；重入再次实际调用新增行，旧行不覆盖，不能据此推断供应商只计费一次。AssistMessage 的用量只是当前消息投影，汇总应以 `model_calls` 为唯一来源，不能和消息列相加。此表是计量证据，不控制 Run/验证/Assist 生命周期，也不进行金额结算。

## 31. 0019 DRAFT 读取输入追溯（2026-09-26 M04 开发自检）

追加迁移 [0019_m04_draft_read_input.sql](../../../apps/api/migrations/0019_m04_draft_read_input.sql) 为 `model_calls` 增加可空 `input_sha256`、`read_operation_id`、`read_invocation_id`。后两者必须同空或同有，且只允许 DRAFT；分别以 FK 指向原 Gateway 操作与实际调用，另建按 operation 查询索引。新增列在模型请求前的 STARTED 插入中写定，不在结算时修改；应用角色既有表级 SELECT/INSERT 权限适用，UPDATE 仍只限原结算列。旧行保持 NULL，不能倒推其历史输入摘要。摘要使用 `draft-input-v1` 的规范 JSON（实际 Manifest、输出 schema 与结构版本）；读正文仍只存在 Gateway Invocation，计量表不复制内容或凭据。该摘要追溯结构化模型输入，不能据此断言 Provider 的私有提示词处理或确定性输出。

0018 同时移除 `assist_messages.usage_input_tokens`/`usage_output_tokens` 的 0 缺省和 NOT NULL；历史 USER 行及双 0 行因无法分辨“已知精确零”和“未知”，保守回填为 `NULL`，已有正数保留。Assist API 同名 `usage` 字段的子值因此可为 `null`，客户端应按未知展示；迁移不改写已应用的 0015 文件或 SHA。无自动 down migration，回退依赖备份与理解 nullable 用量的新应用版本。真实 PostgreSQL 开发回归覆盖三条调用路径及失败、取消、崩溃遗留状态；未进行 M04 独立验收或真实 Provider 外呼。

追加迁移 [0049_m04_model_call_cache_usage.sql](../../../apps/api/migrations/0049_m04_model_call_cache_usage.sql) 给 `model_calls` 与 `assist_messages` 各加可空 `usage_cache_read_tokens`/`usage_cache_creation_tokens`（CHECK `>= 0`）。语义与 0018 一致：`NULL` 是“Provider 未上报”，不是“缓存为零”，因此**不做任何回填**——历史行保持 NULL 才是诚实的未知。两处守卫：`model_calls` 上 CHECK 要求两者之和不超过 `usage_input_tokens`（Provider 口径不一致时不落库自相矛盾）；`assist_messages` 上 CHECK 要求 `role <> 'USER'` 时缓存列才可非空，因为 USER 行从不是一次模型调用。列权限沿用各自现状：`model_calls` 是列白名单式 UPDATE（0049 追加两个列名），`assist_messages` 在 0015 已有表级 UPDATE，无需追加 GRANT。真实 PostgreSQL 回归覆盖「补列前后历史调用行为 NULL」与错误信封三层（`model_calls` → `assist_messages` → HTTP DTO）一致性；未进行 M04 独立验收。

## 32. 0020 Today 用户选择与 Task 调度元数据（2026-09-26 M05 开发自检）

追加迁移 [0020_m05_today_selections.sql](../../../apps/api/migrations/0020_m05_today_selections.sql) 给 `tasks` 加可空 `priority`、成对 `due_local_date date`/`due_timezone`；旧 Task 行保持 NULL，更新只递增 Task revision，不触及 acceptance_revision。`today_selection_states` 每 Workspace 一行保存全局选择 revision，首次命令惰性建立并锁行；`task_selections` 以 Task 为主键，存 Pin、成对 Later 日期/时区及最后写入的选择 revision，双清除删除行；`focus_selections` 以 Workspace + 本地日期为主键，保存时区与三选一的 Goal/Project/Task 目标，复合外键阻止跨 Workspace ID。Focus 清除删除该日行；同日换时区须通过原全局选择 revision 显式写入。

写命令先核对并锁目标 Task/Project（Goal 读取验证范围），再锁 `today_selection_states`，用全局 revision CAS 串行化变更；命令回执与选择事实同事务提交。Task 元数据命令沿 Task 行锁与 Task revision CAS，不把 Today 用户选择混进 Task 验收版本。Today 查询以 PostgreSQL 可重复读快照装配，只读当前事实；Later 截止和查询观察点分别用日期 `AT TIME ZONE` 将 IANA 时区当地 00:00 转为绝对时刻，不以 UTC 日期覆盖用户选择。应用入口校验真实日历日期与 IANA 时区；表的成对 CHECK/复合外键提供持久形态及范围兜底。无自动 down migration；回退须先备份新增用户选择，不改写既有迁移或 SHA。

## 33. 0021 Activity 范围与精确 Artifact Lineage（2026-09-26 M05/P15 开发自检）

追加迁移 [0021_m05_activity_lineage.sql](../../../apps/api/migrations/0021_m05_activity_lineage.sql) 给 `activity_records` 增加非空 `workspace_id` 与可空 `run_id`。历史 Workspace 初始化由 `fact_refs.workspace_id`、Goal 创建由 `fact_refs.goal_id → goals.workspace_id` 回填；其余 Workspace 由 Project/Task 归属或原命令回执作用域定位，Run ID 另由原 Run/Review/Operation/Control 引用定位。无法归属或 Task/Run 归属冲突时迁移整体失败，不让旧事件在 Workspace 分页里静默消失。Workspace/Project/Task/Run 复合外键限制新写入，`(workspace_id,created_at DESC,id DESC)` 及 Run 过滤索引支撑稳定游标。审计写入仍与对应业务事实共用短事务，查询只发布脱敏白名单；旧 `fact_refs` JSON 保持历史证据而不直接对外。

新增 `artifact_lineage_edges`：`child_version_id` 指向不可变 ArtifactVersion，`relation` 与 `parent_kind,parent_id` 是受 CHECK 限定的 typed relation，`workspace_id` 显式绑定，唯一键 `(child_version_id,relation,parent_kind,parent_id)` 使同一确切关系幂等。插入触发器在 Workspace 事务级 advisory 锁下核对 child/parent 真实归属，`REVISED_FROM` 必须指向同 Artifact 更早版本，`GENERATED_BY` 必须是该 Task 的 `PERSIST_CANDIDATE` Step，`VERIFIED_BY` 必须有该 session 的 VerificationTarget，`ACCEPTED_BY` 必须在该 CompletionRecord 的接受版本集合中；ArtifactVersion 父关系拒绝自环和递归环。锁只串行 Lineage 边插入，不包外部模型/文件调用；应用角色只有 SELECT/INSERT，没有 UPDATE/DELETE。现有产物保存、验证结算和完成提交在各自业务事务插入确切边；没有来源事实时不生成推断边。

0021 不改写旧迁移或内容摘要；无自动 down migration。回退须备份审计归属与 Lineage 边，并使用理解新非空审计字段的应用版本。真实隔离 PostgreSQL 迁移回归覆盖历史回填、无法定位行整体回滚；业务回归覆盖 Workspace 过滤、回放去重、版本自环/跨域/循环与来源不可用，属于开发自检，不是独立或桌面验收。

## 34. 0022 Assist 第一方 Skill 冻结快照（2026-09-26 M04/P12 开发自检）

追加迁移 [0022_m04_first_party_skills.sql](../../../apps/api/migrations/0022_m04_first_party_skills.sql) 只在 `assist_messages` 加可空 `skill_snapshot jsonb`、`skill_input jsonb`、`skill_output jsonb`。旧行三列保持 NULL；Skill 只允许 ASSISTANT 行同时保存对象形态的冻结定义与输入，已完成消息才可持有输出对象。更新触发器拒绝修改冻结定义/输入、已结算输出，以及非 RUNNING→COMPLETED 的首次输出写入；原 Assist 领取身份与状态 CAS 仍在 Repository 控制，不建立 SkillRun 或安装表。首批 Skill/Pack 定义随应用只读发布；调用行保存实际定义、依赖内容及精确版本/摘要，输出保存结构化建议和生成时事实基线，不把整包选择写入 Project。

0022 不回填旧消息、不改写已执行迁移或其 SHA。回退须备份三列历史快照与输出，使用理解 nullable 新列的应用版本；无自动 down migration。真实隔离 PostgreSQL 开发回归覆盖新旧消息、命令重放、冻结触发器、首次结算、撤权后读取与 Project Resume 当前事实；独立模块和 Windows 桌面验收未执行。

## 35. 0023 当前 Task Skill 提案与验收版本（2026-09-26 M04/P12 开发自检）

追加迁移 [0023_m04_task_skill_proposals.sql](../../../apps/api/migrations/0023_m04_task_skill_proposals.sql) 扩展原 `assist_proposals` 的 `kind` 约束为 `TASK_CONTRACT_CHANGE`、`VERIFICATION_PLAN_CHANGE`，加入可空 `base_acceptance_revision`、`skill_sha256`、`skill_output_sha256`；旧提案行均保持 NULL，原 `TASK_DEFINITION` 仍以 Project 为目标创建新 Task。新 Task 提案强制 Task 目标、双版本与 64 位来源摘要。冻结触发器拒绝改写目标、基线、候选内容/摘要及 Skill 来源，允许原提案状态/决定按既有事务结算。新接受效果写原 `task_acceptances` 下一版本、`task_criteria`、Task acceptance 指针，撤销旧 Verification 适用性并过期 Task 的 OPEN Review；审计、提案决定和命令回执与之同事务。没有第二份有效 CheckPlan 表；GET 准入预览由当前验收、Rule 与注册检查器重建，活动 Run 仍持有原冻结契约。

锁序为先锁不可变 AssistProposal，随后取 Workspace authority SHARE 并复核当前来源，再锁 Task，最后写验收/旧证据失效/审计/回执。只接受 HUMAN 拥有且无活动 Run、未结算或 UNKNOWN Gateway 动作的 Task；并发不同接受只能有一个提交，重复同命令只读原回执。`task-to-execution-contract@1.1.0` 可变更 Expected Result 描述，但旧 `required_output_spec` 的产物种类与其他键原样保留；已确认 criterion 全部复制，不因模型建议删除或弱化。定义新版本与 Pack 1.2.0 随应用发布，旧定义及消息冻结快照不回填、不改摘要。迁移无自动 down；回退须备份新验收版本/提案证据并使用理解新 kind 的应用，不能只删列回退业务效果。真实隔离 PostgreSQL 的定向开发回归涵盖冲突、回放、旧证据失效、跨范围、UNKNOWN 与审计故障回滚；独立/桌面验收后置。

## 36. 0024 内置 ViewConfiguration（2026-09-26 M05/P14 开发自检）

追加迁移 [0024_m05_view_configuration.sql](../../../apps/api/migrations/0024_m05_view_configuration.sql) 新建每 Project 唯一的 `project_view_configurations`：`workspace_id/project_id` 复合外键防跨域，独立非负 revision、受 CHECK 限制的内置 kind、固定模板版本及时间。旧 Project 按自身类型回填 General/Thesis/Development；新 CreateProject 与 Project/State 在同一事务建 View 行。实际页面显隐/顺序由随应用发布的 `kind@template_version` 固定注册解析并返回摘要；表不存任意页面代码、脚本、URL 或第二份 Project State。View Owner 命令锁本行按 revision CAS，审计/回执同事务，既有 Run 冻结执行契约不受展示选择影响。无自动 down；回退须备份用户已选择的 kind/revision，旧应用若不能建 View 行不得继续写入。真实 PG 定向核对新建初始形态、切换、重放、版本冲突和跨范围；历史回填由迁移 SQL 保证，尚未单独构造升级前 Project 的反例。独立/桌面验收后置。

## 37. 0025 Project Blueprint 候选与来源（2026-09-26）

追加 [0025_m05_project_blueprints.sql](../../../apps/api/migrations/0025_m05_project_blueprints.sql)：`project_blueprint_proposals` 以复合外键绑定 Workspace/Project，保存 `USER_DRAFT` 或 `SKILL` 来源、不可变 candidate/baseline/source JSON、SHA-256、可空 Assist 消息和被替代候选引用、决策终态/时间。候选 JSON 限 64 KiB；触发器拒绝修改来源、候选、基线或摘要，应用仓储以条件更新限定 PENDING→ACCEPTED/REJECTED/EXPIRED/SUPERSEDED 决策。旧 Project/Assist/Run 不回填伪蓝图；无 down migration，回退需备份已接受来源与映射，旧应用不能继续写入这些候选。

候选不是第二份 Project/State/View/Task 当前事实。Preview 读当前 Owner 版本，Apply 按候选→WorkspaceAuthority（Skill 来源时 SHARE）→Project→Goal→现有 Task→新 Task→ProjectState→View 锁序，成功在同一事务调用各 Owner、写审计/决策/命令回执；State/View 在新 Task 插入后发现冲突必须抛错回滚，不得结算过期并提交部分效果。Skill 来源候选在模型外事务冻结定义/Pack/事实 SHA、已选来源和消息身份；当前来源撤销时 GET 隐藏候选正文并标 stale，Apply 在 authority SHARE 栅栏下重读显式来源/hash 后拒绝。Project Skill 复核时使用排他 Project 行锁阻止并发 Task 外键插入，锁定现有 Task 后比对生成时事实基线；内容/状态变化拒绝生成候选。迁移不会修改 0001–0024 的内容或 SHA。

## 38. 0026 真实模型调用预算预留（2026-09-26）

追加 [0026_m04_model_call_budgets.sql](../../../apps/api/migrations/0026_m04_model_call_budgets.sql)：`model_calls.budget_reserved_tokens` 可空且为正。新真实 Provider STARTED 行保存发起时的单次上界；历史行保持 NULL，未回填估算用量。没有 down migration；回退前需保留原调用计量，旧应用不能解释新调用的预算预留。

模型开始用例在单独短事务内先确定所属 Project 并取 `FOR KEY SHARE` 可写栅栏，再锁 `runs`（DRAFT 与 SEMANTIC_CHECK）或 `assist_sessions`（同一会话的全部 Assist 消息），核对 Workspace 与原 StepAttempt/AssistMessage 身份，统计同范围的调用数与 token。没有预算配置的 Mock 调用也在同一栅栏下插入 STARTED；无 Project 的会话不受单 Project 归档约束。两项 usage 都已知时计原值；STARTED、失败或缺失用量计冻结预留；历史无预留且缺用量按整个范围上限计并阻止新增。检查通过才插入 STARTED 和预留，事务提交后才调用网络，结算只更新原 call_id；实际 Provider 用量即使大于预留仍存原值，后续调用因此被阻止。范围限额随受控进程配置，不替代 Run/Assist 原业务 Owner，也不把未知费用记零。

## 39. 0027 Workspace 列表键集索引（2026-09-26 M05/P14）

追加 [0027_m05_workspace_lists.sql](../../../apps/api/migrations/0027_m05_workspace_lists.sql)：`projects(workspace_id,created_at DESC,id DESC)` 与 `tasks(workspace_id,created_at DESC,id DESC)` 支持 Workspace 内 Project/全 Task 只读分页。原 Project/Inbox Task 索引和游标语义保留；无表字段、Owner 或写事务改变。列表按 `(created_at,id)` 键集查询，游标保存 PostgreSQL 微秒时间文本；状态/归档在两页之间发生变化时不提供快照隔离。索引随应用迁移追加，无 down migration；回退仅影响查询计划，不改现有业务行。真实 PostgreSQL/HTTP 定向回归检查微秒键、过滤与 Workspace 边界，独立/桌面验收后置。

## 40. Project 归档串行化与提交（2026-09-26，无迁移）

既有 `projects.archived_at` 与 `revision` 已足以表达归档状态；A/B 两段均不改表和既有 migration。关联业务写事务在首次不可逆写入前对所属 Project 行取 `FOR KEY SHARE`，确认 `archived_at IS NULL`，锁持有至事务提交；模型调用 STARTED 预约也遵循此顺序。`ArchiveProject` 先对该行取 `FOR UPDATE`，不反向锁全部 Task；在锁内用只读查询检查 Task/Run/投递/运行中的 Step/尝试/验证、Gateway Operation/Invocation/legacy effect/资源 claim、Import、Assist/STARTED model call 和 OPEN Review。非终态、PREPARED、DISPATCHING、UNKNOWN、待审或租约过期而无停止证据都不得放行。先到的业务写事务完成后归档检查才读取其事实；归档先提交后，后来写事务取栅栏会发现归档并被拒绝。Project revision CAS、`archived_at`、关键 Activity 与命令回执在同一短事务提交；外部模型、网页和 Gateway 效果不持数据库锁等待。历史行不清理，未决事实须沿原身份收敛后由新命令重新检查。跨模块负面准入与死锁取舍见 [ADR-011](../../decisions/ADR-011-project-archive-serialization.md)。

## 41. 0028 Assist 生成中临时草稿（2026-09-26 M04 开发自检）

追加 [0028_m04_assist_live_preview.sql](../../../apps/api/migrations/0028_m04_assist_live_preview.sql)：`assist_message_previews` 以 `message_id` 为主键及原 AssistMessage 外键，一条消息最多一条暂存行；`revision` 从 1 开始递增，`preview_text` 有 `octet_length <= 16384` 的数据库约束，另存截取标志与更新时间。不回填旧消息，不修改既有消息、Proposal 或模型调用事实；无自动 down migration，回退前须让旧应用忽略新表，删除表会丢失在途临时显示文本，但不影响已结算消息。

普通无 Skill 的 `DISCUSS` 每次流式片段按 UTF-8 完整字符形成有界累计前缀，首片段立即写入，生成期间后续写入至少间隔 100 ms，完整输出返回前可再刷新一次。写入短事务先锁原消息并要求当前 Worker 身份、`RUNNING`、未取消，CAS 不再成立时不能继续发布。模型网络调用不占用这段事务；最终完整输出通过原校验和 Assist Owner 结算，结算同事务删除暂存行。取消请求立刻在读端遮蔽，终态和租约过期清理行；读取短事务以 WorkspaceAuthority SHARE 及消息 SHARE 锁建立与来源撤销、取消、结算的先后关系，并重查目标和有界历史来源。跨进程 API 只读该暂存，不将其当历史全文、审计、凭据或接受证据；重新连接用 revision 识别累计前缀。原消息正文在来源失权时也按当前权限遮蔽，不能借完成行绕过临时草稿的读时规则。2026-10-18 起，API 层以约 200ms 的主键快查 `revision`/`truncated` 作为变化信号，经 SSE（[HTTP 契约 §10.59](../../api/http-command-contract/part-06.md#1059-生成中预览的-sse-推送2026-10-18-源码实现)）把每次重新授权读取的完整前缀推给客户端；表结构、100ms 写入节流和 16 KiB 上限不变。

## 42. 0029 Run DRAFT 生成中临时草稿（2026-09-26 M04 开发自检）

追加 [0029_m04_run_draft_live_preview.sql](../../../apps/api/migrations/0029_m04_run_draft_live_preview.sql)：`run_draft_previews` 每个 Run 最多一行，主键绑定原 `runs`，外键绑定 `step_attempts` 与唯一 `model_calls.call_id`；保存确切 Attempt claim、Run Worker epoch/ID、可选 dispatch invocation epoch、递增 revision、截断标志和最多 16 KiB UTF-8 的前缀。旧 Run 不回填，新表不改 Run/Artifact/Verification 事实。无自动 down migration；删除新表会丢失在途显示文本，不能影响已结算候选或后续恢复。

模型端口收到 DRAFT Markdown 片段后，首片段立即提交，生成期间后续写入至少间隔 100 ms，完整返回前再刷新一次。每次写入在单独短事务核对 Task→Run→当前 DRAFT Step/Attempt、Worker/租约、dispatch invocation、原 STARTED model call 与无待处理控制；网络等待不占数据库事务。Run claim/release/fence 或 Attempt 结算在原事务删除旧草稿。读取以 WorkspaceAuthority SHARE、Task/Run SHARE 和原模型调用身份核对当前 Manifest、输入摘要及 FILE_READ/WEB_FETCH 原读证据，按当前权限重查来源、Connection、Policy 与 Resource；不可见只返回空草稿，不复制受限来源 ID。旧 Worker、旧 Attempt、失败/取消或租约到期不能将该行当作成功结果，恢复仍依原 Step/Attempt/operation 身份。真实 PG/HTTP 开发自检验证跨进程首片段、旧 Worker 与控制/来源栅栏；独立、真实 Provider 和桌面验收后置。2026-10-18 起，API 层以约 200ms 的主键快查 `revision`/截断标志作为变化信号，经 SSE（[HTTP 契约 §10.59](../../api/http-command-contract/part-06.md#1059-生成中预览的-sse-推送2026-10-18-源码实现)）推送每次重新授权读取的完整前缀；换 Attempt/模型调用时 revision 重置，故变化键同时包含 `step_attempt_id`/`attempt_claim_epoch`/`run_worker_epoch`/`model_call_id` 身份字段，表结构与写入节流不变。

## 43. 0030 M06 真实工具能力登记（2026-09-26，开发自检）

追加 [0030_m06_real_tools.sql](../../../apps/api/migrations/0030_m06_real_tools.sql)，只放宽受守卫形态并登记四类新能力，不新建表、不改 0001–0029 的内容或 SHA，无自动 down migration。（1）`ck_gateway_capability_kind` 由原「FAKE→READ/WRITE」放宽为 FAKE 与 REAL 各自可取 READ/WRITE，使 FILE_WRITE/GIT_WRITE/CLI_RUN 这类 `REAL`+`WRITE` 组合合法；（2）登记 `FILE_WRITE(REAL,WRITE)`、`GIT_READ(REAL,READ)`、`GIT_WRITE(REAL,WRITE)`、`CLI_RUN(REAL,WRITE)` 四行；（3）`ck_logical_operation_resource` 增补四类能力均为 `origin=RUN` 且 `resource_id IS NOT NULL` 的绑定形态（写/Git/CLI 都作用于受管资源根下的实际工作目录，需资源排他，与 WEB_FETCH 的无资源形态不同）。`ck_invocation_run_identity` 与连接/参数守卫沿用 0014/0016 的 `root_path` 形态，未再放宽——四类新动作都绑定受管资源并走带资源 claim 的 RUN 身份分支。

本轮仅以完整迁移应用链核对约束形态一致（临时隔离 PG 应用 0028/0029/0030 后 `ledger_rows` 为 30、图安装就绪、全量既有回归不退化）；FILE_WRITE/APPLY_CHANGESET、GIT_READ/GIT_WRITE、CLI_RUN 在 Gateway 准入/执行/核对层的真实 PG 集成反例尚未编写，适配器目前只有单元测试覆盖其纯逻辑（路径保护、安全环境净化、进程树封装语义），不构成「真实工具与故障/冲突测试通过」的 M06 出口。执行边界与缺口见[工具适配器](../../architecture/tool-adapters.md) §2/§4/§5 与 [CODEX_NEXT_STEP](../../../CODEX_NEXT_STEP.md)。


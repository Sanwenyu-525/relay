# PostgreSQL 物理设计：分册 03

角色：所属专题的唯一正文分册；2026-10-25 按原章节迁移，不改变原业务规则、日期、状态与证据范围。

[返回专题路由](../physical-design-postgresql.md) · [文档总入口](../../README.md)

按需读取本分册内的相关小节；跨章节约束沿链接核对，不能把本分册或历史措辞单独当作完整实现/验收结论。正文中的源码与命令路径沿用原有口径。

## 44. 0031 M06 变化集证据账本（2026-09-27，开发自检）

追加 [0031_m06_change_sets.sql](../../../apps/api/migrations/0031_m06_change_sets.sql)，新建两张写入即固定的证据表，不改 0001–0030 的内容或 SHA，无自动 down migration（删表只丢失逐文件落盘账本，不触碰已结算的 operation/invocation 事实）。

`change_sets` 是账本头，与产生它的 invocation 一对一：`uq_change_set_invocation UNIQUE (invocation_id)` 是幂等锚点——执行结算与恢复核对都按此回到同一行，核对不追加第二份历史、也不新建伪造成功；`uq_change_set_identity UNIQUE (id, invocation_id)` 供子表复合外键证明文件行确属那份变化集。0031 的 `fk_change_set_invocation` 证明 invocation 与 operation 成对，项目、Run、资源外键却只分别证明各行存在，**未证明它们属于同一 operation**；该遗漏由下节 0032 修正。`action_type` 固定为 `APPLY_CHANGESET`/`WRITE_FILE` 两种受管写动作（0030 登记，均 RUN 来源且绑定资源根），`canonical_root` 记录执行时使用的规范根（变化集为受管资源根、单文件为其父目录），相对路径只有在该根语境下才可复现。`status` 取 `SUCCEEDED/PARTIAL/UNKNOWN`（部分应用不整体成功），`evidence_source` 标明整体状态来自适配器执行报告（`EXECUTION`）还是事后按真实内容回读（`RECONCILIATION`），`file_count >= 1` 用于识别「结果丢失后一条证据都没落下」。

`change_set_files` 是逐文件观测，主键 `(change_set_id, relative_path)`：声明侧（`action`/`baseline_sha256`/`target_sha256`）取冻结输入，观测侧（`observed_baseline_sha256`/`actual_sha256`/`status`/`error`）取真实落盘或回读。四条 CHECK 把「成功必须可证」写进库：非 CREATE 或未成功的修改/删除必须留可信冻结基线（`ck_change_set_files_baseline`）；`DELETE` 无目标内容（`ck_change_set_files_delete`）；声称 `APPLIED` 必须有与目标一致的实际摘要、删除的成功是 `actual_sha256 IS NULL`（`ck_change_set_files_applied`）；未成功必须留原因（`ck_change_set_files_reason`）。摘要列只接受真正的 64 位十六进制（`ck_change_set_files_hashes`），`relative_path` 非空且不超 1024 字节，`diff_ref` 预留为 jsonb 对象但本增量不生成。

授权落实不可抹除：`relay_app` 对 `change_sets` 只有 `SELECT/INSERT` 加上受限的 `UPDATE (status, evidence_source, file_count, updated_at)`（仅供核对收敛整体状态，身份/作用域/规范根等声明列由权限禁止改写），对 `change_set_files` 只有 `SELECT/INSERT`——两表均无 `DELETE`，逐文件行连 `UPDATE` 都不授予，核对阶段以 `ON CONFLICT DO NOTHING` 只补记执行缺失的路径。`ChangeSetRepository`（`apps/api/src/files/change-set-repository.ts`）是这两张表的唯一 SQL Owner；磁盘 I/O 全在事务外，落库与调用结果结算同处一个短事务。本轮为开发自检（real-tools 定向 23 例）：真实隔离 PG 反例（`real-tools-gateway.integration.test.ts`）覆盖成功写唯一一份 `SUCCEEDED`、基线冲突 `PARTIAL` 且冲突文件记磁盘原值、崩溃后核对收敛 `SUCCEEDED`/`UNKNOWN` 且唯一一份、多文件单冲突按路径逐条固化、多文件全成功（`CREATE`/`MODIFY`/`DELETE` 各一）按账本 `canonical_root` 回读磁盘一致并在库层验证约束与授权（同一 invocation 换主键重复插撞 `23505`；改写或删除逐文件行、删除账本头、改账本头身份列均 `42501`）。不构成 M06 出口放行，逐文件 diff 生成与展示 UI 未实现。

## 45. 0032 M06 账本来源作用域约束（2026-09-27，定向独立复验）

追加 [0032_m06_change_set_source_scope.sql](../../../apps/api/migrations/0032_m06_change_set_source_scope.sql)，不修改已应用的 0031 或其 SHA。`logical_operations` 新增受管写能力与 `WRITE_FILE`/`APPLY_CHANGESET` 动作类型的配对 CHECK，以及覆盖 `(id, workspace_id, project_id, run_id, resource_id, action_type)` 的可引用唯一键；`change_sets.fk_change_set_source` 用单个复合外键绑定同一来源动作的项目、Run、资源与动作类型。0031 原有 invocation 成对外键仍证明这是该 operation 的调用。此约束针对审查发现的“同 Workspace 内拿真实 invocation 搭配别的有效项目/Run/资源”错账路径，不改变磁盘动作或公开 API。

迁移会校验既有 `change_sets`：如果曾写入来源不一致的行，0032 应失败并要求先核对证据，不能静默改写不可变逐文件账本。无自动 down migration；回退约束会重新开放错账准入，故不得把删除约束当常规恢复。`canonical_root` 由应用用例从已锁定的 operation 目标推导并保持不可变，数据库复合外键不证明磁盘路径真实内容；实际落盘摘要及恢复回读仍须由文件适配器与 Gateway 反例核对。

协调侧在一次性 PostgreSQL 18.6 上独立复跑完整迁移链（32 行迁移账本）、migration 8/8 与 real-tools 37/37；新增真实 PG 反例分别用有效的其他动作类型、资源和 Project 组装错账，复合外键均拒绝。执行回执与账本最终结算分别在短事务写入：前者只证明原 Invocation 的适配器曾返回，后者与 Invocation 终态同事务提交；恢复仍须按冻结输入与当前文件状态核对，不把回执或文件终态单独算成功。本节是 0032 与增量 A 的定向证据，不表示所有历史数据迁移场景或 M06 总验收已完成。

2026-09-27 增量 B 后续修复：部分文件已应用时原 Operation/Invocation 保持 `UNKNOWN`，执行阶段形成的 `change_sets.status=PARTIAL` 与不可改写的逐文件行保留其历史观测；后续恢复回读不能将该账本头覆盖为 `UNKNOWN` 或伪装成 `SUCCEEDED`。这只调整既有 `ChangeSetRepository.recordReconciliation` 的收敛条件，没有新 migration 或表。全文件确定无写入的冲突/冻结根拒绝则可把原调用结算为 `FAILED` 并释放 claim；仍记录 `PARTIAL` 账本表示请求未全部应用，不表示曾有已应用文件。人工处置和 diff 证据持久化仍待实现。

## 46. 0033 M06 桌面 Job 停机证明（2026-09-27，开发自检）

追加 [0033_m06_file_write_stop_proofs.sql](../../../apps/api/migrations/0033_m06_file_write_stop_proofs.sql)。`file_write_stop_proofs` 以原 `invocation_id` 为主键，只允许 `relay_app` SELECT/INSERT；复合外键同时约束原 Operation/Run/Invocation/Worker ID 与 epoch、Run 投递命令，CHECK 只接受 `FILE_WRITE` 两种动作和桌面 Job 停止证据枚举，`launch_id` 必须对应桌面 Worker ID。可信桌面启动帧带来的已停止 Job 在 `recoverStoppedDesktopLaunch` 的旧 claim 会话锁内、Run fence 前校验并插入；重复恢复只读原行，不改证据。租约过期、普通 child close 与客户端布尔值都不能生成此证明。旧 `run_invocations.stop_evidence` 可随重新领取清空，因此不可作为人工解除隔离的持久前提。

新增复合唯一键仅供上述外键引用，不修改既有 Invocation、Operation 或 RunCommand 内容；旧行无回填，未有可信证据的历史 UNKNOWN 继续隔离。无自动 down migration；删除此表会丢失已停旧 Job 与原调用的持久关联，使依赖它的人工处置无法再授权，不能当作安全回滚。隔离 PostgreSQL 定向 5/5 和 run-dispatch 回归 22/22 通过；尚无真实 Windows Job handle 活进程反例。

## 47. 0034 M06 部分文件写入的人工处置（2026-09-27，开发自检）

追加 [0034_m06_file_write_manual_dispositions.sql](../../../apps/api/migrations/0034_m06_file_write_manual_dispositions.sql)：`logical_operations` CHECK 增加终态 `MANUALLY_CLOSED`，`file_write_manual_dispositions` 对原 Invocation 唯一且只授予 SELECT/INSERT。处置行用复合外键绑定同一变化集的 Invocation、Operation、Workspace、Project、Run、Resource，另与 0033 停机证明绑定；保存本机人工主体、命令 ID、唯一受支持决定 `KEEP_CURRENT_AND_FAIL_RUN`、逐文件当前摘要及整体观察 SHA-256，不保存文件正文。旧 Operation 的结果引用指向 disposition，原 Invocation `UNKNOWN` 与原 `PARTIAL` 账本不改写。后续无回执崩溃场景复用同一表和外键，原变化集可保持 `UNKNOWN`；观察 JSON 额外保存目标与候选残留的 File ID/摘要，不证明候选归属，也不需要修改 0034 表结构。

应用用例先在业务事务外限量回读逐文件当前状态，再在 Task→Run 事务中核对 revision、原隔离 claim、停机证明、投递、唯一未决动作及回读所依据的账本身份；命令回执、处置行、Operation 终态、claim 释放、旧投递结清、待处理控制拒绝、Run 失败、Task 返 READY 与 Activity 同事务提交。项目归档的 `UNKNOWN_EFFECT` 查询只排除 Operation 已为 `MANUALLY_CLOSED` 且有匹配处置行的历史 Invocation，其他 UNKNOWN 仍阻断。旧数据无自动回填；0034 会校验已有账本/证明键，错配必须先核对，不能删除或改写原证据。无自动 down migration；旧应用不认识新终态，回退须先停用新入口并保留新表/状态解释能力。数据库约束不消除文件回读到事务提交之间的外部编辑竞争。

## 48. 0035 M06 冻结计划文本差异证据（2026-09-27，开发自检）

追加 [0035_m06_file_write_frozen_diff.sql](../../../apps/api/migrations/0035_m06_file_write_frozen_diff.sql)。`file_write_frozen_diffs` 只为新 `FILE_WRITE` 的 `MODIFY/DELETE` 保存准备时核验的基线正文或不可用原因，`CREATE` 的空基线由动作语义推出；目标正文仍在原 `logical_operations.params`。主键 `(operation_id,relative_path)` 防止重复行，联合外键绑定原 Operation 的 Workspace、Project、Run、Resource、Capability 和动作类型，CHECK 限定相对路径、动作、64 KiB 文本上限及基线正文 SHA-256。`relay_app` 仅有 SELECT/INSERT，基线证据与 Operation 同事务写入；同一意图不会刷新已有行。

先以短事务核对 Workspace authority、Task/Run、资源、Connection 与 Permission，再在事务外限量读取最多 16 个文件的基线，最终以另一个短事务重新核对授权并把冻结证据与 Operation 同步提交；不在持锁事务内等待原生助手。可展示正文每文件最多 64 KiB。文件不安全、内容不匹配、非可展示文本或超过上限只记原因，不把当前磁盘内容伪装成旧基线。旧 Operation 不回填：缺失证据在查询中明确为 `BASELINE_UNAVAILABLE`。无自动 down migration；删除此表将丢失新动作的冻结基线文本，旧版本无法重建，回退需保留该证据或明确接受文本差异不可用。此前真实隔离 PostgreSQL migration 8/8 与 `real-tools-gateway` 42/42 已通过；Windows 句柄级读写的后续验证另见 M06 验收记录。

## 49. 0036 M06 文件路径物理身份（2026-09-27，开发中）

追加 [0036_m06_file_write_path_identity.sql](../../../apps/api/migrations/0036_m06_file_write_path_identity.sql)。`file_write_path_identity` 仅对**新** `FILE_WRITE` Operation 保存受管根规范路径及卷号/File ID、逐文件相对路径、父目录链和目标身份；主键为 `operation_id`，复合外键把 Workspace、Project、Run、Resource、Capability 与动作类型绑定到同一来源 Operation。`relay_app` 仅有 SELECT/INSERT，既有行不自动回填，也不改写 0030–0035 或其摘要。

准备时先授权，再由 Windows 原生助手捕获身份，最终在短事务中复核授权并与新 Operation 一同插入。执行和恢复只用原行核对根、父目录与目标；旧 Operation 缺失身份不能靠当前磁盘补造原身份，仍按 UNKNOWN/隔离处理。新 `WRITE_FILE` 账本以受管资源根作为 `canonical_root`，逐文件路径相对该根；历史账本原值不改。单文件上限 1 MiB、单次最多 16 文件，超限不能冻结物理证据。无自动 down migration；删除此表会令依赖它的新 Windows 写动作无法安全恢复。迁移 8/8 已在隔离 PostgreSQL 验证；原生助手与桌面恢复链的确切结果见 M06 验收记录，不能由迁移测试推断文件系统安全。

## 50. 0037 M06 单文件冻结差异的根相对路径（2026-09-27，开发自检）

追加 [0037_m06_file_write_frozen_diff_root_path.sql](../../../apps/api/migrations/0037_m06_file_write_frozen_diff_root_path.sql)，只替换 0035 的 `ck_frozen_diff_action`：`WRITE_FILE` 仍限 `MODIFY`，但允许根相对的子目录路径；0035 的路径格式、长度、冻结摘要和只追加权限约束不变。原因是新 Windows 单文件账本以受管根为 `canonical_root`，冻结计划差异需与账本使用同一路径。历史 basename 行不更新，旧迁移及 SHA 不改。回退此约束会拒绝新嵌套路径的写入，不作为无损回滚。完整迁移链 37 行、迁移测试 8/8、真实隔离 PG real-tools 49/49 通过。

## 51. 0038 M06 受管资源登记时物理身份（2026-09-28，开发自检）

追加 [0038_m06_managed_root_identity.sql](../../../apps/api/migrations/0038_m06_managed_root_identity.sql)，为 `managed_resources` 增加可空 `file_write_root_id`（卷号/File ID 格式 CHECK）。旧行保持 NULL；数据库迁移不能从当前文件系统推断登记时身份，也不自动更新历史 Operation。新 Windows 资源登记在业务事务外调用原生助手捕获当时目录身份，并与资源行同事务写入；助手认为目录不安全时可以登记供其他能力使用，但 `file_write_root_id` 留空，新 Windows `FILE_WRITE` 准备拒绝。非 Windows 登记同样留空，其原有路径实现不因此改为 Windows 句柄保证。

0038 撤销 `relay_app` 对 `managed_resources` 的表级 UPDATE，只重新授予 `status,revision,resource_epoch` 列更新；目录路径、规范键和登记物理身份不由应用角色改写。准备新 Windows 写动作时要求非空且与当前助手捕获的根 File ID 相同，再冻结 0036 的 Operation 身份；旧已准备动作沿其原冻结证据执行/核对。停用旧资源并重新登记会生成新资源 ID，原 claim、Operation 与审计历史不搬迁。无自动 down migration；去掉身份列和门槛会重新开放原资源路径被普通目录替换的准入风险，回退必须先停止新写动作。真实隔离 PostgreSQL 迁移 8/8、Windows 替换/旧空身份定向 2/2、完整 real-tools 51/51 已通过，测试数据库及进程清理；确切桌面包的相邻 Job/WebView2 旧路径已复验，新身份提示的人工交互与 M06 总出口另验。

## 52. 0039 M06 已停用资源的同路径重新登记（2026-09-28，开发自检）

追加 [0039_m06_active_resource_root.sql](../../../apps/api/migrations/0039_m06_active_resource_root.sql)：原 `uq_managed_resource_project_root` 覆盖已停用行，会令 0038 的“停用旧资源并重新登记”实际不可执行。0039 将其替换为仅覆盖 `status='ACTIVE'` 的 `(project_id,identity_key)` 唯一索引；登记命令的重复检查也只看活动资源，并仍持有跨 Workspace 登记 advisory 事务锁。旧资源行、Operation、claim、策略和审计记录不删除或回填；同项目同路径活动资源仍最多一个，停用须先处理占用或隔离。新登记得到新资源 ID 和捕获时根 File ID，旧 Run/Task 的冻结资源 ID 不自动改绑；用户须重新检查连接、Permission 与委托引用。

迁移不改写已有行或权限。回退该部分唯一索引并恢复旧无条件唯一约束之前，若已有同路径历史停用行，约束会失败；不得删除历史行换取回退。真实隔离 PostgreSQL 完整迁移 8/8、Windows 重新登记定向 3/3、完整 Gateway 28/28 与 real-tools 52/52 已通过。0039 已包含在 EXE SHA-256 为 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc` 的确切桌面目录包内，清单核验及相邻 Windows Job/WebView2 路径通过；无回执强杀的桌面同场景另验。

## 53. 0046 M04 Assist Provider 失败类别（2026-09-30）

追加 [0046_assist_provider_error_kind.sql](../../../apps/api/migrations/0046_assist_provider_error_kind.sql)：`assist_messages` 新增可空 `provider_error_kind text`，封闭词表为 `AUTH/RATE_LIMIT/TIMEOUT/STREAM_BROKEN/PROTOCOL/NETWORK`，另一 CHECK 仅允许 `FAILED` 消息带非空类别。该字段与原 Relay `error_code` 分开，避免将预算、取消、解析或本地处理失败归因给 Provider。Assist Owner 在原领取 Worker 身份的 CAS 结算中保存类别；查询只投影持久事实，不重算历史分类、不增加业务写入 Owner。

旧行保持 NULL，迁移无回填、无新表/索引、无权限变化；旧客户端可忽略新增响应字段，新客户端兼容旧服务缺字段。迁移按既有摘要台账顺序应用，不改写 0015。没有自动 down migration；回退代码前需核对 schema 兼容门，删除该列会丢失已保存的诊断类别，不能删除历史消息来绕过约束。API Breaking Change: No，原请求与执行权契约不变。隔离 PostgreSQL 与接口验证结果见[开发记录](../../development/ui-live-integration-2026-09-28.md#12-m04-assist-provider-失败诊断2026-09-30)。

## 54. 0047 M04 首输出观察时间（2026-09-30）

追加 [0047_m04_model_call_first_output.sql](../../../apps/api/migrations/0047_m04_model_call_first_output.sql)：原 `model_calls` 新增 `first_text_delta_at`、`first_preview_persisted_at` 两个可空 `timestamptz`，无默认、无旧行回填，并追加两列的应用角色 UPDATE 权限。CHECK 限制首预览非空时必须已有首文本，且非 DRAFT/ASSIST 调用两列必须为空。不改写已应用的 0018，不增加事实表、索引或业务状态。

首文本时间只接受当前合法 Owner 的首个非空文本回调；首预览时间与通过身份门禁的第一次预览写入在同一短事务内保存。Repository 按原 call_id 一次性写入，后续回调、预览清理与调用结算保留原值；旧 Worker、取消或失效身份不能补写。Run 保留 Task/Project/Run→call 的锁序，Assist 使用 Message→call，避免把计量锁反向带入业务事务。仅记录服务端观察，不以 `started_at` 冒充实际请求发送，也不以事务内时间冒充提交返回或 Windows 可见首字。无自动 down migration；旧应用可忽略新列，删除列会丢失首输出历史证据，回退先核对既有 schema 兼容门。API 为附加可空投影，Breaking Change: No。测试结果只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 55. 0048 M07 数据库级新工作准入门（2026-09-30，源码实现）

追加 [0048_m07_admission_gate.sql](../../../apps/api/migrations/0048_m07_admission_gate.sql)，新表 `runtime_admission_gate` 以 `singleton=true` 为唯一主键，CHECK 固定单行键、mode `NORMAL/DRAINING` 和非负 bigint revision，迁移预置 NORMAL/0。`relay_app` 只获 SELECT 与 `UPDATE(mode,revision)`，无 INSERT/DELETE 或身份列更新权；不改写已有 migration、Workspace 或 Run 状态。运行期 SQL Owner 为 RuntimeAdmissionRepository，状态转换由维护应用用例协调。

首次命令和新领取的 `FOR SHARE` 位于原业务锁之前；状态转换使用专用 `FOR UPDATE` 事务，CAS 与 scope `runtime:database-admission`、target `DATABASE` 的原命令回执同时提交。普通命令等待门锁后再查回执，避免把等待期间已提交的原结果误报维护拒绝；门锁等待最多5秒，不延长较短原期限，成功后恢复原期限，失败整笔回滚，不保留半变更。独立模型连接验证在同一准入短事务里预约原 `model_calls(kind=VERIFY)` 的 STARTED，网络与原调用结算位于事务之外；不增加第二套模型账本或改变 Run/Assist 预算。完整锁/兼容取舍见 [ADR-014](../../decisions/ADR-014-database-maintenance-admission.md)，CLI 与限制见[部署说明](../../deployment/本机部署.md#draining-新工作准入门)。

迁移是追加表，旧数据无需转换；旧包不识别准入门，既有严格 schema 清单也不自动兼容未来 migration，升级需停旧进程并经原迁移入口。无自动 down migration；删除表或回退到不参与门的代码会撤销维护保证，不能当作恢复准入的方法。DRAINING 中原在途业务和图仍可写入，没有完整冻结或备份一致性保证。实际验证与未覆盖项只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

2026-10-01 数据库连接维护接续无新migration/业务字段。受信运维会话暂时撤销数据库CONNECT ACL，修改前保存完整有效ACL及grant option；不可变凭据在独立运维目录，不存URL/密码。按原目标和ACL恢复，不用bootstrap重置既有权限；异常时撤销可能保留，漂移拒绝覆盖，不承诺自动回滚。具体兼容、角色和恢复限制归[部署设计](../../deployment/本机部署.md#数据库连接维护与权限恢复)。

## 58. 0052/0053 N03 项目知识导读与整理候选（2026-10-02）

追加 [0052_n03_project_knowledge_guide.sql](../../../apps/api/migrations/0052_n03_project_knowledge_guide.sql) 与 [0053_n03_knowledge_curation_candidates.sql](../../../apps/api/migrations/0053_n03_knowledge_curation_candidates.sql)，三张新表，不改写 `0009` 的 Information 表或 `0041` 的影响检查表。

`project_knowledge_guides` 以 `UNIQUE(project_id)` 保证一个 Project 一份导读，`revision` 供 CAS；应用角色只有 `SELECT/INSERT` 与 `UPDATE(revision, updated_at)`。`project_knowledge_guide_entries` 的 `(guide_id, ordinal)` 主键承担人工顺序，`UNIQUE(guide_id, ref_kind, target_id)` 拒绝重复，`target_id` 是 `coalesce(knowledge_id, decision_id, rule_id, artifact_version_id)` 的 STORED 生成列——**唯一约束里的 NULL 互不相等，直接对四个可空列建 UNIQUE 会漏掉重复项**，生成列是这里唯一可靠的去重方式。四类目标各一个可空外键，`ref_kind` 与「恰好一个目标列非空」由 CHECK 用 `IS NOT NULL` 强制：这是刻意吸取 `0044` 的教训（该迁移把 CHECK 写成 `target = ref_id`，NULL 时求值为 NULL 而非 FALSE，PostgreSQL 只在 FALSE 时拒绝，脏行因此可落库，只能由 `0045` 追加修正）。`ck_guide_entry_pin` 要求只有 `KNOWLEDGE` 能 `PINNED` 且必须给出 `pinned_version_id`，`CURRENT` 则必须为空，因此「固定历史引用」与「跟随当前导航」在数据库层就无法混淆。

条目表对 `relay_app` 给 `SELECT, INSERT, DELETE`：编辑导读就是替换整份清单，条目是可替换的导航引用。它们指向的知识版本、决定、规则与成果版本仍按原契约不可变——DELETE 权限不触及被引用对象。

**外键不保证 `pinned_version_id` 属于同一条知识**——跨表一致性 CHECK 做不到，由应用层在建导读时复核（`requireReferenceInScope`）。实测用应用角色直插一条指向另一条知识版本的 `PINNED` 行**会被数据库接受**；读端因此返回 `MISSING`/`CROSS_SCOPE` 而不是解析到错误版本。API 路径无绕过，但不要误以为库级已保证。

`knowledge_curation_candidates` 保存来源成果版本与建议归类，`suggested_knowledge_id` 仅在标题字面完全相同时才指向既有条目，否则为空表示建议新建。`ck_curation_decision` 把未决／已接受／已拒绝写成互斥分支，`ck_curation_accepted_pair` 保证两个接受列同时有值或同时为空，避免「有版本但无知识」这类半写状态。应用角色有 `SELECT, INSERT` 与仅限四个决定列的 `UPDATE`，不能改来源或建议标题。

上限（导读 200 项、单次候选 10 项、列表 20 条）在 API schema 层拒绝，数据库不设项数 CHECK。外键只保证被引用对象存在，不保证同项目——跨项目与跨 Workspace 引用由应用层在建导读、建候选、接受三处各自复核，读取端再复核一次作用域；这是与 `0041` 相同形状的纵深依赖，不是数据库级隔离。

**接受候选必须单事务**：「锁候选行 → 复核 accepted/rejected → 写知识版本 → 绑定候选 → 写回执」全在一个事务里。若像首轮实现那样让知识版本在内层命令的独立事务先提交、再在另一个事务绑定候选，则拒绝与接受并发时会出现「用户已拒绝、却留下一个在候选审计链上无归属的孤立知识版本」。为此 `information-commands.ts` 增加了 `createKnowledgeInTransaction` / `addKnowledgeVersionInTransaction`：它们复用同一 execute 主体但不自己开事务、也不自己写回执（否则同一 `command_id` 会写两行回执），回执由组合用例在同一事务写入。

三张表对旧数据无需转换，没有回填、没有触发器、没有改写已应用迁移。没有自动 down migration；回退代码前需停旧进程并经原迁移入口，删表会丢失人工编排顺序与候选决定记录，不能靠删表绕过兼容性核对。API Breaking Change: No，Information 与 Artifact 的形状与状态机均未改变。真实 Windows 阅读与 PV03/PV08 未做；实际成绩只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 56. 0050 N02 跨成果候选组与组合检查（2026-10-02）

追加 [0050_n02_impact_candidate_groups.sql](../../../apps/api/migrations/0050_n02_impact_candidate_groups.sql)，四张新表，不改动 0041 的 `artifact_impact_checks` 与 `artifact_impact_candidates`：

- `artifact_impact_candidate_groups`：`workspace_id`、`impact_check_id` 外键、`source_artifact_id` 与 `source_before/after_version_id` 外键、`source_artifact_revision`，CHECK 只要求 before≠after。它只保存组的来源基线，不复制成果正文。
- `artifact_impact_candidate_group_items`：`(group_id, ordinal)` 主键承担用户顺序，`UNIQUE(group_id, target_version_id)` 拒绝重复目标，`target_artifact_id`/`target_version_id` 为真实外键，因此组不能引用不存在的版本，`relation` 非空 CHECK，`speculative` 标记该目标是否来自 AI 推测。
- `artifact_combination_checks`：`group_id` 与 `task_id` 外键、`acceptance_revision`、`gaps jsonb`（CHECK 为数组）。**没有整体结论列**——整体不可判是类型语义，存一个常量列只会伪装成可写事实。
- `artifact_combination_check_items`：`(combination_check_id, ordinal)` 主键、`UNIQUE(combination_check_id, artifact_version_id)`、`content_hash` 32 字节 CHECK、`is_current_version`/`readable` 快照，以及可空 `verification_session_id` 外键与封闭词表 `verification_status IN ('OPEN','PASS','RETRY','HUMAN')`（对齐 `verification_sessions.status`）。可空而非 NOT NULL，因为「该确切版本在当前验收修订下没有验证会话」是需要如实保存的缺口。

四张表对 `relay_app` 只给 `SELECT, INSERT`；没有 UPDATE/DELETE 权限，应用角色不能改写已保存的范围或覆盖缺口，这与「接续点/候选组不是可编辑的第二份成果状态」一致。上限 1–10 项与 1–20 项在 API schema 层拒绝，数据库不设项数 CHECK。旧行无需转换，没有回填、没有触发器、没有改写已应用迁移。

应用角色持有 INSERT 即可构造跨 Project 的组或组合检查（外键只保证版本存在，不保证同项目）；因此应用层在建组与建检查单时按 `workspace_id` 复核来源与每个目标版本的当前作用域，跨 Workspace 读取一律 404。这是与 `0041` 相同形状的纵深依赖，不是数据库级隔离。

没有自动 down migration；回退代码前需停旧进程并经原迁移入口。删除这四张表会丢失已保存的审阅范围与缺口记录，不能靠删表绕过兼容性核对。API Breaking Change: No，Artifact/Task/Verification/Assist 的形状与状态机均未改变。真实 Windows 差异审阅与 PV08 体验记录未做；实际成绩只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

---

## 57. 0051 M07 文件夹入口与对话执行请求（2026-10-02，源码实现）

追加 [0051_conversation_execution_requests.sql](../../../apps/api/migrations/0051_conversation_execution_requests.sql)：`conversation_execution_requests`。一条原用户消息对应一条执行请求；模型整理出的候选、阶段事实与关联的真实 Task/Run 都在这张表里，业务侧不保存第二份状态。

- `source_message_id` 与 `(workspace_id, command_id)` 各带一条 `UNIQUE`：同一条原消息或同一个命令身份重放都命中同一条请求，不会产生第二个意图。
- 阶段命令身份 `task_command_id` / `ready_command_id` / `delegate_command_id` **在请求创建时就固定**：恢复时按原 `command_id` 重放既有回执，不因重试生成第二个 Task 或 Run。
- `base_content_sha256 bytea`（`length = 32`）固定原消息内容基准；`root_path` 与 `resource_id` 固定这次请求的作用目录，不靠会话推断。
- `decision` 闭合为 `DISCUSS | CLARIFY | PREPARE`，`candidate_status` 为 `PENDING | READY | INVALID | UNAVAILAILABLE`，`status` 为 `INTERPRETING | DISCUSSED | CLARIFY | READY | TASK_PREPARED | DELEGATED | FAILED`。CHECK 保证进入 `TASK_PREPARED` / `DELEGATED` 时必带 `task_id` 与 `task_command_id`，进入 `DELEGATED` 时必带 `delegate_command_id` 与 `run_id`，且 `CLARIFY` 判定不能落在准备或委派阶段。
- 授权来源永远是 `source_message_id` 指向的那条原用户消息。模型只解释候选，`candidate` / `clarification` 是候选与澄清，不是授权、验收或完成凭据。
- 索引：`(session_id, created_at DESC, id)` 供会话内回读；`task_id` 部分索引供任务追溯。
- `relay_app` 获得 `SELECT, INSERT, UPDATE`；不新增 DELETE。写入只经过 [ConversationExecutionRepository](../../../apps/api/src/assist/conversation-execution-repository.ts)，候选只能从 `PENDING` 结算一次，阶段只能向前 CAS。

运行语义：解释（原消息 → 候选）与执行（候选 → Task/READY/Delegate）是两个命令。模型调用在事务外，候选先落库；Task 事实与 `TASK_PREPARED` 在同一短事务提交，READY 与 Delegate 各自是既有命令并各自留回执。跨命令的部分成功按阶段如实显示，不伪称原子。UNKNOWN 沿原 operation 核对，重放只读已保存的候选，不重付模型整理成本。

兼容与回滚：无自动 down migration；删除该表会使文件夹入口与对话执行请求失去持久来源，且历史请求无法重放。回退必须先停用新的写入路径。**API Breaking Change: No**（新增端点，既有 Task/Run/Review/Assist 状态不变）。实际验证与未覆盖项只在[功能验收表](../../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 58. 0054 M04 模型工具循环与 FILE_QUERY（2026-10-03，源码实现）

追加 [0054_m04_agent_tool_loop.sql](../../../apps/api/migrations/0054_m04_agent_tool_loop.sql)：`FILE_QUERY` 能力行、放宽后的 `ck_logical_operation_resource`、新表 `run_tool_calls`。`run_tool_calls` 是 `apps/api/src/run/run-tool-call-repository.ts` 的唯一 SQL Owner。

**能力登记。** `FILE_QUERY` 是 `REAL`/`READ`，逻辑动作 `LIST_DIRECTORY` / `FIND_PATHS` / `SEARCH_TEXT` 共用。`ck_logical_operation_resource` 被完整重述而不是就地追加：`0030` 的每一条分支（含 `WEB_FETCH` 的 RUN 无资源与 `USER_IMPORT` 两种形态）都保留，只把 `FILE_QUERY` 并入「`RUN` 且绑定受管资源」那一支。漏掉任何一条都会让历史动作在下一次写入时违反约束——本轮开发自检中该疏漏曾使 `run-graph` 的 9 个文件写用例失败，已按此修正。

**`run_tool_calls` 的不变量。**

- **行 id 即动作身份。** 该行 id 直接作为对应 `logical_operations.id`（外键 `fk_run_tool_calls_operation`）。Provider 的 `tool_call_id` 只承担轮内配对，跨 Run/轮次可以重名而不产生唯一性冲突。
- **落库即冻结。** `provider_tool_call_id`、`tool_name`、`arguments` 与 `arguments_sha256` 写入后不可改写：应用角色只有 `SELECT, INSERT`，`UPDATE` 被限制在 `(status, operation_id, result_ref, revision, updated_at)`。恢复核对因此总能看到模型实际请求了什么。
- **位置唯一。** `(step_attempt_id, round, ordinal)` 唯一：重放同一轮请求不会插入第二行。
- **派发与身份绑定同一次提交。** `ck_run_tool_calls_operation_binding` 要求 `REQUESTED`/`REJECTED` 必须没有 `operation_id`，其余状态必须有——已连上 Operation 的行必须与该 Operation 同属本次调用。
- **未派发必须留原因。** `ck_run_tool_calls_rejected_reason` 要求 `REJECTED` 行的 `result_ref` 同时带 `reason` 与 `detail`，不能只留一个状态字。
- **状态集合。** `REQUESTED` → (`PREPARED` | `WAITING_APPROVAL`) → `SETTLED`，另有 `REJECTED`（未派发，携带类型化原因）与 `ABANDONED`（恢复核对或人工处置之后）。`SETTLED` 行是唯一被模型下一轮读到的结果来源。

**锁顺序。** 工具派发沿用既有 authority → Task → Run → 资源注册表 → 资源 claim 顺序，`claimRunForGateway` / `claimGatewayWorker` / `prepareGatewayAction` / `dispatchGatewayAction` 均未改动。`run_tool_calls` 的写入不进入 Run/Task 的提交事务：轮次落库在 `advanceRunStep` 的事务外准备阶段，状态推进各占一个短事务，因此不扩大锁集合。

**迁移不改历史。** `0054` 只新增，不回填：旧 Run 的冻结快照没有 `tool_loop_action`，`readToolLoopAction` 对缺失键返回 `undefined`，因此旧 Run 走原单次生成路径，不因本次迁移改变行为。

运行职责与循环规则归[运行架构 §2.3](../../architecture/runtime-context.md)，能力范围归[工具适配器 §1.4](../../architecture/tool-adapters.md)，HTTP 面归[命令契约 §10.54](../../api/http-command-contract.md)。

## 59. 0056 M04 本次任务范围授权与一次自动适配留痕（2026-10-04，源码实现）

追加 [0056_m04_run_scope_grants.sql](../../../apps/api/migrations/0056_m04_run_scope_grants.sql)：新表 `run_scope_grants`，以及 `run_tool_calls` 上的一次自动适配留痕列。`run_scope_grants` 是 `apps/api/src/application/run-scope-grant.ts` 的唯一 SQL Owner。

**`run_scope_grants` 的不变量。**

- **一个 Run 至多一份授权。** `uq_run_scope_grants_run` 保证。授权在 Delegate 事务里与 Run 同批落库，因此不存在「Run 已存在但授权漏写」的中间态，也没有脱离 Run 的孤儿授权；`fk_run_scope_grants_run` 按既有惯例单列引用 `runs (id)`，而不是引用尚不存在的 `runs (workspace_id, id)` 唯一键。
- **边界写入后不可改写。** 应用角色只有 `SELECT, INSERT`，`UPDATE` 被限制在 `(revoked_at, revoked_reason, revision, updated_at)`。授权边界从签发起就是冻结的，撤销只改变「是否仍适用」，不改变「授权了什么」。
- **动作词表是封闭的。** `ck_run_scope_grants_actions` 要求非空且 `<= {WRITE_FILE, APPLY_CHANGESET, CLI_RUN}`；`ck_run_scope_grants_no_delete` 显式禁止 `DELETE` 出现，防止删除被一次授权带走。检查统一记作 `CLI_RUN`：粒度由冻结的 `checks` 清单决定，不由动作名决定。
- **根身份是物理事实。** `root_identity` 存冻结时的规范根身份；路径相同但目录已被整体替换时原授权不再适用，因为那已经不是当初被授权的那一个目录。
- **撤销必须说明原因。** `ck_run_scope_grants_revocation` 要求未撤销时不得留下撤销原因、已撤销时必须留下非空原因，便于审计「为什么不再放行」。
- **边界摘要可核对。** `boundary_digest` 是资源、根身份、动作集合与检查清单的规范摘要，用于核对「模型请求没有超出授权」；`ck_run_scope_grants_digest` 约束其形状。

**一次自动适配的留痕。** `run_tool_calls` 追加 `adaptation_of`（自引用）与 `adapted_path`。`ck_run_tool_calls_adaptation` 只要求两列同现同缺且路径非空——**它不保证深度**：数据库层没有禁止「对已适配的行再适配」。「只适配一次」由应用层判定（`decideToolAdaptation` 拒绝 `adaptation_of` 指向已适配行的请求），不得据此声称数据库层已强制；需要该保证时由应用层测试兜住，而不是靠这条 CHECK。留下这一对列而不是只留计数，是为了让「这次写入是对哪一次基线冲突的重新适配」在恢复核对时仍然可查，且新读取的基线与新意图有对应关系，不覆写旧记录。

**迁移不改历史。** `0056` 只新增并放宽（`run_tool_calls` 的列可空），不回填：既有 Run 没有授权行，`evaluateScopeGrant` 返回 `SCOPE_GRANT_ABSENT`，与本轮之前「文件写入一律 ASK」的行为一致。

授权语义归[工具适配器 §1.2](../../architecture/tool-adapters.md)，HTTP 面归[命令契约 §10.55](../../api/http-command-contract.md)。

## 60. 0057 M04 工具调用的 Run 刷新事件（2026-10-04 设计，2026-10-05 源码实现）

追加 `0057_m04_run_tool_call_events.sql`。**只增加刷新事件的来源，不改 `run_tool_calls` 表结构、不新增业务表、不改任何 CHECK 以外的业务约束。** 依据是[研究 §1.6](../../research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)：Codex 对每个工具项发 `item/started` / `item/completed`，DeepSeek 把 `tool/call` 与 `tool/result` 作为持久事件推送——两家都是「事件本身持久化 + 逐项提示」，不是轮询。

**为什么是补事件而不是加轮询。** `run_tool_calls` 已经是持久账本，缺的是「它变了」这一信号。`0012` 的 `relay_append_run_event()` 用封闭 `CASE` 分派事件来源，遇到未登记的表直接 `RAISE EXCEPTION`（`0012_m03_run_events.sql:44-46`），因此必须显式登记，否则工具调用行的任何写入都会失败。

三条改动：

- `ck_run_events_kind` 增加 `TOOL_CALL_CHANGED`。既有 6 个取值不变，CHECK 只能放宽不能替换。
- `CREATE OR REPLACE FUNCTION relay_append_run_event()` 增加一个分支：`run_tool_calls` 的 `run_id` 就在行上，不需要像 `step_attempts` 那样回查 `run_steps`。锁序不变——函数体仍先 `SELECT ... FROM runs WHERE id = event_run_id FOR UPDATE` 再取 `max(seq)+1`，与其他 6 个来源完全一致。
- 两个 `AFTER INSERT` / `AFTER UPDATE` 触发器，`WHEN` 条件与既有写法同构，只在 `status`、`operation_id`、`result_ref` 三列 `IS DISTINCT FROM` 时触发。**不含 `revision`**：这三个列的变化已覆盖全部状态推进，纳入 `revision` 只会为同一次推进多发一条提示。

**不需要新增 GRANT。** 触发器函数默认 `SECURITY INVOKER`，以调用者即应用角色 `relay_app` 身份执行；`0012` 已授予 `relay_app` 对 `run_events` 的 `SELECT, INSERT`（第 99 行），`0054` 已授予对 `run_tool_calls` 的读写。

**兼容与回滚。** 迁移只放宽 CHECK 并新增触发器，**不回填**：既有 Run 的历史不会补发提示，客户端在流打开时本就读取权威快照（`0012` 首部注释），语义不变。回滚按相反顺序执行：删两个触发器、恢复函数原定义、恢复原 CHECK 约束；期间已写入的 `TOOL_CALL_CHANGED` 行可保留不影响读取，也可随约束一并清理——前端不依赖该 kind 的存在。迁移链顺序在 `0056` 之后。

**已知取舍。** 一次工具轮次内的多个请求各自推进状态会产生多条提示，前端按提示重读幂等投影即可，不做合并。若后续实测提示量成为问题，再评估合并策略——本轮不预造。

## 61. 0058 M06 人工动作的 Gateway 来源（2026-10-05 源码实现）

追加 `0058_m06_user_action_origin.sql`。**只放宽三条 CHECK，不改表结构、不新增表/列/函数/索引、不回填、不改任何已应用迁移。** 契约归[命令契约 §10.57](../../api/http-command-contract/part-04.md#1057-人工触发的受管-git-只读2026-10-05-源码实现)，能力边界归[工具适配器 §1](../../architecture/tool-adapters.md)。

三条改动：

- `ck_logical_operation_origin` 追加一支 `origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL`。
- `ck_logical_operation_resource` 完整重述 `0054` 的六支后追加 `capability_key = 'GIT_READ' AND origin = 'USER_ACTION' AND resource_id IS NOT NULL`。`USER_ACTION` **只放行 `GIT_READ`**——`GIT_WRITE`、`CLI_RUN`、`FILE_WRITE` 在该 origin 下一律被拒（真实 PG 行级反例以 `23514` 确认）。
- `ck_invocation_run_identity` 完整重述 `0016` 的三支后追加 `origin = 'USER_ACTION' AND resource_id IS NOT NULL AND ownership_epoch / worker_id / worker_epoch / resource_claim_id / claim_token / claim_epoch 全为 NULL`。人工动作没有 worker 与租约，因此带 `worker_id` 或 claim 的 Invocation 形态被 CHECK 直接拒绝。

三点必须一并记住，否则会误读这张表：

1. **只读动作不建 claim。** `resource_claims` 强制绑定 `task_id`/`run_id`/`worker_*`（`0008`），人工动作没有这些，在不新增可空列的前提下**无法**建 claim。因此资源排他改由 `prepareGatewayAction` 的 prepare 与 admit 两处按 `listOccupiedResources()` 判定在途目录（`RESOURCE_OCCUPIED`）。代价是一次已派发的只读不与随后开始的写动作互斥。
2. **`uq_logical_operation_run_intent` 在 `run_id IS NULL` 时不提供任何唯一性。** PostgreSQL 的 NULL 在唯一索引中互异，因此 `USER_ACTION` 行的 intent 唯一约束形同虚设。幂等锚点只能是**应用生成的确定性 `logical_operations.id`**（sha256(workspace+project+resource+action+path+cached) → uuid 形态），不能依赖 intent 唯一键。
3. **人工主体没有列位。** 迁移只放宽 CHECK、不加列，所以 `USER_ACTION` 词表里没有 actor 列；留痕走 `activity_records`（`MANAGED_GIT_READ_REQUESTED`），在 prepare 的同一事务内写入。

**兼容与回滚。** 三条 CHECK 只能放宽不能替换，既有 `RUN` 与 `USER_IMPORT` 行的判定逐字不变，`uq_logical_operation_origin` / `uq_logical_operation_run_resource` / `fk_invocation_operation_*` 外键均不需改动即可接受新取值。迁移**不回填**：既有行不变。回滚按相反顺序 `DROP CONSTRAINT` 并恢复三条 CHECK 原定义，期间已写入的 `USER_ACTION` 行会被原 CHECK 拒绝，需先清理或导出——客户端不依赖该 origin 的存在。迁移链顺序在 `0057` 之后。

HTTP 面归[命令契约 §10.56](../../api/http-command-contract.md)，交互规则归[工作台 §18.8](../../frontend/workbench-design.md)。

## 62. 0059/0060 M04 会话模式与人设助手（2026-10-05 源码实现）

依据 [ADR-018](../../decisions/ADR-018-assistant-conversations.md) 与[运行架构 §2.6](../../architecture/runtime-context/part-01.md#26-会话级只读工具轮次)。两条迁移都只新增与只放宽：不改既有表结构、不回填历史行、不改已应用迁移。

### 62.1 0059：助手配置与会话身份

| 对象 | 关键列与约束 | 理由 |
|---|---|---|
| `assistant_profiles` | `workspace_id` / `name` / `role_description` / `tone` / `read_scope` / `revision` / `status` | 配置文本，不是授权。`read_scope` 只接受缺省或带 roots 数组的形状（受管根内相对路径），由 CHECK 挡住其他形状 |
| 活跃名唯一 | 部分唯一索引 `(workspace_id, lower(name)) WHERE status='ACTIVE'` | 归档的助手不占用名字，新助手可复用同一个名字 |
| `assist_sessions` 增列 | `conversation_mode` / `assistant_profile_id` / `assistant_profile_revision` / `assistant_role_snapshot` / `remember` | 身份在建立时冻结。既有行按普通模式读出（`DEFAULT 'AGENT'`），不虚构助手关系 |
| `ck_assist_session_mode` | 模式与三个助手列必须同时齐备或同时缺席 | 挡住「助手会话没有助手」与「普通会话其实挂着人设」两种形态 |
| `ck_assist_session_role_snapshot` | 快照不得含 `capabilities` / `connections` / `permissions` | 人设快照是文本；把权限写进配置的那条路在存储层就被堵住 |

迁移同时收紧既有授权：应用角色对 `assistant_profiles` 只有 `SELECT, INSERT`，可更新的列限于内容列与 `status` / `revision` / `updated_at`——归档推进的是「是否仍适用」，不改写配置文本。

### 62.2 0060：第四种 Gateway 来源与会话级工具账本

| 变更 | 内容 | 理由 |
|---|---|---|
| `ck_logical_operation_origin` 追加助手来源 | task / run / step / import_job 四列必须同时为 NULL | 助手只读动作既没有 Run 也不冒充 Run；否则 Run 的未决列表会漏掉它 |
| `ck_logical_operation_resource` 追加该来源 | 只放行 `FILE_READ` / `FILE_QUERY` / `GIT_READ`，且必须绑定受管资源 | 「可读不可写」落在 CHECK，而不是靠应用层自觉 |
| `ck_invocation_run_identity` 追加该来源 | 绑定受管资源，但 ownership_epoch / worker / claim 各列全为 NULL | 与 0058 的 `USER_ACTION` 同构：只读不建 claim，资源排他靠 `listOccupiedResources()` 拒绝在途目录 |
| 新表 `session_tool_calls` | `(session_id, message_id, round, ordinal)` 唯一；`operation_id` 可空 | 与 `run_tool_calls` 刻意不合并：两种执行身份不得互相填对方的 id |

状态与 Operation 的自洽由 `ck_session_tool_calls_operation` 三态判定：被拒的行必无 Operation；已结算与未知的行必有；请求中两种皆可——准备已绑定而派发未完成，崩溃后要按同一个身份核对，因此这一态不额外收紧，也不允许被当成「什么都没发生」。

三条 CHECK 都**逐条重述**既有分支再追加，而不是就地追加：0054 重述 `ck_logical_operation_resource` 时漏掉 WEB_FETCH 与 FILE_WRITE，造成 9 例既有动作在下一次写入时违反约束，同一类教训。应用角色对 `session_tool_calls` 只有读写与状态推进，没有 DELETE——删行等于抹掉一次真实读取发生过的事实。

## 63. 0062 自然语言状态维护的请求与变更账本（2026-10-09 源码实现）

依据总纲 §0.8.1 与[领域模型 §12.5](../../architecture/domain-model/part-01.md#125-自然语言状态维护的应用边界)、HTTP 契约 §10.61。两张表**不复制业务事实**：目标、知识、决策、任务、计划、进度、阻塞仍各归原 Owner；这里只保存「原消息 → 确认内容 → 领域命令 → 回执」的关系与整组撤回的补偿轨迹。

| 对象 | 关键列与约束 | 理由 |
|---|---|---|
| `conversation_state_requests` | `unique(workspace_id, command_id)`、`unique(source_message_id)`、`base_content_sha256`、三阶段命令身份（interpret/apply/undo）建行即固化 | 原消息与阶段身份可追溯；摘要当前只落库，尚无内容漂移核验及解析对象版本基线。唯一约束排除重复请求行，不等于排除重复在途模型调用或保证各阶段可恢复 |
| `ck_conversation_state_request_status`（13 态）与 `ck_..._decision_stage` | `CLARIFY` 与已决态互斥；应用过必须已结算候选 | 状态机由 CHECK 兜底：解释成功才可应用，应用过的请求不会退回 DISCUSS |
| `decision_required` jsonb | 非空时不得自动应用（应用层 409）；含 `blocked_changes`（null = 整组等待） | 连带承诺先取得决定，不把「延后导出」放大成「推迟发布」；只给序号时独立且明确的修改照常生效 |
| `conversation_state_changes` | `unique(request_id, ordinal)`、`unique(command_id)`、`before_ref`/`after_ref`、`baseline_ref`（0064）、6 态 + 补偿列 | 每条变更一条固定命令身份；`APPLIED` 必须留 `after_ref` 与 `applied_at`，否则「改了什么」无从核对、撤回无从定位；`COMPENSATED` 必须带补偿命令身份 |
| `change_kind` 白名单（12 种，0066 放宽） | CREATE_GOAL…RESOLVE_BLOCKER + SET_TASK_PLANNING | 类型化变更，不接受任意 JSON Patch；ID 由应用按当前事实解析，模型给的 ID 不进库 |

应用角色只有 SELECT/INSERT/UPDATE，没有 DELETE——撤回是沿原 Owner 的新变更与补偿轨迹，不是抹掉「曾生效过」的事实。

## 64. 0063 返回项目的日常查看基线（2026-10-09 源码实现）

依据 HTTP 契约 §10.62。单表 `project_daily_view_baselines`：`unique(workspace_id, project_id)` 每项目一行查看基线，当前行 `unique(workspace_id, presentation_id)` 排除展示身份同时占用；推进会替换 presentation_id，历史确认还须依靠命令回执。`viewed_state_revision` + `viewed_fact_refs` 保存必要引用（phase、下一步任务、未终结任务 id 集合 ≤200、阻塞计数与截断标记），不复制业务正文、不存第二套 Project State。推进条件见 §66（0065 起为「展示序号严格增大且 State revision 不倒退」双条件）。命名接续点（`project_continuation_points`，0044/0045）不被日常查看写入或重设。

## 65. 0064 确认时点的适用基线与已确认撤回方案（2026-10-10 源码实现）

依据 HTTP 契约 §10.61、[领域模型 §12.5](../../architecture/domain-model/part-01.md#125-自然语言状态维护的应用边界)、测试计划 NLS-11。两条 `ALTER TABLE ... ADD COLUMN`，不改既有约束、不改 0062/0063 文件。

| 对象 | 关键列 | 理由 |
|---|---|---|
| `conversation_state_changes.baseline_ref` jsonb | 状态类变更记确认时点 `state_revision`；按标题可解析的对象记 `target_task_id`/`target_goal_id`/`blocker_id`/`knowledge_id`＋`knowledge_revision`；确认时点解析不到记 `resolved:false` | 应用与补偿各自重查适用性：版本/身份对不上就保留当前事实并报类型化冲突。不用「读最新 revision」消除冲突，也不只比较字段值——后续修改可能又改回同值，必须按版本识别 |
| `conversation_state_requests.undo_scope` jsonb | `{ plan_digest, change_ids }`，与 `UNDOING` 状态在同一语句提交 | 事前预检的**已确认方案**持久化：只有持久 Owner 推进撤回，`UNDOING` 中断后按同一范围恢复剩余补偿，不会把未确认的项也补偿掉；CAS 输方拿不到行即不执行计划 |

`baseline_ref` 只保存「确认时点看到了什么」，不复制业务正文；目标、任务、State 仍各归原 Owner。0062 已应用的库按追加迁移升级，历史行该列为 NULL（应用时按当前事实首次解析，不为历史数据伪造版本）。

## 66. 0065 日常查看的服务端展示序号（2026-10-10 源码实现）

依据 HTTP 契约 §10.62、测试计划 NLS-06。新表 `project_daily_view_presentation_counters`（`PRIMARY KEY(workspace_id, project_id)`）在每次 `GET /daily-continuation` 时 `INSERT ... ON CONFLICT DO UPDATE SET issued_seq = issued_seq + 1` 递增签发；基线表追加 `viewed_presentation_seq bigint NOT NULL DEFAULT 0`。

推进条件改为 `viewed_presentation_seq < 新序号 AND viewed_state_revision <= 新值`（仓库层条件更新 + 行锁双保险）。序号解决的是「State revision 不变时任务集合变化」的查看顺序问题：签发顺序由服务端给出，不用客户端时钟；确认携带的序号超过已签发上限即拒绝，客户端不能自造一次展示。表只存计数与最后签发的展示身份，不存业务正文。

## 67. 0066 既有任务的计划调整（2026-10-10 源码实现）

依据 HTTP 契约 §10.61、测试计划 §24。只放宽 `ck_conversation_state_change_kind` 增加 `SET_TASK_PLANNING`（drop 后按完整清单重述再 add，遵守「CHECK 逐条重述而非就地追加」的既有教训），其余约束逐字保留。该变更沿原 Owner `SetTaskPlanningMetadata` 生效，只改模型真正给出的字段，截止日期必须配时区（由客户端随解释请求提交并冻结进 `baseline_ref` 同级的载荷）。

## 68. 0067 复验整改：DECLINED 终态、解释基线前置与展示签发记录（2026-10-10 源码实现）

依据整改任务书 `prompts/remediation/natural-language-state-maintenance-acceptance-20261010.md` R1/R3/R6。三处追加：

1. **R1 拒绝语义**：`conversation_state_requests.status` 与 `conversation_state_changes.status` 白名单各增加 `DECLINED`（drop 后完整重述）。用户回答「不调整」后，受该决定约束的变更进入 `DECLINED`——既不是 `APPLIED/SKIPPED`（不谎报生效/已存在），也不是 `PENDING`（不被自动应用再次执行）。
2. **R3 解释基线前置**：`conversation_state_requests` 新增 `interpretation_baseline jsonb`，在 claim 事务内、调用模型**之前**持久冻结该意图依据的 Project State 版本；结算与重启恢复沿同一基准，不把模型返回时间当成再次确认。迁移前旧行该列为 NULL：缺可信基线的状态类变更按 `STATE_BASELINE_MISSING` 保守拒绝，不读最新版本冒充原基线。
3. **R6 展示签发绑定**：新表 `project_daily_view_presentations`（`UNIQUE(workspace_id, presentation_id)`、`UNIQUE(workspace_id, project_id, issued_seq)`）记录每次真实读取签发的身份、序号、当次 State 版本与已展示事实摘要；确认必须逐项对上签发记录，**取代 §66 中「序号不超过已签发上限」的单点校验**。兼容回填：迁移时把既有基线按其自身身份回填一条 legacy 签发记录（0065 之前的历史行序号为 0）。污染基线（签发来源缺失且版本高于任何真实读取）由应用层按 `PROJECT_DAILY_VIEW_BASELINE_REPAIRED` 审计恢复。

## 69. 0068 外部成果核对与完成指令（2026-10-10 源码实现）

依据测试计划 NLS-04、任务书第五节第 3 项（Slice B）。只放宽 `ck_conversation_state_change_kind` 增加 `SYNC_EXTERNAL_RESULT`（只读核对）与 `COMPLETE_TASK`（沿原完成 Owner `CompleteHumanTask` 提交）；其余约束逐字保留。核对结果写入变更 `after_ref`（`check_result` 分类）与 `CONVERSATION_EXTERNAL_CHECKED` 审计，不改任何业务状态；完成以 `baseline_ref` 冻结任务版本与验收版本，接受声明绑定原用户消息原文，Owner 规则不满足即类型化失败。`SYNC_EXTERNAL_RESULT` 不进补偿计划（只读历史），`COMPLETE_TASK` 归为 `UNDO_ENTRY_MISSING`（完成记录不随整组撤回自动重开，NLS-12）。

## 70. 0069 返回轻量核对记录（2026-10-10 源码实现）

依据测试计划 NLS-05/NLS-08/NLS-09、任务书第五节第 4 项（Slice C）。新表 `project_return_reviews`（`UNIQUE(workspace_id, project_id, fingerprint)`，`status IN ('APPLICABLE','CHANGED')`）：一次核对 = 一个事实与证据指纹行；事实与证据没变复用同一行（重复打开、双击、重启不产生第二次核对），变了得到新指纹重新核对。`result jsonb` 只存变化维度、delta 摘要与完成证据适用性引用，不复制业务正文；核对是同步只读动作，不伪造 Run、不启动进程。回滚风险：纯追加表，回退后旧代码不读它。

## 71. 0070 自然语言撤回的候选白名单（2026-10-10 源码实现）

依据测试计划 NLS-11、任务书第五节第 1 项。只放宽 `ck_conversation_state_change_kind` 增加 `UNDO_STATE_CHANGE`。候选不携带任何 ID：结算时解析同会话**唯一**一条已生效调整并把身份冻结进 `baseline_ref`（0 条或多条记 `resolved:false`，应用时按 `UNDO_TARGET_NOT_FOUND` / `UNDO_TARGET_AMBIGUOUS` 类型化失败）；应用阶段复用按钮撤回的同一应用用例（undo-plan、范围决定与持久 `undo_command_id` 全部不变）。撤回结果本身不进补偿计划（归为 `UNDO_ENTRY_MISSING`，要恢复原调整需重新发起）。


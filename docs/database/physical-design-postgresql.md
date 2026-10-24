# Personal Workflow OS：PostgreSQL 物理数据库设计

> 2026-09-28 增量：`0040_collaboration_artifact_text_locks.sql` 保存当前锁定原文及映射状态；`0041_collaboration_impact_checks.sql` 扩展 Assist intent 并保存确切来源/目标与候选；`0042_collaboration_attention.sql` 保存已发现的锁冲突原目标及通知去重回执。三份 migration 在隔离 PostgreSQL 18.6 成功应用，详见[专项开发记录](../development/collaboration-controls-2026-09-28.md)。新表为空起步，既有版本不改写；回滚删表会丢失当前锁定/回执，须先停写并保存事实。

> 2026-09-24 当前实现：保留 Kysely/pg、业务表及已应用 SQL migration/SHA 台账；M03 已追加 `0011` 的 command/outbox/invocation、`0012` 的 Run 刷新事件及 `0013` 的每 Run 命令顺序。官方 PostgresSaver 的固定 schema 安装与 Worker 接入已通过后端固定图分片独立复验；Windows 组合及 M03 整体仍待验收。业务事务与检查点按稳定身份对账，不能假装原子。

日期：2026-09-19。状态：Proposed。用户已确认允许本机 PostgreSQL；完整技术组合、DDL 与协议仍需工程验证。上游：[逻辑模型](logical-model.md)、[技术选型](../architecture/技术选型.md)。

本文件给出 PostgreSQL 17 基线上的类型、约束、索引、锁协议和建表顺序。SQL 块是需合入后续 migration 的设计片段，不是可以逐段运行的完整脚本。本文业务 DDL 尚未完成真实数据库验证；[P00 基础实验](../research/p00-source-study.md#7-后端开工前准备接续2026-09-20)不代表这些业务 migration 或并发验收通过。

TypeScript-first 评审后的新工程目标候选为 PostgreSQL 18 + Kysely/pg，见 [ADR-006](../decisions/ADR-006-typescript-first.md)。下文 17 基线片段与引用保留来源，P00 必须在 18 上验证后再生成 migration，不能把改版本号当作兼容性通过。没有已部署数据库，不存在本轮生产升级或数据迁移。

## 1. 类型、时间与命名

| 逻辑含义 | 物理约定 |
|---|---|
| 实体、命令、调用 ID | uuid，由应用预分配；不用有业务含义的路径作主键 |
| revision / epoch / acceptance_revision | bigint NOT NULL，普通 revision/epoch >= 0，验收版本和 attempt_number >= 1 |
| 状态/类型 | text NOT NULL + 有名称的 CHECK；迁移显式调整合法值，避免把所有状态塞进同一枚举 |
| 时间点 | timestamptz NOT NULL，后端使用带 UTC 语义的时间类型；显示再转换用户时区，具体类型按 P00 选型验证 |
| 用户 Later 日期 | date + timezone text；不是 UTC 时间点 |
| SHA-256 摘要 | bytea，CHECK(octet_length(value)=32)；边界输出十六进制 |
| 快照/受约束参数 | jsonb NOT NULL + schema_version；应用结构验证，核心关系仍有列与外键 |
| 文本 | text；大小限制由入口验证；大内容进入受管存储 |
| 可选关联 | uuid NULL；通过 CHECK 明确何时允许空，不依赖 CHECK 对 NULL 的隐式行为 |

表和约束使用 snake_case。PK 默认 id；关联表可以使用复合主键。默认外键 ON DELETE NO ACTION；循环依赖只对必要外键使用 DEFERRABLE INITIALLY DEFERRED，唯一约束保持立即检查。终态历史记录不物理删除。

TypeScript 映射：bigint revision/epoch 使用无损表示，公开 JSON 仍按 HTTP 契约输出十进制字符串，不转换为 number。Kysely 的静态类型不改变 pg 实际返回值；Repository 共享应用事务连接，迁移入口和内容完整性另行验证。当前表身份、字段及锁协议不因 Query Builder 改名。

PostgreSQL CHECK 不用于跨表检查；跨表关系优先用复合外键，业务迁移使用受锁保护的用例。[约束官方说明](https://www.postgresql.org/docs/17/ddl-constraints.html)

不使用 JSON 文本序列化顺序计算幂等摘要。命令在输入规范化后，以固定版本的字段规则编码再计算 hash；明确缺省值、数组顺序和路径规范化。保存 hash_algorithm / canonicalization_version，升级规则不改变历史回执判断。

## 2. 核心关系的物理收敛

逻辑模型未展开的普通字段沿用上一份文档，本节定义必须改变或补充的物理关系。

| 关系 | 物理实现 |
|---|---|
| Workspace 范围 | projects、tasks、goals 都有 workspace_id；projects/goals 建 UNIQUE(workspace_id,id)，相应关系用复合 FK 防止跨 Workspace |
| Task 当前验收 | task_acceptances PK(task_id,acceptance_revision)；tasks 的当前指针用延迟复合 FK 引用该键 |
| Task 当前 Run | runs 建 UNIQUE(task_id,id)；tasks(id,executor_run_id) → runs(task_id,id)，executor_run_id 可空；不强制 Run 的旧验收版本等于 Task 当前版本 |
| Run 与执行契约 | execution_contracts 直接以 run_id 为 PK/FK；取消重复 execution_contract_id；runs.id 反向延迟 FK 到 execution_contracts.run_id，保证提交时恰有一份契约 |
| 契约归属 | execution_contracts(run_id,task_id) → runs(id,task_id) 的对应 UNIQUE；契约(task_id,acceptance_revision) → task_acceptances |
| Run 当前步骤 | run_steps 建 UNIQUE(run_id,id)；runs(id,current_step_id) → run_steps(run_id,id) 延迟 FK，可空 |
| Task 当前完成 | completion_records 建 UNIQUE(task_id,acceptance_revision,id)；tasks 当前三列指针复合 FK 到该键，延迟检查 |
| 显式 Goal 对齐 | task_explicit_goals 冗余 project_id；复合 FK(task_id,project_id) → tasks(id,project_id)，FK(project_id,goal_id) → project_goals；三列均非空 |
| Project 下一步 | project_states(project_id,next_action_task_id) → tasks(project_id,id)；为空时没有方向选择 |
| 多资源动作 | 以 operation_resources(operation_id,resource_id) 替代 logical_operations.resource_id；invocation_resource_bindings 保存实际 claim_token 集合，不限定一个资源 |

冗余 project_id 用外键约束而非独立维护。Task 移动 Project 仍须业务前置检查；历史 Run 保留其执行时 Project，不通过更新历史关系迁就移动。移动时清理/重设当前 State 引用与显式 Goal，不能留下跨项目指针。

### 2.1 建立循环引用的实际顺序

建表先建立所有根表，再通过 ALTER TABLE 添加循环外键。运行时：

1. 创建 Task：预分配 Task ID，插入 Task 与 acceptance v1，同一事务结束时验证当前验收 FK。
2. Delegate：锁 Task；预分配 Run ID，插入 Run，再插入 execution_contracts（同 Run ID），更新 Task 的执行权与 epoch，保存回执后提交。
3. Step：插入 run_steps 后更新 runs.current_step_id；不提交无归属步骤或悬空指针。
4. Complete：先插入 completion_records，再设置 Task 当前凭据、状态及 Run 终态；同事务更新必要 State。
5. Reopen：创建新的 acceptance 版本，清空 current_completion_id 并更新当前版本/状态；有所属 Project 时同事务递增 State revision，使当前完成投影失效；历史凭据仍引用旧验收。

延迟约束在 COMMIT 才可能报错，事务执行器必须把提交失败作为整个用例失败处理，不能在提交前向 UI 返回成功。

### 2.2 必要约束片段

```sql
ALTER TABLE tasks ADD CONSTRAINT ck_task_executor CHECK (
  (executor_kind = 'HUMAN' AND executor_run_id IS NULL)
  OR (executor_kind = 'AI' AND executor_run_id IS NOT NULL)
);
ALTER TABLE tasks ADD CONSTRAINT ck_task_completion CHECK (
  (status = 'DONE' AND current_completion_id IS NOT NULL)
  OR (status <> 'DONE' AND current_completion_id IS NULL)
);

CREATE UNIQUE INDEX uq_run_live_task ON runs(task_id)
WHERE status IN ('CREATED','CONTEXT_BUILDING','PLANNING','RUNNING',
  'WAITING_APPROVAL','VERIFYING','RETRYING','PAUSED');

ALTER TABLE completion_records ADD CONSTRAINT uq_completion_cycle
  UNIQUE(task_id, acceptance_revision);

CREATE UNIQUE INDEX uq_control_pending ON run_control_requests(run_id)
WHERE status = 'PENDING';

CREATE UNIQUE INDEX uq_resource_occupied ON resource_claims(resource_id)
WHERE status IN ('HELD','QUARANTINED');

CREATE UNIQUE INDEX uq_invocation_unsettled ON invocation_attempts(operation_id)
WHERE status IN ('PREPARED','DISPATCHING','UNKNOWN');
```

每个 Run 同时一个 PENDING 控制意图：相同 request_id 幂等返回；不同意图必须拒绝冲突或在事务中显式 SUPERSEDED 后替换。部分索引不覆盖全部状态关系：例如 Task executor 与 Run 非终态的一致更新，仍由应用事务保证。

resource_claims 的状态是本轮新增的内部存储术语：HELD 为占用，QUARANTINED 为未证实安全，RELEASED 为已安全释放；不会增加 Task/Run 状态。lease 过期不自动排除出唯一索引。

## 3. State、Review 和证据不使用裸多态 ID

state_refs 拆成 state_completion_refs(project_id,completion_id)、state_decision_refs(project_id,decision_id)、state_artifact_refs(project_id,artifact_version_id)，分别有真实外键。关联源的 Project 一致性使用复合 FK 或受 ProjectState 锁保护的校验；历史有效与当前适用仍需投影检查。

Review 采用一个 review_requests 根表及两种主要类型绑定：

- review_action_bindings：review_id PK/FK、proposed_operation_id、run_id、step_id、action_type、normalized_target、params_hash、content_hash、scope、expires_at。动作尚未准入时 proposed_operation_id 是预分配身份，不假装有 Gateway PREPARED 行；Prepare 时创建同 ID 的动作并建立真实占用关系。
- review_acceptance_bindings：review_id PK/FK、task_id、acceptance_revision、artifact_version_id、session_id?、selection_mode。每个产物明确一行；一份 Review 可绑定多个产物，因此实际关联 PK 为 (review_id,artifact_version_id)。

按类型存在且仅存在相应绑定，由 Review 写入口在单一事务保证，配套数据库集成测试；不声称普通 FK 能保证“父表必须有正确子表”。必要时再采用约束触发器，不在第一版引入通用多态约束框架。

review_decisions.review_id 唯一，review_effects.decision_id 唯一。可重试动作批准拆为：

- approval_reservations(review_id PK, operation_id, reserved_at)：批准只能绑定一个逻辑动作，另建 UNIQUE(review_id,operation_id)。
- invocation_approval_bindings(invocation_id PK, review_id, operation_id)：复合 FK 同时指向 reservation 和 invocation 的相同 operation；每次尝试仍重新验证有效性。未决 invocation 唯一索引防止同一动作并发执行。

这细化了逻辑模型中单行 reservation 的 invocation_id：占用属于逻辑动作，消费记录属于调用尝试；不能靠覆盖旧 invocation_id 丢弃批准历史。

Verification 保留 session 及不可变 check_results；session 完结后禁止继续追加结果。verification_targets、criterion 关联和 completion 的依据均有真实 FK。对于自动完成，必须指定 session 且其契约与 Task 周期匹配；人工完成保存独立 human_acceptances 记录（task_id、acceptance_revision、actor、reason、accepted_version_refs），不要求先伪造一份 Review 或自动 PASS。

completed 与不可变内容不能仅依赖开发约定：应用 DB 角色对 artifact_versions、execution_contracts、task_acceptances、check_results、completion_records、review_decisions、human_acceptances 只授予所需 SELECT/INSERT，不授予 UPDATE/DELETE；迁移角色单独持有 DDL 权限。哈希校验不能代替宿主文件写权限控制。

## 4. 锁定协议与权限撤销

事务隔离基线为 READ COMMITTED，跨行不变量以显式行锁、条件更新和约束共同保证。不能把隔离级别名称当作完整并发证明。[PostgreSQL 行锁说明](https://www.postgresql.org/docs/17/explicit-locking.html)

新增 workspace_execution_authority(workspace_id PK/FK, revision bigint NOT NULL)。创建 Workspace 时同步建行，禁止缺失时继续准入。

- 动作准入和完成提交：先对 authority 行 SELECT ... FOR SHARE，随后检查当前权限、规则适用性、验证撤销等事实，持有到本次短事务提交。
- 权限更新/撤销、硬规则更新、验证适用性撤销、影响验收的共享输入当前版本切换：先对同一行 FOR UPDATE，再修改事实并递增 authority revision。
- Task 自身验收变化通过 Task 行串行化；State 中当前选用版本变化通过 ProjectState 行串行化。相关版本是验收关键输入时，变更用例还须取得 authority 写锁。
- 历史不可变版本不需要锁住内容；current 指针或适用性是可变事实，必须按上述入口更新。

采用 Workspace 粒度是 V1 的简化，会让权限/共享规则变更等待当前短提交；它不会跨外部调用持锁。未来若成为瓶颈再细化，不能提前分散为互不协调的锁。

统一顺序扩充为：Authority → Task（按 ID）→ Run（按 ID）→ ProjectState（按 ID）→ Resource（按 ID）→ Review/Operation/Invocation。仅锁用例需要的行，但不得先持后面的锁再补前面的锁。普通控制命令若不需要 authority，就从 Task 开始且不再反向取 authority。

资源登记/重命名在 authority 写锁下核对规范身份与别名；不同 Project 可登记相同或父子根，真正的重叠排他在占用时执行。准入锁 managed_resources 根行，并使用跨 Workspace 的同一个事务级资源登记锁检查全部 HELD/QUARANTINED 根，避免两个不同 resource_id 各自看不到对方的幻影占用。需要新建策略作用域时也在 authority 写锁下进行，避免查已存在策略却漏掉并发新增拒绝规则。

准入先提交：动作已经在途，后来的撤销/停止只能按在途动作处理。撤销/停止先提交：准入重读后拒绝执行。锁的线性化点是数据库提交，外部调用之后仍存在无法回滚和 UNKNOWN 窗口。

## 5. 工作认领、准入与完成 SQL 路径

### 5.1 Worker 先锁 Task，再锁 Run

队列候选查询示意：

```sql
SELECT t.id AS task_id, r.id AS run_id
FROM tasks t JOIN runs r ON r.id = t.executor_run_id AND r.task_id = t.id
WHERE t.executor_kind = 'AI'
  AND r.status IN ('CREATED','CONTEXT_BUILDING','PLANNING',
                   'RUNNING','VERIFYING','RETRYING')
ORDER BY r.created_at, r.id
LIMIT 1
FOR UPDATE OF t SKIP LOCKED;
```

随后锁该 Run，重读控制意图、claim 和恢复前提，再认领；没有安全接管依据的过期 claim 交恢复器处理。此查询只是候选筛选，不是可直接投入生产的完整调度器：实现需加 eligibility/下一次调度时间和 claim 过滤，防止持续选中暂不可工作的头部记录。不要用先锁 Run 的队列查询破坏全局锁序。

同一 Run 的首次 claim 插入与后续 CAS 续租在 Task/Run 锁下完成，保存 worker_id、claim_epoch、lease_until；期限比较使用数据库 clock_timestamp() 的同次采样值，不沿用长事务开始时间。Worker 续租不自动延长已到期的批准或资源许可。

### 5.2 Prepare 与 Admit 分开

Prepare 在短事务中校验执行权、控制和权限，建立 PREPARED invocation 与批准占用。ASK 只建立 Review，不产生已放行调用。

Admit 按全局锁序再次检查 owner/claim/resource token、控制、有效批准和当前权限，再做带条件的 UPDATE：

```sql
UPDATE invocation_attempts
SET status = 'DISPATCHING', dispatched_at = clock_timestamp()
WHERE invocation_id = :invocation_id AND status = 'PREPARED';
```

必须检查影响恰好一行；提交后才进行一次外部调用。结果保存单独事务，只保存确切 invocation 的证据。失联进入 UNKNOWN，隔离资源；超时不证明未执行。过期 Worker 返回结果不能推进新执行者的 Run。

### 5.3 Complete 的完整顺序

1. 查看同作用域 command_receipt，若存在先比 payload_hash，再返回原结果。
2. 按锁序获取 authority、Task、可选 Run、必要 ProjectState/资源；锁住对应验收/Review 所属的业务根。
3. 重查 receipt、Task 周期与执行者，检查停止意图、未决调用、验收契约、有效证据及必需 Review。
4. 写 CompletionRecord，CAS Task 至 DONE，更新可选 Run 至 COMPLETED，释放安全资源并增加 ownership_epoch。
5. 写确定性 State delta、command_receipt 和关键审计，提交后通知 UI。

锁不能代替唯一约束；两个不同 command_id 对同一周期的竞争还需 uq_completion_cycle。数据库死锁/瞬时冲突只允许对“无外部调用的整个短事务”有界重试，不重放模型或工具。唯一冲突按语义处理为幂等结果或业务冲突，不当作任意可重试故障。

## 6. 索引与查询清单

| 查询 | 首版索引候选 |
|---|---|
| 项目任务列表 | tasks(project_id,status,id) |
| 默认 Inbox | tasks(workspace_id,status,id) WHERE project_id IS NULL |
| Run 待工作候选 | runs(status,created_at,id)，后续加入调度时刻须同步修改索引与查询 |
| 控制请求恢复 | run_control_requests(run_id,status)，PENDING 唯一索引已有则不重复建相同前缀索引 |
| Worker 超时 | run_worker_claims(lease_until,run_id) |
| 未决调用核对 | invocation_attempts(status,dispatched_at,invocation_id) WHERE status IN ('DISPATCHING','UNKNOWN') |
| Run 的动作 | logical_operations(run_id,step_id,operation_id)；invocation_attempts 的 operation + attempt 唯一索引 |
| Review 阻塞 | review_requests(run_id,status,review_id) |
| 验证及证据 | verification_sessions(task_id,acceptance_revision,created_at)；check_results(session_id,criterion_id,check_attempt) UNIQUE |
| 不可变版本 | artifact_versions(artifact_id,version_number) UNIQUE |
| 命令重放 | command_receipts(scope_key,command_id) UNIQUE |

FK 引用侧按实际删除/查询需求补索引；不为每个字段建索引。所有扫描必须有限 batch，按稳定 ID 排序。真实数据量到位后用执行计划检查，不宣称当前已有性能结论。

## 7. 内容存储、备份与数据保留

2026-10-01 Windows 物理发布接续：ManagedContentStore 的路径、ref/hash/size与数据库版本模型不变，无新 migration。实际原生写者在 data_root 固定 `.relay-content-admission.lock` 上持共享锁完成发布，维护对同一真实 sentinel 排他；该文件不保存业务回执，不把文件锁冒充数据库/Saver 冻结。兼容、旧助手限制和外部资源边界见 [ADR-015](../decisions/ADR-015-managed-content-native-publication.md)与[部署说明](../deployment/本机部署.md#windows-受管内容发布安全点)。

建议配置独立 data_root，内容路径使用内部 ID：staging/<upload-id> 与 artifacts/<artifact-id>/<version-id>/content.md。数据库只保存受管相对路径，禁止把用户提供的路径直接拼接到存储根。

写入顺序：同文件系统暂存 → 完整写入并计算 hash/size → 按平台能力刷盘 → 发布到新的不可变版本目录且禁止覆盖 → 数据库登记版本。目录发布/刷盘的实际保证需 Windows 等目标平台验证；rename 不代表“任意断电下文件和 DB 原子”。

失败可留下孤儿文件，不能留下指向未发布文件的版本。V1 默认保留孤儿并提供核对报告，自动清理暂不启用；启用前需明确宽限期并证明不误删正在上传/恢复的内容。启动抽检/访问校验发现缺失时，返回证据不可用并阻止依赖该证据的完成，不能伪造内容或重写旧 hash。

首版备份采用维护窗口：停止领取和业务写入，等待安全点或明确保留 UNKNOWN，冻结内容清理，再备份数据库与不可变内容及摘要清单。恢复时一起校验两部分。只复制数据库或运行中直接复制 PG 数据目录均不作为这里的可用备份流程。具体备份命令和恢复演练在部署文档阶段给出。

## 8. Migration 拆分与验证出口

以下是批次规划；实际已落地 migration 以第 15–22 节和 `apps/api/migrations` 为准：

| 批次 | 范围 | 出口 |
|---|---|---|
| V001 | Workspace、Project、Goal、Task/验收、Artifact、人工接受、完成凭据、State 类型引用、回执/审计 | 人工创建→不可变产物→完成→重开，循环 FK 与周期唯一约束可验证 |
| V002 | Run/契约、Step/Attempt、Verification、Review 与批准类型绑定 | Fake Worker 完整闭环、重复决定和过期证据被拒绝 |
| V003 | P08 先落 Run worker fence、控制请求与受控 Fake 发布动作身份；P09 再落固定 Fake Gateway、Permission 与跨 Task Resource claim | 控制/完成、崩溃点、撤销/准入和重叠资源竞争分阶段测试；真实工具仍后续 |
| V004 | P10 四类长期信息的根/不可变版本、Rule revision 栅栏 | Rule/Delegate 两序、来源范围、并发提升、搜索游标与原效果回执测试 |
| V005 | P11 独立 Context source revision；复用不可变 Manifest payload 保存实际片段 | 资料与构建竞争、预算、历史读取重鉴权、Fake 回路 |
| 后续 | Assist/Workbench 显式资料选择与实际增量 | 按真实调用方新增，不一次性创建占位平台 |

每个批次要生成完整可运行 DDL、权限授权与测试 fixture；SQL 片段不能直接充当 migration 脚本，迁移工具随 P00 选型验证。V001 只允许 HUMAN 执行，尚不建立指向 Run/Verification 的字段与 FK；V002 在建好目标表后添加这些字段、约束并扩展允许状态。不能让 V001 引用尚未创建的表。V002 的 Fake Worker 不执行真实外部副作用；若更早需要权限/动作能力，相应 V003 约束必须前移。

测试最少覆盖：空值 CHECK、跨 Workspace/Task 引用、延迟 FK 提交失败、并发 Delegate、重复周期完成、暂停保留占有、审批跨动作重放、资源隔离不自动释放、撤销/准入两个提交次序、过期 Worker、重开后旧命令重放。映射仍沿用 A01–D11，具体数据库测试在代码建立后实现。

## 9. 完整模块设计的增量落点

Information/Today/Assist 按调用方分期落地：Knowledge/Memory/Decision/Rule 根与版本及 task.goal_alignment_mode 已在 0002/0009，Assist/model_calls 在 0015/0018，Today planning metadata 与独立 selection revision 在 0020；lineage_edges 仍待后续实际入口。字段与唯一性见下文对应迁移小节。提案由领域 Owner 持有，State 复用 state_proposals，统一 ProposalDTO 不再建第二份状态表。不要回头修改已应用 V001。

2026-09-20 的 Skill/Blueprint 待落实项已由 0022–0025 逐段实现；当前 Project Blueprint 持久化、基线和锁序见第 37 节。真实 PG 开发自检覆盖了重放、View stale、来源归档和事务回滚；独立模块与桌面验收仍后置。

同一扩展还需落实可选 Pack 来源、解析成员清单与实际 Profile/Recipe 版本引用的存储/完整性检查；旧记录兼容与定义快照保留见逻辑模型。采用包不能生成另一套事实表，兼容校验失败不得留下部分 current 绑定。此项仍为 D 阶段迁移前核验要求，无新增已执行 SQL。

按 [ADR-004](../decisions/ADR-004-user-import-origin.md)，URL 导入增加 import_jobs。logical_operations 添加 origin_kind（RUN/USER_IMPORT）、import_job_id?、project_id；RUN 要求 run_id/step_id 非空且 import_job_id 空；USER_IMPORT 要求 import_job_id 非空且 run_id/step_id 空，并有真实 FK。两分支都必须 project_id 非空且同 Workspace。USER_IMPORT 的 intent 唯一键为 (import_job_id,intent_key) 部分索引；RUN 保留 (run_id,step_id,intent_key)。

invocation_attempts 只在 RUN 时携带有效 ownership/worker epoch；USER_IMPORT 保存用户/配置来源，不把 0 当万能 epoch。Admit 仍先锁 authority，再锁 import_job 和对应 Operation，验证 job 可执行与当前权限；没有 Task 时不取得虚假的 Task 锁。它只开放公共读取，不授予资源写权。用户来源不能选择 RUN 的身份伪装 Worker。

Task.mode 的传输/持久枚举见运行设计；AI 执行权仍是 executor_assignment，不从 mode 推导。mode 变化与 owner 更新的应用事务保持一致，但 enum 不替代生命周期约束。

## 10. 本轮验证边界与下一步

已依据官方 PostgreSQL 文档检查所用约束和锁语义，并对设计进行静态一致性核对。本机只发现 Docker 客户端，服务未运行，未发现 psql/postgres 命令；未为文档任务安装或启动数据库。

下游已有 [API/命令契约](../api/http-command-contract.md)和[首条工程切片](../development/first-human-slice.md)。下一步在独立工程生成 V001 并于实际 PostgreSQL 运行，不将本文件的 SQL 示例当作已验证实现。原件对照见设计审计；精确依赖补丁仍待工程核验。

## 11. V001 实际 migration 与兼容性（2026-09-20 实施记录）

本节把第 8 节的 V001 批次从设计片段推进为可运行事实，并记录与第 2–6 节示例的差异。实际 DDL 见 [apps/api/migrations/0001_v001_human_core.sql](../../apps/api/migrations/0001_v001_human_core.sql)，角色见 [apps/api/sql/bootstrap-roles.sql](../../apps/api/sql/bootstrap-roles.sql)；全部内容由 apps/api 的真实 PostgreSQL 18.6 集成测试覆盖（30 个用例，见根 README 的“后端工程”一节）。第 2–6 节的 SQL 片段仍只是设计来源，未被逐段执行。

### 11.1 实际纳入的表与约束

- 文件已应用后不可改写：迁移入口把每份 `*.sql` 的内容 SHA-256 写入台账 `relay_schema_migrations`，文件缺失或内容变化一律拒绝执行。
- 表（21 张）：workspaces、workspace_execution_authority、projects、goals、project_goals、tasks、task_acceptances、acceptance_criteria、task_explicit_goals、task_dependencies、project_states、project_blockers、project_risks、artifacts、artifact_versions、human_acceptances、completion_records、state_completion_refs、state_artifact_refs、command_receipts、activity_records。
- Workspace 范围用复合外键：projects/goals 建 UNIQUE(workspace_id,id)；tasks(workspace_id,project_id)→projects；project_goals 与 task_dependencies 两端都带 workspace_id；task_explicit_goals 三列非空并分别复合引用 tasks(id,project_id) 与 project_goals(project_id,goal_id)；project_states(project_id,next_action_task_id)→tasks(project_id,id)。
- artifacts 同时保留 `task_id` 单列外键与 `(task_id,project_id)` 复合外键：project_id 为空时复合外键不检查，单列外键仍保证 Task 归属成立。
- completion_records 增加 `human_acceptance_id` 与 `(human_acceptance_id,task_id,acceptance_revision)` 复合外键（第 5 节逻辑模型只列 human_decision_ref）：V001 只有人工完成依据，改为指向真实 human_acceptances 行并按周期校验，防止借其他周期的接受记录完成本轮。
- 只对必要循环外键使用 `DEFERRABLE INITIALLY DEFERRED`，且只在 COMMIT 校验：tasks(id,acceptance_revision)→task_acceptances（当前验收指针）、tasks(id,acceptance_revision,current_completion_id)→completion_records(task_id,acceptance_revision,id)（当前完成指针）。因此插入顺序固定为：先 Task 再验收版本、先 completion_records 再设置指针；提交失败必须作为整个用例失败处理（应用层见 `apps/api/src/application/unit-of-work.ts` 的 `withTransaction` 与集成测试中的 COMMIT 失败用例）。
- 唯一与 CHECK：completion_records UNIQUE(task_id,acceptance_revision)（完成周期唯一）与 UNIQUE(task_id,acceptance_revision,id)；artifact_versions UNIQUE(artifact_id,version_number)；command_receipts PK(scope_key,command_id)；tasks.ck_tasks_completion 显式写 `IS NOT NULL`，避免 NULL 让完成指针与状态脱钩；artifact_versions.content_hash 用 `octet_length = 32`；storage_ref 只接受不以分隔符起始、不含冒号、不含 `..` 的受管相对路径。
- 索引：tasks(project_id,status,id)、tasks(workspace_id,status,id) WHERE project_id IS NULL（默认 Inbox）、artifacts(task_id,created_at,id)，以及关联/证据外键引用侧与审计查询索引（文件第 9 节）。

### 11.2 权限

- `sql/bootstrap-roles.sql` 建立两个真实非超级用户角色：relay_migrator（持有表所有权与 DDL，运行迁移）与 relay_app（应用角色）；应用库 owner 必须是 relay_migrator。
- 应用角色只获得必要的 SELECT/INSERT/UPDATE；artifact_versions、task_acceptances、acceptance_criteria、human_acceptances、completion_records、command_receipts、activity_records 只有 SELECT/INSERT（不可变历史无 UPDATE/DELETE）；project_goals、task_explicit_goals、task_dependencies、state_*_refs 额外有 DELETE 以支持显式解除；迁移台账 relay_schema_migrations 不对应用角色授予任何权限。
- 集成测试用两种真实角色连接验证：应用角色执行 DDL、UPDATE 不可变表、读取迁移台账都返回 42501，迁移角色作为表所有者可通过同一语句；不使用超级用户冒充应用角色。

### 11.3 留待后续 migration 的引用

V001 不引用尚未存在的表，以下全部留待 V002/V003/D 阶段的新 migration：runs、execution_contracts、run_steps、execution_attempts、verification_*、review_*、permission_*、managed_resources、resource_claims、logical_operations、invocation_*、run_control_requests、run_worker_claims、decisions。由此产生的 V001 边界：

- tasks 没有 executor_run_id；`executor_kind` 只能是 HUMAN，`mode` 只允许 ME/AI_ASSIST；状态只允许 INBOX/READY/IN_PROGRESS/DONE/CANCELLED（WAITING/BLOCKED 与 Delegate 相关状态在建好 Run 后扩展）。
- state_decision_refs 需要尚未存在的 decisions 表，未在本批次创建；state_completion_refs 与 state_artifact_refs 已用真实外键落地。
- artifact_versions.source_kind、acceptance_criteria.method、completion_records.basis_kind、activity_records.actor_kind 在 V001 只允许人工/系统取值，扩展取值需要新的 migration。
- 尚未落地的还有 Authority 写锁用例、Worker/Resource claim、控制请求与核对记录，因此 V001 没有承诺动作准入或恢复能力。

### 11.4 与第 1–6 节的差异

- `task_acceptances.source` 固定为 CREATE/REOPEN/CONTRACT_CHANGE；`goals.status` 固定为 ACTIVE/ARCHIVED；`task_dependencies.dependency_kind` 固定为 BLOCKS/INFORMS；`projects.project_type` 固定为 GENERAL/THESIS/DEVELOPMENT（与前端现有类型一致）。这些是 V001 值集，改动需新 migration。
- `phase_key` 不固化取值：阶段词汇按 Project Type 版本化配置，不在 CHECK 中写死。
- state_completion_refs/state_artifact_refs 只做真实外键（项目状态 + 目标行）；跨对象作用域一致性由 ProjectState 锁下的写入用例保证，这与第 3 节允许的“复合 FK 或受锁保护校验”一致。
- project_blockers.target_kind/target_id 保留第 3 节列出的类型化目标；非 PROJECT 目标的作用域校验同样由写入用例执行，未引入通用多态约束框架。
- vocabulary：`workspaces`/`goals`/`projects`/`tasks`/`artifacts` 等可变根都带 revision 与 created_at/updated_at；时间点统一 timestamptz，由数据库默认 now() 生成。

### 11.5 迁移兼容性与回滚风险

- 不与 Kysely Migrator 共用迁移入口：Kysely 0.29.6 的台账只记录 name/timestamp，无法发现已应用迁移被改写；其 PostgreSQL adapter 使用 session 级 `pg_advisory_lock`，SQL 失败进入 aborted transaction 后 unlock 会返回 25P02。本工程改为单一入口读取 `*.sql`，在同一事务内取 `pg_advisory_xact_lock`（事务结束自动释放）串行化，并在提交前比对每条已应用迁移的内容 SHA-256；迁移连接每次运行独立建立并销毁，不与 API 连接池共享。
- DDL、台账行与摘要同事务提交：实测迁移中途失败（重复建表 42P07）后 workspaces 与 relay_schema_migrations 都不存在，结构不会部分落地。
- 回滚风险：V001 没有 down migration，也不提供自动回滚；要回退只能依靠备份恢复，已应用文件绝不允许改写，需要更正时新建 migration。当前没有已部署数据库，因此不存在生产数据迁移。
- 残余风险：新增表/列若忘记同步 GRANT，应用角色会在运行期遇到 42501；`0003_schema_readiness` 已让 readiness 拒绝空库、缺迁移、未知未来迁移和摘要不匹配，但 API 为保留 liveness 仍会启动，且业务路由尚未逐一加独立 schema gate；这些不在 V001 约束范围内，属于应用联动缺口。

## 12. 0002 实际 migration 与兼容性（2026-09-20 P02 实施记录）

本节记录 P02（Project / Goal / Task / State 应用用例）所需的 schema 增量。实际 DDL 见 [apps/api/migrations/0002_p02_task_goal_alignment.sql](../../apps/api/migrations/0002_p02_task_goal_alignment.sql)；覆盖它的真实 PostgreSQL 用例见 apps/api 集成测试（`enforces the 0002 task goal alignment column and its constraints` 等）。

### 12.1 内容

- `tasks.goal_alignment_mode text NOT NULL DEFAULT 'INHERIT'`：区分“读取时继承所属 Project 当前 Goals”与“使用 `task_explicit_goals` 的显式集合”。显式空集合是一种明确事实，不能与继承共用“没有行”这一种表示（[信息与计划](../architecture/information-planning.md) 第 5 节）。
- `ck_tasks_goal_alignment_mode`：取值只能是 `INHERIT` / `EXPLICIT`（text + 具名 CHECK，与 V001 的取值风格一致）。
- `ck_tasks_goal_alignment_project`：`goal_alignment_mode = 'INHERIT' OR project_id IS NOT NULL`。`task_explicit_goals` 的复合外键要求 `project_id` 非空，因此无 Project 的 Me Inbox 事项只能是 `INHERIT`；把同一条不变量前移到 `tasks` 上，避免出现“EXPLICIT 却无法表达任何显式集合”的行。
- `ix_tasks_project_created (project_id, created_at DESC, id DESC)` 与 `ix_tasks_inbox_created (workspace_id, created_at DESC, id DESC) WHERE project_id IS NULL`：任务列表按稳定排序键 `(created_at DESC, id DESC)` 做键集分页，游标绑定过滤条件。V001 的 `ix_tasks_project_status` / `ix_tasks_inbox` 仍按状态过滤使用，不替代这两个索引。
- `GRANT SELECT, INSERT, UPDATE ON tasks TO relay_app`：新增列由 `tasks` 的表级授权自动覆盖，这里显式重申以便审计“新增列不会造成 42501”，并由集成测试用应用角色真实写入该列验证。

### 12.2 兼容性与回滚风险

- 只做追加，不改写 `0001_v001_human_core.sql`（迁移入口按内容 SHA-256 校验，改写会被拒绝）。既有 `tasks` 行由列默认值回填为 `INHERIT`；PostgreSQL 11 起 `NOT NULL DEFAULT` 采用 fast default，不改写整表。
- 本批次不扩展任何领域取值：`tasks.mode` 仍只允许 `ME`/`AI_ASSIST`，`executor_kind` 仍只允许 `HUMAN`，`tasks.status` 仍为 `INBOX/READY/IN_PROGRESS/DONE/CANCELLED`。Delegate 相关的 `DELEGATE_AI`、`WAITING/BLOCKED` 与 `executor_run_id` 仍要等 Run 落地后的新 migration。
- 与 V001 相同：没有 down migration，回退依靠备份恢复；需要更正时新建 migration。
- 残余风险：`INHERIT` 与 `EXPLICIT` 的一致性（例如“EXPLICIT 却仍残留显式行”）不能用 CHECK 表达，由 Task 写入用例在同一个事务内保证；API 启动流程为保留 liveness 不以 schema 检查阻塞，但 `0003_schema_readiness` 已使 `/health/ready` 校验 schema 兼容性。

### 12.3 本批次涉及的锁序（P02 实际写法）

统一锁序（第 4 节）为 Authority → Task → Run → ProjectState → Resource。P02 没有 Run 与 Resource，实际使用如下，且不反向获取更靠前的锁：

- Task 状态迁移、展示字段、显式 Goal 对齐、依赖：先锁 Task 行 `SELECT ... FOR UPDATE`（`tasks/` 用例）。
- Project State 类型化命令：除非非空 `SET_NEXT_ACTION` 需要先锁目标 Task 并确认其属于该 Project，否则只锁 `project_states` 行 `SELECT ... FOR UPDATE`；非空 SET_NEXT_ACTION 固定为 Task → ProjectState，`next_action_task_id = null` 不取 Task 锁。随后 `revision` 用 CAS 递增；每次成功提交只递增一次。
- Goal 关联/解除与 Task 显式对齐：先锁 `projects` 行 `SELECT ... FOR NO KEY UPDATE`，再锁 Task。用 `FOR NO KEY UPDATE` 而不是 `FOR UPDATE`，是为了让同类命令互斥，同时不阻塞其他事务对同一 Project 行加 `KEY SHARE`（创建 Task 时的复合外键检查）。Project → Task 的顺序与第 4 节“不得先持后面的锁再补前面的锁”一致。
- 解除 Project–Goal 时先删除 `task_explicit_goals` 的受影响行、再删除 `project_goals` 行：`task_explicit_goals` 通过复合外键引用 `project_goals(project_id, goal_id)`，反向删除会被外键检查拒绝（实测 23503）。

## 13. P03 内容存储与完成/重开（2026-09-20 实施记录）

本节记录 P03（受管 Markdown 内容存储、Artifact 版本、人工接受、完成与重开）对第 7 节的实际落实，以及本批次涉及的锁序与残余风险。实现位于 [apps/api/src/storage](../../apps/api/src/storage/managed-content-store.ts) 与 [apps/api/src/application](../../apps/api/src/application)，真实用例见 `apps/api/test/integration/api-artifacts.integration.test.ts`。

### 13.1 P03 本身没有新增业务 migration

第 7 节的内容存储要求不需要 schema 增量：`artifacts`、`artifact_versions`、`human_acceptances`、`completion_records`、`state_completion_refs` 已在 V001 落地，`tasks` 的重开只使用已有列（`status`、`acceptance_revision`、`current_completion_id`、`revision`），新验收版本由 `task_acceptances.source = 'REOPEN'` 表达。P03 未新增业务 migration，也未改写 `0001`/`0002`（迁移入口按内容 SHA-256 校验，改写会被拒绝）。后续 `0003_schema_readiness` 仅增加运维兼容视图，不改变 P03 领域表或权限模型；不可变历史的写权限仍是 V001 授予的 SELECT/INSERT。

## 14. 0003 Schema readiness 兼容门（2026-09-21）

实际 DDL 见 [0003_schema_readiness.sql](../../apps/api/migrations/0003_schema_readiness.sql)。它创建 `relay_schema_migration_compatibility` 视图，作为 `relay_app` 的唯一迁移兼容读取口：只公开迁移 `name` 与十六进制 SHA-256，仍不授予 `relay_schema_migrations` 的直接权限。API 将该只读结果与随发布物读取的本地迁移清单逐项对照；缺行、多出未来行或摘要不等时 readiness 返回 `SCHEMA_UNAVAILABLE`，不运行 migration。该运维 migration 不包含 `runs`、Authority、Worker 或 V003 的任何业务 DDL。

### 13.2 实际内容布局与写入顺序

- 布局：`<data_root>/staging/<version-id>.part` → `<data_root>/artifacts/<artifact-id>/<version-id>/content.md`。`artifact_versions.storage_ref` 保存受管相对路径，数据库不保存宿主绝对路径。
- 顺序：以 `wx` 打开暂存文件并完整写入 → `fsync` → 计算 SHA-256 与 UTF-8 字节数 → 在 `artifacts/<artifact-id>` 下创建新的版本目录 → 确认目标不存在（存在即拒绝覆盖）→ `rename` 发布 → 再对发布后的文件 `fsync` → 最后在同一数据库事务里登记 `artifacts` 与 `artifact_versions` 行。
- 路径只能由服务端生成：存储层只接受 UUID 形式的内部 ID（`managedContentRef`），读取时对 `storage_ref` 重新校验（拒绝绝对路径、盘符/冒号、空片段、`.`/`..` 与逃出 data_root 的结果）。HTTP 层不存在任何可传入路径的字段，未知字段一律 422。
- 证据核对：读取内容与完成前的证据检查都重新计算 SHA-256 与大小，与登记的 `content_hash`/`size` 比较；缺失、被替换或摘要不一致返回 `EVIDENCE_UNAVAILABLE`（503），不返回部分内容、不重写旧 hash、也不允许依赖该证据的完成继续。
- 孤儿：内容先发布、数据库后登记，因此事务失败会留下已发布但未被引用的内容。V1 **默认保留**孤儿，不自动清理；本批次未实现核对报告与宽限期，见 13.4。

### 13.3 本批次涉及的锁序

统一锁序（第 4 节）为 Authority → Task → Run → ProjectState → Resource。P03 没有 Run 与 Resource，实际使用：

- 保存产物版本（`CreateArtifactWithVersion` / `SubmitHumanArtifactVersion`）：先锁 Task 行 `SELECT ... FOR UPDATE`（校验 revision、IN_PROGRESS 与 HUMAN 执行权），再锁 Artifact 行分配新版本序号与递增 `artifacts.revision`。没有反向路径（不会先取 Artifact 再取 Task），也没有先取 ProjectState 的路径。
- 完成（`CompleteHumanTask`）：锁 Task 行后在同一事务内插入 `human_acceptances`、`completion_records`，用 CAS 更新 Task 的完成指针，再锁 `project_states` 行写入 `state_completion_refs` 并递增 State revision；顺序固定为 Task → ProjectState。
- 重开（`ReopenTask`）：先锁 Task 行，再锁所属 `project_states` 行，插入新的 `task_acceptances` 与复制后的 criteria，切到 READY 并清空当前完成指针，最后递增 State revision；顺序固定为 Task → ProjectState，任一步失败整笔回滚。`tasks(acceptance_revision)` 的延迟外键在 COMMIT 时校验。没有 Project 的 Me 事项不获取 State 锁。
- 并发完成的裁决：两个不同 `command_id` 竞争同一周期时，Task 行锁让后到者看到 `DONE` 与新 revision，从而得到 409（`REVISION_CONFLICT` 或 `INVALID_TRANSITION`）；`uq_completion_records_cycle`（`task_id, acceptance_revision`）仍是最后的兜底约束。
- 审查后回归（R01）：同一 DONE Task 的非空 SET_NEXT_ACTION 与 Reopen 以真实 HTTP 并发；SET_NEXT_ACTION 先锁 Task 后不再获得 500/`40P01`，竞争结果保留 200/409 原语义。对重开最后的 `project_states` revision 更新注入失败时，Task、复制出的新验收版本/criteria、State、回执与审计一起回滚；同一 `command_id` 的后续重试与重放各只产生一次成功事实。

### 13.4 残余风险与未落实项

- 目录项本身没有 `fsync`（Node 在 Windows 上不提供可靠的目录同步），`rename` 也不构成“任意断电下文件与数据库原子”的保证；这与第 7 节“目录发布/刷盘的实际保证需目标平台验证”一致，仍需在目标平台补断电实验。
- 孤儿内容的核对报告、宽限期与清理仍未实现；当前只能人工核对 `artifacts/` 与 `staging/` 目录。
- 完成/保存事务内包含一次本地文件写入与一次 `fsync`（内容上限 256 KiB）。这是有界的本地 I/O，不是模型、网络或人工等待，但它确实让短事务更长；若后续出现明显尾延迟，需要把发布移出事务并依赖孤儿核对。
- 启动流程仍不以 schema 检查阻塞，也不做内容抽检（第 7 节提到的“启动抽检”仍未实现；访问路径的 hash 校验已实现）；`/health/ready` 已在 `0003_schema_readiness` 中单独校验 schema，业务路由尚未逐一加全局 gate。

## 15. 0004 实际 migration 与兼容性（2026-09-21 P05 实施记录）

实际 DDL 见 [0004_v002_runs.sql](../../apps/api/migrations/0004_v002_runs.sql)。这是 V002 的第一批：Run/契约、Step/Attempt 与不可变 Context Manifest。Verification 与 Review 的表仍属 P06/P07，Authority/Worker claim/控制请求仍属 V003。

### 15.1 内容

- 新增 `runs`、`execution_contracts`、`run_steps`、`step_attempts`、`context_manifests`。
- `tasks` 追加 `executor_run_id`，并把 `ck_tasks_mode` 扩展为含 `DELEGATE_AI`、`ck_tasks_executor` 改为“HUMAN 不得带 Run / AI 必须带 Run”。
- 复合与延迟外键按第 2.1 节的顺序建立：`runs` 先建，再建 `execution_contracts`（PK = `run_id`），随后补 `runs.id → execution_contracts.run_id` 延迟外键；`run_steps` 建好后再补 `runs(id, current_step_id) → run_steps(run_id, id)`；`tasks(id, executor_run_id) → runs(task_id, id)` 同样延迟检查，因此 Delegate 可以在同一事务内先插 Run 再更新 Task。
- `uq_run_live_task` 部分唯一索引覆盖全部非终态（含 `PAUSED`/`WAITING_APPROVAL`），是“一个 Task 至多一个 AI 执行权占有者”的数据库兜底；`ck_runs_terminal` 要求终态与 `terminal_at` 同时成立。
- `step_attempts` 的 `(step_id, attempt_key)` 唯一约束承担稳定来源尝试去重，`(step_id, attempt_number)` 保持尝试序号唯一；`worker_id`/`lease_until` 由 CHECK 要求成对出现。
- `execution_contracts` 与 `context_manifests` 只授予 `SELECT, INSERT`：冻结快照与上下文 Manifest 都是不可变事实。`runs`/`run_steps`/`step_attempts` 授予 `SELECT, INSERT, UPDATE`。
- `artifact_versions.source_kind` 扩展为 `HUMAN | AI`（PERSIST_CANDIDATE 由 Worker 写入候选版本）；`activity_records.actor_kind` 扩展为含 `AI`。人工保存入口仍要求 HUMAN 执行权，放开取值不等于允许 Worker 冒充人工。

### 15.2 与第 1–6 节的差异与细化

- **`runs.ownership_epoch` 记录“授予后”的值**：Delegate 使 Task 的 `ownership_epoch` 恰好 +1，Run 直接保存该结果，使“Run 的写提交匹配 Task 当前 epoch 与 `executor_run_id`”成为可直接比较的等式，不需要在每次写入时重新推导。
- **`tasks.status` 不扩展 `WAITING`/`BLOCKED`**：两者需要控制请求与阻塞事实，随 P08 的控制用例一起扩展；本批次不提前开放没有命令能设置的状态。
- **不建 `run_worker_claims` 表**：P05 的单步 Fake 执行把 claim 身份（`worker_id`、`claim_epoch`、`lease_until`）放在 `step_attempts` 上，通用 Worker/Resource claim 仍按第 8 节留给 V003；这样避免在没有资源与准入协议时提前建表。
- **迟到 claim 结果不更新 `step_attempts`**：`claim_epoch` 不匹配时应用只追加 `STEP_ATTEMPT_RESULT_REJECTED_STALE` 到既有 `activity_records`，保存提交与观测 epoch、当前领取事实和核对证据；不再把当前 `RUNNING` Attempt 改为 `REJECTED_STALE`。当前领取者仍由 `recordAttemptOutcome` 的 `status='RUNNING' AND claim_epoch=:expected` 条件更新裁决，重复或终态结果不能回写。
- **`context_manifests` 只有 `(run_id, manifest_hash)` 唯一约束**：重复执行 BUILD_CONTEXT 命中既有摘要即复用，不产生第二份快照（第 3 节提到的 `context_builds` 增量尚未出现真实调用方）。

### 15.3 本批次涉及的锁序

统一锁序为 Authority → Task → Run → ProjectState → Resource → Review/Operation/Invocation。P05 没有 Authority/Resource，实际使用：

- Delegate：锁 Task（`FOR UPDATE`）→ 读依赖/验收 → 插 Run → 插契约 → 插步骤计划 → CAS 更新 Task 执行权（Task → Run 方向，与第 4 节一致）。并发 Delegate 由 Task 行锁、`assignExecutionToRun` 的条件更新与 `uq_run_live_task` 三重保护裁决。
- 推进步骤（`advanceRunStep`）：先锁 Run，再锁 Task（Run → Task 的例外路径），校验 `executor_run_id` 与 `ownership_epoch` 后推进步骤与 Run 状态；因为两条路径互不嵌套（Delegate 不先取 Run 锁），没有形成反向锁序。该顺序已在 15.4 记为待优化项。
- 失败释放执行权：同一事务内写步骤 FAILED、Run FAILED（终态）、Task 释放（epoch 再 +1）与审计，提交失败整笔回滚。

### 15.4 兼容性与残余风险

- 0004 只做追加与约束替换：既有行由 `executor_run_id` 默认 NULL 回填，`ck_tasks_executor` 在替换时对既有 HUMAN 行仍然成立。
- 已应用迁移禁止改写；本批次没有 down migration，回退仍靠备份。
- `advanceRunStep` 在 P05 时的 Run → Task 锁序与 Delegate 的 Task → Run 不同；P08 已统一为 Task → Run，当前实现见第 18 节。本条保留当时的风险依据。
- P05 当时的 Fake Runtime 没有受控发布动作身份；`step_attempts.lease_until` 只表达租约，过期候选扫描与恢复用例由 P08 增加（第 18 节）。
- 候选版本由 Worker 写入受管存储，与人工保存共用同一内容存储实现；目录项持久性与断电保证同 13.4，仍未在目标平台验证。

## 16. 0005 实际 migration 与兼容性（2026-09-22 P06 实施记录）

实际 DDL 见 [0005_v002_verification.sql](../../apps/api/migrations/0005_v002_verification.sql)。这是 V002 的第二批：Verification Session/CheckResult 与自动完成依据。Review 与批准类型绑定仍属 P07，Authority/Worker claim/控制请求仍属 V003。

### 16.1 内容

- 新增 `verification_sessions`（`task_id`+`acceptance_revision` 复合外键指向 `task_acceptances`；`run_id`/`execution_contract_id` 成对非空或成对为空；`check_plan`/`check_plan_hash` 冻结计划；`status OPEN|PASS|RETRY|HUMAN` 与 `verdict` 由 CHECK 绑定；`correction_budget_used`）、`verification_targets`（`(session_id, artifact_version_id)` 主键 + `content_hash`）、`check_results`（`UNIQUE(session_id, criterion_id, check_attempt)`，`result` 取值含 `ERROR`/`NOT_RUN`/`NOT_APPLICABLE`，`severity` 含 `HARD|RULE|PREFERENCE|SEMANTIC`）、`verification_applicability`（显式撤销适用性，PK = `session_id`）。
- `completion_records` 替换 `ck_completion_records_basis` 并新增 `verification_session_id`/`run_id`：`HUMAN` 必须带 `human_acceptance_id` 且两者为空，`AUTO` 必须带 `verification_session_id` 与 `run_id` 且 `human_acceptance_id` 为空；`verification_session_id` 用 `(id, task_id, acceptance_revision)` 复合外键，防止借其他周期的 PASS 完成本轮。
- `acceptance_criteria.method` 扩展为 `HUMAN | MARKDOWN_STRUCTURE | CITATION_EXISTS | SEMANTIC`（P06 的实际检查方式；`target_spec.severity` 只是可选声明，仍是应用结构验证，不做跨表 CHECK）。
- 权限：`verification_sessions` 给 `SELECT, INSERT, UPDATE`（状态/总决策/预算是可变事实）；`verification_targets`、`check_results`、`verification_applicability` 只给 `SELECT, INSERT`（历史结果与撤销事实不可改写）；`completion_records` 重申 `SELECT, INSERT`。

### 16.2 与第 1–6 节的差异与细化

- **`correction_budget_used` 放在 session 上，不新增计数表**：已用预算与修正轮次都由「该 Run 已 finalize 为 `RETRY` 的 session 数」推导（`run_steps` 的既有注释也说明 RETRYING 通过新 Attempt 表达），因此不需要额外列或计数器；代价是查询时要按 Run 聚合 session 状态。
- **修正回路不新增步骤行**：总决策 `RETRY` 时把 `BUILD_CONTEXT`/`DRAFT`/`PERSIST_CANDIDATE`/`VERIFY` 重置为 `PENDING`（`RunRepository.resetStepToPending` 的 CAS，清空 `result_ref`/`started_at`/`finished_at`），步骤计划长度与 `step_index` 序列保持不变；执行历史保留在 `step_attempts`、`check_results`、`artifact_versions` 与各 session 上。
- **修正产物是同一 Artifact 的新版本**：`PERSIST_CANDIDATE` 的 round ≥ 1 使用 `run:<runId>/step:PERSIST_CANDIDATE/round:<n>` 作为 `source_ref`，在 Artifact 行锁下分配 `version_number`；`(artifact_id, version_number)` 唯一约束与 P03 的人工追加版本共用同一套保证。
- **完成 Gate 在建立步骤尝试之前核对**：等待人工不写 `FAILED` 尝试，反复轮询不会累积失败尝试；`COMPLETION_BLOCKED` 不改任何表。
- **冻结产物要求由完成 Gate 复核**：Delegate 会先拒绝非数组或当前不支持的 `required_output_spec.artifacts`；完成前仍从 `execution_contracts.frozen_snapshot.expected_outputs` 读取要求，并以最新 PASS session 的 `verification_targets`→Artifact 种类集合精确核对。包括旧 Run 在内，未知种类、畸形快照或声明必需产物却 target 为空/不足时返回 `DECLARED_OUTPUTS_UNSATISFIED`，不创建 COMPLETE Attempt 或写 Completion/State/成功审计；完成事务内再次核对同一集合；沿用现有 Run 锁串行化正常写入口，不宣称重复读取本身能替代并发锁协议。
- **Task 完成时保留 `mode`**：自动完成释放 AI 执行权（`executor_kind='HUMAN'`、`executor_run_id=NULL`、`ownership_epoch+1`）但保留 `mode='DELEGATE_AI'` 供展示；`ReopenTask` 复位为 `ME`（runtime-context 第 5 节）。`ck_tasks_completion` 与 `ck_tasks_executor` 在写入顺序上同时成立。

### 16.3 本批次涉及的锁序

统一锁序为 Authority → Task → Run → ProjectState → Resource → Review/Operation/Invocation。P06 没有 Authority/Resource，实际使用：

- 推进 `VERIFY`/`COMPLETE` 沿用 `advanceRunStep` 的 Run → Task 顺序（15.4 记录的例外路径未变），完成时在 Task 之后取 `project_states` 行锁，即 Run → Task → ProjectState，未反向获取更靠前的锁。
- 修正回路（finalize session → 重置四个步骤 → Run 回 `RETRYING`）与自动完成短事务都在**同一事务**内完成，不跨模型、网络或人工等待。
- **P06 当时的 15.4 待办**：P08 已将推进、Review/动作审批、控制与恢复统一到「先 Task 后 Run」，见第 18 节；本条保留历史实现顺序。

### 16.4 兼容性与残余风险

- 0005 只做追加与约束替换：`completion_records` 的既有 `HUMAN` 行在替换后仍满足新 CHECK，`acceptance_criteria.method` 的既有 `HUMAN` 行不受影响。
- 已应用迁移禁止改写；本批次没有 down migration，回退仍靠备份。
- R05 没有新增或改写 migration：迟到结果的核对证据复用已有 `activity_records` 的追加权限，自动 Gate 复用既有冻结契约、verification target 与 Artifact 表。
- 仍然只有 Fake Runtime：`FakeSemanticChecker` 是确定性替身，真实语义判断属 P12；本阶段不声称验证器能保证事实绝对正确，也不声称已具备 Review/人工判断能力。
- `verification_sessions` 允许 `run_id` 为空（人工补验）但当前没有写入口；`GET /runs/{id}` 的投影尚未包含 verification 摘要；修正预算与检查器重试上限仍是常量，未进入版本化执行配置。
- P06 当时尚无过期 claim 扫描、资源隔离与 `PAUSED` 状态；P08 已增加内部扫描入口和 `PAUSED`，通用资源隔离仍待后续。本批次没有新增可被外部进程影响的副作用。

## 17. 0006 Review 与后继验证会话（2026-09-23 P07）

实际 DDL 见 [0006_v002_reviews.sql](../../apps/api/migrations/0006_v002_reviews.sql)。迁移只追加，不改写 0001–0005；没有 down migration，恢复仍依赖备份。P07 的目标是让 P06 `HUMAN` 可被精确人工判断，同时保留原验证历史。

- `review_requests` 保存 kind、Workspace/Project/Task/Run/Session、可选 criterion 与预分配 `operation_id`、规范 `target` 及 SHA-256、证据、影响、允许决定、有效期、状态与 revision。唯一索引防止同一 session/criterion、同一 session/预算或检查器请求、同一 operation 身份重复建立。
- `review_decisions` 对 `review_id` 唯一，保存决定、命令 ID、反馈、预算、目标摘要及实际效果；批准仅是持久判断，不代表外部动作已调用。`run_correction_budgets` 以 Run 为主键，最大值限制 1–6，缺行采用默认 2。已用轮次仍由该 Run 的 RETRY session 数推导。
- `verification_sessions.parent_session_id` 指向前一份已决会话；人工接受/请求修改产生新会话，旧 `HUMAN` 的 CheckResult 不追加或覆盖。新人工 PASS 的 `evidence_refs.review_decision_id` 指回不可变决定。最新 PASS 仍须通过 P06 完成 Gate 的验收版本、适用性、产物集合和内容核对。
- P07 时 Run 类 Review 决定走 Run → Task → Review 锁序；State 提案决定先锁可选目标 Task、再锁 ProjectState、最后锁 Review，同事务复核 `base_revision` 并使用类型化 State 写入口。P08 已将 Run 相关路径统一为 Task → Run（第 18 节）；本条保留 P07 的历史边界。当前操作审批仅保存预授权与 operation 身份，P09 另行定义消费/Invocation 的锁序和权限复核。应用角色对 Review 请求与预算有 `SELECT/INSERT/UPDATE`，对决定仅有 `SELECT/INSERT`。

本阶段未增加外部工具执行能力；P07 的审批不能证明外部效果已发生。真实 PG 开发自检覆盖迁移可重放、后继会话、重复命令、版本失效、预算持久化与 State 基线冲突；这些检查不等于正式验收。

## 18. 0007 持久控制与受控 Fake 恢复（2026-09-23 P08）

实际 DDL 见 [0007_v003_recovery_control.sql](../../apps/api/migrations/0007_v003_recovery_control.sql)。它是 V003 的 P08 最小切片：保持 0001–0006 的 SHA 不变，新增控制意图、Run 级 Worker fence 和唯一受控的候选 Markdown 发布动作；不宣称通用资源排他或真实工具 Gateway 已具备。

- `tasks.status` CHECK 增加 `WAITING`、`BLOCKED`；`runs` 增加 `worker_epoch`、`worker_id`、`worker_lease_until` 及成对约束，`resume_phase` 允许 `WAITING_APPROVAL`。Worker 领取使 epoch 增长；旧 epoch 不能提交步骤或 Task 完成。Task/Run/Review 的入口统一先锁 Task 再锁 Run；效果发布前再以此顺序检查当前 Worker、epoch、执行权与 PENDING 控制。
- `run_control_requests` 保存 PAUSE/CANCEL/HANDOFF/CANCEL_TASK、状态 PENDING/APPLIED/REJECTED/SUPERSEDED、revision、决定时间和 `result_ref`；`uq_run_control_pending` 保证每个 Run 最多一个待处理意图。请求提交与安全点应用是不同短事务；冲突拒绝或显式 supersede，不能从 202 推断已暂停。HANDOFF 的 `result_ref.handoff` 保存步骤位置与可用候选/验证事实 ID；未写入数据库的发布文件不伪装为候选版本。
- `run_effect_actions` 以 `operation_id=step_attempts.id` 保存不可变的目标相对路径、SHA-256 参数摘要、PREPARED/DISPATCHING/SUCCEEDED/FAILED/UNKNOWN、派发次数与结果。`(run_id,step_id)` 与 `(attempt_id,step_id)` 复合外键把 Run→Step→Attempt 绑定，避免跨 Run 拼错动作身份。受管 Fake 发布到 `artifacts/<run_id>/<attempt_id>/content.md`（修正轮沿用原 Artifact ID），DB 只保存受管相对路径；新文件不会覆盖旧版本。
- 领取、效果派发与步骤提交分别使用短事务；Fake 模型生成和受管文件读取/发布在事务外。派发前控制先提交则不发布；派发先提交则控制保持 PENDING，待目标核对/提交或显式处理后才 APPLIED。成功步骤不重放。成功发布但步骤事务尚未提交时仍视为未决；若内容丢失/损坏，动作降为 UNKNOWN，不放行控制。若已核对成功且控制在等待，未提交的尝试标记为被控制抢占，发布文件保留为可追溯孤儿，控制才可应用。
- 内部 `scanRecoveryCandidates` 只报告租约到期或有持久 fence 记录的未决动作，当前没有生产调度器自动调用它。内部 `recoverStoppedWorker` 要求调用方提供旧 Worker 已停止的依据；用例提升 Run epoch，并写入 `run_worker_fences`（旧 Worker ID、该依据、新 epoch 的结构化事实，0129 起；同时保留 `activity_records` 追溯记录），再次重启可用该表、Attempt worker ID 与当前 epoch 复核。生产进程管理器自动确认退出尚未实现。只有同一目标确实不存在、当前无新 claim 且有持久 fence 证据，才将原动作重置为 PREPARED，下一次仍使用原 `operation_id`。`UNKNOWN` 或成功日志与目标文件不符不能仅凭租约重发；租约到期本身不等于进程已停。
- **兼容与回滚**：旧 HUMAN Task 的状态与既有 Run 行满足新 CHECK，新增 Worker 列有默认/NULL，旧数据可升级；旧应用版本不理解新增控制状态与 WAITING，部署需与 API 同步升级。迁移只追加/替换约束，已应用文件不能改写；没有 down migration，回退依赖备份及相容版本。P08 只覆盖同机受管 Fake 文件动作，尚无跨 Task 工作目录资源 claim、实际工具准入、通用操作核对报告/孤儿清理和断电持久性证明；这些是后续独立边界。
- **0129 结构化 fence 事实（2026-10-21）**：追加 [0129_run_worker_fences.sql](../../apps/api/migrations/0129_run_worker_fences.sql)。`run_worker_fences` 以 `(run_id, worker_epoch)` 为主键，保存 `stopped_worker_id`、`stopped_evidence` 与 `created_at`；CHECK 拒绝空 Worker ID 和非正 epoch，索引支持按 run 与旧 Worker 查询；`relay_app` 只有 `SELECT/INSERT`，审计记录仍只增不减。恢复扫描与重入改为按表匹配 run/epoch/worker，不再依赖 `activity_records.fact_refs` 的 JSON 文本：审计被裁剪、字段改名或写入格式变化都不影响 fence 判定。迁移从既有 `RUN_WORKER_FENCED` 审计回填格式合法（UUID 与正整数 epoch）的记录并 `ON CONFLICT DO NOTHING`；已被裁剪或格式损坏的历史 fence 无法还原，只能人工核对。没有 down migration；回退需备份和能理解新表的应用版本，旧版本忽略该表时仍可按原审计路径工作但会失去结构化保障。

## 19. 0008 Fake Gateway 与权限准入（2026-09-23 P09）

实际 DDL 见 [0008_v003_gateway.sql](../../apps/api/migrations/0008_v003_gateway.sql)。本迁移追加在已应用的 0001–0007 后，不改写其内容或摘要；现有 Run、Review 与 P08 受管发布数据不用重填。没有 down migration，回退依赖备份和能理解新表的应用版本。

- `gateway_capabilities` 固定 Fake 写/公共读两项；`gateway_connections` 保存所属 Project、状态和递增 version，`gateway_connection_capabilities` 单独保存能力。P09 Fake 的 `config` 和 Operation/Invocation 连接快照有数据库 CHECK，只能是 `{}`，不能用这些列存 token 或 secret。真实适配器的 `secret_ref` 与配置格式需后续迁移和准入再设计。
- `gateway_permission_policies` 是可撤销根，`gateway_permission_versions(policy_id,version)` 保存不可变目标范围、Capability、AUTO/ASK/DENY 和字节上限，根上的 `active_version/revision` 是当前指针。策略更新和 Connection 停用先取 Workspace authority 写锁并递增其 revision；Admit 先取 SHARE，在同一短事务重读活动版本、实际目标、参数、连接能力与 Review。准备时冻结 connection version、空配置快照、policy version、规范目标和 SHA-256 参数摘要，批准目标也含这些身份；新版本或撤销使旧批准失效。
- `managed_resources` 保存 realpath 规范根、大小写规范 identity_key、状态、resource_epoch/revision；同 Project 的完全重复根唯一，跨 Project 或 Workspace 可以登记相同/父子根。`resource_claims` 保存 Task/Run/Worker epoch、资源 epoch、唯一 claim_token 与 HELD/QUARANTINED/RELEASED。单 resource_id 的部分唯一索引阻止双占用；不同 ID 的父子根由同一个 PostgreSQL advisory 事务锁与全部已占用根扫描串行。租约过期不释放 QUARANTINED。当前以 realpath 和路径段比较做同机 Fake 演示，不能证明对 Windows junction、挂载变化或宿主外进程的完整隔离。
- `import_jobs` 绑定真实 Workspace/Project、用户主体、配置版本、来源 URI 和请求 command_id，状态为 QUEUED/RUNNING/SUCCEEDED/FAILED；P09 只建立内部固定 Fake 公共读来源，不宣称已生成 KnowledgeVersion。`logical_operations` 以 RUN 或 USER_IMPORT 明确来源，复合 FK 绑定 Project/Task/Run/Step/Resource/ImportJob/Connection/策略版本；`invocation_attempts` 绑定来源及完整 claim 身份，约束 USER_IMPORT 无 Run/claim、RUN 必有 Worker/claim。一个 intent_key 只能表示同一逻辑动作，新的 Invocation 可复用原 operation_id；未决状态有部分唯一索引。Run 或 ImportJob 的另一未决动作会阻止换 ID 绕开 UNKNOWN。
- `approval_reservations` 以 Review/Operation 复合 FK 把批准占用限定为原 Review 所指动作，`invocation_approval_bindings` 每次尝试独立记录消费，同一 Review 的两次并发决定由 Review revision/唯一决定约束裁决。Admit 先成功提交 DISPATCHING 才调用一次 Fake；效果和数据库不假装原子。PREPARED 且有旧进程停机依据可记 NOT_EXECUTED 并以原 Operation 新建 Invocation；DISPATCHING/UNKNOWN 时目标缺失仍保持 UNKNOWN，因为文件可能先写入再被移除。旧 Worker 结果只作为核对证据，不推进新 owner。
- 应用角色仅对这些表具有所需 DML，无迁移 DDL 权；当前 Invocation/批准记录须保留历史而不是覆盖。内部 reconcile 需要调用方提供旧进程已停依据，尚无生产进程管理器自动证明；真实工具、任意本地文件写、断电持久性和孤儿效果处理留后续阶段。

## 20. 0009 长期信息与规则栅栏（2026-09-23 P10）

实际 DDL 见 [0009_v004_information_rules.sql](../../apps/api/migrations/0009_v004_information_rules.sql)。这是追加迁移，不改已应用的 0001–0008 或其 SHA；旧 Workspace authority 以 `rule_revision=0` 补齐，旧 Run 的冻结契约无此字段时按 0 解释。没有 down migration，回退需备份与能读取新表的应用版本。

- `knowledge_items/versions`、`memory_items/versions`、`decisions/decision_versions`、`rules/rule_versions` 各有类型化根、当前版本指针和不可变版本。根的 `current_version` 有延迟外键指向本根版本，创建事务可先写根后写 v1；应用角色对版本表只有 SELECT/INSERT，没有 UPDATE/DELETE。Memory 版本的确认主体固定为 `user:local`；Rule 有 Workspace/Project/Task 真实外键，Task Rule 还以复合 FK 核对所属 Project。
- Knowledge 的 NOTE/MANAGED_TEXT 正文直接作为不超过 256 KiB 的不可变 PostgreSQL 文本保存，SHA-256 与媒体类型同版本；本阶段不使用受管文件目录保存这两类正文。ArtifactVersion 来源只保存确切版本 FK、原内容 hash 和类型化 `source_refs`，不复制正文；同 Workspace 的来源版本有唯一约束。应用以事务级 advisory 锁串行同来源并发提升，返回同一 Knowledge 身份。`scope_key` 生成列与复合 FK 防止版本行错连另一 Project 的 Knowledge 根；Artifact 复合 FK 防止把 Project A 的来源直接挂到 Project B，Workspace 全局根目前不接受 Project Artifact 的提升。文件实际可用性仍须在读取 Artifact 内容时核对，Knowledge 元数据不能证明文件没有损坏。
- Decision 根上的 `superseded_by_id` 保留替代链；应用用例以 authority 写锁串行替代、要求同 Project/Workspace 范围和活动状态、拒绝自指与已有替代链形成环。数据库直接 DML 没有递归无环触发器，模块写入口是该业务不变量的 Owner。Rule 版本保存 key、strength、applicability、enforcement、method 和 target_spec；`workspace_execution_authority.rule_revision` 在 Rule 创建、追加版本、退役时递增，Delegate 持 authority SHARE 冻结当前值与所有适用来源引用。
- 活动 Run 的步骤领取/提交、P08 受管发布派发、P09 Gateway Worker 领取/Prepare/Admit 先取 authority SHARE 并核对冻结 `rule_revision`。更新先取 UPDATE，因此规则更新与 Delegate/准入具有确定提交顺序。栅栏目前是 Workspace 全局版本：更新其他 Project 的 Rule 也可能使旧 Run stale，换取本阶段单一串行点；后续可在保持来源版本绑定的条件下缩小影响范围。已发布或已 Admit 的效果仍保存原 Attempt/Invocation outcome，不能因新规则抹去已发生动作；后续动作拒绝。
- 搜索读取只用 Workspace/Project、状态和当前版本，游标包含匹配级别、完整 PostgreSQL 更新时间、ID 与类型，避免同毫秒内翻页丢项。当前索引支持作用域/状态筛选，中文字面 `ILIKE` 仍可能扫描该作用域记录；没有 pg_trgm、向量、标签或正文提取索引，实际规模与性能需 P21 测量。URL 抓取、`import_jobs.knowledge_version_id` 完成绑定和提取器版本属 P17；本迁移不回填或声称这些来源已可用。

## 21. 0010 Context 来源版本与 Manifest（2026-09-23 P11）

实际追加 DDL 见 [0010_v005_context_revision.sql](../../apps/api/migrations/0010_v005_context_revision.sql)：仅给 `workspace_execution_authority` 增加非负 `context_revision`，旧 Workspace 默认 0；0001–0009 内容和 SHA 不改。Knowledge/Memory/Decision 的创建、追加版本、退役/替代先取 authority UPDATE 再写根与版本，完成时递增该列；Rule mutation 在原 `rule_revision` 外也递增 Context 版本。Gateway Permission/Connection 变更使用原 authority `revision`。Builder 领取、提交仍按 authority→Task→Run 锁序，并在提交时核对两类 authority 版本和 Project/Task revision；Project 在 Task/Run 后取 SHARE 复核，避免构建途中标题等实际来源改变。

沿用 0004 的 `context_manifests` 不可变表及 `(run_id,manifest_hash)` 唯一约束，不新增第二个 Context 事实表。P11 的 `payload` 保存真正送给 FakeModelPort 的来源片段、UTF-8 字节范围、片段/全文 SHA-256、来源版本、选择/裁剪原因、预算估算、模板/Builder/Profile 摘要及当前依赖版本。文本资料与确切 ArtifactVersion 来源分开：后者在事务外通过受管内容存储复核原 hash/size 后才选入，缺失/损坏不冒充空正文。来源更新导致新 hash/新 Manifest；旧 Manifest 保留原字节作为历史证据，但公开详情按当前 Workspace/Project、根状态、Memory 到期和 Artifact 可用性重新过滤，受限来源的 ID/名称/正文及逐条排除项均不返回。无 down migration；回退需备份及能识别新增 authority 列/Manifest payload 的应用版本。

## 22. 0011 Run 命令、投递与整线程领取（2026-09-24 M03 首片）

实际 DDL 见 [0011_m03_run_dispatch.sql](../../apps/api/migrations/0011_m03_run_dispatch.sql)。`run_commands` 以 UUID 为内部命令身份，记录 `workspace_id/run_id/source_command_id/kind`；应用角色只有 SELECT/INSERT，`(workspace_id,source_command_id)` 唯一。原 HTTP `command_id` 仍由 `command_receipts` 的 payload hash 判定同/异载荷；内部投递 UUID、图线程 `run_id` 和工具 `operation_id` 互不替代。`run_command_outbox` 只保存 PENDING/CLAIMED/DONE/BLOCKED 及领取 epoch；通知可丢，扫描 PG 才是恢复入口。`run_invocations` 每 Run 一行，`epoch` 递增；ACTIVE/STOP_REQUIRED 在租约过期后继续占位，不凭时间自动改回 IDLE。旧 Run 只补 IDLE 行，不创建 START，故旧工作不会在升级时自动执行。

Delegate 延用现有 Task 行锁、Run/契约/步骤写入、Task CAS 和回执事务，新增 START/outbox/invocation 也在同一事务；注入 outbox 后异常的真实 PG 测试确认这些事实整体回滚。独立 Worker 从 PG 选候选，先锁 Run，再锁 outbox 和 invocation，只有 IDLE 可领；旧 `runs.worker_id` 是单步 claim，不能充当整线程锁。Worker 续租与业务步骤开始、效果派发、结果提交均核对 invocation epoch 和数据库租约；逾期结果被拒绝。受监督的 Mock Worker 子进程 `close` 才提供停机事实，随后调用原 `recoverStoppedWorker` 核对单步 claim 与原 `operation_id`，无未决动作时重新置同一 outbox 为 PENDING。监督器若自身死亡而未观察到退出，保留占位等待可信处置；本协议尚未对任意外部工具子进程提供停机证明。

独立源码审查后补齐了两个短事务栅栏：长时间准备后新增 PREPARED 效果意图、以及已有 DISPATCHING/UNKNOWN 的效果结果更新，均在 Task/Run 锁下重新核对单步 Worker/epoch、Task 执行权与当前整线程 invocation/租约。旧 Worker 迟到时不写业务效果状态；已经发生的外部发布仍由可信停机后的恢复入口按原 `operation_id` 核对，目标损坏保持 UNKNOWN。启动前取消不领取；领取期间取消而尚未执行的 claim 等监督器观察子进程退出再重排。真实 PG 红灯与修复证据见 [M03 首片记录](../development/m03-run-dispatch-slice.md#独立源码审查后的失租修复)。

本迁移只追加新表、索引与应用角色最小权限，不改 0001–0010 的内容摘要；无 down migration，回退依赖备份及能读新表的应用版本。首片未增加可靠事件表、图 checkpoint 或完整恢复命令；它们属于 M03 后续切片。

第二片桌面私有监督协议不改变 0011 DDL。宿主证明旧 Windows Job 整组停机后，监督器只扫描带该 `launchId` 的 ACTIVE/STOP_REQUIRED invocation；每 Run 持有 PostgreSQL session advisory 锁，在锁内重新检查 worker/epoch/command/status、核对原效果、条件式重排同一 outbox。锁跨受管内容核对，但不打开长业务事务；它只串行并发监督器，不能代替 OS 停机证明。若 `SUCCEEDED` 效果的 Attempt 仍为 RUNNING，恢复先核验受管目标 hash/size；完整时可保留原 Attempt/`operation_id` 重新入队，由下一 invocation 完成业务提交，损坏时转 UNKNOWN 并阻断。DISPATCHING/UNKNOWN 仍按原 `operation_id` 核对，不能凭目标缺失换动作身份重发。具体进程反例见 [M03 第二片记录](../development/m03-run-dispatch-slice.md#桌面私有监督与旧-launch-恢复第二片)。

## 23. 0012 Run 刷新事件（2026-09-24 M03 SSE 后端片）

实际追加 DDL 见 [0012_m03_run_events.sql](../../apps/api/migrations/0012_m03_run_events.sql)。`run_events(run_id,seq)` 是每 Run 持久刷新提示，首序号为 1，`kind` 只标识改变的事实类型，不保存正文、凭据、来源 ID 或业务快照。已有 Run 不回填历史事件；初次订阅仍须读取权威 Run 快照。此迁移不改 0001–0011 内容/SHA，新增表只授予 `relay_app` SELECT/INSERT，没有 UPDATE/DELETE；无 down migration，回退仍依赖备份和相容应用版本。当前事件不裁剪、不设 TTL；静默删除历史会让游标断续，因此保留规模和清理协议须先经过独立设计与测量。

每个业务事实的 AFTER trigger 在**原写入事务**中先取对应 Run 行 `FOR UPDATE`，再读取 `max(seq)+1` 并插入事件。Run 行锁使同一 Run 的分配和提交顺序一致，事务回滚连同事件一起回滚，不留下序列空洞。触发器不成为 Run/Step/Review/Control/Effect 的第二个写入 Owner：它只发 UI 重读提示。Run 创建时触发 `RUN_CHANGED`；Run 状态、revision、当前步骤、等待原因或终止时间真实改变时发事件；Step、Attempt、Run Review、Control、受管 Effect 的可见状态或结果真实改变时分别发对应事件。无变化 UPDATE、Run/Attempt lease 心跳不发事件。State 提案 Review 没有 Run ID，故不发 Run 事件。

原业务路径的锁序仍以 Task→Run 为主：Delegate 先锁 Task 后插 Run，Step/Attempt/Review/Control 写入先锁 Task/Run，触发器取得的是当前事务已经持有的 Run 锁。恢复路径中原有两个直接 `resolveEffect` 写点已改为先锁 Task→Run 再写 Effect，避免触发器从已锁 Effect 反向等 Run；其余 Effect 准备、派发和结果写入沿原 Task→Run→Effect 栅栏。真实 PG 受控竞争测试让另一事务持 Task→Run 再等 Effect，验证恢复核对不会造成反向死锁。`run_invocations`、outbox 的领取和续租是内部运输状态，当前 Run HTTP 投影不暴露它们；这些写入不触发刷新提示。API 空批定期再查 PG 已提交事件，不能从通知或单次查询推断历史已完整。

## 24. 0013 每 Run 命令顺序与 Review 唤醒（2026-09-24 M03 后端片）

追加迁移见 [0013_m03_run_command_order.sql](../../apps/api/migrations/0013_m03_run_command_order.sql)。`run_commands.ordinal bigint NOT NULL` 按既有 `created_at,id` 在每个 Run 内确定性回填，新增正整数检查和 `(run_id,ordinal)` 唯一约束；新命令由 Task→Run 短事务内锁住 Run 行后分配 `max(ordinal)+1`。`review_decision_id` 可空且唯一，外键指向不可变 Review 决定，只允许 `RESUME` 使用；此前 START 无需伪造 Review 关联。应用角色继续只有 `run_commands` SELECT/INSERT，不能改写 ordinal 或决定绑定。0013 不改写 0001–0012 的 SQL/SHA；无 down migration，回退依赖备份及相容应用版本。

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

追加迁移 [0017_m04_web_import.sql](../../apps/api/migrations/0017_m04_web_import.sql) 放宽 `logical_operations.ck_logical_operation_resource`，允许 `USER_IMPORT + WEB_FETCH + resource_id IS NULL`；`knowledge_versions` 增加受约束的 `WEB_PAGE` 形态：不可变正文、`source_uri` 非空、媒体类型为 `text/plain` 或 `text/markdown`、UTF-8 正文不超过 256 KiB。`import_jobs.connection_id` 以 Workspace 复合外键绑定 Gateway Connection，`knowledge_version_id` 指向成功版本；`review_requests.import_job_id` 指向等待批准的 Job，并建立查询索引。既有迁移文件不改写，无 down migration；回退依赖备份和兼容应用版本。

创建命令的 `command_id` 回执与 Job 插入同事务。Worker 扫描 QUEUED，以及状态已改 RUNNING 但尚无 operation 的崩溃遗留 Job；同一 Job/intent 使用稳定 `operation_id`，Gateway 的唯一 intent 约束阻止并发重建动作。已成功的 WEB_FETCH Operation 与 Knowledge 根/版本、Workspace Context revision、Job SUCCEEDED/`knowledge_version_id` 在一个短事务结算；若此事务失败，下一 tick 只按原 Operation 证据重试结算。已失败的 Operation 同样按原结果补结算 Job FAILED。`DISPATCHING` 未结算 Invocation 不在自动重扫范围，仍要求可信旧进程停机后以原 Invocation 核对；扫描不能把租约到期当停机证明，也不能重发新动作身份。真实 PostgreSQL 定向集成覆盖这两个 RUNNING 崩溃窗口、单版本结算和 Workspace 隔离查询；属于开发自检，不替代 M04 独立验收。

## 30. 0018 统一模型调用事实（2026-09-26 M04 开发自检）

追加迁移 [0018_m04_model_calls.sql](../../apps/api/migrations/0018_m04_model_calls.sql) 新增 `model_calls`，每次 DRAFT、SEMANTIC_CHECK、ASSIST 的 Fake/真实端口调用各用独立 UUID 主键。DRAFT 绑定 `step_attempt_id` 与 `manifest_id`；语义检查绑定 `step_attempt_id`、`criterion_id`、`check_attempt`，其 CheckResult 证据另存 `model_call_id`；Assist 绑定 `assist_message_id`。关联列为外键并以形态 CHECK 限制互斥；Workspace ID 来自原 Run 或 AssistSession。`provider`、`model` 只保存非敏感标识，`config_fingerprint` 是不含密钥与 endpoint 的模型参数 SHA-256；不保存提示词、响应正文、endpoint 或凭据。按 StepAttempt/AssistMessage 和 Workspace 时间建立查询索引，应用角色可 SELECT/INSERT，UPDATE 仅限结算字段，无 DELETE；原调用身份与关联不能由应用角色改写。

调用前以独立数据库写入提交 `STARTED`，得到响应后只允许从 STARTED 一次结算为 COMPLETED/FAILED/CANCELLED；已知的 Provider request id、输入/输出 token 数分别记录，未知列为 `NULL`，不能以 0 冒充。Provider 已返回但提案 JSON 未通过业务 schema 时，调用可为 COMPLETED 而 AssistMessage 为 FAILED；VERIFY 外层业务事务回滚时，已经发生的调用仍留痕，不伪造 CheckResult。崩溃遗留 STARTED 不自动变为成功、失败或零用量；重入再次实际调用新增行，旧行不覆盖，不能据此推断供应商只计费一次。AssistMessage 的用量只是当前消息投影，汇总应以 `model_calls` 为唯一来源，不能和消息列相加。此表是计量证据，不控制 Run/验证/Assist 生命周期，也不进行金额结算。

## 31. 0019 DRAFT 读取输入追溯（2026-09-26 M04 开发自检）

追加迁移 [0019_m04_draft_read_input.sql](../../apps/api/migrations/0019_m04_draft_read_input.sql) 为 `model_calls` 增加可空 `input_sha256`、`read_operation_id`、`read_invocation_id`。后两者必须同空或同有，且只允许 DRAFT；分别以 FK 指向原 Gateway 操作与实际调用，另建按 operation 查询索引。新增列在模型请求前的 STARTED 插入中写定，不在结算时修改；应用角色既有表级 SELECT/INSERT 权限适用，UPDATE 仍只限原结算列。旧行保持 NULL，不能倒推其历史输入摘要。摘要使用 `draft-input-v1` 的规范 JSON（实际 Manifest、输出 schema 与结构版本）；读正文仍只存在 Gateway Invocation，计量表不复制内容或凭据。该摘要追溯结构化模型输入，不能据此断言 Provider 的私有提示词处理或确定性输出。

0018 同时移除 `assist_messages.usage_input_tokens`/`usage_output_tokens` 的 0 缺省和 NOT NULL；历史 USER 行及双 0 行因无法分辨“已知精确零”和“未知”，保守回填为 `NULL`，已有正数保留。Assist API 同名 `usage` 字段的子值因此可为 `null`，客户端应按未知展示；迁移不改写已应用的 0015 文件或 SHA。无自动 down migration，回退依赖备份与理解 nullable 用量的新应用版本。真实 PostgreSQL 开发回归覆盖三条调用路径及失败、取消、崩溃遗留状态；未进行 M04 独立验收或真实 Provider 外呼。

追加迁移 [0049_m04_model_call_cache_usage.sql](../../apps/api/migrations/0049_m04_model_call_cache_usage.sql) 给 `model_calls` 与 `assist_messages` 各加可空 `usage_cache_read_tokens`/`usage_cache_creation_tokens`（CHECK `>= 0`）。语义与 0018 一致：`NULL` 是“Provider 未上报”，不是“缓存为零”，因此**不做任何回填**——历史行保持 NULL 才是诚实的未知。两处守卫：`model_calls` 上 CHECK 要求两者之和不超过 `usage_input_tokens`（Provider 口径不一致时不落库自相矛盾）；`assist_messages` 上 CHECK 要求 `role <> 'USER'` 时缓存列才可非空，因为 USER 行从不是一次模型调用。列权限沿用各自现状：`model_calls` 是列白名单式 UPDATE（0049 追加两个列名），`assist_messages` 在 0015 已有表级 UPDATE，无需追加 GRANT。真实 PostgreSQL 回归覆盖「补列前后历史调用行为 NULL」与错误信封三层（`model_calls` → `assist_messages` → HTTP DTO）一致性；未进行 M04 独立验收。

## 32. 0020 Today 用户选择与 Task 调度元数据（2026-09-26 M05 开发自检）

追加迁移 [0020_m05_today_selections.sql](../../apps/api/migrations/0020_m05_today_selections.sql) 给 `tasks` 加可空 `priority`、成对 `due_local_date date`/`due_timezone`；旧 Task 行保持 NULL，更新只递增 Task revision，不触及 acceptance_revision。`today_selection_states` 每 Workspace 一行保存全局选择 revision，首次命令惰性建立并锁行；`task_selections` 以 Task 为主键，存 Pin、成对 Later 日期/时区及最后写入的选择 revision，双清除删除行；`focus_selections` 以 Workspace + 本地日期为主键，保存时区与三选一的 Goal/Project/Task 目标，复合外键阻止跨 Workspace ID。Focus 清除删除该日行；同日换时区须通过原全局选择 revision 显式写入。

写命令先核对并锁目标 Task/Project（Goal 读取验证范围），再锁 `today_selection_states`，用全局 revision CAS 串行化变更；命令回执与选择事实同事务提交。Task 元数据命令沿 Task 行锁与 Task revision CAS，不把 Today 用户选择混进 Task 验收版本。Today 查询以 PostgreSQL 可重复读快照装配，只读当前事实；Later 截止和查询观察点分别用日期 `AT TIME ZONE` 将 IANA 时区当地 00:00 转为绝对时刻，不以 UTC 日期覆盖用户选择。应用入口校验真实日历日期与 IANA 时区；表的成对 CHECK/复合外键提供持久形态及范围兜底。无自动 down migration；回退须先备份新增用户选择，不改写既有迁移或 SHA。

## 33. 0021 Activity 范围与精确 Artifact Lineage（2026-09-26 M05/P15 开发自检）

追加迁移 [0021_m05_activity_lineage.sql](../../apps/api/migrations/0021_m05_activity_lineage.sql) 给 `activity_records` 增加非空 `workspace_id` 与可空 `run_id`。历史 Workspace 初始化由 `fact_refs.workspace_id`、Goal 创建由 `fact_refs.goal_id → goals.workspace_id` 回填；其余 Workspace 由 Project/Task 归属或原命令回执作用域定位，Run ID 另由原 Run/Review/Operation/Control 引用定位。无法归属或 Task/Run 归属冲突时迁移整体失败，不让旧事件在 Workspace 分页里静默消失。Workspace/Project/Task/Run 复合外键限制新写入，`(workspace_id,created_at DESC,id DESC)` 及 Run 过滤索引支撑稳定游标。审计写入仍与对应业务事实共用短事务，查询只发布脱敏白名单；旧 `fact_refs` JSON 保持历史证据而不直接对外。

新增 `artifact_lineage_edges`：`child_version_id` 指向不可变 ArtifactVersion，`relation` 与 `parent_kind,parent_id` 是受 CHECK 限定的 typed relation，`workspace_id` 显式绑定，唯一键 `(child_version_id,relation,parent_kind,parent_id)` 使同一确切关系幂等。插入触发器在 Workspace 事务级 advisory 锁下核对 child/parent 真实归属，`REVISED_FROM` 必须指向同 Artifact 更早版本，`GENERATED_BY` 必须是该 Task 的 `PERSIST_CANDIDATE` Step，`VERIFIED_BY` 必须有该 session 的 VerificationTarget，`ACCEPTED_BY` 必须在该 CompletionRecord 的接受版本集合中；ArtifactVersion 父关系拒绝自环和递归环。锁只串行 Lineage 边插入，不包外部模型/文件调用；应用角色只有 SELECT/INSERT，没有 UPDATE/DELETE。现有产物保存、验证结算和完成提交在各自业务事务插入确切边；没有来源事实时不生成推断边。

0021 不改写旧迁移或内容摘要；无自动 down migration。回退须备份审计归属与 Lineage 边，并使用理解新非空审计字段的应用版本。真实隔离 PostgreSQL 迁移回归覆盖历史回填、无法定位行整体回滚；业务回归覆盖 Workspace 过滤、回放去重、版本自环/跨域/循环与来源不可用，属于开发自检，不是独立或桌面验收。

## 34. 0022 Assist 第一方 Skill 冻结快照（2026-09-26 M04/P12 开发自检）

追加迁移 [0022_m04_first_party_skills.sql](../../apps/api/migrations/0022_m04_first_party_skills.sql) 只在 `assist_messages` 加可空 `skill_snapshot jsonb`、`skill_input jsonb`、`skill_output jsonb`。旧行三列保持 NULL；Skill 只允许 ASSISTANT 行同时保存对象形态的冻结定义与输入，已完成消息才可持有输出对象。更新触发器拒绝修改冻结定义/输入、已结算输出，以及非 RUNNING→COMPLETED 的首次输出写入；原 Assist 领取身份与状态 CAS 仍在 Repository 控制，不建立 SkillRun 或安装表。首批 Skill/Pack 定义随应用只读发布；调用行保存实际定义、依赖内容及精确版本/摘要，输出保存结构化建议和生成时事实基线，不把整包选择写入 Project。

0022 不回填旧消息、不改写已执行迁移或其 SHA。回退须备份三列历史快照与输出，使用理解 nullable 新列的应用版本；无自动 down migration。真实隔离 PostgreSQL 开发回归覆盖新旧消息、命令重放、冻结触发器、首次结算、撤权后读取与 Project Resume 当前事实；独立模块和 Windows 桌面验收未执行。

## 35. 0023 当前 Task Skill 提案与验收版本（2026-09-26 M04/P12 开发自检）

追加迁移 [0023_m04_task_skill_proposals.sql](../../apps/api/migrations/0023_m04_task_skill_proposals.sql) 扩展原 `assist_proposals` 的 `kind` 约束为 `TASK_CONTRACT_CHANGE`、`VERIFICATION_PLAN_CHANGE`，加入可空 `base_acceptance_revision`、`skill_sha256`、`skill_output_sha256`；旧提案行均保持 NULL，原 `TASK_DEFINITION` 仍以 Project 为目标创建新 Task。新 Task 提案强制 Task 目标、双版本与 64 位来源摘要。冻结触发器拒绝改写目标、基线、候选内容/摘要及 Skill 来源，允许原提案状态/决定按既有事务结算。新接受效果写原 `task_acceptances` 下一版本、`task_criteria`、Task acceptance 指针，撤销旧 Verification 适用性并过期 Task 的 OPEN Review；审计、提案决定和命令回执与之同事务。没有第二份有效 CheckPlan 表；GET 准入预览由当前验收、Rule 与注册检查器重建，活动 Run 仍持有原冻结契约。

锁序为先锁不可变 AssistProposal，随后取 Workspace authority SHARE 并复核当前来源，再锁 Task，最后写验收/旧证据失效/审计/回执。只接受 HUMAN 拥有且无活动 Run、未结算或 UNKNOWN Gateway 动作的 Task；并发不同接受只能有一个提交，重复同命令只读原回执。`task-to-execution-contract@1.1.0` 可变更 Expected Result 描述，但旧 `required_output_spec` 的产物种类与其他键原样保留；已确认 criterion 全部复制，不因模型建议删除或弱化。定义新版本与 Pack 1.2.0 随应用发布，旧定义及消息冻结快照不回填、不改摘要。迁移无自动 down；回退须备份新验收版本/提案证据并使用理解新 kind 的应用，不能只删列回退业务效果。真实隔离 PostgreSQL 的定向开发回归涵盖冲突、回放、旧证据失效、跨范围、UNKNOWN 与审计故障回滚；独立/桌面验收后置。

## 36. 0024 内置 ViewConfiguration（2026-09-26 M05/P14 开发自检）

追加迁移 [0024_m05_view_configuration.sql](../../apps/api/migrations/0024_m05_view_configuration.sql) 新建每 Project 唯一的 `project_view_configurations`：`workspace_id/project_id` 复合外键防跨域，独立非负 revision、受 CHECK 限制的内置 kind、固定模板版本及时间。旧 Project 按自身类型回填 General/Thesis/Development；新 CreateProject 与 Project/State 在同一事务建 View 行。实际页面显隐/顺序由随应用发布的 `kind@template_version` 固定注册解析并返回摘要；表不存任意页面代码、脚本、URL 或第二份 Project State。View Owner 命令锁本行按 revision CAS，审计/回执同事务，既有 Run 冻结执行契约不受展示选择影响。无自动 down；回退须备份用户已选择的 kind/revision，旧应用若不能建 View 行不得继续写入。真实 PG 定向核对新建初始形态、切换、重放、版本冲突和跨范围；历史回填由迁移 SQL 保证，尚未单独构造升级前 Project 的反例。独立/桌面验收后置。

## 37. 0025 Project Blueprint 候选与来源（2026-09-26）

追加 [0025_m05_project_blueprints.sql](../../apps/api/migrations/0025_m05_project_blueprints.sql)：`project_blueprint_proposals` 以复合外键绑定 Workspace/Project，保存 `USER_DRAFT` 或 `SKILL` 来源、不可变 candidate/baseline/source JSON、SHA-256、可空 Assist 消息和被替代候选引用、决策终态/时间。候选 JSON 限 64 KiB；触发器拒绝修改来源、候选、基线或摘要，应用仓储以条件更新限定 PENDING→ACCEPTED/REJECTED/EXPIRED/SUPERSEDED 决策。旧 Project/Assist/Run 不回填伪蓝图；无 down migration，回退需备份已接受来源与映射，旧应用不能继续写入这些候选。

候选不是第二份 Project/State/View/Task 当前事实。Preview 读当前 Owner 版本，Apply 按候选→WorkspaceAuthority（Skill 来源时 SHARE）→Project→Goal→现有 Task→新 Task→ProjectState→View 锁序，成功在同一事务调用各 Owner、写审计/决策/命令回执；State/View 在新 Task 插入后发现冲突必须抛错回滚，不得结算过期并提交部分效果。Skill 来源候选在模型外事务冻结定义/Pack/事实 SHA、已选来源和消息身份；当前来源撤销时 GET 隐藏候选正文并标 stale，Apply 在 authority SHARE 栅栏下重读显式来源/hash 后拒绝。Project Skill 复核时使用排他 Project 行锁阻止并发 Task 外键插入，锁定现有 Task 后比对生成时事实基线；内容/状态变化拒绝生成候选。迁移不会修改 0001–0024 的内容或 SHA。

## 38. 0026 真实模型调用预算预留（2026-09-26）

追加 [0026_m04_model_call_budgets.sql](../../apps/api/migrations/0026_m04_model_call_budgets.sql)：`model_calls.budget_reserved_tokens` 可空且为正。新真实 Provider STARTED 行保存发起时的单次上界；历史行保持 NULL，未回填估算用量。没有 down migration；回退前需保留原调用计量，旧应用不能解释新调用的预算预留。

模型开始用例在单独短事务内先确定所属 Project 并取 `FOR KEY SHARE` 可写栅栏，再锁 `runs`（DRAFT 与 SEMANTIC_CHECK）或 `assist_sessions`（同一会话的全部 Assist 消息），核对 Workspace 与原 StepAttempt/AssistMessage 身份，统计同范围的调用数与 token。没有预算配置的 Mock 调用也在同一栅栏下插入 STARTED；无 Project 的会话不受单 Project 归档约束。两项 usage 都已知时计原值；STARTED、失败或缺失用量计冻结预留；历史无预留且缺用量按整个范围上限计并阻止新增。检查通过才插入 STARTED 和预留，事务提交后才调用网络，结算只更新原 call_id；实际 Provider 用量即使大于预留仍存原值，后续调用因此被阻止。范围限额随受控进程配置，不替代 Run/Assist 原业务 Owner，也不把未知费用记零。

## 39. 0027 Workspace 列表键集索引（2026-09-26 M05/P14）

追加 [0027_m05_workspace_lists.sql](../../apps/api/migrations/0027_m05_workspace_lists.sql)：`projects(workspace_id,created_at DESC,id DESC)` 与 `tasks(workspace_id,created_at DESC,id DESC)` 支持 Workspace 内 Project/全 Task 只读分页。原 Project/Inbox Task 索引和游标语义保留；无表字段、Owner 或写事务改变。列表按 `(created_at,id)` 键集查询，游标保存 PostgreSQL 微秒时间文本；状态/归档在两页之间发生变化时不提供快照隔离。索引随应用迁移追加，无 down migration；回退仅影响查询计划，不改现有业务行。真实 PostgreSQL/HTTP 定向回归检查微秒键、过滤与 Workspace 边界，独立/桌面验收后置。

## 40. Project 归档串行化与提交（2026-09-26，无迁移）

既有 `projects.archived_at` 与 `revision` 已足以表达归档状态；A/B 两段均不改表和既有 migration。关联业务写事务在首次不可逆写入前对所属 Project 行取 `FOR KEY SHARE`，确认 `archived_at IS NULL`，锁持有至事务提交；模型调用 STARTED 预约也遵循此顺序。`ArchiveProject` 先对该行取 `FOR UPDATE`，不反向锁全部 Task；在锁内用只读查询检查 Task/Run/投递/运行中的 Step/尝试/验证、Gateway Operation/Invocation/legacy effect/资源 claim、Import、Assist/STARTED model call 和 OPEN Review。非终态、PREPARED、DISPATCHING、UNKNOWN、待审或租约过期而无停止证据都不得放行。先到的业务写事务完成后归档检查才读取其事实；归档先提交后，后来写事务取栅栏会发现归档并被拒绝。Project revision CAS、`archived_at`、关键 Activity 与命令回执在同一短事务提交；外部模型、网页和 Gateway 效果不持数据库锁等待。历史行不清理，未决事实须沿原身份收敛后由新命令重新检查。跨模块负面准入与死锁取舍见 [ADR-011](../decisions/ADR-011-project-archive-serialization.md)。

## 41. 0028 Assist 生成中临时草稿（2026-09-26 M04 开发自检）

追加 [0028_m04_assist_live_preview.sql](../../apps/api/migrations/0028_m04_assist_live_preview.sql)：`assist_message_previews` 以 `message_id` 为主键及原 AssistMessage 外键，一条消息最多一条暂存行；`revision` 从 1 开始递增，`preview_text` 有 `octet_length <= 16384` 的数据库约束，另存截取标志与更新时间。不回填旧消息，不修改既有消息、Proposal 或模型调用事实；无自动 down migration，回退前须让旧应用忽略新表，删除表会丢失在途临时显示文本，但不影响已结算消息。

普通无 Skill 的 `DISCUSS` 每次流式片段按 UTF-8 完整字符形成有界累计前缀，首片段立即写入，生成期间后续写入至少间隔 100 ms，完整输出返回前可再刷新一次。写入短事务先锁原消息并要求当前 Worker 身份、`RUNNING`、未取消，CAS 不再成立时不能继续发布。模型网络调用不占用这段事务；最终完整输出通过原校验和 Assist Owner 结算，结算同事务删除暂存行。取消请求立刻在读端遮蔽，终态和租约过期清理行；读取短事务以 WorkspaceAuthority SHARE 及消息 SHARE 锁建立与来源撤销、取消、结算的先后关系，并重查目标和有界历史来源。跨进程 API 只读该暂存，不将其当历史全文、审计、凭据或接受证据；重新连接用 revision 识别累计前缀。原消息正文在来源失权时也按当前权限遮蔽，不能借完成行绕过临时草稿的读时规则。2026-10-18 起，API 层以约 200ms 的主键快查 `revision`/`truncated` 作为变化信号，经 SSE（[HTTP 契约 §10.59](../api/http-command-contract.md#1059-生成中预览的-sse-推送2026-10-18-源码实现)）把每次重新授权读取的完整前缀推给客户端；表结构、100ms 写入节流和 16 KiB 上限不变。

## 42. 0029 Run DRAFT 生成中临时草稿（2026-09-26 M04 开发自检）

追加 [0029_m04_run_draft_live_preview.sql](../../apps/api/migrations/0029_m04_run_draft_live_preview.sql)：`run_draft_previews` 每个 Run 最多一行，主键绑定原 `runs`，外键绑定 `step_attempts` 与唯一 `model_calls.call_id`；保存确切 Attempt claim、Run Worker epoch/ID、可选 dispatch invocation epoch、递增 revision、截断标志和最多 16 KiB UTF-8 的前缀。旧 Run 不回填，新表不改 Run/Artifact/Verification 事实。无自动 down migration；删除新表会丢失在途显示文本，不能影响已结算候选或后续恢复。

模型端口收到 DRAFT Markdown 片段后，首片段立即提交，生成期间后续写入至少间隔 100 ms，完整返回前再刷新一次。每次写入在单独短事务核对 Task→Run→当前 DRAFT Step/Attempt、Worker/租约、dispatch invocation、原 STARTED model call 与无待处理控制；网络等待不占数据库事务。Run claim/release/fence 或 Attempt 结算在原事务删除旧草稿。读取以 WorkspaceAuthority SHARE、Task/Run SHARE 和原模型调用身份核对当前 Manifest、输入摘要及 FILE_READ/WEB_FETCH 原读证据，按当前权限重查来源、Connection、Policy 与 Resource；不可见只返回空草稿，不复制受限来源 ID。旧 Worker、旧 Attempt、失败/取消或租约到期不能将该行当作成功结果，恢复仍依原 Step/Attempt/operation 身份。真实 PG/HTTP 开发自检验证跨进程首片段、旧 Worker 与控制/来源栅栏；独立、真实 Provider 和桌面验收后置。2026-10-18 起，API 层以约 200ms 的主键快查 `revision`/截断标志作为变化信号，经 SSE（[HTTP 契约 §10.59](../api/http-command-contract.md#1059-生成中预览的-sse-推送2026-10-18-源码实现)）推送每次重新授权读取的完整前缀；换 Attempt/模型调用时 revision 重置，故变化键同时包含 `step_attempt_id`/`attempt_claim_epoch`/`run_worker_epoch`/`model_call_id` 身份字段，表结构与写入节流不变。

## 43. 0030 M06 真实工具能力登记（2026-09-26，开发自检）

追加 [0030_m06_real_tools.sql](../../apps/api/migrations/0030_m06_real_tools.sql)，只放宽受守卫形态并登记四类新能力，不新建表、不改 0001–0029 的内容或 SHA，无自动 down migration。（1）`ck_gateway_capability_kind` 由原「FAKE→READ/WRITE」放宽为 FAKE 与 REAL 各自可取 READ/WRITE，使 FILE_WRITE/GIT_WRITE/CLI_RUN 这类 `REAL`+`WRITE` 组合合法；（2）登记 `FILE_WRITE(REAL,WRITE)`、`GIT_READ(REAL,READ)`、`GIT_WRITE(REAL,WRITE)`、`CLI_RUN(REAL,WRITE)` 四行；（3）`ck_logical_operation_resource` 增补四类能力均为 `origin=RUN` 且 `resource_id IS NOT NULL` 的绑定形态（写/Git/CLI 都作用于受管资源根下的实际工作目录，需资源排他，与 WEB_FETCH 的无资源形态不同）。`ck_invocation_run_identity` 与连接/参数守卫沿用 0014/0016 的 `root_path` 形态，未再放宽——四类新动作都绑定受管资源并走带资源 claim 的 RUN 身份分支。

本轮仅以完整迁移应用链核对约束形态一致（临时隔离 PG 应用 0028/0029/0030 后 `ledger_rows` 为 30、图安装就绪、全量既有回归不退化）；FILE_WRITE/APPLY_CHANGESET、GIT_READ/GIT_WRITE、CLI_RUN 在 Gateway 准入/执行/核对层的真实 PG 集成反例尚未编写，适配器目前只有单元测试覆盖其纯逻辑（路径保护、安全环境净化、进程树封装语义），不构成「真实工具与故障/冲突测试通过」的 M06 出口。执行边界与缺口见[工具适配器](../architecture/tool-adapters.md) §2/§4/§5 与 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 44. 0031 M06 变化集证据账本（2026-09-27，开发自检）

追加 [0031_m06_change_sets.sql](../../apps/api/migrations/0031_m06_change_sets.sql)，新建两张写入即固定的证据表，不改 0001–0030 的内容或 SHA，无自动 down migration（删表只丢失逐文件落盘账本，不触碰已结算的 operation/invocation 事实）。

`change_sets` 是账本头，与产生它的 invocation 一对一：`uq_change_set_invocation UNIQUE (invocation_id)` 是幂等锚点——执行结算与恢复核对都按此回到同一行，核对不追加第二份历史、也不新建伪造成功；`uq_change_set_identity UNIQUE (id, invocation_id)` 供子表复合外键证明文件行确属那份变化集。0031 的 `fk_change_set_invocation` 证明 invocation 与 operation 成对，项目、Run、资源外键却只分别证明各行存在，**未证明它们属于同一 operation**；该遗漏由下节 0032 修正。`action_type` 固定为 `APPLY_CHANGESET`/`WRITE_FILE` 两种受管写动作（0030 登记，均 RUN 来源且绑定资源根），`canonical_root` 记录执行时使用的规范根（变化集为受管资源根、单文件为其父目录），相对路径只有在该根语境下才可复现。`status` 取 `SUCCEEDED/PARTIAL/UNKNOWN`（部分应用不整体成功），`evidence_source` 标明整体状态来自适配器执行报告（`EXECUTION`）还是事后按真实内容回读（`RECONCILIATION`），`file_count >= 1` 用于识别「结果丢失后一条证据都没落下」。

`change_set_files` 是逐文件观测，主键 `(change_set_id, relative_path)`：声明侧（`action`/`baseline_sha256`/`target_sha256`）取冻结输入，观测侧（`observed_baseline_sha256`/`actual_sha256`/`status`/`error`）取真实落盘或回读。四条 CHECK 把「成功必须可证」写进库：非 CREATE 或未成功的修改/删除必须留可信冻结基线（`ck_change_set_files_baseline`）；`DELETE` 无目标内容（`ck_change_set_files_delete`）；声称 `APPLIED` 必须有与目标一致的实际摘要、删除的成功是 `actual_sha256 IS NULL`（`ck_change_set_files_applied`）；未成功必须留原因（`ck_change_set_files_reason`）。摘要列只接受真正的 64 位十六进制（`ck_change_set_files_hashes`），`relative_path` 非空且不超 1024 字节，`diff_ref` 预留为 jsonb 对象但本增量不生成。

授权落实不可抹除：`relay_app` 对 `change_sets` 只有 `SELECT/INSERT` 加上受限的 `UPDATE (status, evidence_source, file_count, updated_at)`（仅供核对收敛整体状态，身份/作用域/规范根等声明列由权限禁止改写），对 `change_set_files` 只有 `SELECT/INSERT`——两表均无 `DELETE`，逐文件行连 `UPDATE` 都不授予，核对阶段以 `ON CONFLICT DO NOTHING` 只补记执行缺失的路径。`ChangeSetRepository`（`apps/api/src/files/change-set-repository.ts`）是这两张表的唯一 SQL Owner；磁盘 I/O 全在事务外，落库与调用结果结算同处一个短事务。本轮为开发自检（real-tools 定向 23 例）：真实隔离 PG 反例（`real-tools-gateway.integration.test.ts`）覆盖成功写唯一一份 `SUCCEEDED`、基线冲突 `PARTIAL` 且冲突文件记磁盘原值、崩溃后核对收敛 `SUCCEEDED`/`UNKNOWN` 且唯一一份、多文件单冲突按路径逐条固化、多文件全成功（`CREATE`/`MODIFY`/`DELETE` 各一）按账本 `canonical_root` 回读磁盘一致并在库层验证约束与授权（同一 invocation 换主键重复插撞 `23505`；改写或删除逐文件行、删除账本头、改账本头身份列均 `42501`）。不构成 M06 出口放行，逐文件 diff 生成与展示 UI 未实现。

## 45. 0032 M06 账本来源作用域约束（2026-09-27，定向独立复验）

追加 [0032_m06_change_set_source_scope.sql](../../apps/api/migrations/0032_m06_change_set_source_scope.sql)，不修改已应用的 0031 或其 SHA。`logical_operations` 新增受管写能力与 `WRITE_FILE`/`APPLY_CHANGESET` 动作类型的配对 CHECK，以及覆盖 `(id, workspace_id, project_id, run_id, resource_id, action_type)` 的可引用唯一键；`change_sets.fk_change_set_source` 用单个复合外键绑定同一来源动作的项目、Run、资源与动作类型。0031 原有 invocation 成对外键仍证明这是该 operation 的调用。此约束针对审查发现的“同 Workspace 内拿真实 invocation 搭配别的有效项目/Run/资源”错账路径，不改变磁盘动作或公开 API。

迁移会校验既有 `change_sets`：如果曾写入来源不一致的行，0032 应失败并要求先核对证据，不能静默改写不可变逐文件账本。无自动 down migration；回退约束会重新开放错账准入，故不得把删除约束当常规恢复。`canonical_root` 由应用用例从已锁定的 operation 目标推导并保持不可变，数据库复合外键不证明磁盘路径真实内容；实际落盘摘要及恢复回读仍须由文件适配器与 Gateway 反例核对。

协调侧在一次性 PostgreSQL 18.6 上独立复跑完整迁移链（32 行迁移账本）、migration 8/8 与 real-tools 37/37；新增真实 PG 反例分别用有效的其他动作类型、资源和 Project 组装错账，复合外键均拒绝。执行回执与账本最终结算分别在短事务写入：前者只证明原 Invocation 的适配器曾返回，后者与 Invocation 终态同事务提交；恢复仍须按冻结输入与当前文件状态核对，不把回执或文件终态单独算成功。本节是 0032 与增量 A 的定向证据，不表示所有历史数据迁移场景或 M06 总验收已完成。

2026-09-27 增量 B 后续修复：部分文件已应用时原 Operation/Invocation 保持 `UNKNOWN`，执行阶段形成的 `change_sets.status=PARTIAL` 与不可改写的逐文件行保留其历史观测；后续恢复回读不能将该账本头覆盖为 `UNKNOWN` 或伪装成 `SUCCEEDED`。这只调整既有 `ChangeSetRepository.recordReconciliation` 的收敛条件，没有新 migration 或表。全文件确定无写入的冲突/冻结根拒绝则可把原调用结算为 `FAILED` 并释放 claim；仍记录 `PARTIAL` 账本表示请求未全部应用，不表示曾有已应用文件。人工处置和 diff 证据持久化仍待实现。

## 46. 0033 M06 桌面 Job 停机证明（2026-09-27，开发自检）

追加 [0033_m06_file_write_stop_proofs.sql](../../apps/api/migrations/0033_m06_file_write_stop_proofs.sql)。`file_write_stop_proofs` 以原 `invocation_id` 为主键，只允许 `relay_app` SELECT/INSERT；复合外键同时约束原 Operation/Run/Invocation/Worker ID 与 epoch、Run 投递命令，CHECK 只接受 `FILE_WRITE` 两种动作和桌面 Job 停止证据枚举，`launch_id` 必须对应桌面 Worker ID。可信桌面启动帧带来的已停止 Job 在 `recoverStoppedDesktopLaunch` 的旧 claim 会话锁内、Run fence 前校验并插入；重复恢复只读原行，不改证据。租约过期、普通 child close 与客户端布尔值都不能生成此证明。旧 `run_invocations.stop_evidence` 可随重新领取清空，因此不可作为人工解除隔离的持久前提。

新增复合唯一键仅供上述外键引用，不修改既有 Invocation、Operation 或 RunCommand 内容；旧行无回填，未有可信证据的历史 UNKNOWN 继续隔离。无自动 down migration；删除此表会丢失已停旧 Job 与原调用的持久关联，使依赖它的人工处置无法再授权，不能当作安全回滚。隔离 PostgreSQL 定向 5/5 和 run-dispatch 回归 22/22 通过；尚无真实 Windows Job handle 活进程反例。

## 47. 0034 M06 部分文件写入的人工处置（2026-09-27，开发自检）

追加 [0034_m06_file_write_manual_dispositions.sql](../../apps/api/migrations/0034_m06_file_write_manual_dispositions.sql)：`logical_operations` CHECK 增加终态 `MANUALLY_CLOSED`，`file_write_manual_dispositions` 对原 Invocation 唯一且只授予 SELECT/INSERT。处置行用复合外键绑定同一变化集的 Invocation、Operation、Workspace、Project、Run、Resource，另与 0033 停机证明绑定；保存本机人工主体、命令 ID、唯一受支持决定 `KEEP_CURRENT_AND_FAIL_RUN`、逐文件当前摘要及整体观察 SHA-256，不保存文件正文。旧 Operation 的结果引用指向 disposition，原 Invocation `UNKNOWN` 与原 `PARTIAL` 账本不改写。后续无回执崩溃场景复用同一表和外键，原变化集可保持 `UNKNOWN`；观察 JSON 额外保存目标与候选残留的 File ID/摘要，不证明候选归属，也不需要修改 0034 表结构。

应用用例先在业务事务外限量回读逐文件当前状态，再在 Task→Run 事务中核对 revision、原隔离 claim、停机证明、投递、唯一未决动作及回读所依据的账本身份；命令回执、处置行、Operation 终态、claim 释放、旧投递结清、待处理控制拒绝、Run 失败、Task 返 READY 与 Activity 同事务提交。项目归档的 `UNKNOWN_EFFECT` 查询只排除 Operation 已为 `MANUALLY_CLOSED` 且有匹配处置行的历史 Invocation，其他 UNKNOWN 仍阻断。旧数据无自动回填；0034 会校验已有账本/证明键，错配必须先核对，不能删除或改写原证据。无自动 down migration；旧应用不认识新终态，回退须先停用新入口并保留新表/状态解释能力。数据库约束不消除文件回读到事务提交之间的外部编辑竞争。

## 48. 0035 M06 冻结计划文本差异证据（2026-09-27，开发自检）

追加 [0035_m06_file_write_frozen_diff.sql](../../apps/api/migrations/0035_m06_file_write_frozen_diff.sql)。`file_write_frozen_diffs` 只为新 `FILE_WRITE` 的 `MODIFY/DELETE` 保存准备时核验的基线正文或不可用原因，`CREATE` 的空基线由动作语义推出；目标正文仍在原 `logical_operations.params`。主键 `(operation_id,relative_path)` 防止重复行，联合外键绑定原 Operation 的 Workspace、Project、Run、Resource、Capability 和动作类型，CHECK 限定相对路径、动作、64 KiB 文本上限及基线正文 SHA-256。`relay_app` 仅有 SELECT/INSERT，基线证据与 Operation 同事务写入；同一意图不会刷新已有行。

先以短事务核对 Workspace authority、Task/Run、资源、Connection 与 Permission，再在事务外限量读取最多 16 个文件的基线，最终以另一个短事务重新核对授权并把冻结证据与 Operation 同步提交；不在持锁事务内等待原生助手。可展示正文每文件最多 64 KiB。文件不安全、内容不匹配、非可展示文本或超过上限只记原因，不把当前磁盘内容伪装成旧基线。旧 Operation 不回填：缺失证据在查询中明确为 `BASELINE_UNAVAILABLE`。无自动 down migration；删除此表将丢失新动作的冻结基线文本，旧版本无法重建，回退需保留该证据或明确接受文本差异不可用。此前真实隔离 PostgreSQL migration 8/8 与 `real-tools-gateway` 42/42 已通过；Windows 句柄级读写的后续验证另见 M06 验收记录。

## 49. 0036 M06 文件路径物理身份（2026-09-27，开发中）

追加 [0036_m06_file_write_path_identity.sql](../../apps/api/migrations/0036_m06_file_write_path_identity.sql)。`file_write_path_identity` 仅对**新** `FILE_WRITE` Operation 保存受管根规范路径及卷号/File ID、逐文件相对路径、父目录链和目标身份；主键为 `operation_id`，复合外键把 Workspace、Project、Run、Resource、Capability 与动作类型绑定到同一来源 Operation。`relay_app` 仅有 SELECT/INSERT，既有行不自动回填，也不改写 0030–0035 或其摘要。

准备时先授权，再由 Windows 原生助手捕获身份，最终在短事务中复核授权并与新 Operation 一同插入。执行和恢复只用原行核对根、父目录与目标；旧 Operation 缺失身份不能靠当前磁盘补造原身份，仍按 UNKNOWN/隔离处理。新 `WRITE_FILE` 账本以受管资源根作为 `canonical_root`，逐文件路径相对该根；历史账本原值不改。单文件上限 1 MiB、单次最多 16 文件，超限不能冻结物理证据。无自动 down migration；删除此表会令依赖它的新 Windows 写动作无法安全恢复。迁移 8/8 已在隔离 PostgreSQL 验证；原生助手与桌面恢复链的确切结果见 M06 验收记录，不能由迁移测试推断文件系统安全。

## 50. 0037 M06 单文件冻结差异的根相对路径（2026-09-27，开发自检）

追加 [0037_m06_file_write_frozen_diff_root_path.sql](../../apps/api/migrations/0037_m06_file_write_frozen_diff_root_path.sql)，只替换 0035 的 `ck_frozen_diff_action`：`WRITE_FILE` 仍限 `MODIFY`，但允许根相对的子目录路径；0035 的路径格式、长度、冻结摘要和只追加权限约束不变。原因是新 Windows 单文件账本以受管根为 `canonical_root`，冻结计划差异需与账本使用同一路径。历史 basename 行不更新，旧迁移及 SHA 不改。回退此约束会拒绝新嵌套路径的写入，不作为无损回滚。完整迁移链 37 行、迁移测试 8/8、真实隔离 PG real-tools 49/49 通过。

## 51. 0038 M06 受管资源登记时物理身份（2026-09-28，开发自检）

追加 [0038_m06_managed_root_identity.sql](../../apps/api/migrations/0038_m06_managed_root_identity.sql)，为 `managed_resources` 增加可空 `file_write_root_id`（卷号/File ID 格式 CHECK）。旧行保持 NULL；数据库迁移不能从当前文件系统推断登记时身份，也不自动更新历史 Operation。新 Windows 资源登记在业务事务外调用原生助手捕获当时目录身份，并与资源行同事务写入；助手认为目录不安全时可以登记供其他能力使用，但 `file_write_root_id` 留空，新 Windows `FILE_WRITE` 准备拒绝。非 Windows 登记同样留空，其原有路径实现不因此改为 Windows 句柄保证。

0038 撤销 `relay_app` 对 `managed_resources` 的表级 UPDATE，只重新授予 `status,revision,resource_epoch` 列更新；目录路径、规范键和登记物理身份不由应用角色改写。准备新 Windows 写动作时要求非空且与当前助手捕获的根 File ID 相同，再冻结 0036 的 Operation 身份；旧已准备动作沿其原冻结证据执行/核对。停用旧资源并重新登记会生成新资源 ID，原 claim、Operation 与审计历史不搬迁。无自动 down migration；去掉身份列和门槛会重新开放原资源路径被普通目录替换的准入风险，回退必须先停止新写动作。真实隔离 PostgreSQL 迁移 8/8、Windows 替换/旧空身份定向 2/2、完整 real-tools 51/51 已通过，测试数据库及进程清理；确切桌面包的相邻 Job/WebView2 旧路径已复验，新身份提示的人工交互与 M06 总出口另验。

## 52. 0039 M06 已停用资源的同路径重新登记（2026-09-28，开发自检）

追加 [0039_m06_active_resource_root.sql](../../apps/api/migrations/0039_m06_active_resource_root.sql)：原 `uq_managed_resource_project_root` 覆盖已停用行，会令 0038 的“停用旧资源并重新登记”实际不可执行。0039 将其替换为仅覆盖 `status='ACTIVE'` 的 `(project_id,identity_key)` 唯一索引；登记命令的重复检查也只看活动资源，并仍持有跨 Workspace 登记 advisory 事务锁。旧资源行、Operation、claim、策略和审计记录不删除或回填；同项目同路径活动资源仍最多一个，停用须先处理占用或隔离。新登记得到新资源 ID 和捕获时根 File ID，旧 Run/Task 的冻结资源 ID 不自动改绑；用户须重新检查连接、Permission 与委托引用。

迁移不改写已有行或权限。回退该部分唯一索引并恢复旧无条件唯一约束之前，若已有同路径历史停用行，约束会失败；不得删除历史行换取回退。真实隔离 PostgreSQL 完整迁移 8/8、Windows 重新登记定向 3/3、完整 Gateway 28/28 与 real-tools 52/52 已通过。0039 已包含在 EXE SHA-256 为 `577a731e3022e540e38edc6a152301afc31b5a585e75eabb999919bbd5863efc` 的确切桌面目录包内，清单核验及相邻 Windows Job/WebView2 路径通过；无回执强杀的桌面同场景另验。

## 53. 0046 M04 Assist Provider 失败类别（2026-09-30）

追加 [0046_assist_provider_error_kind.sql](../../apps/api/migrations/0046_assist_provider_error_kind.sql)：`assist_messages` 新增可空 `provider_error_kind text`，封闭词表为 `AUTH/RATE_LIMIT/TIMEOUT/STREAM_BROKEN/PROTOCOL/NETWORK`，另一 CHECK 仅允许 `FAILED` 消息带非空类别。该字段与原 Relay `error_code` 分开，避免将预算、取消、解析或本地处理失败归因给 Provider。Assist Owner 在原领取 Worker 身份的 CAS 结算中保存类别；查询只投影持久事实，不重算历史分类、不增加业务写入 Owner。

旧行保持 NULL，迁移无回填、无新表/索引、无权限变化；旧客户端可忽略新增响应字段，新客户端兼容旧服务缺字段。迁移按既有摘要台账顺序应用，不改写 0015。没有自动 down migration；回退代码前需核对 schema 兼容门，删除该列会丢失已保存的诊断类别，不能删除历史消息来绕过约束。API Breaking Change: No，原请求与执行权契约不变。隔离 PostgreSQL 与接口验证结果见[开发记录](../development/ui-live-integration-2026-09-28.md#12-m04-assist-provider-失败诊断2026-09-30)。

## 54. 0047 M04 首输出观察时间（2026-09-30）

追加 [0047_m04_model_call_first_output.sql](../../apps/api/migrations/0047_m04_model_call_first_output.sql)：原 `model_calls` 新增 `first_text_delta_at`、`first_preview_persisted_at` 两个可空 `timestamptz`，无默认、无旧行回填，并追加两列的应用角色 UPDATE 权限。CHECK 限制首预览非空时必须已有首文本，且非 DRAFT/ASSIST 调用两列必须为空。不改写已应用的 0018，不增加事实表、索引或业务状态。

首文本时间只接受当前合法 Owner 的首个非空文本回调；首预览时间与通过身份门禁的第一次预览写入在同一短事务内保存。Repository 按原 call_id 一次性写入，后续回调、预览清理与调用结算保留原值；旧 Worker、取消或失效身份不能补写。Run 保留 Task/Project/Run→call 的锁序，Assist 使用 Message→call，避免把计量锁反向带入业务事务。仅记录服务端观察，不以 `started_at` 冒充实际请求发送，也不以事务内时间冒充提交返回或 Windows 可见首字。无自动 down migration；旧应用可忽略新列，删除列会丢失首输出历史证据，回退先核对既有 schema 兼容门。API 为附加可空投影，Breaking Change: No。测试结果只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 55. 0048 M07 数据库级新工作准入门（2026-09-30，源码实现）

追加 [0048_m07_admission_gate.sql](../../apps/api/migrations/0048_m07_admission_gate.sql)，新表 `runtime_admission_gate` 以 `singleton=true` 为唯一主键，CHECK 固定单行键、mode `NORMAL/DRAINING` 和非负 bigint revision，迁移预置 NORMAL/0。`relay_app` 只获 SELECT 与 `UPDATE(mode,revision)`，无 INSERT/DELETE 或身份列更新权；不改写已有 migration、Workspace 或 Run 状态。运行期 SQL Owner 为 RuntimeAdmissionRepository，状态转换由维护应用用例协调。

首次命令和新领取的 `FOR SHARE` 位于原业务锁之前；状态转换使用专用 `FOR UPDATE` 事务，CAS 与 scope `runtime:database-admission`、target `DATABASE` 的原命令回执同时提交。普通命令等待门锁后再查回执，避免把等待期间已提交的原结果误报维护拒绝；门锁等待最多5秒，不延长较短原期限，成功后恢复原期限，失败整笔回滚，不保留半变更。独立模型连接验证在同一准入短事务里预约原 `model_calls(kind=VERIFY)` 的 STARTED，网络与原调用结算位于事务之外；不增加第二套模型账本或改变 Run/Assist 预算。完整锁/兼容取舍见 [ADR-014](../decisions/ADR-014-database-maintenance-admission.md)，CLI 与限制见[部署说明](../deployment/本机部署.md#draining-新工作准入门)。

迁移是追加表，旧数据无需转换；旧包不识别准入门，既有严格 schema 清单也不自动兼容未来 migration，升级需停旧进程并经原迁移入口。无自动 down migration；删除表或回退到不参与门的代码会撤销维护保证，不能当作恢复准入的方法。DRAINING 中原在途业务和图仍可写入，没有完整冻结或备份一致性保证。实际验证与未覆盖项只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

2026-10-01 数据库连接维护接续无新migration/业务字段。受信运维会话暂时撤销数据库CONNECT ACL，修改前保存完整有效ACL及grant option；不可变凭据在独立运维目录，不存URL/密码。按原目标和ACL恢复，不用bootstrap重置既有权限；异常时撤销可能保留，漂移拒绝覆盖，不承诺自动回滚。具体兼容、角色和恢复限制归[部署设计](../deployment/本机部署.md#数据库连接维护与权限恢复)。

## 58. 0052/0053 N03 项目知识导读与整理候选（2026-10-02）

追加 [0052_n03_project_knowledge_guide.sql](../../apps/api/migrations/0052_n03_project_knowledge_guide.sql) 与 [0053_n03_knowledge_curation_candidates.sql](../../apps/api/migrations/0053_n03_knowledge_curation_candidates.sql)，三张新表，不改写 `0009` 的 Information 表或 `0041` 的影响检查表。

`project_knowledge_guides` 以 `UNIQUE(project_id)` 保证一个 Project 一份导读，`revision` 供 CAS；应用角色只有 `SELECT/INSERT` 与 `UPDATE(revision, updated_at)`。`project_knowledge_guide_entries` 的 `(guide_id, ordinal)` 主键承担人工顺序，`UNIQUE(guide_id, ref_kind, target_id)` 拒绝重复，`target_id` 是 `coalesce(knowledge_id, decision_id, rule_id, artifact_version_id)` 的 STORED 生成列——**唯一约束里的 NULL 互不相等，直接对四个可空列建 UNIQUE 会漏掉重复项**，生成列是这里唯一可靠的去重方式。四类目标各一个可空外键，`ref_kind` 与「恰好一个目标列非空」由 CHECK 用 `IS NOT NULL` 强制：这是刻意吸取 `0044` 的教训（该迁移把 CHECK 写成 `target = ref_id`，NULL 时求值为 NULL 而非 FALSE，PostgreSQL 只在 FALSE 时拒绝，脏行因此可落库，只能由 `0045` 追加修正）。`ck_guide_entry_pin` 要求只有 `KNOWLEDGE` 能 `PINNED` 且必须给出 `pinned_version_id`，`CURRENT` 则必须为空，因此「固定历史引用」与「跟随当前导航」在数据库层就无法混淆。

条目表对 `relay_app` 给 `SELECT, INSERT, DELETE`：编辑导读就是替换整份清单，条目是可替换的导航引用。它们指向的知识版本、决定、规则与成果版本仍按原契约不可变——DELETE 权限不触及被引用对象。

**外键不保证 `pinned_version_id` 属于同一条知识**——跨表一致性 CHECK 做不到，由应用层在建导读时复核（`requireReferenceInScope`）。实测用应用角色直插一条指向另一条知识版本的 `PINNED` 行**会被数据库接受**；读端因此返回 `MISSING`/`CROSS_SCOPE` 而不是解析到错误版本。API 路径无绕过，但不要误以为库级已保证。

`knowledge_curation_candidates` 保存来源成果版本与建议归类，`suggested_knowledge_id` 仅在标题字面完全相同时才指向既有条目，否则为空表示建议新建。`ck_curation_decision` 把未决／已接受／已拒绝写成互斥分支，`ck_curation_accepted_pair` 保证两个接受列同时有值或同时为空，避免「有版本但无知识」这类半写状态。应用角色有 `SELECT, INSERT` 与仅限四个决定列的 `UPDATE`，不能改来源或建议标题。

上限（导读 200 项、单次候选 10 项、列表 20 条）在 API schema 层拒绝，数据库不设项数 CHECK。外键只保证被引用对象存在，不保证同项目——跨项目与跨 Workspace 引用由应用层在建导读、建候选、接受三处各自复核，读取端再复核一次作用域；这是与 `0041` 相同形状的纵深依赖，不是数据库级隔离。

**接受候选必须单事务**：「锁候选行 → 复核 accepted/rejected → 写知识版本 → 绑定候选 → 写回执」全在一个事务里。若像首轮实现那样让知识版本在内层命令的独立事务先提交、再在另一个事务绑定候选，则拒绝与接受并发时会出现「用户已拒绝、却留下一个在候选审计链上无归属的孤立知识版本」。为此 `information-commands.ts` 增加了 `createKnowledgeInTransaction` / `addKnowledgeVersionInTransaction`：它们复用同一 execute 主体但不自己开事务、也不自己写回执（否则同一 `command_id` 会写两行回执），回执由组合用例在同一事务写入。

三张表对旧数据无需转换，没有回填、没有触发器、没有改写已应用迁移。没有自动 down migration；回退代码前需停旧进程并经原迁移入口，删表会丢失人工编排顺序与候选决定记录，不能靠删表绕过兼容性核对。API Breaking Change: No，Information 与 Artifact 的形状与状态机均未改变。真实 Windows 阅读与 PV03/PV08 未做；实际成绩只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 56. 0050 N02 跨成果候选组与组合检查（2026-10-02）

追加 [0050_n02_impact_candidate_groups.sql](../../apps/api/migrations/0050_n02_impact_candidate_groups.sql)，四张新表，不改动 0041 的 `artifact_impact_checks` 与 `artifact_impact_candidates`：

- `artifact_impact_candidate_groups`：`workspace_id`、`impact_check_id` 外键、`source_artifact_id` 与 `source_before/after_version_id` 外键、`source_artifact_revision`，CHECK 只要求 before≠after。它只保存组的来源基线，不复制成果正文。
- `artifact_impact_candidate_group_items`：`(group_id, ordinal)` 主键承担用户顺序，`UNIQUE(group_id, target_version_id)` 拒绝重复目标，`target_artifact_id`/`target_version_id` 为真实外键，因此组不能引用不存在的版本，`relation` 非空 CHECK，`speculative` 标记该目标是否来自 AI 推测。
- `artifact_combination_checks`：`group_id` 与 `task_id` 外键、`acceptance_revision`、`gaps jsonb`（CHECK 为数组）。**没有整体结论列**——整体不可判是类型语义，存一个常量列只会伪装成可写事实。
- `artifact_combination_check_items`：`(combination_check_id, ordinal)` 主键、`UNIQUE(combination_check_id, artifact_version_id)`、`content_hash` 32 字节 CHECK、`is_current_version`/`readable` 快照，以及可空 `verification_session_id` 外键与封闭词表 `verification_status IN ('OPEN','PASS','RETRY','HUMAN')`（对齐 `verification_sessions.status`）。可空而非 NOT NULL，因为「该确切版本在当前验收修订下没有验证会话」是需要如实保存的缺口。

四张表对 `relay_app` 只给 `SELECT, INSERT`；没有 UPDATE/DELETE 权限，应用角色不能改写已保存的范围或覆盖缺口，这与「接续点/候选组不是可编辑的第二份成果状态」一致。上限 1–10 项与 1–20 项在 API schema 层拒绝，数据库不设项数 CHECK。旧行无需转换，没有回填、没有触发器、没有改写已应用迁移。

应用角色持有 INSERT 即可构造跨 Project 的组或组合检查（外键只保证版本存在，不保证同项目）；因此应用层在建组与建检查单时按 `workspace_id` 复核来源与每个目标版本的当前作用域，跨 Workspace 读取一律 404。这是与 `0041` 相同形状的纵深依赖，不是数据库级隔离。

没有自动 down migration；回退代码前需停旧进程并经原迁移入口。删除这四张表会丢失已保存的审阅范围与缺口记录，不能靠删表绕过兼容性核对。API Breaking Change: No，Artifact/Task/Verification/Assist 的形状与状态机均未改变。真实 Windows 差异审阅与 PV08 体验记录未做；实际成绩只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

---

## 57. 0051 M07 文件夹入口与对话执行请求（2026-10-02，源码实现）

追加 [0051_conversation_execution_requests.sql](../../apps/api/migrations/0051_conversation_execution_requests.sql)：`conversation_execution_requests`。一条原用户消息对应一条执行请求；模型整理出的候选、阶段事实与关联的真实 Task/Run 都在这张表里，业务侧不保存第二份状态。

- `source_message_id` 与 `(workspace_id, command_id)` 各带一条 `UNIQUE`：同一条原消息或同一个命令身份重放都命中同一条请求，不会产生第二个意图。
- 阶段命令身份 `task_command_id` / `ready_command_id` / `delegate_command_id` **在请求创建时就固定**：恢复时按原 `command_id` 重放既有回执，不因重试生成第二个 Task 或 Run。
- `base_content_sha256 bytea`（`length = 32`）固定原消息内容基准；`root_path` 与 `resource_id` 固定这次请求的作用目录，不靠会话推断。
- `decision` 闭合为 `DISCUSS | CLARIFY | PREPARE`，`candidate_status` 为 `PENDING | READY | INVALID | UNAVAILAILABLE`，`status` 为 `INTERPRETING | DISCUSSED | CLARIFY | READY | TASK_PREPARED | DELEGATED | FAILED`。CHECK 保证进入 `TASK_PREPARED` / `DELEGATED` 时必带 `task_id` 与 `task_command_id`，进入 `DELEGATED` 时必带 `delegate_command_id` 与 `run_id`，且 `CLARIFY` 判定不能落在准备或委派阶段。
- 授权来源永远是 `source_message_id` 指向的那条原用户消息。模型只解释候选，`candidate` / `clarification` 是候选与澄清，不是授权、验收或完成凭据。
- 索引：`(session_id, created_at DESC, id)` 供会话内回读；`task_id` 部分索引供任务追溯。
- `relay_app` 获得 `SELECT, INSERT, UPDATE`；不新增 DELETE。写入只经过 [ConversationExecutionRepository](../../apps/api/src/assist/conversation-execution-repository.ts)，候选只能从 `PENDING` 结算一次，阶段只能向前 CAS。

运行语义：解释（原消息 → 候选）与执行（候选 → Task/READY/Delegate）是两个命令。模型调用在事务外，候选先落库；Task 事实与 `TASK_PREPARED` 在同一短事务提交，READY 与 Delegate 各自是既有命令并各自留回执。跨命令的部分成功按阶段如实显示，不伪称原子。UNKNOWN 沿原 operation 核对，重放只读已保存的候选，不重付模型整理成本。

兼容与回滚：无自动 down migration；删除该表会使文件夹入口与对话执行请求失去持久来源，且历史请求无法重放。回退必须先停用新的写入路径。**API Breaking Change: No**（新增端点，既有 Task/Run/Review/Assist 状态不变）。实际验证与未覆盖项只在[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)维护。

## 58. 0054 M04 模型工具循环与 FILE_QUERY（2026-10-03，源码实现）

追加 [0054_m04_agent_tool_loop.sql](../../apps/api/migrations/0054_m04_agent_tool_loop.sql)：`FILE_QUERY` 能力行、放宽后的 `ck_logical_operation_resource`、新表 `run_tool_calls`。`run_tool_calls` 是 `apps/api/src/run/run-tool-call-repository.ts` 的唯一 SQL Owner。

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

运行职责与循环规则归[运行架构 §2.3](../architecture/runtime-context.md)，能力范围归[工具适配器 §1.4](../architecture/tool-adapters.md)，HTTP 面归[命令契约 §10.54](../api/http-command-contract.md)。

## 59. 0056 M04 本次任务范围授权与一次自动适配留痕（2026-10-04，源码实现）

追加 [0056_m04_run_scope_grants.sql](../../apps/api/migrations/0056_m04_run_scope_grants.sql)：新表 `run_scope_grants`，以及 `run_tool_calls` 上的一次自动适配留痕列。`run_scope_grants` 是 `apps/api/src/application/run-scope-grant.ts` 的唯一 SQL Owner。

**`run_scope_grants` 的不变量。**

- **一个 Run 至多一份授权。** `uq_run_scope_grants_run` 保证。授权在 Delegate 事务里与 Run 同批落库，因此不存在「Run 已存在但授权漏写」的中间态，也没有脱离 Run 的孤儿授权；`fk_run_scope_grants_run` 按既有惯例单列引用 `runs (id)`，而不是引用尚不存在的 `runs (workspace_id, id)` 唯一键。
- **边界写入后不可改写。** 应用角色只有 `SELECT, INSERT`，`UPDATE` 被限制在 `(revoked_at, revoked_reason, revision, updated_at)`。授权边界从签发起就是冻结的，撤销只改变「是否仍适用」，不改变「授权了什么」。
- **动作词表是封闭的。** `ck_run_scope_grants_actions` 要求非空且 `<= {WRITE_FILE, APPLY_CHANGESET, CLI_RUN}`；`ck_run_scope_grants_no_delete` 显式禁止 `DELETE` 出现，防止删除被一次授权带走。检查统一记作 `CLI_RUN`：粒度由冻结的 `checks` 清单决定，不由动作名决定。
- **根身份是物理事实。** `root_identity` 存冻结时的规范根身份；路径相同但目录已被整体替换时原授权不再适用，因为那已经不是当初被授权的那一个目录。
- **撤销必须说明原因。** `ck_run_scope_grants_revocation` 要求未撤销时不得留下撤销原因、已撤销时必须留下非空原因，便于审计「为什么不再放行」。
- **边界摘要可核对。** `boundary_digest` 是资源、根身份、动作集合与检查清单的规范摘要，用于核对「模型请求没有超出授权」；`ck_run_scope_grants_digest` 约束其形状。

**一次自动适配的留痕。** `run_tool_calls` 追加 `adaptation_of`（自引用）与 `adapted_path`。`ck_run_tool_calls_adaptation` 只要求两列同现同缺且路径非空——**它不保证深度**：数据库层没有禁止「对已适配的行再适配」。「只适配一次」由应用层判定（`decideToolAdaptation` 拒绝 `adaptation_of` 指向已适配行的请求），不得据此声称数据库层已强制；需要该保证时由应用层测试兜住，而不是靠这条 CHECK。留下这一对列而不是只留计数，是为了让「这次写入是对哪一次基线冲突的重新适配」在恢复核对时仍然可查，且新读取的基线与新意图有对应关系，不覆写旧记录。

**迁移不改历史。** `0056` 只新增并放宽（`run_tool_calls` 的列可空），不回填：既有 Run 没有授权行，`evaluateScopeGrant` 返回 `SCOPE_GRANT_ABSENT`，与本轮之前「文件写入一律 ASK」的行为一致。

授权语义归[工具适配器 §1.2](../architecture/tool-adapters.md)，HTTP 面归[命令契约 §10.55](../api/http-command-contract.md)。

## 60. 0057 M04 工具调用的 Run 刷新事件（2026-10-04 设计，2026-10-05 源码实现）

追加 `0057_m04_run_tool_call_events.sql`。**只增加刷新事件的来源，不改 `run_tool_calls` 表结构、不新增业务表、不改任何 CHECK 以外的业务约束。** 依据是[研究 §1.6](../research/p00-source-study.md#16-工具调用呈现与刷新机制对照2026-10-04)：Codex 对每个工具项发 `item/started` / `item/completed`，DeepSeek 把 `tool/call` 与 `tool/result` 作为持久事件推送——两家都是「事件本身持久化 + 逐项提示」，不是轮询。

**为什么是补事件而不是加轮询。** `run_tool_calls` 已经是持久账本，缺的是「它变了」这一信号。`0012` 的 `relay_append_run_event()` 用封闭 `CASE` 分派事件来源，遇到未登记的表直接 `RAISE EXCEPTION`（`0012_m03_run_events.sql:44-46`），因此必须显式登记，否则工具调用行的任何写入都会失败。

三条改动：

- `ck_run_events_kind` 增加 `TOOL_CALL_CHANGED`。既有 6 个取值不变，CHECK 只能放宽不能替换。
- `CREATE OR REPLACE FUNCTION relay_append_run_event()` 增加一个分支：`run_tool_calls` 的 `run_id` 就在行上，不需要像 `step_attempts` 那样回查 `run_steps`。锁序不变——函数体仍先 `SELECT ... FROM runs WHERE id = event_run_id FOR UPDATE` 再取 `max(seq)+1`，与其他 6 个来源完全一致。
- 两个 `AFTER INSERT` / `AFTER UPDATE` 触发器，`WHEN` 条件与既有写法同构，只在 `status`、`operation_id`、`result_ref` 三列 `IS DISTINCT FROM` 时触发。**不含 `revision`**：这三个列的变化已覆盖全部状态推进，纳入 `revision` 只会为同一次推进多发一条提示。

**不需要新增 GRANT。** 触发器函数默认 `SECURITY INVOKER`，以调用者即应用角色 `relay_app` 身份执行；`0012` 已授予 `relay_app` 对 `run_events` 的 `SELECT, INSERT`（第 99 行），`0054` 已授予对 `run_tool_calls` 的读写。

**兼容与回滚。** 迁移只放宽 CHECK 并新增触发器，**不回填**：既有 Run 的历史不会补发提示，客户端在流打开时本就读取权威快照（`0012` 首部注释），语义不变。回滚按相反顺序执行：删两个触发器、恢复函数原定义、恢复原 CHECK 约束；期间已写入的 `TOOL_CALL_CHANGED` 行可保留不影响读取，也可随约束一并清理——前端不依赖该 kind 的存在。迁移链顺序在 `0056` 之后。

**已知取舍。** 一次工具轮次内的多个请求各自推进状态会产生多条提示，前端按提示重读幂等投影即可，不做合并。若后续实测提示量成为问题，再评估合并策略——本轮不预造。

## 61. 0058 M06 人工动作的 Gateway 来源（2026-10-05 源码实现）

追加 `0058_m06_user_action_origin.sql`。**只放宽三条 CHECK，不改表结构、不新增表/列/函数/索引、不回填、不改任何已应用迁移。** 契约归[命令契约 §10.57](../api/http-command-contract.md#1057-人工触发的受管-git-只读2026-10-05-源码实现)，能力边界归[工具适配器 §1](../architecture/tool-adapters.md)。

三条改动：

- `ck_logical_operation_origin` 追加一支 `origin = 'USER_ACTION' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NULL`。
- `ck_logical_operation_resource` 完整重述 `0054` 的六支后追加 `capability_key = 'GIT_READ' AND origin = 'USER_ACTION' AND resource_id IS NOT NULL`。`USER_ACTION` **只放行 `GIT_READ`**——`GIT_WRITE`、`CLI_RUN`、`FILE_WRITE` 在该 origin 下一律被拒（真实 PG 行级反例以 `23514` 确认）。
- `ck_invocation_run_identity` 完整重述 `0016` 的三支后追加 `origin = 'USER_ACTION' AND resource_id IS NOT NULL AND ownership_epoch / worker_id / worker_epoch / resource_claim_id / claim_token / claim_epoch 全为 NULL`。人工动作没有 worker 与租约，因此带 `worker_id` 或 claim 的 Invocation 形态被 CHECK 直接拒绝。

三点必须一并记住，否则会误读这张表：

1. **只读动作不建 claim。** `resource_claims` 强制绑定 `task_id`/`run_id`/`worker_*`（`0008`），人工动作没有这些，在不新增可空列的前提下**无法**建 claim。因此资源排他改由 `prepareGatewayAction` 的 prepare 与 admit 两处按 `listOccupiedResources()` 判定在途目录（`RESOURCE_OCCUPIED`）。代价是一次已派发的只读不与随后开始的写动作互斥。
2. **`uq_logical_operation_run_intent` 在 `run_id IS NULL` 时不提供任何唯一性。** PostgreSQL 的 NULL 在唯一索引中互异，因此 `USER_ACTION` 行的 intent 唯一约束形同虚设。幂等锚点只能是**应用生成的确定性 `logical_operations.id`**（sha256(workspace+project+resource+action+path+cached) → uuid 形态），不能依赖 intent 唯一键。
3. **人工主体没有列位。** 迁移只放宽 CHECK、不加列，所以 `USER_ACTION` 词表里没有 actor 列；留痕走 `activity_records`（`MANAGED_GIT_READ_REQUESTED`），在 prepare 的同一事务内写入。

**兼容与回滚。** 三条 CHECK 只能放宽不能替换，既有 `RUN` 与 `USER_IMPORT` 行的判定逐字不变，`uq_logical_operation_origin` / `uq_logical_operation_run_resource` / `fk_invocation_operation_*` 外键均不需改动即可接受新取值。迁移**不回填**：既有行不变。回滚按相反顺序 `DROP CONSTRAINT` 并恢复三条 CHECK 原定义，期间已写入的 `USER_ACTION` 行会被原 CHECK 拒绝，需先清理或导出——客户端不依赖该 origin 的存在。迁移链顺序在 `0057` 之后。

HTTP 面归[命令契约 §10.56](../api/http-command-contract.md)，交互规则归[工作台 §18.8](../frontend/workbench-design.md)。

## 62. 0059/0060 M04 会话模式与人设助手（2026-10-05 源码实现）

依据 [ADR-018](../decisions/ADR-018-assistant-conversations.md) 与[运行架构 §2.6](../architecture/runtime-context.md#26-会话级只读工具轮次)。两条迁移都只新增与只放宽：不改既有表结构、不回填历史行、不改已应用迁移。

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

依据总纲 §0.8.1 与[领域模型 §12.5](../architecture/domain-model.md#125-自然语言状态维护的应用边界)、HTTP 契约 §10.61。两张表**不复制业务事实**：目标、知识、决策、任务、计划、进度、阻塞仍各归原 Owner；这里只保存「原消息 → 确认内容 → 领域命令 → 回执」的关系与整组撤回的补偿轨迹。

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

依据 HTTP 契约 §10.61、[领域模型 §12.5](../architecture/domain-model.md#125-自然语言状态维护的应用边界)、测试计划 NLS-11。两条 `ALTER TABLE ... ADD COLUMN`，不改既有约束、不改 0062/0063 文件。

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

回滚风险：纯追加表、可空列与 CHECK 重建。回退应用后旧代码不读新表与新列；`conversation_mode='LEARNING'` 的会话在旧代码下会被当成未知模式读出，因此回退前应先确认没有学习会话。真实 PG 出口见[功能验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)「学习模式：协议冻结与工作包 A」行。

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

Migration：`0088_model_catalog_snapshot.sql`。两张**全局**表实现 `prompts/free-model-catalog.md` 阶段 B 的目录同步与严格免费判定，进程级事实不隶属 Workspace，不回填、不触碰 `model_calls`/`assist`/`runs` 契约。协议归 HTTP §10.81，物理边界归[运行架构 §8.6](../architecture/runtime-context.md)。

`model_catalog_sync_state` 是单例发布头 + 跨进程同步租约 + 失败退避：`boolean PRIMARY KEY CHECK (singleton)` 强制一行，迁移由 `relay_migrator` 预置 `(true,'openrouter')`，运行期应用角色只 UPDATE 不 INSERT。`directory_digest` 无成功快照时 `NULL`、有则 `~ '^[0-9a-f]{64}$'`（绝不伪造）；`snapshot_seq bigint CHECK (>=0)` 每次成功发布 +1，领取租约记下基线、发布以 `snapshot_seq = base_seq` 做 CAS，推进后旧响应整体丢弃、旧快照不被较旧结果覆盖。`last_attempt_at`/`last_success_at`/`last_failure_at` 语义分离：失败保留旧 `last_success_at` 与旧快照条目，仅记 `last_failure_reason`（词表 `NETWORK/TIMEOUT/AUTH/RATE_LIMIT/PROTOCOL/INCOMPLETE/ENDPOINT_NOT_ALLOWED/NOT_CONFIGURED`）并递增 `consecutive_failures` 供退避。`sync_lease_token`/`sync_lease_expires_at` 同现同缺（`CHECK ((token IS NULL)=(expires_at IS NULL))`）：只有拿到未过期租约的执行体才外呼；租约过期不代表旧进程已停，迟到结果仍由 seq CAS 兜住。`revision bigint CHECK (>=1)`。

`model_catalog_entries` 保存当前快照的逐条判定：`source_model_id text PRIMARY KEY`（`:free` 后缀原样保留、判定不依赖此后缀）、`display_name`、`context_window integer NULL CHECK (>=0)`（未知 `NULL` 不写 0）、`pricing jsonb` 逐字保留来源字符串单价供核对、`capabilities jsonb`（tools/text_input/text_output 三态，`null`=未知不冒充可用）、`is_free boolean` 与非免费原因 `not_free_reason`。核心 CHECK `((is_free AND not_free_reason IS NULL) OR ((NOT is_free) AND not_free_reason IS NOT NULL))` 挡住「仅名称带 free 就入选」「缺价默认零」两类误判；原因词表 `MISSING_PRICE/INVALID_PRICE/NEGATIVE_PRICE/NONZERO_PRICE/UNKNOWN_BILLABLE_ITEM`。条目随成功发布**同事务整体替换**（CAS 更新发布头后 `DELETE` 全表再 `INSERT`），读取永远看到完整一份、不会读到半份；合法空目录替换后无行、可选免费集合清空。

权限：`relay_app` 对两表 `SELECT`；对 `sync_state` 只给定向列 `UPDATE`（`source/directory_digest/snapshot_seq/last_*/consecutive_failures/sync_lease_*/revision`），无 `INSERT/DELETE`；对 `entries` 给 `INSERT/DELETE`、**不给 `UPDATE`**（条目不可被单点改写，只能整体替换）。逻辑 Owner 是 `ModelCatalogRepository`（经 `unit-of-work` 登记），用例开事务绑定同一执行器，仓库不自开事务；网络拉取在事务外。

兼容：纯追加两张全局表，无历史回填、新依赖或外部副作用，Breaking Change：No；应用先迁移，未迁移时目录端点读不到表即如实报错、不影响既有流程。回退可直接保留两表（旧代码不读），删表只丢失目录快照与同步/退避状态、下次重新同步，无自动 down migration。会话模型选择、Run 模型冻结与免费调用硬保护属阶段 C，以 `0089+` 追加，本批不预建无当前调用方的表或列。

## 88. 0089 会话模型选择（2026-10-15 源码实现，阶段 C 首批）

Migration：`0089_session_model_selection.sql`。追加**一张会话作用域表** `session_model_selection` 实现 `prompts/free-model-catalog.md` 阶段 C 的「会话选择持久化」，纯追加、不回填、不改写任何既有迁移或 `model_calls`/`runs`/`assist_sessions` 列。协议归 HTTP §10.82，Owner 归[运行架构 §8.6](../architecture/runtime-context.md)。该表只记录「本会话后续新发起的请求改用哪个模型」这一事实，**从不写回进程默认**（应用默认仍只由 `RELAY_MODEL_*` 决定），也不建 Task/Run、不发外呼、不写调用账本。

`session_id uuid PRIMARY KEY REFERENCES assist_sessions(id)`：每会话至多一条当前选择，随会话生命周期留存（归档不删行，保留可核对的失效来源）。`connection text CHECK IN ('default','openrouter')` 把可选连接钉死为两枚已登记对象——原默认与 OpenRouter 免费目录连接，目录内容不得引入第三主机。`model text CHECK (~ '^.{1,200}$')` 冻结确切模型 ID（续轮/重启按此恢复，不用 `openrouter/free` 随机选型）。`config_fingerprint text CHECK (~ '^[0-9a-f]{64}$')` 是所选连接当时解析出的非密钥配置指纹，连接配置变化后指纹不符即视为失效。`free_only boolean DEFAULT false` 为真才在每次外呼附服务商端零价硬限制；缺省/假保持原默认行为、不受免费目录故障影响。目录依据三列 `catalog_source NULL|'openrouter'` / `catalog_snapshot_seq bigint NULL CHECK (>=0)` / `catalog_model_id text NULL` 记录「免费判定来自哪版快照、哪个目录型号」。

核心 CHECK 挡住半截与矛盾记录：`(free_only=false OR (catalog_source='openrouter' AND catalog_snapshot_seq IS NOT NULL AND catalog_model_id IS NOT NULL))` 保证「仅免费」必带完整目录依据；`(connection='default' OR catalog_source='openrouter')` 保证非默认连接必来自目录；`(catalog_source IS NULL)=(catalog_snapshot_seq IS NULL) AND (catalog_source IS NULL)=(catalog_model_id IS NULL)` 保证依据三列同现同缺。`revision bigint CHECK (>=1) DEFAULT 1` 供 CAS：`selected_by_command_id uuid NOT NULL` 留存最近一次写入该选择的原命令身份。

写入是「CAS + revision 单调递增」：首次以 `INSERT ... ON CONFLICT (session_id) DO NOTHING` 建 `revision=1`，后续以 `UPDATE ... WHERE session_id=? AND revision=期望值` 收窄，冲突返回空由用例判 `INVALID_TRANSITION`，绝不覆盖更新的值。逻辑 Owner 是 `SessionModelSelectionRepository`（经 `unit-of-work` 登记）与用例 `select-session-model.ts`（复用命令回执/幂等基础，`command_type='SelectSessionModel'`）：用例开事务绑定同一执行器，仓库不自开事务；选择命令读目录快照是事务内 DB 读、无任何外呼。`/model` 与选择器共用此 Owner，只影响该会话后续新请求。

权限：`relay_app` 只有 `SELECT, INSERT, UPDATE`，**无 `DELETE`**（会话归档不删选择，保留历史）。

兼容与限制：纯追加一张会话作用域表，无旧数据依赖，Breaking Change：No；未迁移时 `/model` 执行入口与 `GET …/model-selection` 读不到表即如实报错，既有 `/clear`/`/new`/`/undo` 与普通消息发送不受影响。回退可保留该表（旧代码不读），删表只丢失各会话选择、用户需重选，不影响任何业务事实。**本批只接通「默认连接」这一枚当前可执行的聊天端口的选择持久化与 `/model` 写读接线；OpenRouter 聊天连接的实际外呼（携零价硬限制）与「所有生成/连接验证入口读取各自冻结约束、Run 非密钥模型快照列」尚未接线，命中目录免费项的选择本批如实拒绝（`OPENROUTER_CHAT_NOT_WIRED`），以 `0090+` 追加，不预建尚不可兑现的表列。**

## 89. 0091 输入框草稿辅助的调用证据（2026-10-16 源码实现）

Migration：`0091_composer_draft_assist.sql`。协议归 HTTP §10.84，交互归[工作台 §30](../frontend/workbench-design.md#30-输入框自动分点与手动润色)。本迁移**不新建表、不加列、不回填**，只给既有 `model_calls` 的 `kind` 增加一个取值 `'COMPOSER'`，并补一条「无作用域」来源分支。编号说明：`0090`（会话行内控制：改名/置顶/归档/重开）属并行任务，本文档尚未登记它；本批只登记自己引入的 `0091`。

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

**新约束**：`ck_session_model_selection_default_no_catalog_source CHECK (connection <> 'default' OR catalog_source IS NULL)`，已覆盖默认连接不得带来源。**独立复验发现反向组合仍未闭合**：`connection='openrouter'`、`free_only=false`、目录三列全 NULL 时，0089 的 `(connection='default' OR catalog_source='openrouter')` 求值为 NULL，SQL CHECK 视为通过；0094 只限制 default，不会拒绝该组合。因此“合并后语义完备”的原说明不成立。**该反向组合已由同日追加的 [0095](#92-0095-会话模型选择的-openrouter-来源反向约束2026-10-16-源码实现阶段-0-整改) 闭合**；本轮（0094 时点）只新增 [独立验收反例](../../apps/api/test/integration/model-selection-source-acceptance.integration.test.ts)，不修改已应用迁移或产品实现。实际成绩只归统一验收表。

**升级与回滚风险。** 既有库若存在 default 带目录来源的组合，0094 会失败；当前选择 Owner 仅写默认连接且来源为空，但这不能证明所有部署库都不存在旁路或历史冲突行，升级前须实际核对。如确有，应先按业务纠正，不采用 `NOT VALID` 绕过。回滚可 `DROP CONSTRAINT ck_session_model_selection_default_no_catalog_source`，不删除数据。反向 OpenRouter/NULL 组合已由 0095 处理，并含只读预检与既有数据阻止策略。

## 91. 0093 Assist 消息图片附件（2026-10-16 源码实现）

Migration：`0093_assist_message_attachments.sql`。协议归 [HTTP §10.85](../api/http-command-contract.md#1085-assist-消息图片附件2026-10-18-前后端接线)，交互归[工作台 §33](../frontend/workbench-design.md#33-输入框粘贴图片与消息附件)。Breaking Change：**No**（全新表，无既有读取方）。

**定位**：粘贴/拖拽进输入框的图片是**会话输入快照**——不是资料（不进 knowledge/memory/decision 版本体系）、不是 artifact（不受管存储的版本目录与防篡改核对语义）、不是幂等命令（上传端点只暂存）。内容用 `bytea` 而非受管存储文件：附件必须与消息在同一短事务提交（契约 04），`bytea` 没有「写了文件没写库」的中间态，也无孤儿文件；单用户本机、体积由 CHECK 上限约束，DB 体量可控。

**表结构**：`assist_message_attachments`（`id uuid PK`；`workspace_id`/`session_id` 外键隔离；`message_id` 可空外键 `assist_messages(id)`，NULL=已上传未发送；`name` 1–200 字符；`media_type` CHECK 白名单 `image/png|image/jpeg|image/gif|image/webp`；`byte_length` >0 且 ≤2 MiB 且 `= octet_length(content)` 防元数据与实际字节错位；`content_hash bytea`；`content bytea`；`created_at`）。索引：`(session_id, created_at)` 与 `message_id` 部分索引（仅已绑定）。授权：只授 `SELECT/INSERT/UPDATE`，应用角色无 `DELETE`。

**不变性**：媒体类型与内容插入后不可变（没有任何 UPDATE 路径改写）；`message_id` 只允许从 NULL 绑定为非 NULL，由仓库层 `where message_id is null` 守住并发重复绑定。「每消息 ≤4 张、总量 ≤6 MiB」由 `RequestAssistMessage` 用例在事务内裁决，不写触发器；CHECK 只兜单行形状。

**升级与回滚风险。** 全新表，无数据回填。回滚直接整表丢弃——附件是会话输入快照，不是业务事实。与 `0094`（同日并行批次的会话选择来源约束修正）互不触碰：编号避让已在双方迁移注释中互相记录。

## 92. 0095 会话模型选择的 OpenRouter 来源反向约束（2026-10-16 源码实现，阶段 0 整改）

Migration：`0095_session_model_selection_openrouter_provenance.sql`。**只新增一条 CHECK 与一段只读预检**，不加列、不改数据、不新建表、不动授权，Breaking Change：**No**。协议仍归 HTTP §10.82，物理对象与 Owner 仍归本文档 §88。

**修正的独立反例（输入未放宽）**：`connection='openrouter'`、`free_only=false`、`catalog_source`/`catalog_snapshot_seq`/`catalog_model_id` 全 NULL。预期 `23514`，实际插入成功。反例固定在 [`model-selection-source-acceptance.integration.test.ts`](../../apps/api/test/integration/model-selection-source-acceptance.integration.test.ts)，本轮先真实 PG 复现红灯再修。

**根因是两次同一类 NULL 三值语义漏洞，不是一次**：0089 的第二合取式 `(connection='default' OR catalog_source='openrouter')` 在 `catalog_source` 为 NULL 时求值为 NULL（`false OR NULL = NULL`，CHECK 视为通过）；0094 的 `(connection <> 'default' OR catalog_source IS NULL)` 在 `connection='openrouter'` 时左支为 true，同样放行。两条约束**各自**都在该组合上通过，因此必须再补一条。

**新约束**：`ck_session_model_selection_openrouter_requires_catalog CHECK (connection <> 'openrouter' OR (catalog_source = 'openrouter' AND catalog_snapshot_seq IS NOT NULL AND catalog_model_id IS NOT NULL))`。`connection` 非空且只两枚取值（0089），故 `<> 'openrouter'` 恒为确定布尔，不落 NULL 陷阱；非默认分支全部用显式 `IS NOT NULL` 与等值比较表达。

**合并后的完整语义**（至此才算闭合，本轮起不再宣称“完备”而无证据）：`default` → 目录依据三列全空（0094）；`openrouter` → 必带 `catalog_source='openrouter'` + 非空 `snapshot_seq` + 非空 `model_id`（0095）；`free_only=true` → 必带完整三列依据（0089）；三列同现同缺（0089）。推论：`default` 上 `free_only=true` 被 0094/0089 联合拒绝，不存在「默认连接却声称免费」。

**既有数据升级策略：明确阻止，不悄悄纠正。** 迁移在同事务内先做**只读预检**（用 `IS DISTINCT FROM` 显式处理 NULL，统计将违反新约束的既有行数），大于 0 即 `RAISE EXCEPTION ... ERRCODE='23514'` 并给出行数与纠正提示，让整个迁移回滚——不伪造来源、不默认改写 `catalog_source`、不删除用户数据。纠正只能走受控业务动作（重选或显式撤销），由人决定。就本功能历史而言，OpenRouter 选择在聊天连接接通前被 Owner 如实拒绝（`OPENROUTER_CHAT_NOT_WIRED`），从未落过 openrouter 行，预检应为 0；真实 PG 全量迁移已验证 95 项全部通过。

**不误伤合法组合（有真实 PG 断言）**：`default` 无来源可用；`openrouter` 带完整依据、`free_only=false` 可用（来源依据与「是否仅免费」无关）；`openrouter` 带完整依据、`free_only=true` 可用。见 `session-model-selection.integration.test.ts` 的「迁移 0094/0095 不误伤合法组合」用例——该用例用**独立会话**逐组合插入，因为应用角色没有 `DELETE`（0089 只授 SELECT/INSERT/UPDATE），测试同样不能用删除清行。

**升级与回滚风险。** 若库中确有 openrouter 无来源的行，迁移以 23514 失败并阻止，属预期行为；纠正后重跑即可，无部分提交（单事务）。回滚可直接 `DROP CONSTRAINT ck_session_model_selection_openrouter_requires_catalog`，预检 DO 块不残留任何对象。

## 93. 0103 GitHub 只读能力（2026-10-17 源码实现，开发自检）

Migration：`0103_github_read.sql`。协议归 [ADR-023](../decisions/ADR-023-builtin-github-skill.md)，实现边界归[工具适配器 §4.1](../architecture/tool-adapters.md#41-github-只读查询01032026-10-17-开发自检)。Breaking Change：**No**（只新增能力行与放宽 CHECK；不新建表、不改既有列、不新增索引或授权）。

**能力登记。** `gateway_capabilities` 新增 `('GITHUB_READ','REAL','READ')`。动作词表为 `GITHUB_REPO_VIEW` / `GITHUB_PR_LIST` / `GITHUB_PR_VIEW` / `GITHUB_ISSUE_LIST`，逻辑动作不新建表；适配器在受管根内用本地 `git` remote 解析仓库身份，模型参数没有仓库名字段。

**资源约束。** `ck_logical_operation_resource` 按 0054/0060/0087/0092 的教训**逐条重述既有分支再追加**，新增唯一分支：

```sql
capability_key = 'GITHUB_READ'
AND origin IN ('ASSISTANT_READ', 'AGENT_SESSION_READ')
AND resource_id IS NOT NULL
```

`RUN`、`USER_ACTION`、`USER_IMPORT` 与无资源行均被数据库拒绝。`RUN` 不放行是刻意的：Run 工具循环信封的 `connections` 形状是冻结协议，开放它需要执行契约与审批链一起改，属于 GitHub 写动作片的前置。应用角色沿用既有 `gateway_capabilities` 读取授权，无新增 GRANT。

**为什么不复用 `CLI_RUN`。** 该能力是 `WRITE`、`approvalPassthrough=false`、`resumable=false`，失败恒隔离、核对恒 UNKNOWN，且入口必须是在连接上点名的绝对路径文件；把只读查询挂上去会让「查一下 PR」进入写语义与 UNKNOWN 隔离。依据与四条源码事实见 ADR-023 的「实施前核对与偏离」。

**验证。** 真实 PostgreSQL 迁移链应用成功（含 `0103`）；集成测试用 DDL 角色做原始 INSERT 正反例（应用角色对 `logical_operations` 无写授权），断言受管资源绑定与来源限制由数据库而非仅应用层守住；受约束重述影响的既有套件回归 85/85。具体场景归[测试计划 §35](../testing/verification-plan.md#35-内置-github-skill-只读片0103)。

**升级与回滚风险。** 只新增能力行与 CHECK 分支，既有行不受影响；升级无数据回填。回滚必须在没有任何 `GITHUB_READ` 逻辑动作之前：先恢复 0092 版本的约束，再删除 `gateway_capabilities` 行，否则外键或既有账本会阻止删除。账本按既有规则不可改写，因此已产生 GitHub 读取后只做前向修复，不回退迁移。

## 94. 0104 会话未读标记（2026-10-17 源码实现）

Migration：`0104_assist_session_unread.sql`。**只给 `assist_sessions` 增加一列可空 `unread_at timestamptz NULL`**，不新建表、不回填、不改写既有迁移、不动索引与授权；Breaking Change：**No**。协议归 [HTTP §10.87](../api/http-command-contract.md#1087-会话未读标记2026-10-17-源码实现迁移-0104)，交互归[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。编号说明：`0090`（会话行内控制：改名/置顶/归档/重开）至今未在本文档登记，本批只登记自己引入的 `0104`。

**形状：时间戳而不是布尔。** `NULL` = 已读，非空 = 标记未读的确切时刻；取消未读写回 `NULL`，不留「曾经未读」的第三态——那一次改动留在命令回执里。它与 `0090` 的 `pinned_at` 同一性质：**近期工作栏的导航偏好，不是业务事实**——不改变能否发消息、绑定哪个目录、归哪个项目。**不建索引**：未读不参与列表排序（当时的排序键为 `pinned_at desc nulls last, created_at desc, id desc`；2026-10-18 起 `created_at` 那一档换成 `coalesce(last_message_at, created_at)`，见 §100），也不作筛选条件，只按主键读写单行；与 0090 对 `pinned_at` 的判断一致。

**Owner 与写入路径。** 唯一写入方是 `application/assist-session-controls.ts` 的 `setAssistSessionUnread`：`requireEditableSession`（归属、可见性与 ACTIVE 闸门）→ 仓库 `applySessionControl` 在同一事务内以行锁 + `where revision = expected_revision` 收窄写入并在成功时 `revision + 1`。它与改名／置顶／归档共用 `runIdempotentCommand` 的命令回执；归档会话在进入写入前即被拒，不会留下半截回执。**没有第二套并发机制**：上游 ZCode 用 `unread_at` + `last_unread_at` 两列，是为了让「点开自动清除」这个后台写入与人工标记各自 CAS；本项目当前只有人工 toggle 一个写入方，同一行的并发已经由 `revision` 裁决，提前加单调版本列没有当前调用方。

**权限。** `0015` 已对 `assist_sessions` 授表级 `SELECT, INSERT, UPDATE`，新列自动落在既有授权内，本迁移**不追加 GRANT**；应用角色仍无 `DELETE`。

**上游对照（用户要求的会话存储核查）。** Codex 把 rollout 以 JSONL 落在 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`（另有可重建的 SQLite 索引），其线程表没有未读概念；DeepSeek Harness 的 `completionUnread` 是进程内 Set，重启即丢；ZCode 持久化 `unread_at`（NULL=已读）并用 `last_unread_at` 单调版本做清除 CAS；OpenCode 用 SQLite 的 `time_updated`／`time_archived` 表达侧栏状态。本项目采用数据库行 + 命令回执作为唯一事实源，采纳 ZCode 的「NULL=已读」读法，不采纳其第二枚版本列（理由见上）与 Codex 的文件投影（会形成第二套会话事实；会话存储仍由数据库承担）。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（已读），旧响应与旧客户端不受影响。回退可直接保留该列（旧代码不读）；删除只丢失未读标记，不丢失会话、消息、命令回执或目录绑定。

**验证（如实）。** 真实 PostgreSQL 的 `assist-session-controls.integration.test.ts` **14/14** 经 `run-integration.ps1` 整体 PASSED，覆盖 `0104` 的列形状（可空、`timestamptz`、无默认）、标记/取消的修订推进、重放与 CAS、归档拒绝、跨 Workspace 不可见、列表逐字回显与排序不变；工作台定向 **10/10**（jsdom）与 **7/7**（真实 Chromium 伪造 API）。真实 Windows 窗口与多 DPI 未复验；桌面实机需重新暂存 API。

## 95. 0106 浏览器后端健康投影（2026-10-17 源码实现）

Migration：`0106_browser_backend_state.sql`。新建单行表 `browser_backend_state`（`id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)`），承载浏览器后端最近一次被实测的健康结论；Breaking Change：**No**。协议归 [HTTP §10.88](../api/http-command-contract.md#1088-浏览器后端状态2026-10-17-源码实现迁移-0106)，设计与集成点归[浏览器自动化 V1](../architecture/browser-automation-v1.md)。

**为什么是一张单行表。** 浏览器后端由 **Worker 进程**懒启动并持有，而读它的是 API 进程与桌面壳；三个进程之间只共享 PostgreSQL，因此「浏览器后端现在是什么状态」必须是库里的一行展示事实，而不是任何进程的内存单例——与 `0096` 的 `computer_control_state` 同一理由。**与 0096 的差异**：那是「是否有活跃操控会话」的单行（多任务只有一个前台会话），这一行是「后端本身健康吗」——后端是安装级资源，一个安装只有一份，单行正是它的真实基数。

**形状。** `status` CHECK 五态（`READY`/`CHROME_MISSING`/`BACKEND_MISSING`/`INCOMPATIBLE`/`DISCONNECTED`）；`backend_version`/`chrome_version`/`detail`/`remediation` 为 `text NOT NULL DEFAULT ''`（空串=无值，读取方投影为 `null`）；`tool_count integer CHECK (tool_count >= 0)`；`updated_at timestamptz NOT NULL DEFAULT now()`。没有行的语义是「从未使用过浏览器能力」（读取方投影为 `NOT_STARTED`），不预插一行占位。

**Owner 与写方。** 唯一写入方是 Worker 派发路径 `browserExecute`：每次动作前 `ensureStarted` 后 upsert。**上报失败不阻断真实执行**（try/catch 包住，与 0096 的操控状态上报同一纪律）。不做惰性过期——READY 的后端在 Worker 存活期间一直活着，按 `updated_at` 猜过期只会制造假阴性；进程退出时 Worker 写 `DISCONNECTED`。

**权限。** `GRANT SELECT, INSERT, UPDATE ON browser_backend_state TO relay_app`。**没有 DELETE**：后端状态永远不该被「删掉」，只应被改写。历史发现的 `0096` 未授 `relay_app` 权限问题由迁移 `0110` 修复，见下节；不修改已应用迁移的内容。

**兼容与回滚。** 纯新增表，不改既有列；回退可直接保留（旧代码不读）。`0105`/`0106` 都不改写历史迁移。

**验证（如实）。** 真实 PostgreSQL：`browser-read.integration.test.ts` **6/6**（`run-integration.ps1 -TestFile browser-read` 整体 PASSED，临时集群已删除）——覆盖投影的写入/读取/失败态与跨进程可见（含真实 API 进程经 HTTP 读同一行）；单测 `projectBrowserHealth` 锁定内存结论 → DTO 的形状。安装态未验。

## 96. 0107 浏览器任务状态（2026-10-17 源码实现）

Migration：`0107_browser_sessions.sql`。新建 `browser_sessions`（`owner_kind` + `owner_id` 联合主键），承载"现在有哪个任务在操作哪个页面"；Breaking Change：**No**。协议归 [HTTP §10.89](../api/http-command-contract.md#1089-浏览器任务列表与停止2026-10-17-源码实现迁移-0107)，设计归[浏览器自动化 V1](../architecture/browser-automation-v1.md)。

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

## 100. 0111 会话活动排序键（2026-10-18 源码实现）

Migration：`0111_assist_session_last_message.sql`。**只给 `assist_sessions` 增加一列可空 `last_message_at timestamptz NULL`**，不新建表、不回填、不改写既有迁移、不动索引与授权；Breaking Change：**No**。协议归 [HTTP §10.91](../api/http-command-contract.md#1091-会话列表的活动排序键2026-10-18-源码实现迁移-0111)，交互归[工作台 §28.1](../frontend/workbench-design.md#281-左栏recentworkrail)。

**语义：这段讨论最近一次真正说过话是什么时候。** `NULL` = 还没有任何消息；有值 = 最后一条消息落库或生成结算的时刻。不分发送方——用户说完与 AI 说完都算一次活动，因此失败或取消的那一轮同样上浮。它和 0090 的 `pinned_at`、0104 的 `unread_at` 同一性质：**导航排序键，不是业务事实**，不参与能否发消息、目录绑定、项目归属或任何准入判定。

**为什么不用 `max(assist_messages.updated_at)` 现算，也不复用 `updated_at`。** 列表每次读都要扫消息聚合，且生成中的逐帧预览会把它顶成「一直在动」；`updated_at` 同时是改名／置顶／归档那组命令的更新时间，用它排序会让「只是重命名过一次」的会话跳到活动序最前。上游正好有两派做法：ZCode 在 `saveMessage`/`savePart` 统一调 `touchSession` 并以 `time_updated = max(time_updated, ?)` 保持单调（本列采纳这一口径）；OpenCode 只在用户消息准入时 `Session.touch`，并用自引用 SQL 压制 `$onUpdate`，消息与 part 落库都不 touch 父会话；Codex 分两列——任何追加都推进的 `updated_at` 与只在用户新一轮开口推进的 `recency_at`；DeepSeek Harness 用 `max(header.createdAt, lastPromptAt)` 在内存算。本项目要的是「AI 说完这条也上浮」，取 Codex 的 `updated_at` 那一派而不是 `recency_at` 那一派。

**Owner 与写入路径（两个，都在 `assist-repository.ts`）。** ① `insertMessage` 尾部调 `touchLastMessage`：用户消息与发送时预插的 PENDING ASSISTANT 行都推进同一键，写入取 `greatest(last_message_at, now())`，并发结算不按提交顺序取时间时排序键只前进不回退。② `settleGeneration` 只在 CAS 命中（返回受影响行）后 touch 该行所属会话：迟到的旧 Worker 结算既不收敛消息也不推进排序键。ASSISTANT 行在发送时刻预插，其 `created_at` 早于真正说完的时间，所以结算这一 touch 是「AI 说完才上浮」的依据，不能省。**改名、置顶、未读、归档、重开、绑定项目与绑定目录都不写本列**；生成中的预览表 `assist_message_previews` 也不写——那是会被删除的临时前缀，每条增量都 touch 会让左栏在流式期间持续跳位。租约过期的 `failExpiredLeases` 与 `setCancelRequested` 同样不额外 touch：消息落库时该键已不早于这些事件。

**推进的是排序键，不是并发基线。** 本列的写入**不**推进 `revision`，也**不**推进 `updated_at`。会话行的修订号是上面那组人工控制命令的 CAS 基线；若每条消息都推进修订，在途生成会把置顶/改名打成 409，界面只能反复重读。测试把这条锁住：消息落库后 `revision` 与 `updated_at` 逐字不变。

**排序读法。** `listSessions` 用 `order by pinned_at desc nulls last, coalesce(last_message_at, created_at) desc, id desc`——置顶仍是第一排序键，活动序只在未置顶的组内生效；`coalesce` 让还没说话的会话按创建时间留在原位，不因本列为空而沉底或消失。左栏客户端在没有人手动排过序时按同一口径重排，两边不各猜一套。

**权限与索引。** 与其它批次一致：`0015` 已对 `assist_sessions` 授表级 `SELECT/INSERT/UPDATE`（无 `DELETE`），新列自动落在既有授权内，**不追加 GRANT**；**不新建索引**——单用户本机库会话量级小，列表读仍走 `ix_assist_sessions_scope` 的既有范围过滤，与 0090/0104 对 `pinned_at`／`unread_at` 的判断相同。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（无消息，回落 `created_at`），既有响应只多一个可空只读字段，旧客户端忽略即可。回退可直接保留该列（旧代码不读、旧排序键照旧用 `created_at`）；删除该列只丢失活动排序偏好，不丢失任何会话、消息、命令回执或选择事实。

**验证（如实，分层）。** 见[统一验收表](../testing/overall-acceptance-2026-09-28.md#当前功能验收表)对应行：真实 PostgreSQL 定向套件、工作台 jsdom 与两端 `tsc` 分别报告，一种证据不代替另一种。

## 101. 0112 本地目录完全访问档位（2026-10-18 源码实现）

Migration：`0112_local_directory_full_access.sql`。**只放宽 `local_directory_access` 的档位 CHECK**：`ck_local_directory_access_tier` 的取值集合由 `('READ_ONLY','ASK','AUTO')` 扩为 `('READ_ONLY','ASK','AUTO','FULL')`。不新增表、不加列、不回填、不改写既有迁移、不动索引与授权（`0109` 已给 `relay_app` 表级 `SELECT/INSERT/UPDATE`）。**Breaking Change: No**——加值是兼容新增，既有行取值不变，旧界面把未知取值读成「待核对」而不是替用户猜一档。

`FULL` 仍然是[§98](#98-0109-本地目录访问档位元数据2026-10-18-源码实现)意义上的管理元数据，不是第二套授权表：网关判定词表只有 `AUTO/ASK/DENY` 三值，所以选 `FULL` 落的是与 `AUTO` 完全相同的策略行，两者的差别只存在这一列里。因此实际准入必须回读本列（`gateway-actions.ts` 的 prepare 与 dispatch 各读一次同一个函数），不能只信策略投影，也不能由界面把档位传进来。档位投影的反向推导不产生 `FULL`：`READ_ONLY/ASK/AUTO` 仍由策略行回推，`FULL` 只能来自用户显式发出的这条目录命令。

**兼容与回滚。** 迁移不回撤。回退应用代码时库里的 `FULL` 仍受约束允许，旧代码读它当作一个非只读档位，准入退回「AUTO 目录 + 删除逐次确认」，也就是放宽前的行为，不会静默放大权限；旧代码写档位时不认识这个取值，只会拒绝新的一次设置。若以后要收掉这个取值，必须先把所有 `FULL` 行改写回 `AUTO` 再收窄约束——本迁移不提供自动降级，也不删除已发生的档位事实。

## 102. 0113 会话分叉血缘（2026-10-18 源码实现）

Migration：`0113_assist_session_fork.sql`。`assist_sessions` 追加一列可空自引用 `forked_from_session_id uuid REFERENCES assist_sessions (id)`；不回填、不改写任何既有迁移、不动消息/提案/附件/选择表的形状。

**这一列是来源，不是状态。** 分叉之后父子两条会话各自独立生长，父会话不因为被分叉而变化——标题、`revision`、`updated_at`、`last_message_at` 与 `status` 都不动，也不维护反向的子会话列表。唯一的写方是 `forkAssistSession`（`assist-session-controls.ts`）里的 `insertForkedSession`：按源行 `insert … select` 整行搬运会话身份列，`forked_from_session_id` 只在插入时写一次；改名、置顶、未读、归档、重开与消息写入都不读写它。界面上它只用于解释分叉标题末尾那个「（n）」从哪来，不参与任何准入判定。

**形状沿用 0006 的 `verification_sessions.parent_session_id`**：同表自引用、可空、无 CHECK。不加 `forked_from_session_id <> id`：子行 ID 由命令新生成，永不等于父行 ID；父子同 Workspace 由应用 Owner 的行锁读取保证（跨作用域的父会话按 `RESOURCE_NOT_FOUND` 拒掉）。不建索引：一张父会话可以有多个子会话（1:N），当前只有「按子行主键读它自己的父 ID」这一种读法，没有按父反查的读方；0006 的部分索引是配 UNIQUE「一个父只能派生一次」用的，本表既不反查也不唯一，照抄只会多一份写放大。若以后出现「列出某条会话的全部分叉」读方，再按 `(forked_from_session_id)` 增列索引也不迟。

**权限。** `0015` 已对 `assist_sessions` 授表级 `SELECT/INSERT/UPDATE`（无 `DELETE`），新列自动落在既有授权内，不追加 GRANT。

**与消息复制的关系。** 本列只记血缘；子会话里的消息与附件由同一命令用新 ID 复制（`assist_messages` 从 `seq=1` 重排、附件绑定到子会话的新消息行）。刻意不复制的是提案与过程/结局列（请求号、usage、worker、错误码、`model_attempt_state`）；`model_selection_snapshot` 一并不复制，因为 0098 要求它与尝试状态成对非空，而复制后的历史不会再进生成路径。协议见 [HTTP §10.93](../api/http-command-contract.md#1093-会话分叉2026-10-18-源码实现迁移-0113)。

**兼容与回滚。** 纯追加一列，旧行取 `NULL`（不是任何会话的分叉），既有响应只多一个可空只读字段，旧客户端忽略即可，**Breaking Change: No**。回退可直接保留该列（旧代码不读）；删除该列只丢失「这条从哪来」的来源说明，不丢失任何会话、消息、附件、回执或选择事实。

**验证（如实，分层）。** 真实 PostgreSQL：`assist-session-controls.integration.test.ts` **22/22**，其中 0113 用例从 `information_schema.columns` 核对可空与类型、从 `pg_constraint` 核对自引用外键，并验证列表/单会话投影逐字返回来源。真实 Windows 窗口未验；迁移台账用例另有并行流的登记缺口（0114/0115 未进 `ALL_MIGRATIONS`），不是本迁移引入。

## 103. 0116 会话物理删除授权（2026-10-18 源码实现）

会话物理删除（[ADR-027](../decisions/ADR-027-session-physical-delete.md)、[HTTP §10.94](../api/http-command-contract.md#1094-会话物理删除2026-10-18-源码实现迁移-0116)）只需要应用角色对**会话自有账本**的 `DELETE`。0015 授的是 `SELECT, INSERT, UPDATE`，0050/0060/0062/0089/0093/0097/0100 同样没有 DELETE，因此 0116 是一次纯授权迁移：不改表结构、不加 `ON DELETE CASCADE`、不回填任何数据。

**授予 DELETE 的十五张表**：`assist_sessions`、`assist_messages`、`assist_proposals`、`assist_message_attachments`、`session_tool_calls`、`session_model_selection`、`artifact_impact_checks`、`artifact_impact_candidates`、`artifact_impact_candidate_groups`、`artifact_impact_candidate_group_items`、`conversation_state_requests`、`conversation_state_changes`、`model_calls`、`model_provider_cooldowns`、`conversation_diff_baselines`。逐表对应删除路径上的一次显式 DELETE；`assist_message_previews`（0028）与 `learning_*`（0072）已有 DELETE，不重复授予。

**刻意不授予的表就是阻断面**：`task_acceptance_trial_observations`、`hypothesis_versions`、`work_segments`、`project_blueprint_proposals`、`conversation_execution_requests`、`learning_evidence`、`learning_rounds`、`learning_session_controls`，以及 Task/Artifact/Project 主表。删除命令在发现这些引用时整条拒绝（`409 SESSION_DELETE_BLOCKED`），**不能**借 DELETE 授权把它们一并抹掉。`activity_records` 仍只有 `SELECT, INSERT`：删除命令写一条 `ASSIST_SESSION_DELETED`，但不允许改写或抹去审计。

**为什么不用级联。** 指向 `assist_sessions` 的 12 条外键全部是默认 `NO ACTION`；保留这个形状，删除顺序由仓储层逐表写出。顺序写错会当场撞外键失败并整条回滚，而不是让数据库按自己的规则扩大删除范围。`conversation_diff_baselines.session_id` 没有外键（0097），不在数据库的保护范围内，必须显式删。

**权限边界与回滚。** 授权只覆盖会话自有账本，不外溢到 `tasks` 等其它对象（`has_table_privilege` 在集成用例里逐项核对）。回滚只需撤销这批 GRANT，会话行与消息不会被带回；已删除的数据不在回滚范围内。

**证据（如实分层）。** 真实临时 PostgreSQL 18.6：`assist-session-delete.integration.test.ts` **9/9**，含账本删净与无悬空基线、删除后回执重放、阻断项（分叉、学习记录）、在途与陈旧基线栅栏、跨 Workspace 不可见、0116 授权边界。未在用户库验证 0116 是否已应用，也未做真实 Windows 安装态复核。

## 103. 0115 周期定时启动任务（2026-10-18 源码实现）

Migration：`0115_scheduled_tasks.sql`，新增 `scheduled_tasks` 与 `scheduled_task_occurrences` 两张表。取舍与代价见 [ADR-026](../decisions/ADR-026-scheduled-task-autostart.md)，协议见 [HTTP §10.94](../api/http-command-contract.md#1094-周期定时启动任务2026-10-18-源码实现迁移-0115)。

**计划表只存配置与授权，不存执行状态。** `scheduled_tasks` 有模板 `template jsonb`（`task_title/objective/criteria/expected_outputs/mode`，与 `CreateTask` 入参同形）、重复规则 `repeat_rule jsonb`（`{kind:'DAILY',interval_days:1..30}` 或 `{kind:'WEEKLY',weekdays:[1..7]}`，CHECK 只放这两个 kind）、`timezone`、`local_time`（`HH:MM` 正则 CHECK）、`first_run_at`、`next_due_at`、`status`（`ENABLED/PAUSED/DISABLED/EXPIRED`）、`schedule_generation`、`revision`、`max_runs`（1–100）、`runs_reserved`、`runs_started`、`authorization_expires_at`、`execution_input jsonb`、`history jsonb`。Task 状态、Run 生命周期与验收都不在这里——它们仍归原 Owner。

**两个计数列分工不同，不能合并。** `runs_reserved` 是「已产生的时段数」，只用于序号与顺序；`runs_started` 才是预算口径，因为用户理解的 `max_runs` 是「最多真正启动多少次」。跳过的时段（上一轮未验收）与阻塞的时段都推进 `runs_reserved`，但只有真正 Delegate 成功才推进 `runs_started`。约束只有 `runs_started <= runs_reserved`，刻意不加 `runs_reserved <= max_runs`：否则跳过次数会把额度吃光。

**发生表记录「这一次时段」，不复制业务事实。** `scheduled_task_occurrences` 有 `schedule_generation`、`sequence`、`due_at`、`timezone`、`missed`、`status`（`DISPATCHING/DISPATCHED/BLOCKED/SKIPPED/RESOLVED`）、`task_id`、`run_id`、三个预生成命令身份、`frozen_execution jsonb`、`reason`、`revision`。`UNIQUE (scheduled_task_id, schedule_generation, sequence)` 是第二道防线；三个命令列各自 `UNIQUE`，保证同一时段不会建出两个 Task。

**`DISPATCHING` 是租约，不是终态。** 插入即置该状态，调度器用行锁 + `UPDATE … RETURNING` 抢租约后才执行三步命令；进程在分发中途崩溃时该行保持 `DISPATCHING`，下一次扫描从「待分发」重新取它，靠预生成命令身份回执重放，不会重复建 Task。人工「补跑」也是把 `BLOCKED` 改回 `DISPATCHING`，不新增行、不消耗额度。

**索引。** `scheduled_tasks(next_due_at) WHERE status='ENABLED'` 服务到期扫描；`(workspace_id, project_id, created_at)` 服务列表；`scheduled_task_occurrences(scheduled_task_id, created_at DESC, id DESC)` 服务详情页最近 20 条；`(workspace_id, created_at, id) WHERE status='BLOCKED'` 服务待处理投影。不建 `(due_at)` 索引：发生表按计划反查，没有按时刻全局扫描的读方。

**权限。** 末尾 `GRANT SELECT, INSERT, UPDATE ON scheduled_tasks, scheduled_task_occurrences TO relay_app`，无 `DELETE`——两张表都不删除，取消与作废靠状态列表达。

**时区与 DST。** 库只存 `local_time` 墙钟字符串与 `timezone` 名称，绝对时刻 `next_due_at`/`due_at` 由应用用 `zoned-time.ts` 现算。刻意不存固定偏移：跨夏令时的「每天 09:00」必须仍是 09:00。春跳不存在的时刻顺延 +1 小时，秋回重复的时刻取较早一次。

**兼容与回滚。** 纯新增两张表，不改任何既有表或列，**Breaking Change: No**。回退应用代码时旧代码不读这两张表，定时任务停止调度但已产生的 Task/Run 事实不受影响；迁移不回撤。删除这两张表只丢失「哪些时段被排定过」的记录，不删除已经建出的 Task、Run、回执或审计。

**验证（如实分层）。** 单元：`zoned-time.test.ts` **10/10**（上海/纽约春跳秋回/伦敦/Kolkata/Chatham/Kiritimati、跨 DST 的每日 09:00、关机三天只推进一次、严格晚于 now）、`scheduled-tasks.test.ts` **4/4**（规则/上限/到期/时刻/日期/时区/文本口径）。真实 PostgreSQL：`scheduled-tasks.integration.test.ts` 见[测试计划 §37](../testing/verification-plan.md#37-周期定时启动任务验收规格2026-10-18)与统一验收表。真实 Windows 窗口与安装态未验。

## 104. 0117 Workspace 默认目录（2026-10-19）

Migration：`0117_workspace_default_directory.sql`。原方案编号 `0111` 已被活动排序键占用，使用当前空闲号；不修改任何已应用迁移。

`workspace_default_directories` 每 Workspace 一行，`workspace_id` 主键引用 workspaces，`resource_id` 可空引用 managed_resources，`revision bigint >= 0`，以及 `created_at / updated_at`。WorkspaceRepository 是存储入口，应用命令负责跨 Workspace、资源状态与路径核对；不复制目录或权限事实。`resource_id=NULL` 表示清除，保留修订以防旧请求覆盖清除后的选择。缺行的外部修订为 0，首次写入为 1；更新持有 Workspace authority 排他锁，配置 revision 为独立 CAS，不推进 Workspace 业务修订。只授 relay_app SELECT/INSERT/UPDATE，不授 DELETE。

`assist_sessions.working_directory_source text NULL` 与资源在创建/显式绑定事务内一起写入，取值 USER_PICKED 或 WORKSPACE_DEFAULT；CHECK 禁止无资源时带来源。历史绑定不回填，来源 NULL 表示未知；分叉复制源来源。已有会话不随默认设置变化，ASSISTANT/LEARNING 与显式 Project/Task 不继承。配置及继承按 authority→资源登记锁→Project 归档栅栏→资源锁核对，读取工具本身不查默认配置。

**Breaking Change: No**。纯新增表与可空列，兼容旧数据。回退应用后新表和列保留；直接删除列会丢失来源与配置追溯，不提供自动 down migration。没有回填或用户数据迁移，本轮仅在一次性临时库应用，用户库迁移和安装包升级另验。API 协议见 [HTTP §10.96](../api/http-command-contract.md#1096-workspace-默认工作目录2026-10-19-后端实现)。

## 105. 0118–0119 长短期记忆（2026-10-19）

Migration：`0118_long_term_memory.sql`、`0119_short_term_memory.sql`、`0120_memory_usage_sources.sql`、`0123_memory_usage_scope.sql`；**Breaking Change: No**，新增表与使用足迹列，无历史正文回填，不更改原消息或 Memory 版本。0121/0122 归并行模型能力/插话功能，不属于记忆模块。Information 拥有长期事实与配置，Assist 拥有短期工作窗口。

- `workspace_memory_settings`：每 Workspace 一行，recall_enabled/automatic_compaction 默认 true，revision 用 CAS；应用仅 SELECT/INSERT/UPDATE。
- `memory_message_sources`：主键 memory_id/memory_version，引用确切 Memory 版本和原会话/消息，冻结 SHA256；仅 SELECT/INSERT。停用不删除来源，跨对象引用阻止源会话物理删除。
- `assist_memory_state`：每会话当前检查点指针、revision 与 cleared_through_seq；成功 CAS 后才更换，不改原聊天。
- `assist_memory_requests`：手动/自动请求、原文覆盖 IDs/hash、冻结模型、会话/权限/上下文/设置/窗口修订、PENDING/RUNNING/COMPLETED/FAILED/CANCELLED、worker/epoch/lease/cancel 与结果引用；每会话至多一条活动请求的部分唯一索引。租约丢失收敛失败，不自动重复网络调用。
- `assist_memory_checkpoints`：不可变摘要与确切覆盖边界/来源足迹、model_call_id 和作用域修订；提交新行再 CAS 指针，原行保留。
- `assist_memory_uses`：每条真实生成消息采用的检查点、窗口/权限/上下文修订；0120 增加直接及传递来源 sources、has_tool_context，0123 增加 project/task/working_resource 的 session_scope 快照，支持多轮派生答复和换目录后的隔离。旧使用行 scope=NULL 表示无法核对，不能给旧工具文本补当前授权。分叉仅继承来源/工具作用域足迹，不继承父 checkpoint 所有权和计量；无使用账本的旧工具答复不复制正文，改用明确不可用文本占位，父原文仍保留；不放宽原 COMPLETED 消息非空正文约束。

短期表仅请求/state 可更新，checkpoint/uses 不可更新；四表授 DELETE 仅供既有会话物理删除用例按 uses→state→requests→checkpoints 清理，再删原 model_calls/消息。活动整理、长期跨对象引用仍走原删除栅栏。摘要调用复用 ASSIST model_calls，锚点为真实已覆盖消息，独立请求保存实际 call_id，原回复 usage 不被覆盖。

兼容回退：旧应用不读取新表，但回退版本的旧物理删除代码不了解新 FK，不应执行带新记忆记录的删除。回退不删表、不抹新事实；直接 DROP 会丢失来源/窗口/调用关联并存在 FK 风险，无自动 down migration。用户库升级、真实安装态另验。协议归 [HTTP §10.99](../api/http-command-contract.md#1099-长短期记忆接口2026-10-19)。

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

**兼容与回滚**：默认 false，旧行取 false；旧应用不读该列，行为退回「只排队不插话」。回退可保留列；删除列只丢失未消费的插话意图，不丢失消息、回执或状态事实。**Breaking Change: No。** 协议归 [HTTP §10.102](../api/http-command-contract.md#10102-排队消息的插话2026-10-19-源码实现)，上下文位置归[运行时上下文 §2.9](../architecture/runtime-context.md#29-排队消息的插话进入上下文的方式2026-10-19已实施)。

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
- **写入 Owner 不变**：仍只有 `insertMessage` 与 `settleGeneration`（0111 口径，`greatest(last_message_at, now())` 单调推进），本迁移不新增写入方。回填完成后 `NULL ⇔ 这条会话没有任何消息` 才真正成立——这是左栏「未开始」标记唯一依赖的前提。
- **回滚**：不提供反向语句。把已填行改回 NULL 只会重新引入本缺陷；旧代码读到更精确的活动时刻只影响排序，属改善。

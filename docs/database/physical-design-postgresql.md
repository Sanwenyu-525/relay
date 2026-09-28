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
- 内部 `scanRecoveryCandidates` 只报告租约到期或有持久 fence 记录的未决动作，当前没有生产调度器自动调用它。内部 `recoverStoppedWorker` 要求调用方提供旧 Worker 已停止的依据；用例提升 Run epoch，并把旧 Worker ID、该依据、新 epoch 追加到 `activity_records`，再次重启可用该记录、Attempt worker ID 与当前 epoch 复核。生产进程管理器自动确认退出尚未实现。只有同一目标确实不存在、当前无新 claim 且有持久 fence 证据，才将原动作重置为 PREPARED，下一次仍使用原 `operation_id`。`UNKNOWN` 或成功日志与目标文件不符不能仅凭租约重发；租约到期本身不等于进程已停。
- **兼容与回滚**：旧 HUMAN Task 的状态与既有 Run 行满足新 CHECK，新增 Worker 列有默认/NULL，旧数据可升级；旧应用版本不理解新增控制状态与 WAITING，部署需与 API 同步升级。迁移只追加/替换约束，已应用文件不能改写；没有 down migration，回退依赖备份及相容版本。P08 只覆盖同机受管 Fake 文件动作，尚无跨 Task 工作目录资源 claim、实际工具准入、通用操作核对报告/孤儿清理和断电持久性证明；这些是后续独立边界。

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

普通无 Skill 的 `DISCUSS` 每次流式片段按 UTF-8 完整字符形成有界累计前缀，首片段立即写入，生成期间后续写入至少间隔 100 ms，完整输出返回前可再刷新一次。写入短事务先锁原消息并要求当前 Worker 身份、`RUNNING`、未取消，CAS 不再成立时不能继续发布。模型网络调用不占用这段事务；最终完整输出通过原校验和 Assist Owner 结算，结算同事务删除暂存行。取消请求立刻在读端遮蔽，终态和租约过期清理行；读取短事务以 WorkspaceAuthority SHARE 及消息 SHARE 锁建立与来源撤销、取消、结算的先后关系，并重查目标和有界历史来源。跨进程 API 只读该暂存，不将其当历史全文、审计、凭据或接受证据；重新连接用 revision 识别累计前缀。原消息正文在来源失权时也按当前权限遮蔽，不能借完成行绕过临时草稿的读时规则。

## 42. 0029 Run DRAFT 生成中临时草稿（2026-09-26 M04 开发自检）

追加 [0029_m04_run_draft_live_preview.sql](../../apps/api/migrations/0029_m04_run_draft_live_preview.sql)：`run_draft_previews` 每个 Run 最多一行，主键绑定原 `runs`，外键绑定 `step_attempts` 与唯一 `model_calls.call_id`；保存确切 Attempt claim、Run Worker epoch/ID、可选 dispatch invocation epoch、递增 revision、截断标志和最多 16 KiB UTF-8 的前缀。旧 Run 不回填，新表不改 Run/Artifact/Verification 事实。无自动 down migration；删除新表会丢失在途显示文本，不能影响已结算候选或后续恢复。

模型端口收到 DRAFT Markdown 片段后，首片段立即提交，生成期间后续写入至少间隔 100 ms，完整返回前再刷新一次。每次写入在单独短事务核对 Task→Run→当前 DRAFT Step/Attempt、Worker/租约、dispatch invocation、原 STARTED model call 与无待处理控制；网络等待不占数据库事务。Run claim/release/fence 或 Attempt 结算在原事务删除旧草稿。读取以 WorkspaceAuthority SHARE、Task/Run SHARE 和原模型调用身份核对当前 Manifest、输入摘要及 FILE_READ/WEB_FETCH 原读证据，按当前权限重查来源、Connection、Policy 与 Resource；不可见只返回空草稿，不复制受限来源 ID。旧 Worker、旧 Attempt、失败/取消或租约到期不能将该行当作成功结果，恢复仍依原 Step/Attempt/operation 身份。真实 PG/HTTP 开发自检验证跨进程首片段、旧 Worker 与控制/来源栅栏；独立、真实 Provider 和桌面验收后置。

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

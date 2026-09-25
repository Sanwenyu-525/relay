# Personal Workflow OS：PostgreSQL 物理数据库设计

日期：2026-09-19。状态：Proposed。用户已确认允许本机 PostgreSQL；完整技术组合、DDL 与协议仍需工程验证。上游：[逻辑模型](logical-model.md)、[技术选型](../architecture/technology-selection.md)。

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

资源登记/重命名在 authority 写锁下检查规范身份、父子路径和别名。准入始终锁 managed_resources 根行，即使还没有 resource_claim，避免“查不到 claim 所以无锁可拿”。需要新建策略作用域时也在 authority 写锁下进行，避免查已存在策略却漏掉并发新增拒绝规则。

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

以下是建议批次，不是已存在的 migration 文件：

| 批次 | 范围 | 出口 |
|---|---|---|
| V001 | Workspace、Project、Goal、Task/验收、Artifact、人工接受、完成凭据、State 类型引用、回执/审计 | 人工创建→不可变产物→完成→重开，循环 FK 与周期唯一约束可验证 |
| V002 | Run/契约、Step/Attempt、Verification、Review 与批准类型绑定 | Fake Worker 完整闭环、重复决定和过期证据被拒绝 |
| V003 | Authority、Worker/Resource claim、控制请求、Gateway 与核对记录 | 控制/完成、撤销/准入竞争与崩溃点测试；开放真实外部执行前必须完成 |
| 后续 | Context 证据、信息模块与 Workbench 选择的实际增量 | 按真实调用方新增，不一次性创建占位平台 |

每个批次要生成完整可运行 DDL、权限授权与测试 fixture；SQL 片段不能直接充当 migration 脚本，迁移工具随 P00 选型验证。V001 只允许 HUMAN 执行，尚不建立指向 Run/Verification 的字段与 FK；V002 在建好目标表后添加这些字段、约束并扩展允许状态。不能让 V001 引用尚未创建的表。V002 的 Fake Worker 不执行真实外部副作用；若更早需要权限/动作能力，相应 V003 约束必须前移。

测试最少覆盖：空值 CHECK、跨 Workspace/Task 引用、延迟 FK 提交失败、并发 Delegate、重复周期完成、暂停保留占有、审批跨动作重放、资源隔离不自动释放、撤销/准入两个提交次序、过期 Worker、重开后旧命令重放。映射仍沿用 A01–D11，具体数据库测试在代码建立后实现。

## 9. 完整模块设计的增量落点

Information/Today/Assist 在后续 migration 落地，字段与唯一性见对应主设计：Knowledge/Memory/Decision/Rule 根与版本；task.goal_alignment_mode 区分继承和显式空；planning metadata 与 selection revision 独立；model_calls/assist_sessions/lineage_edges 保存实际需要的证据。提案由领域 Owner 持有，State 复用 state_proposals，统一 ProposalDTO 不再建第二份状态表。不要回头修改已应用 V001。

2026-09-20 新增待落实项：[Skill/Blueprint 逻辑扩展](logical-model.md#10-skill-与蓝图的持久化补充)不在现有 SQL 片段覆盖范围。D 阶段需补 ProjectBlueprintProposal 与应用来源关系、同提案应用唯一约束、多对象基线校验，以及 Project/Goal/View/Proposal 在统一锁序中的位置；所有相关人工/Assist 写入口必须一致。真实 PG 并发接受、人工编辑/归档竞争、事务失败和响应丢失通过前，不得宣称 ApplyProjectBlueprint 可安全交付。此处不提前分配 migration 号或假定已有 DDL。

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
- **`context_manifests` 只有 `(run_id, manifest_hash)` 唯一约束**：重复执行 BUILD_CONTEXT 命中既有摘要即复用，不产生第二份快照（第 3 节提到的 `context_builds` 增量尚未出现真实调用方）。

### 15.3 本批次涉及的锁序

统一锁序为 Authority → Task → Run → ProjectState → Resource → Review/Operation/Invocation。P05 没有 Authority/Resource，实际使用：

- Delegate：锁 Task（`FOR UPDATE`）→ 读依赖/验收 → 插 Run → 插契约 → 插步骤计划 → CAS 更新 Task 执行权（Task → Run 方向，与第 4 节一致）。并发 Delegate 由 Task 行锁、`assignExecutionToRun` 的条件更新与 `uq_run_live_task` 三重保护裁决。
- 推进步骤（`advanceRunStep`）：先锁 Run，再锁 Task（Run → Task 的例外路径），校验 `executor_run_id` 与 `ownership_epoch` 后推进步骤与 Run 状态；因为两条路径互不嵌套（Delegate 不先取 Run 锁），没有形成反向锁序。该顺序已在 15.4 记为待优化项。
- 失败释放执行权：同一事务内写步骤 FAILED、Run FAILED（终态）、Task 释放（epoch 再 +1）与审计，提交失败整笔回滚。

### 15.4 兼容性与残余风险

- 0004 只做追加与约束替换：既有行由 `executor_run_id` 默认 NULL 回填，`ck_tasks_executor` 在替换时对既有 HUMAN 行仍然成立。
- 已应用迁移禁止改写；本批次没有 down migration，回退仍靠备份。
- `advanceRunStep` 的 Run → Task 锁序与 Delegate 的 Task → Run 不同。当前两条路径不会互相等待（Delegate 不持有 Run 锁），但一旦后续批次在 Delegate 内加锁 Run（例如写入控制请求或资源 claim），必须统一为先 Task 后 Run，否则会形成真实死锁；这是 P08 前必须处理的前置检查项。
- Fake Runtime 没有外部副作用、没有真实模型调用；`step_attempts.lease_until` 只表达租约，尚无过期扫描器与恢复器（属 P08）。
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
- **Task 完成时保留 `mode`**：自动完成释放 AI 执行权（`executor_kind='HUMAN'`、`executor_run_id=NULL`、`ownership_epoch+1`）但保留 `mode='DELEGATE_AI'` 供展示；`ReopenTask` 复位为 `ME`（runtime-context 第 5 节）。`ck_tasks_completion` 与 `ck_tasks_executor` 在写入顺序上同时成立。

### 16.3 本批次涉及的锁序

统一锁序为 Authority → Task → Run → ProjectState → Resource → Review/Operation/Invocation。P06 没有 Authority/Resource，实际使用：

- 推进 `VERIFY`/`COMPLETE` 沿用 `advanceRunStep` 的 Run → Task 顺序（15.4 记录的例外路径未变），完成时在 Task 之后取 `project_states` 行锁，即 Run → Task → ProjectState，未反向获取更靠前的锁。
- 修正回路（finalize session → 重置四个步骤 → Run 回 `RETRYING`）与自动完成短事务都在**同一事务**内完成，不跨模型、网络或人工等待。
- **15.4 的待办仍然成立**：一旦 Delegate 内部开始加锁 Run（例如 P08 的控制请求或资源 claim），必须先把两条路径统一为「先 Task 后 Run」，否则会形成真实死锁。

### 16.4 兼容性与残余风险

- 0005 只做追加与约束替换：`completion_records` 的既有 `HUMAN` 行在替换后仍满足新 CHECK，`acceptance_criteria.method` 的既有 `HUMAN` 行不受影响。
- 已应用迁移禁止改写；本批次没有 down migration，回退仍靠备份。
- 仍然只有 Fake Runtime：`FakeSemanticChecker` 是确定性替身，真实语义判断属 P12；本阶段不声称验证器能保证事实绝对正确，也不声称已具备 Review/人工判断能力。
- `verification_sessions` 允许 `run_id` 为空（人工补验）但当前没有写入口；`GET /runs/{id}` 的投影尚未包含 verification 摘要；修正预算与检查器重试上限仍是常量，未进入版本化执行配置。
- 过期 claim 扫描器、资源隔离与 `PAUSED` 状态仍属 P08；本批次没有新增可被外部进程影响的副作用。


# Personal Workflow OS：PostgreSQL 物理数据库设计

> 2026-09-24 当前实现：保留 Kysely/pg、业务表及已应用 SQL migration/SHA 台账；M03 已追加 `0011` 的 command/outbox/invocation、`0012` 的 Run 刷新事件及 `0013` 的每 Run 命令顺序。官方 PostgresSaver 的固定 schema 安装与 Worker 接入已通过后端固定图分片独立复验；Windows 组合及 M03 整体仍待验收。业务事务与检查点按稳定身份对账，不能假装原子。

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

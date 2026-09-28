# 长期信息、搜索、Today 与证据查询

日期：2026-09-19。状态：Proposed。唯一写权与 State 字段语义见[契约 01](../../contracts/01-facts-and-ownership.md)。本文补充实现深度，不增加通用知识平台。

## 1. 信息归类和生命周期

| 类型 | 保存什么 | 版本与失效 | 不承担什么 |
|---|---|---|---|
| Knowledge | File/URL/Note/已验证产物的可引用内容 | 根 id + 当前版本指针；版本内容/hash/来源不可变；ACTIVE/ARCHIVED；失效单独记录 | 不因导入就保证内容真实 |
| Memory | 用户明确确认的长期偏好/背景 | revision、确认来源、有效期可选；ACTIVE/RETIRED；修改留版本 | 不从聊天自动建立画像 |
| Decision | 选择、理由、候选与代价 | ACTIVE/SUPERSEDED；替代时保存新旧引用同事务，禁止环 | 不重复保存为 Memory 正文 |
| Rule | 明确约束、范围与检查方式 | 版本不可变；current 指针；HARD/PREFERENCE；enforcement 与 applicability | 不把自然语言自动变成可执行脚本 |

共同索引可用 information_refs(type,id,workspace_id,project_id?)，但不得以万能 JSON 取代类型规则。物理实现优先四类根表与版本表，复用值对象/映射代码即可。信息引用使用带类型的外键关系；需要通用搜索结果时输出统一 DTO，不统一写入口。

KnowledgeVersion 记录来源 URI（可空）、检索时间、媒体类型、正文/Blob 引用、hash、提取器版本与可用性。网页重抓建立新版本，不覆盖旧引用。初版导入 txt/md/plain note，URL 经 Web Adapter；PDF/Office 提取作为明确后续支持项，UI 显示格式不支持，不能假装全文已索引。

产物提升为 Knowledge 仅引用 ArtifactVersion 和适用验证，不复制一份可独立编辑的产物正文。用户编辑知识笔记形成新的 KnowledgeVersion；如果内容本质变成约束/决策，用户选择归类后引用原来源，不静默迁移或自动删原件。

### 1.1 人和 AI 共用知识来源

2026-09-27，承接 [Knowledge 产品定义](../../Personal_Workflow_OS_Master_Spec.md#331-定义)。既有 Owner、作用域和不可变版本继续成立，以下补充双向使用的责任边界；不新增独立知识运行时或持久化 schema。

- **同源、不同读取方式。** Workbench 提供完整阅读及版本选择；Context Builder 按任务读取合法来源的必要片段并记录 Manifest。两者引用同一知识身份与版本，旧 Manifest 保留当时内容，不因知识更新改写历史；已有检索排名和摘要不成为新的事实源。
- **原件与快照分开。** 仓库文档、网页和 Artifact 各保留原来源身份，接入时记录可核对的版本/hash。查看原件不表示当前内容仍与旧快照相同；原件变化后若需重新导入，应形成新版本，不能用当前文件顶替旧引用。首版没有双向文档同步承诺，也不创建第二份需人工同步的正文。
- **可读不等于可外发。** 查看知识不触发模型请求；“用于 AI”仍经过既有显式选源、范围、权限和预算。工作空间共享内容不会因为可被人搜索就自动进入所有项目 Context，来源失权或不可用时仍按原规则处理。
- **收录不等于验证。** 来源为外部资料、用户笔记或 AI 建议时保留可证实的来源信息；收录、摘要确认、内容核验和 Task 验收分别依据相应事实呈现。现有 availability 仅表示可用性，不是可信度；没有确认或核验记录不能生成“已验证”标记，不先造一套通用可信度状态。
- **沉淀和导航复用原对象。** AI 整理先为建议，用户选择保存或提升确切产物版本；修改后的总结是有来源的新内容，不修改原产物。项目导读是到目标、流程说明、Decision、Rule、验收条件及经验的导航投影，不能保存第二套 Task/Project 当前状态；关系缺失时显示缺口，不推断完整知识图谱。

实现前核对确切版本的全文读取、来源身份、引用导航与现有 DTO/命令；缺失能力先列出所需契约，不因界面需要虚构接口。项目导读的维护入口、原件接入方式及确认信息的保存方式仍待设计。交互归[工作台第 12 节](../frontend/workbench-design.md#12-人和-ai-共用的知识库体验)，验证归[测试计划第 12 节](../testing/verification-plan.md#12-共享知识库的阅读与来源验证)。

## 2. 规则解析

Rule scope 为 Workspace、Project 或 Task；Project Type 和工作配置的默认规则在创建配置时形成显式引用，不因切换 Workbench 更改。HARD 适用集合求交；无法兼容时返回冲突及源规则，不选择“更具体的覆盖”。PREFERENCE 按 Task > Project > Workspace，同层冲突需显式选择或保留冲突提示。

禁止弱化来源层 HARD 的临时覆盖，但用户可在拥有该规则的来源入口修改版本。更新对后续准入生效，影响执行契约时按契约 03 停止/重新 Delegate。共享规则变更、关键输入 current 指针切换与验证撤销遵守 Workspace authority 写锁。

enforcement 的最小集合：PRE_ACTION、POST_CHECK、SEMANTIC、HUMAN；每条 HARD 必须有真实检查/判断路径。预动作规则交 Permission/Gateway，产物规则交 Verification；两者可引用同 Rule，不能各自维护规则副本。

## 3. 基础搜索

范围始终先由 Workspace/Project/可用性过滤，再检索；默认不搜索 Trace 中的原始模型正文或凭据。返回 type/id/version、title、snippet、matched_fields、source_ref 和当前适用状态。

首版采用标题/标签/正文的有界包含匹配，规范化大小写、空白，并限制查询 1–200 字；按标题完整匹配、标题包含、正文包含、更新时间、ID 确定性排序。中文短查询能找到字面结果；不宣称具备中文语义检索。

性能不足时可增加 PostgreSQL pg_trgm 索引作为迁移，实际可用性与中文短词查询用数据验证；不默认增加向量服务。[PostgreSQL pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html)

TypeScript-first 提案中的 PostgreSQL FTS 作为候选增强，不替换上述首版中文字面匹配。先验证真实中英文资料的分词、短词召回和作用域过滤；不能把默认 FTS 等同中文分词能力。pgvector 后置，以 Context Eval 的召回、任务通过率和 token 成本证明引入收益。

Context 检索复用范围过滤与版本引用，不把搜索排名当事实正确性。Required refs 直接读取而不是经过相关性淘汰。搜索缓存键含作用域和信息版本，重新授权前不得暴露已不可见内容。

### P10 当前实现边界（2026-09-23）

0009 migration 已落四类类型化根与不可变版本；NOTE/MANAGED_TEXT 的 txt/md 正文直接保存在 PostgreSQL 版本行（256 KiB 上限），同 Project 的 Markdown ArtifactVersion 提升只保存引用和原 hash，不复制正文。Memory 必须显式 `confirmed:true`，确认主体由服务端固定；Decision 替代保持历史，并由单一应用用例拒绝跨范围和替代环。URL、PDF、Office、标签、来源提取器和受管任意文件导入仍按原设计留后续。当前 `availability` 为版本元数据状态，Artifact 文件是否可读仍需原 Artifact 内容校验；搜索不从 Artifact 引用提取全文。

Rule 在 Delegate 的 authority SHARE 锁下解析，冻结来源版本和实际 CheckPlan criterion；同层不同 PREFERENCE 与不同含义 HARD 冲突显式拒绝。HARD PRE_ACTION 没有当前 Gateway 检查路径、HARD SEMANTIC 只有 Fake checker 时一律阻止 Delegate；PREFERENCE PRE_ACTION 只保留来源，不冒充执行检查。Rule mutation 与后续准入采用 [ADR-009](../decisions/ADR-009-rule-revision-fence.md) 的 Workspace 级保守栅栏：无关 Project 的规则更新也可令旧 Run stale，已发生效果仍登记原回执。P10 当时 Knowledge/Memory/Decision 尚未自动进入固定 Workflow 的 Context；P11 已用独立 `context_revision` 与真实 Manifest 纳入有界来源，仍未写入不可变 ExecutionContract 的显式选择引用，不能把 `rule_revision` 当资料失效键。实际选取与下一阶段边界见[运行设计](runtime-context.md#p11-当前实现边界2026-09-23)。

当前 `/search` 实际按 Workspace/Project、活动状态和当前版本过滤，只检索标题与可用文本字段，字面 `ILIKE` 转义通配符；1–200 字查询、1–50 条分页，按本节排序并将完整时间/ID/类型写入游标。尚无标签字段和中文语义检索；现有范围索引不保证大规模文本扫描性能，需按后续真实资料规模测量。

P10 本地源码参考按[固定清单](../research/p00-source-study.md#11-本地源码对照清单2026-09-20-核验)定向核对：Kysely `2fefd4c848cc3129281fac0632d2376c7a723ee4` 的 `src/migration/migrator.ts`、`test/node/src/migration.test.ts` 提供迁移顺序/并发测试机制；本轮沿用已有 SQL 迁移入口的事务级锁和 SHA-256 台账，只追加 0009，不改写旧迁移。差异及 SQL 错误后的会话锁限制沿用[P00 实测](../research/p00-source-study.md#postgresql-基础实验与依赖兼容)。四类信息版本、Rule 层级冲突与 Delegate 冻结是 Relay 的业务事实规则；对照 Pi `36b60d2e8985899743c4cf5bd5f8929832a3f05d` 的 `packages/agent/src/agent-loop.ts` (`prepareToolCall`/`executePreparedToolCall`) 和 LangChain `eba445b7563d1709427bd8072892975a6ea59fdc` 的 `human_in_the_loop.py` (`interrupt_on`/`_process_decision`) 后，未套用其工具钩子或人工决定来写这些事实：它们处理工具调用/决定，不提供本项目的不可变业务版本或上层 HARD 合并。对应本轮证据为 0009 真实 PG 迁移、Rule/Delegate 两序竞争、信息版本和搜索用例；上游测试本轮未运行。

## 4. Today 的确定性规则

第一版不预测时长、不自动排日历，也不推断精确进度。Task 增加用户可选 priority（LOW/NORMAL/HIGH）与 due_local_date/timezone；这些是显式调度元数据，不改变验收版本，更新仍增加 Task revision。

候选：HUMAN 且 READY/IN_PROGRESS，依赖满足、无未解决硬 blocker、非未到期 Later。AI 正持有任务不出现在“立即开始”列表；进入单独“等待 AI/需你判断”区域。无 Project 的合法人工任务可参与。

排序键按顺序：有效 Focus 对齐 → Pin → 逾期/到期日 → priority → 被选为 Project Next Action → 已人工进行中 → created_at → id。所有排序键必须有真实数据；先执行资格过滤，Focus/Pin 不越过依赖。

Later 是用户选择的本地日期与保存时区，在该时区当天 00:00 恢复候选；没有后台午夜任务也能由查询正确计算。切换界面时区不改已保存 Later 语义，修改需显式命令。到期但仍 BLOCKED 时显示原因而不进入可执行队列。

Focus 保存日期、时区、目标类型（Goal/Project/Task）与目标 ID，一天一个显式焦点；没有合格候选时显示“当前焦点暂无可开始任务”，不替用户改变焦点。Pin/Later 支持清除命令，刷新与重启保留。

每条建议返回 reason_codes 及依据（例如 PINNED、DUE_TODAY、PROJECT_NEXT_ACTION），界面用固定模板呈现。“AI 建议优先”不能成为没有来源的理由。

2026-09-26 的 P13 后端开发切片已把上述规则接入 `GET /today`：Task 的 priority 与 due_local_date/timezone 是可清空的显式元数据，更新只推进 Task revision，不推进 acceptance_revision；Pin/Later 与日期 Focus 是独立于 Task 的用户选择，以 Workspace 级 `selection_revision` 串行化命令。查询在 PostgreSQL 的可重复读快照内读取 Workspace Task、依赖/blocker、Project Next Action、当前 Goal 关联和选择事实，不保存推荐结果。`waiting_items` 包含不合格的活动 Task，`blocked_pinned_items` 是其中 Pin 项的子集；AI 占有、依赖、blocker、Later 和未就绪均带真实 reason_codes/evidence_refs。Focus 以 Workspace + 本地日期唯一，原时区与目标即使和查询时区不同也在响应中保留；仅日期和时区均匹配时对合格候选排序。Later 截止与查询日期的观察点分别取各自 IANA 时区当地 00:00 对应的绝对时刻；查询不运行后台午夜改写。此段只表示后端开发自检范围，尚非 M05 或桌面验收。

## 5. Goal 和项目迁移

Goal 只有标题、说明、生命周期和显式 Project 关联，不做百分比/KPI 引擎。Task goal_alignment_mode 使用 INHERIT/EXPLICIT；EXPLICIT 可以是空集合，不能用“空集合”歧义表示继承。

解除 Project–Goal 时先查询影响；提交包含 impacted_task_ids 与处理方式，并在锁下重新核对。列表已变化返回 409，不静默清理新增引用。Project 归档阻止新 Delegate，保留历史浏览；存在活动 Run/UNKNOWN 先拒绝归档并显示阻塞。

2026-09-26 归档协议分两段落地，取舍见 [ADR-011](../decisions/ADR-011-project-archive-serialization.md)。A 段在 Project、Task、State、Goal 关联、Information/Rule、Assist、Blueprint、View、Gateway、Import、Today 与 Run/Review 的业务写事务加入 Project 行 `FOR KEY SHARE` 可写栅栏；归档字段非空时返回 `PROJECT_ARCHIVED`。模型调用的 STARTED 预约也在短事务内先取该栅栏，再锁 Run 或 AssistSession 预算范围；事务提交后才外呼 Provider。B 段 `ArchiveProject` 先取同一行 `FOR UPDATE`，在锁内读取持久在途事实；HUMAN 活动 Task、AI 占有、非终态 Run/投递/运行中的 Step/尝试/验证、Gateway 操作与调用、UNKNOWN、资源 claim、Import、Assist/STARTED 模型调用、OPEN Review 任一未安全收敛即返回 `PROJECT_ARCHIVE_BLOCKED`，不会因租约过期推断进程已停止。检查通过后仅更新 Project 的 `archived_at/revision`，与审计、命令回执同事务。归档不取消任务、重试动作或清除历史。文件产物发布前须取得栅栏；模型、网页和工具调用仍在短事务外。历史 Project/Task/Assist 读取保留，归档 Project 的 Task 不给可执行动作，Today 不列为候选。原有跨模块写命令沿 A 段栅栏在归档提交后拒绝。

Task 移动 Project 仅允许 HUMAN、无活动 Run、无未知动作、非 DONE；清理 Next Action/显式关联与 State 选择，由一次显式用例完成。历史 Run/产物来源不改写；当前跨项目资料引用重新授权。

## 6. Activity / Trace / Lineage

Activity 是用户业务事件：创建任务、改验收、请求控制、人工判断、完成/重开等。存 actor、时间、command_id、实体 refs 和短摘要；唯一关键证据与业务同事务保存。Trace 是 Run 的步骤/尝试/调用/验证证据，不新增独立事实副本。

Artifact lineage_edges 使用 child_version_id、relation、typed_parent_ref，关系只开放 DERIVED_FROM、REVISED_FROM、GENERATED_BY、VERIFIED_BY、ACCEPTED_BY。产物版本关系拒绝自环与循环；Run/资料可共享引用，多父合法。界面以直接父来源和执行路径展开，不做通用图谱编辑器。

查询支持 project/task/run 和时间过滤、游标分页；展示“决定已批准”与“动作已成功”分别引用 Review/Gateway。用户完成凭据可一路跳转到验收、产物、资料版本；正文已移除时显示 unavailable，不用当前正文替代历史。

2026-09-26 M05/P15 后端开发切片已提供只读 Activity、Run Trace 与单个 ArtifactVersion 的直接父来源查询。Activity 使用原业务事务里的审计行和 Workspace 归属做稳定倒序分页，公开投影只选固定摘要及经当前 Workspace 核对的实体引用；原 `fact_refs`、自由文本和凭据不出接口。Trace 从现有 Step/Attempt、模型调用、Manifest、Verification、Review、Gateway 与受管效果事实装配；Review 决定与操作/效果结算分别展示，不从批准推断成功。Manifest 的历史来源须在读取时重新核对当前作用域、确切版本和正文可用性；不可读来源只显示 `UNAVAILABLE`，不返回原引用或用最新版本替代。

Lineage 只在明确的保存、验证和完成事务写入确切 typed relation；`VERIFIED_BY` 对应实际 VerificationTarget，`ACCEPTED_BY` 对应完成凭据接受的版本。查询仅展示直接父边，源内容缺失或当前不可读时保留边的关系与 `UNAVAILABLE` 状态，隐藏父 ID。数据库在同 Workspace 事务锁下拒绝跨域、自环和 ArtifactVersion 环。`DERIVED_FROM` 虽为允许的关系，目前没有自动推断写入者；不能把资料或相似内容推测成已确认来源。本切片的真实 PostgreSQL 回归属于开发自检，独立模块与 Windows 桌面验收仍后置。

## 7. 验收

A03、A04、A06–A09 为核心依据。补充：中文查询能检出字面内容；EXPLICIT 空 Goal 不误继承；Later 跨午夜/时区保持定义；Focus/Pin 均不能突破资格；重复提升同产物知识引用幂等；Decision 替代不能成环；审计查询不泄漏密钥。

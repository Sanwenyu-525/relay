# 长期记忆系统 V2：架构与边界

本文描述 2026-11-15 已落地的长期记忆 V2，以及 MEMORY-ACCEPTANCE-20261115 的可靠性补全。第二轮（2026-11-16）补齐了显式记住/自动捕获隔离、压缩屏障、Worker 崩溃恢复、消息级捕获状态和 Skill 执行轨迹；不改变 Information 作为唯一写入 Owner 的边界。它接续 [ADR-028](../decisions/ADR-028-memory-layers.md) 的分层原则和 [ADR-041](../decisions/ADR-041-memory-v2-layered-retrieval.md) 的取舍，不维护第二套进度或成绩；运行状态归 `CODEX_NEXT_STEP.md`，验证结果归功能验收表和 [memory-testing](memory-testing.md)。

## 1. 唯一 Owner 与模块

长期记忆的唯一写入 Owner 仍是 Information 领域。V2 没有另建 Memory 服务或第二套表，而是在既有根/不可变版本上追加语义层：

| 逻辑职责 | 实际代码 | 说明 |
|---|---|---|
| 领域模型 | `apps/api/src/application/memory-model.ts` | 类型/作用域/验证/有效状态、分词、hash、敏感识别、置信度、类型提示 |
| 配置默认值与校验 | `apps/api/src/application/memory-config.ts` | 预算、topK、检索模式、整理间隔、按类型陈旧窗口 |
| 写前裁决 | `apps/api/src/application/memory-write.ts` | 候选归一化、去重/替代/冲突、固定记忆、事务写入 |
| 显式记住 | `apps/api/src/application/memory-explicit.ts` | 识别中英文“记住/remember”，推断类型与作用域，走真实写入 |
| 自动捕获 | `apps/api/src/application/memory-auto-capture.ts` | 结算后登记 `memory_capture_tasks`，Worker tick 执行、退避与终态回执 |
| 召回 | `apps/api/src/application/memory-recall.ts` | 作用域过滤、固定常驻、倒排命中、预算裁剪、降级度量 |
| 整理 | `apps/api/src/application/memory-consolidation.ts` | 确定性去重、同键合并、按类型陈旧标记、索引回填 |
| 管理命令 | `apps/api/src/application/memory-commands.ts` | 固定、人工验证、有效期延长、手动整理 |
| 导入导出/删除 | `apps/api/src/application/memory-transfer.ts` | schema_version=2、作用域校验、失效项清理、真实删除 |
| 可观测性 | `apps/api/src/application/memory-observability.ts` | 真实统计、索引健康、召回度量、整理运行、捕获任务 |
| 持久化 | `apps/api/src/information/information-repository.ts` | 所有 SQL、作用域约束、替代链、真删除、捕获任务 CRUD |
| HTTP | `apps/api/src/api/information-api.ts` | 列表/详情/统计/capture-tasks/expiry/import/export/purge |
| Workbench | `apps/workbench/src/views/MemoryView.tsx`、`MemoryAdvancedSettingsCard.tsx` | 列表/详情/修订/固定/验证/有效期/删除/整理/导入导出与设置 |

短期记忆、检查点、压缩仍归 Assist：`assist-memory.ts`、`assist-memory-runner.ts`、`assist-memory-repository.ts`。它们不是长期记忆的第二个写入入口；长期记忆在任务结算、用户显式记住或导入时通过 Information 写入。

## 2. 存储结构

真相源是 PostgreSQL，不存在 Markdown/数据库双写：

- `memory_items`：根、作用域、类型、键、重要性、置信度、验证、固定、替代链、内容指纹与检索 token；`instruction_risk` 标记正文中的指令覆盖风险，`expires_at_override` 保存用户手动延长的有效期；
- `memory_versions`：不可变正文、标题、确认者、有效期；正文改动产生新版本，不继承旧验证；
- `memory_message_sources`：冻结的来源会话/消息/内容 hash；
- `memory_auto_captures`：自动捕获记账与撤销依据；
- `memory_capture_tasks`：待捕获任务状态、租约、尝试次数、下次重试时间与结果回执；状态为 `PENDING` / `RUNNING` / `SUCCEEDED` / `EMPTY` / `FAILED` / `CANCELLED`；
- `workspace_memory_settings`：召回/自动捕获/整理/隐私设置；
- `memory_recall_events`：查询摘要与计数，不存完整查询正文；
- `memory_maintenance_runs`：整理触发、结果统计与错误。

索引可重建，真相不依赖索引：`memory_items` 的 GIN 表达式索引基于 `search_title_tokens` / `search_body_tokens`；token 为空时召回用未索引行字面兜底，整理会回填。10,000 条验收库上，选择性 token 查询使用 GIN（`Bitmap Index Scan`），不回退全表扫描。

迁移：`0164_memory_system_v2.sql` 追加 V2 结构与索引；`0166_memory_actor_sources.sql` 放宽版本确认者标签并补真实删除所需授权；`0168_memory_capture_tasks.sql` 追加捕获任务表、`instruction_risk` 与 `expires_at_override`。迁移只追加，不改已应用迁移的旧列语义。

## 3. 作用域与权限

- `WORKSPACE`：`project_id`、`task_id`、`agent_id` 均为空；
- `PROJECT`：必须有 `project_id`；
- `TASK`：必须有 `project_id` 与 `task_id`，服务端校验 task 归属；
- `AGENT`：仅预留列，当前没有多 Agent 身份/共享模型，UI 不创建。

检索先做 Workspace 与作用域过滤，再进入候选排序；写入裁决只在完全相同的作用域内比较。跨项目、跨任务、跨用户读取没有隐式通道；项目导出必须在项目作用域导入，导入时重新校验项目属于当前工作区。Context Builder 与 Delegate 的短期上下文同样按 scope 过滤，不把其他项目/任务的事实带入当前执行。

## 4. 写入、捕获与冲突

```
显式“记住” / 自动捕获 / 导入
  → 归一化（类型、key、hash、token、敏感识别、instruction_risk）
  → 完全相同作用域内取候选
  → 精确重复 → 拒绝并返回已有 ID
  → 同键且来源可信度足够 → 事务内插入新根/版本 + 旧根 superseded_by_id
  → 同键但低可信/已验证冲突 → 拒绝冲突
  → 无键高重叠 → 近似重复
  → 敏感凭证 → 拒绝
  → 插入根/版本/来源，刷新 token 索引
```

所有多表写入在同一短事务内；模型/网络/CLI 不进入事务。写入失败如实返回，不由 UI 假装成功。

自动捕获在助手消息结算后先把任务行落库，再由 Worker tick 执行辅助模型提取；每任务最多 3 次，退避为 1/5/15 分钟。任务成功、空内容、失败、取消都是可查询终态；所有候选都写失败时按 `WRITE_FAILED` 重试，不伪装成“无内容”。租约过期的任务可被下一 Worker 恢复；重试复用原任务行，不撞唯一键。同一轮重复触发按 advisory lock 与去重指纹只落一份。

`enqueueMemoryCaptureTask()` 现在**先读 session/message/previous，再识别显式意图**，最后按 `kind` 插任务：

- `EXPLICIT` 不受 `auto_capture=false`、每日自动配额和寒暄过滤影响；即使 `session.remember=false` 也插任务，并立即收口为 `CANCELLED + MEMORY_DISABLED`，留下可查回执，而不是静默丢弃；
- `AUTO` 在关闭自动捕获、超配额或寒暄轮时分别保留 `AUTO_CAPTURE_DISABLED`、`DAILY_LIMIT`、`TRIVIAL_TURN` 终态；
- 显式任务允许助手回复为空，自动任务仍要求回复非空；
- 遗留 `AUTO` 任务若在执行时识别到显式意图，会创建 `EXPLICIT` 任务并把原任务收口为 `CONVERTED_TO_EXPLICIT`，新任务再按 EXPLICIT 领取，避免同一意图产生两份记忆。

用户明确要求记住时走显式路径，写真实库并返回真实回执；落库使用 `HUMAN_CONFIRMED + USER_STATEMENT + UNVERIFIED`，来源为 `previous.user`，并记录 `sourceContentHash`。显式只是“用户明确表达”，不等于事实已经验证：敏感凭证、重复、冲突和写入失败仍按真实裁决处理。随口提及和模型推断不会全量持久化，也不因一次辅助模型调用失败就宣称已保存。

## 5. 召回流程

1. 读取会话所在 Workspace/Project/Task 与设置；
2. 固定记忆先占 `core_token_budget`；固定项即使 STALE 也常驻，但普通 STALE 被门禁；
3. 普通候选按作用域、有效状态（ACTIVE/STALE）、来源撤销过滤；
4. 只使用 LITERAL 全文检索：查询 token 走 `to_tsvector('simple', ...)` GIN 命中，按标题 A/正文 B 权重与相关性排序；
5. 按 `retrieval_top_k` 截取，再按 `retrieval_token_budget` 硬裁剪；
6. 每条结果带 `selection_basis` 与来源身份，作为 `UNTRUSTED_DATA` 注入；
7. 失败时记录真实降级原因并让 Agent 继续执行，不阻塞主流程。

`HYBRID` 与 Embedding **未实现**：设置能力返回 `literal: true`、`hybrid: false`、`embedding: false`；服务端拒绝新的 HYBRID、`openai-compatible` 与 `remoteEmbeddingAllowed: true`。没有“全文冒充混合”的降级路径，也就不存在未经授权发送记忆正文的远程 Embedding 链路。

## 6. 生命周期与整理

- 写入即建立根与 v1；编辑正文产生新版本，不继承旧 `VERIFIED`，除非显式再次验证；已替代记忆不能再修订；
- 同键新事实替代旧事实，旧根保留并派生 `SUPERSEDED`；固定记忆不能被同置信度自动观察无条件替代；
- 过期由当前版本 `expires_at` 或 `expires_at_override` 派生；用户可延长 30 天、1 年或改为长期；
- 陈旧窗口按类型：`EPISODIC` 30 天、`EXPERIENCE` 90 天、`PROJECT_FACT` 使用设置值、`UNKNOWN` 120 天；`USER_PREFERENCE` 不自动陈旧；
- 手动整理与 Worker tick 只做确定性动作：精确重复合并、同键保留更可信/更新者、陈旧标记、索引回填；整理不调用模型、不制造新事实；
- 停用（RETIRED）只退出召回，保留正文、版本、来源，可恢复；过期（EXPIRED）与替代（SUPERSEDED）各自独立，恢复停用不会延长已过期有效期；
- 真实删除先输入 `DELETE_MEMORIES`，事务内删除索引、来源、自动捕获、版本和根；删除后不进入列表、统计或召回。

## 7. 与相邻系统的边界

| 系统 | 谁拥有 | 记忆系统不做什么 |
|---|---|---|
| 上下文压缩 | Assist | 不把压缩摘要写成新记忆、不让摘要提升可信度；压缩前只检查即将被覆盖消息上未结算（PENDING/RUNNING）的捕获任务。手动压缩返回 409 `MEMORY_CAPTURE_PENDING`；自动压缩保留当前消息执行，落一条持久 AUTO 请求并 `deferAutomaticRequest`，当前 Checkpoint 不变；任务到达终态后由捕获 tick 调用 `resumeDeferredAutomaticRequests()` 自动恢复，不要求用户重新发消息。SUCCEEDED/EMPTY/CANCELLED 允许继续，FAILED 允许继续但保留失败状态。 |
| Skill 执行轨迹 | Assist | 第一方 Skill 的真实执行事件写入独立账本 `assist_skill_invocations`（REQUESTED/RUNNING/SUCCEEDED/FAILED/CANCELLED，`invocation_key` 唯一）；只存脱敏截断的输入/输出摘要。普通 MCP/文件工具仍走 `assist_session_tool_calls`，不得冒充 Skill，也不写入长期记忆。 |
| 任务 Checkpoint / 恢复 | Workflow / Assist | 不代替执行阶段、工具调用状态、外部副作用与幂等；恢复先读真实 Checkpoint，记忆只提供偏好/项目规则/历史经验 |
| 日志 | 日志系统 | 不把日志表当记忆库；只提炼已确认根因/有效经验并保留来源引用，不让日志条数线性放大记忆条数 |
| 代码索引/文件 | 代码索引与实际文件 | 不复制仓库全文；项目事实使用前应可重新核对文件/命令，实时事实以文件为准 |
| 会话历史 | Assist | 长期记忆不是聊天历史的别名；只保存有跨会话价值的结构化事实/经验/事件 |

## 8. 可观测与 UI

`GET /memory/stats` 返回真实总数、各状态/类型计数、存储字节、索引健康、24h 召回次数/平均耗时、`unverified`、`failed`、`instruction_risk`、捕获待处理/失败与最近整理。Workbench `/memory` 是独立管理页；设置页挂载高级设置卡。

UI 的统计、列表、保存回执都来自真实 API，不使用模拟数据；统计请求失败时显示“—”并在文案中明确“未知不是 0”，不沿用旧值伪装成功。列表使用服务端游标分页，不把固定条数当全量；详情保留一个主容器，内部分区显示正文、来源证据、作用域、验证、固定与生命周期、修订历史和替代关系。

聊天消息 DTO 新增 `memory_capture` 与 `skill_invocations`：捕获状态来自该消息真实任务，按 `RUNNING > PENDING > FAILED > SUCCEEDED > CANCELLED > EMPTY` 聚合成单一展示态，返回任务/保存/失败计数；无任务时字段为 `null`，不伪装成“无需保存”。Skill 事件按 `requested_at, ordinal` 排列，先在 `AssistView` 默认折叠展示，展开后显示名称、版本、sha 前 12、状态、输入/输出摘要与失败原因。

记忆页的捕获面板只在展开时立即读取；存在 PENDING/RUNNING 时每 6 秒刷新，页面隐藏时暂停，全部终态后停止；同一拍会重读服务端统计，避免列表已“已捕获”而头部仍显示“捕获待处理”。刷新失败清空旧任务并明确报错，不保留陈旧数字。聊天页对捕获状态使用同样的“终态即停”轮询边界。

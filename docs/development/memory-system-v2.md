# 长期记忆系统 V2：架构与边界

本文描述 2026-11-15 已落地的长期记忆 V2。它接续 [ADR-028](../decisions/ADR-028-memory-layers.md) 的分层原则和 [ADR-041](../decisions/ADR-041-memory-v2-layered-retrieval.md) 的取舍，不维护第二套进度或成绩；运行状态归 `CODEX_NEXT_STEP.md`，验证结果归功能验收表和 `docs/testing/memory-system-v2.md`。

## 1. 唯一 Owner 与模块

长期记忆的唯一写入 Owner 仍是 Information 领域。V2 没有另建 Memory 服务或第二套表，而是在既有根/不可变版本上追加语义层：

| 逻辑职责 | 实际代码 | 说明 |
|---|---|---|
| 领域模型 | `apps/api/src/application/memory-model.ts` | 类型/作用域/验证/有效状态、分词、hash、敏感识别、置信度、类型提示 |
| 配置默认值与校验 | `apps/api/src/application/memory-config.ts` | 预算、topK、检索模式、整理间隔、陈旧天数 |
| 写前裁决 | `apps/api/src/application/memory-write.ts` | 候选归一化、去重/替代/冲突、事务写入 |
| 召回 | `apps/api/src/application/memory-recall.ts` | 作用域过滤、固定常驻、倒排命中、预算裁剪、降级度量 |
| 自动捕获 | `apps/api/src/application/memory-captures.ts`、`memory-auto-capture.ts` | 统一走写入裁决，保留来源类别 |
| 整理 | `apps/api/src/application/memory-consolidation.ts` | 确定性去重、同键合并、陈旧标记、索引回填 |
| 管理命令 | `apps/api/src/application/memory-commands.ts` | 固定、人工验证、手动整理 |
| 导入导出/删除 | `apps/api/src/application/memory-transfer.ts` | schema_version、作用域校验、失效项清理、真删除 |
| 可观测性 | `apps/api/src/application/memory-observability.ts` | 真实统计、索引健康、召回度量、整理运行 |
| 持久化 | `apps/api/src/information/information-repository.ts` | 所有 SQL、作用域约束、替代链、真删除 |
| HTTP | `apps/api/src/api/information-api.ts` | 新 schema 与 pin/verify/stats/maintenance/export/import/purge |
| Workbench | `apps/workbench/src/views/MemoryView.tsx`、`MemoryAdvancedSettingsCard.tsx` | 列表/详情/修订/固定/验证/删除/整理/导入导出与设置 |

短期记忆、检查点、压缩仍归 Assist：`assist-memory.ts`、`assist-memory-runner.ts`、`assist-memory-repository.ts`。它们不是长期记忆的第二个写入入口；长期记忆只在任务结算、用户显式保存或压缩前的有界提取时通过 Information 写入。

## 2. 存储结构

真相源是 PostgreSQL，不存在 Markdown/数据库双写：

- `memory_items`：根、作用域、类型、键、重要性、置信度、验证、固定、替代链、内容指纹与检索 token；
- `memory_versions`：不可变正文、标题、确认者、有效期；正文改动产生新版本；
- `memory_message_sources`：冻结的来源会话/消息/内容 hash；
- `memory_auto_captures`：自动捕获记账与撤销依据；
- `workspace_memory_settings`：召回/整理/隐私设置；
- `memory_recall_events`：查询摘要与计数，不存完整查询正文；
- `memory_maintenance_runs`：整理触发、结果统计与错误。

索引可重建，真相不依赖索引：`memory_items` 的 GIN 表达式索引基于 `search_title_tokens` / `search_body_tokens`；token 为空时召回用未索引行字面兜底，整理会回填。

迁移：`0164_memory_system_v2.sql` 追加 V2 结构与索引；`0166_memory_actor_sources.sql` 放宽版本确认者标签并补真实删除所需的 DELETE 授权。迁移只追加，不改已应用迁移的旧列语义。

## 3. 作用域与权限

- `WORKSPACE`：`project_id`、`task_id`、`agent_id` 均为空；
- `PROJECT`：必须有 `project_id`；
- `TASK`：必须有 `project_id` 与 `task_id`，服务端校验 task 归属；
- `AGENT`：仅预留列，当前没有多 Agent 身份/共享模型，UI 不创建。

检索先做 Workspace 与作用域过滤，再进入候选排序；写入裁决只在完全相同的作用域内比较。跨项目、跨任务、跨用户读取没有隐式通道；项目导出必须在项目作用域导入，导入时重新校验项目属于当前工作区。

## 4. 写入流程

```
显式保存 / 自动捕获 / 导入
  → 归一化（类型、key、hash、token、敏感识别）
  → 完全相同作用域内取候选
  → 精确重复 → 拒绝并返回已有 ID
  → 同键且来源可信度足够 → 事务内插入新根/版本 + 旧根 superseded_by_id
  → 同键但低可信/已验证冲突 → 拒绝冲突
  → 无键高重叠 → 近似重复
  → 敏感凭证 → 拒绝
  → 插入根/版本/来源，刷新 token 索引
```

所有多表写入在同一短事务内；模型/网络/CLI 不进入事务。写入失败如实返回，不由 UI 假装成功。

## 5. 召回流程

1. 读取会话所在 Workspace/Project/Task 与设置；
2. 固定记忆先占 `core_token_budget`；
3. 普通候选按作用域、有效状态、来源撤销过滤；
4. 查询 token 走 `to_tsvector('simple', ...)` GIN 命中，按标题 A/正文 B 权重与相关性排序；
5. 按 `retrieval_top_k` 截取，再按 `retrieval_token_budget` 裁剪；
6. 每条结果带 `selection_basis` 与来源身份，作为 `UNTRUSTED_DATA` 注入；
7. 失败时记录真实降级原因并让 Agent 继续执行，不阻塞主流程。

`HYBRID` 只是可选模式；当前没有 Embedding 适配时记录 `EMBEDDING_UNAVAILABLE` 并退回字面检索。没有 API Key 不影响基础记忆。

## 6. 生命周期与整理

- 写入即建立根与 v1；编辑正文产生新版本，不继承旧 `VERIFIED`，除非显式再次验证；
- 同键新事实替代旧事实，旧根保留并派生 `SUPERSEDED`；
- 过期由当前版本 `expires_at` 派生；项目事实/经验超过 `memory_stale_after_days` 标 `STALE`；
- 手动整理与 Worker tick 只做确定性动作：精确重复合并、同键保留更可信/更新者、陈旧标记、索引回填；
- 整理不调用模型、不制造新事实，低可信内容不会因多次摘要升级；
- 清理失效项按派生状态反选并排除固定项；硬删除需要 `DELETE_MEMORIES`，事务内删除来源、自动捕获、版本和根。

## 7. 与相邻系统的边界

| 系统 | 谁拥有 | 记忆系统不做什么 |
|---|---|---|
| 上下文压缩 | Assist | 不把压缩摘要写成新记忆、不让摘要提升可信度；压缩前只做有界候选保存，失败有界超时不阻塞压缩 |
| 任务 Checkpoint / 恢复 | Workflow / Assist | 不代替执行阶段、工具调用状态、外部副作用与幂等；恢复先读真实 Checkpoint，记忆只提供偏好/项目规则/历史经验 |
| 日志 | 日志系统 | 不把日志表当记忆库；只提炼已确认根因/有效经验并保留来源引用，不让日志条数线性放大记忆条数 |
| 代码索引/文件 | 代码索引与实际文件 | 不复制仓库全文；项目事实使用前应可重新核对文件/命令，实时事实以文件为准 |
| 会话历史 | Assist | 长期记忆不是聊天历史的别名；只保存有跨会话价值的结构化事实/经验/事件 |

## 8. 可观测与 UI

`GET /memory/stats` 返回真实总数、各状态/类型计数、存储字节、索引健康、24h 召回次数/平均耗时、最近整理。Workbench `/memory` 是独立管理页；设置页挂载高级设置卡。UI 的状态、统计、保存回执都来自真实 API，不使用模拟数据。

# 长期记忆配置

所有用户可见参数集中在 `workspace_memory_settings`，默认值只在 `apps/api/src/application/memory-config.ts` 定义。设置通过 `GET/POST /workspaces/:id/memory-settings` 读写，Workbench 设置页的两个卡片只调用真实客户端。

## 1. 默认值

| 字段 | 默认 | 范围/含义 |
|---|---:|---|
| `recall_enabled` | `true` | 是否自动召回当前有效长期记忆；关闭后新请求不再召回 |
| `auto_capture` | `true` | 结算后是否自动提取候选记忆；关闭后仍可手动保存/召回已有条目 |
| `automatic_compaction` | `true` | 既有上下文自动压缩开关，不属于长期记忆 V2 |
| `core_token_budget` | `2000` | 固定记忆每轮常驻预算；0 表示不常驻 |
| `retrieval_token_budget` | `3000` | 单次普通召回预算 |
| `retrieval_top_k` | `5` | 单次普通召回候选上限，1–20 |
| `retrieval_mode` | `LITERAL` | `LITERAL` 倒排全文；`HYBRID` 有语义端口时叠加，否则降级 |
| `auto_consolidate` | `true` | Worker 是否自动整理 |
| `consolidation_interval_hours` | `24` | 自动整理间隔，1–720 小时 |
| `memory_stale_after_days` | `180` | 项目事实/经验的老化阈值，7–3650 天 |
| `embedding_provider` | `disabled` | `disabled` 或 `openai-compatible`；当前无真实远程适配 |
| `remote_embedding_allowed` | `false` | 是否允许把记忆正文发送给远程 Embedding；默认禁止 |
| `include_stale_in_recall` | `false` | 是否允许召回 STALE 条目；仅作参考，不作为现行规则 |

未保存过设置的工作区按上述默认值运行，但不会因为读取而写一行空设置。整理 tick 对无设置行的活跃工作区同样按 `auto_consolidate=true`、24h、180d 处理。

## 2. 校验

- 预算必须是整数且在迁移约束范围内；非法值返回字段错误，不静默夹取；
- `retrieval_mode` 只接受 `LITERAL`/`HYBRID`；`embedding_provider` 只接受 `disabled`/`openai-compatible`；
- 读取不存在的设置返回修订 0 与默认开关，`GET` 零写入；
- 保存使用 `command_id` 与 `expected_revision`，整行 CAS；后保存者冲突返回 409，不覆盖先保存者的字段。

## 3. 配置分级

- **部署开关**：`RELAY_MEMORY_AUTO_CONSOLIDATION=false` 可关闭 Worker 自动整理；不影响手动整理和手动保存；
- **工作区设置**：预算、topK、模式、整理、隐私均按 Workspace 持久化；
- **请求级**：召回读取当前 Project/Task 作用域，不改变保存的设置；
- **不存在的配置**：不创建重复配置来源，不把默认值当成用户已确认的选择。

## 4. 隐私与 Embedding

- 默认 `embedding_provider=disabled`，基础全文检索完全可用；
- 即使选择 `openai-compatible`，没有实现远程适配或用户未允许远程发送时不会调用外部服务；`HYBRID` 记录 `EMBEDDING_UNAVAILABLE` 并降级；
- 关闭 `auto_capture` 后，后台整理不能悄悄新增记忆；手动保存仍遵循用户显式动作；
- 导出只含正文与元数据，不含会话/消息凭据；导入逐行校验作用域和项目归属。

## 5. 性能开销

- 固定记忆先占 `core_token_budget`，普通召回再受 `retrieval_token_budget` 与 `retrieval_top_k` 限制；
- 检索先做 Workspace/作用域过滤，走 GIN 表达式索引，不做全表扫描；
- 整理每拍最多一个到期工作区、每批 `maintenanceBatchSize=50`，不阻塞主流程；
- 写入 token 与 hash 是应用层确定性计算，不额外调用模型；自动提取只在结算后运行，有每会话每日上限。

## 6. 相关入口

- 默认值/校验：`apps/api/src/application/memory-config.ts`
- 设置读写：`apps/api/src/application/memory-settings.ts`、`apps/api/src/information/information-repository.ts`
- HTTP 契约：`apps/api/src/api/information-api.ts`
- UI：`apps/workbench/src/components/MemorySettingsCard.tsx`、`MemoryAdvancedSettingsCard.tsx`

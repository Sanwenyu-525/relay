# 长期记忆生命周期

本文是 [Memory Architecture](memory-system-v2.md) 的生命周期分册，描述实际代码中的写入、验证、替代、整理、过期和删除。所有动作以 Information 领域入口为准；UI 只调用真实命令。

## 1. 写入时机

- 用户明确要求记住，或显式保存消息/手动创建；
- 自动捕获在会话结算后异步提取，单会话每日有上限；
- 上下文压缩前，只对已结算、明确且尚未保存的内容做有界候选提取；
- 任务完成且经过必要验证后，可写入已确认经验；
- 导入是独立入口，不伪装成自动捕获。

普通寒暄、临时工具输出、无长期价值的问答不进入长期记忆。自动捕获默认 `UNVERIFIED`，不冒充人工确认。

## 2. 写入裁决

`prepareMemoryCandidate` 先归一化类型、`memory_key`、内容 hash 和 token，并运行敏感凭证识别。`decideMemoryWrite` 在**完全相同作用域**的候选内裁决：

1. 内容 hash 相同或归一化标题+正文相同 → `DUPLICATE`，不写第二份；
2. 同作用域、同类型、同 key：
   - 显式人工保存/导入（`force`）→ 新事实替代旧事实；
   - 自动来源遇到旧事实已验证或固定 → `CONFLICT`，不顶掉；
   - 来源可信度更高或同级且置信度不低于旧事实 → `SUPERSEDE`；
   - 否则 `CONFLICT`；
3. 无 key 时，仅同类型且 token Jaccard ≥ 0.8 判近似重复；
4. 敏感凭证 → `REJECTED_SENSITIVE`，调用方返回可理解字段错误。

替代不是覆盖正文：插入新根和 v1，旧根保留原文与版本，只设置 `superseded_by_id` 与 `retired_reason`。旧根 `status` 保持 `ACTIVE`，有效状态派生为 `SUPERSEDED`。

## 3. 验证与修订

- `verification` 只有 `VERIFIED` / `UNVERIFIED` / `FAILED`；
- 人工确认的新记忆通常为 `VERIFIED`；自动捕获为 `UNVERIFIED`；失败经验可显式 `FAILED`；
- 编辑正文产生新版本。正文变化后默认重置为 `UNVERIFIED`，除非请求显式给出验证状态；同时重算置信度、设置或清空 `verified_at`；新修订会清除旧的 `stale_at`，避免已更新内容继续被默认召回过滤。
- 固定只影响常驻召回，不提升事实真实性。

## 4. 有效状态

有效状态按以下顺序派生：

`RETIRED` > `SUPERSEDED` > `EXPIRED` > `STALE` > `ACTIVE`

- `RETIRED`：根 `status` 非 ACTIVE，用户明确停用；
- `SUPERSEDED`：`superseded_by_id` 非空；
- `EXPIRED`：当前版本 `expires_at` 已过；
- `STALE`：`stale_at` 非空；
- `ACTIVE`：其余。

派生状态不写回根，避免两套可写状态。召回默认排除 RETIRED/SUPERSEDED/EXPIRED/STALE；设置 `include_stale_in_recall=true` 才纳入 STALE，且作为参考数据标注。

## 5. 整理（Consolidation）

手动命令与 Worker 低频 tick 调用同一确定性整理：

- 同内容指纹/同键分组，保留来源更可信、更新时间更新、内容更完整者；其余标记替代；
- 超过 `memory_stale_after_days` 的项目事实/经验标记 `STALE`；
- 回填缺失 token 与内容指纹，使 GIN 索引可用；
- 写 `memory_maintenance_runs` 记录触发者、统计、错误与完成时间；
- 只处理一个到期工作区/拍，避免阻塞主流程；无设置行按默认 `auto_consolidate=true`、24h 间隔、180d 陈旧阈值。

整理不调用模型，不生成新事实；低可信内容不能因为被多次摘要而升级为高可信知识。失败只结束本次运行，不损坏已有数据。

## 6. 过期与停用

- 用户明确指定的稳定偏好通常不自动过期；
- 项目事实/经验可因老化标 `STALE`，使用前应重新核对文件、命令或测试；
- 历史事件可长期保留，但不等同当前事实；
- 临时状态不应进入长期记忆；
- 用户停用（RETIRED）退出召回但保留历史；恢复只把根状态改回 ACTIVE，不改变正文版本。

## 7. 导入、导出与删除

- 导出携带正文与元数据，不含会话/消息凭据；项目导出必须在项目作用域导入；
- 导入 `schema_version=1`，单次最多 200 条、payload ≤ 1,000,000 字节；逐行校验作用域、项目归属和键；
- 清理失效项按派生状态反选并排除固定项：停用、过期、被替代、可能过时都会清理，不会碰当前有效或固定项；
- 硬删除必须输入 `DELETE_MEMORIES`；事务内摘除替代链、自动捕获、来源引用、版本、根；
- 删除后不会从旧索引或旧摘要恢复；全文索引随根删除，重建时只从现存根回填。

## 8. 与压缩/恢复的接缝

- 压缩触发时先尝试有界保存候选；失败或超时只记录待处理，不无限阻塞压缩；
- 压缩摘要不作为新证据，不提升可信度；召回时重新按来源与版本核对；
- 任务恢复先读真实 Checkpoint 和工具状态，记忆只提供规则/偏好/历史经验，不能替代「工具是否已执行」；
- 主动中断/重启后，未完成提取保留可重试记录；不把记忆正文当作执行状态。

## 9. 相关入口

- 写入：`memory-write.ts`、`information-commands.ts`、`memory-captures.ts`
- 召回：`memory-recall.ts`
- 整理：`memory-consolidation.ts`、`memory-commands.ts`
- 导入导出/删除：`memory-transfer.ts`
- 统计：`memory-observability.ts`

# 长期记忆生命周期

本文是 [Memory Architecture](memory-system-v2.md) 的生命周期分册，描述实际代码中的写入、验证、替代、整理、过期、停用和删除。所有动作以 Information 领域入口为准；UI 只调用真实命令。

## 1. 写入时机

- 用户明确说“记住/remember”：走显式路径，形成候选后写真实库并返回回执；
- 显式保存消息或手动创建；
- 自动捕获在会话结算后登记持久任务，由 Worker 异步提取；单会话每日有上限；
- 任务完成且经过必要验证后，可写入已确认经验；
- 导入是独立入口，不伪装成自动捕获。

普通寒暄、临时工具输出、无长期价值的问答不进入长期记忆。自动捕获默认 `UNVERIFIED`，不冒充人工确认；显式记住使用 `HUMAN_CONFIRMED` + `USER_STATEMENT` 来源，但不因此绕过去重、冲突或敏感信息拒绝。

显式写入的正文是用户原话（`trimContent` 去掉句尾标点/客套），来源固定为触发消息的前一条用户消息，并记录 `sourceContentHash`。显式任务仍执行敏感凭证拒绝、重复指纹、同键冲突裁决和事务写入；显式成功写 `MEMORY_EXPLICIT_REMEMBER`，重复执行复用任务身份和去重指纹，不产生第二条有效记忆。显式写入异常走 `INTERNAL` 重试；`intent===null` 时收口 `EXPLICIT_INTENT_MISSING` 并保留失败回执。

显式意图在**入队阶段**识别，不依赖 Worker 执行到哪一步：

| 用户设置 | 普通对话自动提取 | 显式“记住” |
|---|---|---|
| `auto_capture=true` | 允许（受配额/寒暄过滤） | 允许 |
| `auto_capture=false` | 禁止，收口 `AUTO_CAPTURE_DISABLED` | 仍允许，不受每日自动配额与寒暄过滤影响 |
| `session.remember=false` | 禁止 | 仍插 EXPLICIT 任务并立即收口 `CANCELLED + MEMORY_DISABLED`，留下真实回执 |

显式任务允许助手回复为空；自动任务仍要求非空回复。遗留 AUTO 任务执行时识别到显式意图，会创建 EXPLICIT 任务并把 AUTO 收口为 `CONVERTED_TO_EXPLICIT`，以新任务身份幂等执行。

## 2. 写入裁决

`prepareMemoryCandidate` 先归一化类型、`memory_key`、内容 hash 和 token，并运行敏感凭证识别与指令风险检测。`decideMemoryWrite` 在**完全相同作用域**的候选内裁决：

1. 内容 hash 相同或归一化标题+正文相同 → `DUPLICATE`，不写第二份；
2. 同作用域、同类型、同 key：
   - 显式人工保存/导入（`force`）→ 新事实替代旧事实；
   - 自动来源遇到旧事实已验证或固定 → `CONFLICT`，不顶掉；
   - 来源可信度更高或同级且置信度不低于旧事实 → `SUPERSEDE`；
   - 否则 `CONFLICT`；
3. 无 key 时，仅同类型且 token Jaccard ≥ 0.8 判近似重复；
4. 敏感凭证 → `REJECTED_SENSITIVE`，调用方返回可理解字段错误。

替代不是覆盖正文：插入新根和 v1，旧根保留原文与版本，只设置 `superseded_by_id` 与 `retired_reason`。旧根 `status` 保持 `ACTIVE`，有效状态派生为 `SUPERSEDED`；后续修订被拒绝，避免旧事实“复活”。

## 3. 验证与修订

- `verification` 只有 `VERIFIED` / `UNVERIFIED` / `FAILED`；
- 人工确认的新记忆通常为 `VERIFIED`；自动捕获为 `UNVERIFIED`；失败经验可显式 `FAILED`；
- 编辑正文产生新版本，默认重置为 `UNVERIFIED`，并重算置信度、设置或清空 `verified_at`；新修订清空 `stale_at`，同时重算 `instruction_risk`；
- 固定只影响常驻召回，不提升事实真实性，也不能让固定记忆被同置信度自动观察替代；
- 验证状态只代表事实可信程度，不代表指令权限。

## 4. 有效状态与有效期

有效状态按以下顺序派生：

`RETIRED` > `SUPERSEDED` > `EXPIRED` > `STALE` > `ACTIVE`

- `RETIRED`：根 `status` 非 ACTIVE，用户明确停用；
- `SUPERSEDED`：`superseded_by_id` 非空；
- `EXPIRED`：当前版本 `expires_at` 或 `expires_at_override` 已过；
- `STALE`：`stale_at` 非空（按类型窗口或整理标记）；
- `ACTIVE`：其余。

派生状态不写回根，避免两套可写状态。召回排除 RETIRED/SUPERSEDED/EXPIRED/STALE；固定项即使 STALE 也常驻，普通 STALE 不接受 `include_stale_in_recall` 的旧口径。

有效期可以手动延长 +30 天、+1 年或改为长期；恢复停用只把根状态改回 ACTIVE，不延长已过期有效期。

## 5. 整理（Consolidation）

手动命令与 Worker 低频 tick 调用同一确定性整理：

- 同内容指纹/同键分组，保留来源更可信、更新时间更新、内容更完整者；其余标记替代；
- 按类型标记陈旧：`EPISODIC` 30 天、`EXPERIENCE` 90 天、`PROJECT_FACT` 使用 `memory_stale_after_days`、`UNKNOWN` 120 天；`USER_PREFERENCE` 不自动陈旧；
- 回填缺失 token 与内容指纹，使 GIN 索引可用；
- 写 `memory_maintenance_runs` 记录触发者、统计、错误与完成时间；
- 每拍只处理一个到期工作区，避免阻塞主流程；无设置行按默认 `auto_consolidate=true`、24h 间隔。

整理不调用模型，不生成新事实；模型无法确定两条记忆是否重复时，不允许合并或删除。失败只结束本次运行，不损坏已有数据。

## 6. 过期、停用与删除

- 用户偏好的稳定事实不自动过期；项目事实、经验、事件按各自窗口老化，使用前应重新核对文件、命令或测试；
- 历史事件可长期保留，但不等同当前事实；临时状态不进入长期记忆；
- 停用（RETIRED）退出召回但保留正文、版本、来源与替代链，可恢复；
- 过期（EXPIRED）与替代（SUPERSEDED）各自独立，停用/恢复不会重写它们；
- 真实删除必须先输入 `DELETE_MEMORIES`；事务内摘除替代链、自动捕获、来源引用、版本、根，并清理全文索引与派生缓存；删除后不会从旧索引或旧摘要恢复。

## 7. 导入、导出与删除

- 导出携带 `schema_version=2`、正文、版本、作用域、来源类别、置信度、验证与固定状态，不含会话/消息凭据；
- 导入 `schema_version=2`，单次最多 200 条、payload ≤ 1,000,000 字节；逐行校验作用域、项目归属、键、版本与验证状态，旧 v1 文件按兼容路径读取但不会把自动来源升级为人工确认；
- 清理失效项按派生状态反选并排除固定项：停用、过期、被替代、可能过时都会清理，不会碰当前有效或固定项；
- 删除后不再出现在列表、统计或召回中，也不会从旧摘要恢复。

## 8. 与压缩/恢复的接缝

- 捕获任务在结算后先落库，状态为 `PENDING` / `RUNNING` / `SUCCEEDED` / `EMPTY` / `FAILED` / `CANCELLED`；
- 压缩前只检查**即将被 Checkpoint 覆盖的消息**上未结算的捕获任务（`trigger_message_id/user_message_id` 限定），不是整个会话一律阻塞；
- 手动压缩遇 PENDING/RUNNING 返回 409 `MEMORY_CAPTURE_PENDING`；
- 自动压缩不阻塞当前回复：当前消息照常完成，系统插入持久 AUTO 请求并 `deferAutomaticRequest`，请求收口 `FAILED + MEMORY_CAPTURE_PENDING`，当前 Checkpoint 不变；已有 deferred 请求不重复创建；
- 捕获任务到达终态后，捕获 tick 调用 `resumeDeferredAutomaticRequests()` 自动恢复压缩；当前轮消息保持原文，压缩只覆盖已结算的旧消息前缀（验收场景 `through_seq=26`，35/36 当前轮不删）；
- 捕获失败按 1/5/15 分钟退避重试，最多 3 次；Worker 崩溃后租约过期由下一拍恢复；所有候选写失败按 `WRITE_FAILED` 重试，不伪装成 EMPTY；
- 重放时去重命中不再误收口为 EMPTY，而是返回 `{ duplicate: true, memoryId }` 并计为 `SUCCEEDED + duplicate`；
- 压缩摘要不作为新证据，不提升可信度；召回时重新按来源与版本核对；
- 任务恢复先读真实 Checkpoint 和工具状态，记忆只提供规则/偏好/历史经验，不能替代“工具是否已执行”；
- 主动中断/重启后，未完成提取保留可重试记录；不把记忆正文当作执行状态；任何压缩失败都保留原始消息与上一个有效 Checkpoint。

## 9. 相关入口

- 写入：`memory-write.ts`、`memory-explicit.ts`、`memory-auto-capture.ts`、`information-commands.ts`
- 召回：`memory-recall.ts`
- 整理：`memory-consolidation.ts`、`memory-commands.ts`
- 导入导出/删除：`memory-transfer.ts`
- 统计与捕获任务：`memory-observability.ts`、`information-repository.ts`
- 页面：`apps/workbench/src/views/MemoryView.tsx`

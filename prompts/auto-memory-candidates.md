# 长期记忆自动捕获：后端工作包（2026-10-20，零点击版）

用户 2026-10-20 先指认「长期记忆应该是自动保存有价值的内容而不是手动」，随后否决了「候选 + 一次确认」的确认环节（「要人手动确认感觉很麻烦」）。方向与取舍归 [ADR-030](../docs/decisions/ADR-030-zero-click-auto-memory.md)（取代 [ADR-029](../docs/decisions/ADR-029-auto-memory-candidates.md) 的确认环节），本文只定工程边界与验收出口。

**本文取代 2026-10-20 早间的同文件草稿（候选 + 接受端点）。** 现在没有「待确认队列」，只有「已生效 + 可撤销」。

~~~text
你在 D:/Develop/Relay-Agent 工作，所有说明用中文。本工作包只做后端（提取链 + 自动记忆存储 + 撤销端点 + 设置开关 + 召回标注），不开发前端、不改短期窗口与压缩语义、不改用户数据库、不 commit/push。

一、先核对事实

先读 docs/decisions/ADR-030-zero-click-auto-memory.md（方向与代价）、docs/decisions/ADR-028-memory-layers.md（确认与召回不变量，本工作包只在 origin 维度上扩展）、docs/api/http-command-contract.md §10.98–10.99（既有记忆接口与命令回执协议）、docs/development/memory-module.md（模块非目标）、CODEX_NEXT_STEP 与统一验收表「完整长短期记忆后端」「长短期记忆前端接线」两行。

再核对源码：apps/api/src/application/assist-memory.ts、memory-settings.ts、memory-recall.ts、information-commands.ts（createMemoryFromMessage 的来源 hash 与范围校验）、information-queries.ts（记忆列表/详情投影）、assist-runner.ts 的 settle() 成功路径、assist/assist-memory-repository.ts、information/information-repository.ts（insertMemoryRoot/insertMemoryVersion/insertMemoryMessageSource）、infrastructure/database-schema.ts、migrations 目录（当前最新 0124，本包用 0125）。

先检查 git status 与目标文件 diff：工作树有大量并行改动，不得回退或覆盖。迁移只追加、不改已应用迁移。

二、边界（先记住这几条）

1. **自动记忆是 Memory，不是另一个东西**：复用 memory_roots / memory_versions / memory_message_sources；新增的只是「它是谁写的」这一维（origin）与「哪次提取、是否已撤销」这一层（memory_auto_captures）。Information 仍是唯一写入 Owner。
2. **不冒充人**：`confirmed_by` 记 `auto-capture`，`origin = AUTO_CAPTURE`；任何投影、召回、界面都不得把自动记忆显示成人工确认。
3. **不阻塞主回复**：提取在结算之后；超时、非法 JSON、预算不足、Worker 丢失、端口异常一律放弃这一轮，不写记忆、不改聊天正文、不重试、不换模型。
4. **不改召回口径，只加排序与标注**：仍是最多 3 条、合计 8000 字符、与手工资料合计最多 20 来源、同 Workspace 全局 + 当前 Project、仅有效未过期。唯一变化：同范围内 `HUMAN_CONFIRMED` 先于 `AUTO_CAPTURE`；来源投影带 origin。
5. **撤销是停用不是删除**：复用 retire 语义，保留版本与审计；同时写去重指纹，之后同一内容不再提取。

三、数据（migration 0125）

1. `ALTER TABLE memories ADD COLUMN origin text NOT NULL DEFAULT 'HUMAN_CONFIRMED' CHECK (origin IN ('HUMAN_CONFIRMED','AUTO_CAPTURE'))`。旧数据全部落为 HUMAN_CONFIRMED，行为不变。
2. 新表 `memory_auto_captures`：`id`、`workspace_id`、`project_id`（可空）、`session_id`、`message_id`（被提取的 ASSISTANT 消息）、`source_sha256`（该消息正文 UTF-8 SHA256）、`normalized_sha256`（title+text 归一化摘要）、`memory_id`（写入后的 Memory）、`status`（ACTIVE / RETIRED）、`revision`、`created_at`、`decided_at`、`decided_by`。
   - 唯一：`(session_id, message_id, normalized_sha256)`——同一来源同一内容只提取一次。
   - 索引：`(workspace_id, status, created_at)`（最近自动记住列表）、`(session_id, created_at)`（每日限频计数）。
   - `status = RETIRED` 时 `decided_at`/`decided_by` 必须非空（CHECK）。
3. **必须 `GRANT SELECT, INSERT, UPDATE ON memory_auto_captures TO relay_app`**（`memories` 的 ALTER 不需要新授权）。此前 `model_capability_declarations` 漏 GRANT 让 `/model-port` 静默降级为 UNKNOWN，这次不要再踩。

四、提取链

- **触发点**：普通 AGENT 会话、`session.remember = true`、`auto_capture = true`、assistant 消息以 COMPLETED 结算成功之后（settle 提交之后，不在同一长事务内）。按 `message_id` 幂等。
- **限频**：同一会话每日最多 5 条自动记忆（按 `memory_auto_captures.created_at` 当日计数，时区按 UTC）；超出只写 activity、不写 Memory。
- **输入**：这一轮用户原文 + 助手正文，合计上限 8000 字符（超限截断，不编造）。不重发全历史，不读取新的外部来源。
- **输出**：严格 JSON `{"memories":[{"title","text","reason"}]}`，最多 3 条；空数组合法。
- **只提取明确陈述**：决定、约定、偏好、事实性结论；不提取推测、一次性任务细节、寒暄。prompt 里必须写清这条，并要求「没有就返回空数组」。
- **去重**：与同范围现有 ACTIVE 记忆归一化后完全重复 → 不写；与已 RETIRED 的同一 `(session_id, message_id, normalized_sha256)` → 不写；标题或正文为空 → 丢弃。不做语义去重、不引入向量库。
- **模型与计量**：使用该会话冻结的模型选择，走既有 `model_calls`，用途标记 `MEMORY_AUTO_CAPTURE`；预算不足即放弃，不降级到别的模型，不修改原消息 usage。
- **写入**：同一事务内写 Memory 根（origin=AUTO_CAPTURE）、版本（confirmed_by='auto-capture'）、来源行（session_id/message_id/source_sha256）与 `memory_auto_captures`（ACTIVE）。写完后 `bumpContextRevision`，并记 activity `MEMORY_AUTO_CAPTURED`。
- **不可提取的对象**：ASSISTANT/LEARNING 会话、一次性模式、归档会话/项目、FAILED/CANCELLED 轮次。

五、召回与投影

- `memory-recall.ts`：同范围内先取 HUMAN_CONFIRMED 再取 AUTO_CAPTURE（各自仍受条数与字符上限约束）；来源记录增加 `origin` 字段；`selection_basis` 语义不变。
- 消息 sources 与 checkpoint sources 的投影带 `origin`（`recheckAssistSources` 的 safeSources 透传），前端据此标「自动记住」。
- `GET /memories`、`GET /memories/{id}`、修订列表返回 `origin`；旧服务端/旧数据缺字段按 `HUMAN_CONFIRMED` 处理（兼容读，不改变行为）。

六、端点（均在 `/api/v1/workspaces/{workspace_id}` 下）

1. `GET /memory-auto-captures?limit=20` → `{items:[{id, memory_id, session_id, message_id, title, text, origin, status, source_sha256, created_at, revision}]}`。只读，`Cache-Control: no-store`；默认只列 ACTIVE，按时间倒序。
2. `POST /memory-auto-captures/{id}/retire`，body `{command_id, expected_revision}` → **200**，result `{capture_id, memory_id, status:"RETIRED", memory_status:"RETIRED"}`。同一事务内：停用 Memory 根（复用 retire 语义）、把 capture 置 RETIRED 并记 decided_at/decided_by、保留来源与版本。
3. 命令遵循既有回执协议：同 command_id 重放返回原回执；同 ID 异载荷 409；`expected_revision` 落后 409 且回执带两个修订；已 RETIRED 再撤销按 409 拒绝。
4. **不提供**「接受/确认」端点：自动记忆写入即生效。手动保存入口（HTTP §10.99 的消息保存）保留不变。

七、测试

先建立反例，记录有意义的红→绿：

- 真实临时 PG 集成（0125 实际应用）：结算后写入自动记忆且 origin/confirmed_by 正确；同一消息重复触发不重复写；0 条、3 条、超 3 条截断；与现有记忆重复不写；撤销后 Memory 停用且 capture=RETIRED、同内容不再提取；撤销后再撤销 409；每日上限 5 条后只记 activity；一次性模式/归档会话/关闭开关不提取；提取失败（端口抛错、非法 JSON、预算不足）不写记忆且主回复正常；自动记忆出现在召回但排在人工记忆之后；消息 sources 带 origin；`/memories` 投影带 origin 且旧数据为 HUMAN_CONFIRMED。
- 单元：归一化摘要稳定（空白/标点/全半角归一）、JSON 解析与条数截断、8000 字符截断、每日限频计数。
- 复跑受影响的集成（memory-module、assist-memory、memory-status、agent-conversation-main-loop）确认无回归；不得删除失败检查或改断言求绿。
- 记录：Fake 模型只能证明工程链路；真实 Provider 的误报率、重复率与成本必须单列未验。

八、文档与交付

- 更新 [HTTP 契约]（新增 §10.105 自动记忆接口与 origin 字段）、数据库物理设计（0125）、ADR-030 状态、memory-module.md、工作台 §40（前端待接）、CODEX_NEXT_STEP、统一验收表新增「长期记忆自动捕获（后端）」行；只更新受影响事实。
- 运行 `node scripts/check-docs.mjs`。
- 完成后再单独交付前端任务书（资料页记忆列表的「自动记住」标注 + 复用既有「停用记忆」作为撤销 + 设置第三个开关 + 消息来源标注）；**不新增常驻面板、不收件箱、不加角标**。本包交付不代表前端已实施。

完成标准：自动记忆在真实主流程里写入并可召回、origin 全程可辨、撤销能止住重复、失败不打扰主回复、真实 PG 反例通过、文档一致。需要改召回上限或引入语义去重时，报告差异与影响，不擅自扩大范围。
~~~

## 交付状态

2026-10-20 按 ADR-030 重写，同日实施到「自检」出口：迁移 0125、提取链、撤销端点、origin 投影与第三开关均已写入源码，前端开关与「自动记住」标注已接。

**未闭合**：真实 PG 集成未跑（迁移未应用，写入/去重/限频/撤销/召回排序只有类型与单测证据）；真实 Provider 提取质量与成本未验；未做独立验收；未 commit/push。早间「候选 + 确认」草稿已作废，不要按它实施。

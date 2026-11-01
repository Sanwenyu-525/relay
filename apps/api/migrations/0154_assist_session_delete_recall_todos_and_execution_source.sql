-- 0154：会话物理删除补齐 0116 之后新建的账本（ADR-027 续，接 0116 / 0133 / 0137）。
--
-- 背景：0116 按「会话自有账本 → 仓储层逐表显式删除」的口径授予了当时全部子表的 DELETE；
-- 之后 0132（撤回基线 / 撤回请求 / 保护副本 / 撤销）、0146 与 0151（会话待办清单）、
-- 0148（子代理补充消息）又建了引用 `assist_sessions` / `assist_messages` 的表，却只授了
-- SELECT / INSERT / UPDATE。于是「发过消息、绑过目录、写过待办」的会话一删除就撞两类错误：
--   * 权限：`assist_message_baseline_files`、`assist_message_recalls`、`assist_message_recall_files`、
--     `assist_message_recall_undos`、`assist_session_todo_snapshots`、`assist_session_todo_events`、
--     `assist_session_todo_turn_scopes`、`assist_delegation_supplements` 上没有 DELETE，
--     显式删除或 `ON DELETE CASCADE` 都会 permission denied；
--   * 外键：`assist_delegation_supplements.source_message_id` 默认 NO ACTION，而删除路径没有覆盖它。
-- 两者都落到 500 `INTERNAL_ERROR`（详情「请通过 request_id 在本机日志中核对」），
-- 界面上看起来像「删除失败」，真实原因是授权与解析顺序，不是业务阻断。
--
-- 只补删除路径真正需要的授权，不外溢：阻断面不变——被外部对象引用的行（Task 验收观察、
-- 项目假设、工作片段、蓝图提案、学习记录、分叉与子代理会话、委派账本的反向引用）仍在
-- `listDeleteBlockers` 整条拒绝，不借 DELETE 把别人的历史抹掉。
--
-- 回滚：撤销这些 GRANT 即回到「含撤回账本、待办清单或子代理补充的会话无法删除」；
-- 不涉及数据形状，已删除的会话不会因回滚恢复。

GRANT DELETE ON
  assist_message_baseline_files, assist_message_recalls,
  assist_message_recall_files, assist_message_recall_undos,
  assist_session_todo_snapshots, assist_session_todo_events,
  assist_session_todo_turn_scopes, assist_delegation_supplements
TO relay_app;

-- ── 执行请求的来源凭据脱离聊天历史 ────────────────────────────────────────────
--
-- `conversation_execution_requests` 同时引用会话与原用户消息（默认 NO ACTION），并承载
-- 「这条任务从哪条消息来」的授权来源。删除会话时既不能删掉请求行（那是 Task/Run 的来源
-- 事实），也不能把外键置空（等于替它改历史）。此前只能整条阻断删除，代价是「发过一次执行
-- 请求，这段讨论就永远删不掉」。
--
-- 这里改成**受约束的最小 tombstone**：请求行保留，来源身份从「硬外键」变成「持久凭据」。
--   * 去掉指向 `assist_sessions` / `assist_messages` 的两条外键，两列仍是普通 uuid 列
--     （与 `conversation_diff_baselines.session_id` 的既有口径一致：身份留着、完整性不再
--     由数据库代管）；
--   * 删除会话时把来源消息的序号与正文摘要、脱钩时刻写进请求行，任务侧仍能核对
--     「这条请求当初来自哪条消息、什么内容」——摘要只能核对，不能还原正文；
--   * 不复制消息正文、不复制会话标题：用户要求删除聊天，审计不该变成第二份保存。
--
-- 语义变化只有一条，而且是**失败关闭**：`source_detached_at` 非空表示来源聊天已删除，
-- 这条请求不能再被推进成新的 Task/Run（应用层会以 409 拒绝）。已经产生的 Task/Run 不受
-- 影响，它们本来就不依赖会话存活。
--
-- 回滚：删除新增列并恢复两条外键即可回到旧形状；但已脱钩的行无法再指回已删除的消息，
-- 恢复外键会失败——回滚只对「没删过会话」的库成立，这一点必须在回滚前核对。

ALTER TABLE conversation_execution_requests
  DROP CONSTRAINT conversation_execution_requests_session_id_fkey,
  DROP CONSTRAINT conversation_execution_requests_source_message_id_fkey;

ALTER TABLE conversation_execution_requests
  ADD COLUMN source_message_seq bigint,
  ADD COLUMN source_message_sha256 bytea,
  ADD COLUMN source_detached_at timestamptz,
  ADD CONSTRAINT ck_conversation_execution_source_digest
    CHECK (source_message_sha256 IS NULL OR length(source_message_sha256) = 32),
  -- 脱钩必须连同来源序号一起写下：只有「已脱钩」而没有「哪一条」的凭据无法核对。
  ADD CONSTRAINT ck_conversation_execution_source_detached
    CHECK (source_detached_at IS NULL OR source_message_seq IS NOT NULL);

-- 存量行：外键还在，来源消息必然存在，按消息补齐序号与摘要（只补缺失的，不覆盖）。
UPDATE conversation_execution_requests r
   SET source_message_seq = m.seq,
       source_message_sha256 = sha256(convert_to(coalesce(m.content, ''), 'UTF8'))
  FROM assist_messages m
 WHERE m.id = r.source_message_id
   AND (r.source_message_seq IS NULL OR r.source_message_sha256 IS NULL);

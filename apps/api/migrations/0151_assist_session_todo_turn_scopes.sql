-- ADR-038 第五轮（2026-10-30/31）：工作身份的服务端持久化。
--
-- 此前「这一轮属于哪个工作」是写入时现算的：插话会改变「最新一轮」的判定，同一轮里
-- 两次写入可能落进不同作用域；崩溃恢复重算时也可能把延续轮次的调用判回它自己的
-- turn 键、被轮次顺序闸门误拒。这里把归属在**首次判定时冻结**成持久事实：
--   * 每条用户消息一行，scope_key 是它归属的工作作用域，basis 记录判定依据
--     （OPENED 开新作用域 / CONTINUED_UNFINISHED 延续未完成清单 / FORCED_NEW_PREFIX
--     用户写明「新任务：」或 /newtask）；
--   * 判定只由服务端事实驱动（用户消息原文、当前快照状态），模型写入不改变归属，
--     也不能静默切换作用域；
--   * 事件、快照、CAS 与 scope_seq 的语义不变：scope_seq 仍取作用域开启消息的 seq，
--     快照行依旧是唯一当前投影。
-- 历史回填只补「作用域开启轮次」这个可从 scope_key 直接还原的事实；延续归属无法从
-- 存量数据重建，留给未来的首次判定按现行规则现算（恢复重放不受影响：同身份重放
-- 走事件表，不依赖归属行）。

CREATE TABLE assist_session_todo_turn_scopes (
  session_id uuid NOT NULL REFERENCES assist_sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES assist_messages(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  basis text NOT NULL CHECK (basis IN ('OPENED', 'CONTINUED_UNFINISHED', 'FORCED_NEW_PREFIX')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_id)
);

INSERT INTO assist_session_todo_turn_scopes (session_id, message_id, scope_key, basis)
SELECT DISTINCT e.session_id, m.id, e.scope_key, 'OPENED'
  FROM assist_session_todo_events e
  JOIN assist_messages m
    ON e.scope_key = 'turn:' || m.id::text AND m.session_id = e.session_id
ON CONFLICT (session_id, message_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON assist_session_todo_turn_scopes TO relay_app;

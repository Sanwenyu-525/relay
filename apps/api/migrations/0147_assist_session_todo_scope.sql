-- 待办清单按工作轮次归属（ADR-038 补记，2026-10-30）。
--
-- 0146 把清单挂在 Session 上：一个会话只有一份清单，于是同一个会话里任务 A 收尾后，
-- 用户再提一件独立任务 B，B 会继承 A 的清单。这里改成「一个工作轮次一份清单」：
--   * `scope_key` 就是开启这一轮的用户消息（`turn:<message_id>`），没有用户消息时为 'session'；
--   * 快照仍然一会话一行，但只代表「当前轮次」；不属于当前轮次等于这一轮没有清单，
--     旧轮次的清单不得被当作本轮进度继续注入或展示；
--   * 事件表的唯一性从 (session_id, version) 改成 (session_id, scope_key, version)，
--     同一轮次的版本串仍然连续，不同轮次各自从 1 开始；
--   * (session_id, tool_call_id) 唯一约束不变：调用身份仍然是幂等与异载荷拒绝的依据。

ALTER TABLE assist_session_todo_snapshots ADD COLUMN scope_key text NOT NULL DEFAULT 'session';
ALTER TABLE assist_session_todo_events ADD COLUMN scope_key text NOT NULL DEFAULT 'session';

DO $migration$
DECLARE stale text;
BEGIN
  SELECT conname INTO stale FROM pg_constraint
   WHERE conrelid = 'assist_session_todo_events'::regclass
     AND contype = 'u'
     AND conname = 'assist_session_todo_events_session_id_version_key';
  IF stale IS NOT NULL THEN
    EXECUTE format('ALTER TABLE assist_session_todo_events DROP CONSTRAINT %I', stale);
  END IF;
END
$migration$;

ALTER TABLE assist_session_todo_events
  ADD CONSTRAINT assist_session_todo_events_scope_version_key
  UNIQUE (session_id, scope_key, version);

GRANT SELECT, INSERT, UPDATE ON assist_session_todo_snapshots, assist_session_todo_events TO relay_app;
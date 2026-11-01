-- 0156：执行透明性的观察时间（2026-11-01 ENG-OBS-02 P0-B）
--
-- 三列都只记录 Relay 自己观察到的时刻，不是 Provider 事实、不是 lease：
--   * assist_messages.claimed_at：Worker 领取这条消息的时刻；重新排队时清空。
--   * assist_messages.settled_at：消息进入 COMPLETED/FAILED/CANCELLED 的时刻；
--     撤回/改名/置顶不覆盖它。
--   * session_tool_calls.bound_at：工具行绑定 Gateway Operation 的时刻；
--     Operation 绑定前的 prepare/attach 崩溃窗口不伪造。
-- 旧行保持 NULL，读取侧必须显示“时间未记录”，不能回填推测值。
ALTER TABLE assist_messages
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN settled_at timestamptz;

ALTER TABLE session_tool_calls
  ADD COLUMN bound_at timestamptz;

GRANT UPDATE (bound_at) ON session_tool_calls TO relay_app;

COMMENT ON COLUMN assist_messages.claimed_at IS
  'Worker 领取该消息的观察时刻；重新排队时清空，旧行 NULL';
COMMENT ON COLUMN assist_messages.settled_at IS
  '消息进入终态（COMPLETED/FAILED/CANCELLED）的观察时刻；撤回/编辑不覆盖';
COMMENT ON COLUMN session_tool_calls.bound_at IS
  '工具行绑定 Gateway Operation 的观察时刻；prepare/attach 崩溃窗口不伪造';

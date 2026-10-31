-- ADR-038 第三轮（2026-10-30）：工作轮次顺序与规范化请求摘要。
--
-- `scope_seq` 是该轮次的顺序号（开启这一轮的用户消息 seq），用于阻止旧轮次的
-- 迟到写入覆盖新轮次的当前投影；`request_digest` 是同身份重放的规范化请求摘要
-- （基线版本 + 条目身份 + 内容 + 状态），换载荷重放会因此被识别为身份伪造。

ALTER TABLE assist_session_todo_snapshots ADD COLUMN scope_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE assist_session_todo_events ADD COLUMN scope_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE assist_session_todo_events ADD COLUMN request_digest text;

UPDATE assist_session_todo_snapshots s
   SET scope_seq = m.seq
  FROM assist_messages m
 WHERE s.scope_key = 'turn:' || m.id::text;

UPDATE assist_session_todo_events e
   SET scope_seq = m.seq
  FROM assist_messages m
 WHERE e.scope_key = 'turn:' || m.id::text;
-- M05 消息层 FIFO 队列：保证 claimNextPendingMessage 的排序确定性
-- 依据：runtime-context.md §2.3、assist-repository.ts claimNextPendingMessage
-- 问题：assist_messages.id 是 uuid（随机），同一毫秒多条提交时 order by created_at, id
--       可能得不到严格 FIFO。加部分唯一索引 + index，确保排序结果唯一且有序。

-- 1) 防止同一会话同一秒内多条相同 created_at 的行冲突，确保 order by 有序
CREATE UNIQUE INDEX uq_assist_messages_session_created_at_id
  ON assist_messages (session_id, created_at, id)
  WHERE status IN ('PENDING', 'RUNNING');

-- 2) 常规 FIFO 查询索引：claimNextPendingMessage 里的 order by 走这条
CREATE INDEX ix_assist_messages_session_pending_fifo
  ON assist_messages (session_id, created_at, id)
  WHERE status = 'PENDING';

-- 3) 权限不在索引上单独授予：PostgreSQL 拒绝 GRANT ... ON <index>
--    （报 "X" is an index），索引的 SELECT 权限跟随所属表。
--    assist_messages 的表级 SELECT 已由 0015_m04_assist.sql 授予 relay_app，
--    本迁移新建的两个索引自动继承，不需要也不允许再单独 GRANT。
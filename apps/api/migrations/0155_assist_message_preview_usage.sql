-- 0155：生成中的 Token 进度（2026-11-01 AGENT-LIVE-TOKEN-USAGE）
--
-- `assist_message_previews` 是**可丢弃展示投影**：消息结算的同一事务会删除整行。
-- 实时 Token 读数挂在同一行上，因此天然共享这条生命周期，不新建第二套计量账本。
--
-- 列内容只描述**当前在途调用**的估算（call_id + 输入/输出估算 + Provider 已上报
-- 字段）。已结算调用的真实用量仍只在 `model_calls`；读侧把两者合并时，只有对应
-- call 仍为 STARTED 的估算才参与，结算后账本优先，不会重复累计。
ALTER TABLE assist_message_previews ADD COLUMN usage jsonb;

COMMENT ON COLUMN assist_message_previews.usage IS
  '生成中的可丢弃用量估算；结算后由 model_calls 覆盖，不是计费事实';

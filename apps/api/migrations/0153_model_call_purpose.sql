-- 0153：模型调用的用途（2026-10-31 上下文用量口径核对）
--
-- 背景：会话里除了「回复用户的那一次生成」，还有两类**辅助外呼**——
--   ① 自动记忆提取（memory-auto-capture）：把刚结束的一轮抽成记忆条目；
--   ② 记忆压缩（assist-memory-runner）：把已结算历史压成摘要。
-- 两者都复用主对话的冻结预算、都挂在同一条 assistant message 上，因此也都会进
-- `model_calls`。它们**按设计不采上下文分项**（不是对话上下文，见 0145 的列注释），
-- 但这会让「最近一次调用」读到一条 512 tokens、没有分项的辅助调用，用户看到的
-- 就不是他刚收到的那次回复。
--
-- 用途是调用自己的事实，不能靠输入大小或时间差猜。默认 PRIMARY 覆盖所有既有行与
-- 所有主生成路径；只有辅助外呼显式写另外两个值。

ALTER TABLE model_calls
  ADD COLUMN purpose text NOT NULL DEFAULT 'PRIMARY';

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_purpose
  CHECK (purpose IN ('PRIMARY', 'MEMORY_CAPTURE', 'MEMORY_COMPACT'));

COMMENT ON COLUMN model_calls.purpose IS
  'PRIMARY=面向用户的生成（含工具续轮）；MEMORY_CAPTURE/COMPACT=辅助外呼，不参与「最近一次调用」读数';

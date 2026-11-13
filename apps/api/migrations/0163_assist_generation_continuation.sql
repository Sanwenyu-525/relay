-- 0163：普通会话生成的持久接续（Durable Task Continuation，2026-11-12）
--
-- 背景：租约过期的会话消息此前一律收敛为 FAILED/LEASE_LOST。用户只发一次请求、
-- 宿主意外退出后，回复就永久失败，必须重新提问；已经执行完的工具轮次也会随内存
-- 一起丢失，重跑时只能重新调用模型与工具。
--
-- 本迁移只加**恢复所需的最小事实**，不改任何既有行：
--
-- 1) `assist_messages.generation_attempt`
--    这条助手消息已经开始的生成次数（1 = 首次）。意外中断后同一消息身份重新排队时
--    递增；到上界仍失败则落 FAILED + RECOVERY_EXHAUSTED，不会无限重启。
--    旧行默认 1，与「只生成过一次」一致，不回填推测值。
--
-- 2) `interrupted_at` / `interruption_reason`
--    最近一次观察到的中断时刻与类型化原因（LEASE_LOST / RECOVERY_BLOCKED_* /
--    RECOVERY_EXHAUSTED）。它们由服务端写入，前端只读，不得自行推断。
--
-- 3) `assist_generation_rounds`
--    一次生成里每个**已完成的工具回合**的检查点：模型给出的完整回合（工具请求、
--    前导说明、推理片段、回合前插话）与逐调用结果正文。恢复时按原轮次回灌，已结算
--    的工具不再派发；结果正文只用于恢复对话，不替代 `session_tool_calls`（那份账本
--    仍记录动作身份与外部副作用的核对依据）。
--    没有副作用的一次模型调用不写检查点：它是可重放的纯生成，不产生业务事实。
--
-- 只增列、只加表；回滚删除该表与三列即可，既有行与约束不受影响。

ALTER TABLE assist_messages
  ADD COLUMN generation_attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN interrupted_at timestamptz,
  ADD COLUMN interruption_reason text;

ALTER TABLE assist_messages
  ADD CONSTRAINT ck_assist_messages_generation_attempt CHECK (generation_attempt >= 1),
  ADD CONSTRAINT ck_assist_messages_interruption_reason CHECK (
    interruption_reason IS NULL OR interruption_reason <> '');

COMMENT ON COLUMN assist_messages.generation_attempt IS
  '这条助手消息已开始的生成次数；意外中断后同一消息身份重新排队时递增';
COMMENT ON COLUMN assist_messages.interrupted_at IS
  '最近一次观察到生成中断的时刻；旧行 NULL，不回填推测值';
COMMENT ON COLUMN assist_messages.interruption_reason IS
  '最近一次中断的类型化原因（LEASE_LOST / RECOVERY_BLOCKED_* / RECOVERY_EXHAUSTED）';

CREATE TABLE assist_generation_rounds (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  -- 产生这一回合的生成次数。恢复时会跳过既有回合，仍按 round 排序回灌。
  attempt integer NOT NULL CHECK (attempt >= 1),
  round integer NOT NULL CHECK (round >= 0),
  -- { calls: ModelToolCall[], steers_before?: string[], preamble?: string, reasoning_content?: string }
  assistant_turn jsonb NOT NULL CHECK (jsonb_typeof(assistant_turn) = 'object'),
  -- [{ provider_tool_call_id, name, content, is_error, slot }]；逐次追加，崩溃时可为部分结果。
  tool_results jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_results) = 'array'),
  usage jsonb,
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_assist_generation_rounds UNIQUE (message_id, round)
);

CREATE INDEX ix_assist_generation_rounds_message
  ON assist_generation_rounds (message_id, round);

GRANT SELECT, INSERT, UPDATE, DELETE ON assist_generation_rounds TO relay_app;

COMMENT ON TABLE assist_generation_rounds IS
  '会话生成的逐回合检查点；恢复时回灌已完成工具结果，不重新派发已结算动作';
COMMENT ON COLUMN assist_generation_rounds.tool_results IS
  '已回传给模型的工具结果正文（有界）；逐次追加，崩溃时允许部分结果';

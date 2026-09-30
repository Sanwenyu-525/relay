-- Assist 生成失败时，Provider 传输层类别上浮到消息行。
--
-- 此前六类归因（见 workflow/model-error-classification.ts）只写入 model_calls 账本，
-- 界面只能看到被压平的 MODEL_FAILED：密钥失效、限流、超时、断流在 UI 上完全无法区分。
-- 这里在消息行上独立成列，不并进 error_code —— error_code 是 Relay 自身的语义原因
-- （SESSION_MISSING / MODEL_BUDGET_EXHAUSTED / LEASE_LOST 等），而 Provider 类别是
-- 另一个维度（谁在传输层失败），合并会破坏按类别聚合，也不利于两轴各自演进。
--
-- 约束用封闭词表：拼写错误会直接被拒，而不是悄悄落库后在界面上变成未知类别。
-- 只允许出现在 FAILED 行上：类别描述的是失败归因，COMPLETED / CANCELLED 带类别没有
-- 事实依据（取消路径只保全 provider_request_id 与用量，不归因失败）。
ALTER TABLE assist_messages
  ADD COLUMN provider_error_kind text;

ALTER TABLE assist_messages
  ADD CONSTRAINT ck_assist_messages_provider_error_kind CHECK (
    provider_error_kind IS NULL OR provider_error_kind IN (
      'AUTH', 'RATE_LIMIT', 'TIMEOUT', 'STREAM_BROKEN', 'PROTOCOL', 'NETWORK'
    )
  );

ALTER TABLE assist_messages
  ADD CONSTRAINT ck_assist_messages_provider_error_kind_failed CHECK (
    provider_error_kind IS NULL OR status = 'FAILED'
  );


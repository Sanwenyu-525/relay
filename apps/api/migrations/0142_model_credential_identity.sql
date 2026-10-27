-- 2026-10-26：模型凭据身份（P0-2）。
--
-- 背景：`config_fingerprint` 只覆盖 Provider / 型号 / 端点 / 预算，换 API Key 不改变它。
-- 于是「A Key 验证成功、换成 B Key 后仍被判为已验证」，账户级冷却也会被另一个账户继承
-- （`model_provider_cooldowns` 的 ACCOUNT 行此前用固定指纹）。
--
-- 本迁移只加三列**服务端身份**，不改任何既有列、不回填、不放宽任何权限：
--
--   * `model_calls.credential_fingerprint`：每次真实外呼当时所用凭据的身份，供验证结果
--     失效判定与审计比较。空值＝该行产生于本迁移之前，按「未知」处理，不冒充匹配。
--   * `execution_contracts.credential_fingerprint`：Run 冻结时所用凭据的身份。它**不进**
--     `frozen_snapshot`——冻结快照会原样嵌入上下文清单并可能出现在界面，凭据摘要不能
--     出现在那里；契约摘要 `contract_hash` 仍只覆盖 `frozen_snapshot`，因此本列不改变
--     既有哈希语义。
--   * `assist_messages.model_credential_fingerprint`：会话消息受理时所用凭据的身份，
--     与 `model_selection_snapshot` 同一事务写入，语义相同（快照是公开计划，本列是
--     服务端身份）。
--
-- 值是 `sha256(domain ‖ provider ‖ key)` 的十六进制，单向且不可枚举（Provider Key 是
-- 高熵随机串）。任何 HTTP 响应都不返回它，日志也不记录。约束只保证形状：空或 64 位小写
-- 十六进制，避免把明文或截断值写进来。
--
-- 回滚：三列均为可空且无既有读依赖，直接 DROP COLUMN 即可恢复；不需要数据修复。

ALTER TABLE model_calls ADD COLUMN credential_fingerprint text;
ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_credential_fingerprint CHECK (
  credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$'
);

ALTER TABLE execution_contracts ADD COLUMN credential_fingerprint text;
ALTER TABLE execution_contracts ADD CONSTRAINT ck_execution_contracts_credential_fingerprint CHECK (
  credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$'
);

ALTER TABLE assist_messages ADD COLUMN model_credential_fingerprint text;
ALTER TABLE assist_messages ADD CONSTRAINT ck_assist_messages_model_credential_fingerprint CHECK (
  model_credential_fingerprint IS NULL OR model_credential_fingerprint ~ '^[0-9a-f]{64}$'
);

COMMENT ON COLUMN model_calls.credential_fingerprint IS
  '单向凭据身份（sha256, 域分隔）；仅服务端比较，永不返回给前端或写入日志。';
COMMENT ON COLUMN execution_contracts.credential_fingerprint IS
  'Run 冻结时的凭据身份；不进 frozen_snapshot，不参与 contract_hash。';
COMMENT ON COLUMN assist_messages.model_credential_fingerprint IS
  'Assist 消息受理时的凭据身份；与 model_selection_snapshot 同事务写入。';

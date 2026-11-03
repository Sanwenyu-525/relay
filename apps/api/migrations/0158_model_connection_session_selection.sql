-- 2026-11-02：模型配置与调用链路收口（MODEL-SETTINGS-01，ADR-036 阶段四）。
--
-- 三件事，都是**追加**，不改写既有迁移：
--
--   1. `session_model_selection` 可以绑定一条**已登记连接**。此前会话只能选进程默认模型或
--      OpenRouter 目录里的严格免费型号，设置页登记的连接在聊天里根本选不到——「登记了但
--      用不上」正是本任务要消掉的主缺陷。绑定用稳定 `connection_id`，不用显示名：同名可改、
--      型号可重复，只有 ID 能回答「这条选择到底指哪条连接」。
--   2. `workspace_default_model_connection.chat_connection_id`：工作区**聊天**默认连接。
--      0144 的 `connection_id` 只决定「新 Run 从哪条连接冻结」，把它直接当成聊天默认会
--      让所有既有会话在无人操作时换模型——那是未授权的 Provider 切换。因此新开一列，
--      两枚默认各自作用域、互不写回；未设置时聊天继续走进程默认（原兼容行为）。
--      既然两枚默认各自独立，任一都可以单独设置或单独取消：`connection_id` 因此放开 NOT NULL，
--      两列都为 NULL 表示「聊天与 Run 都回到进程默认」，是一个可表达、可解释的状态。
--   3. `assist_messages.model_connection_id`：消息受理时冻结的连接身份。执行端按它解析，
--      **不**重新读「当前默认连接」，否则改默认会让排队中的消息悄悄换 Provider。
--      与 `execution_contracts.connection_id`（0144）同一形态。
--   4. `model_calls.connection_id`：仅 VERIFY 行填写的连接归属。同一个 provider + 型号可以
--      被多条连接使用，只按 (provider, model) 汇总会把 A 的验证结论显示成 B 的；
--      「每条连接独立验证」因此需要这一列，不改 `model_calls` 的既有语义。
--
-- 凭据代数不在这里再冻一次：消息行已有 `model_credential_fingerprint`（0142），执行端按
-- 密钥摘要比对即可发现「换过 Key」；连接行被改动时配置指纹不符同样停止。
--
-- 0089 的连接取值 CHECK 是表内匿名约束（自动名 `session_model_selection_connection_check`），
-- 放宽它必须先按定义文本找到真实约束名——硬编码名字在别的库里可能不存在，静默跳过又会让
-- 迁移半成功。因此这里找不到就抛异常，绝不半应用。
--
-- 兼容与回滚：三列都可空、无回填。旧行 `connection` 仍是 default/openrouter 且
-- `connection_id` 为 NULL，天然满足新 CHECK；旧消息 `model_connection_id` 为 NULL，继续走
-- 进程默认解析路径。回滚：DROP 新列与新约束、把取值 CHECK 改回两枚即可，无数据修复。
-- API Breaking Change: No —— 纯新增列与新增可选响应字段，既有端点响应只增不减。

DO $$
DECLARE
  legacy_constraint text;
BEGIN
  SELECT c.conname INTO legacy_constraint
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'session_model_selection'
    AND c.contype = 'c'
    -- 列名 `connection` 在 pg_get_constraintdef 里是裸标识符，不带单引号；单引号只包住
    -- 枚举字面量 'default' / 'openrouter'。写成 %'connection'% 会永远匹配不上。
    AND pg_get_constraintdef(c.oid) LIKE $conn$%connection%$conn$
    AND pg_get_constraintdef(c.oid) LIKE $conn$%'default'%$conn$
    AND pg_get_constraintdef(c.oid) LIKE $conn$%'openrouter'%$conn$
    -- 0089 另有一条表级 CHECK 同时含 'default' 与 'openrouter'（connection = 'default' OR
    -- catalog_source = 'openrouter'）。它不是要替换的取值约束，按目录依据列排除。
    AND pg_get_constraintdef(c.oid) NOT LIKE $conn$%catalog_source%$conn$
    AND pg_get_constraintdef(c.oid) NOT LIKE $conn$%free_only%$conn$;
  IF legacy_constraint IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0158: the connection enum CHECK on session_model_selection was not found',
      HINT = 'This migration must replace that CHECK; refusing to half-apply. Inspect pg_constraint for session_model_selection.',
      ERRCODE = 'P0004';
  END IF;
  EXECUTE format('ALTER TABLE session_model_selection DROP CONSTRAINT %I', legacy_constraint);
END
$$;

ALTER TABLE session_model_selection
  ADD CONSTRAINT ck_session_model_selection_connection_kind
  CHECK (connection IN ('default', 'openrouter', 'registered'));

-- 已登记连接：绑定必须有连接 ID，且不带任何目录依据、不受「仅免费」约束。
-- 反向也必须成立：另两枚连接不得携带 connection_id。显式两分支写法，不依赖 NULL 三值语义
-- （0094/0095 两次同类漏洞的根因就是把方向写漏，这里一次写全）。
ALTER TABLE session_model_selection
  ADD COLUMN connection_id uuid REFERENCES model_connections (id);

ALTER TABLE session_model_selection
  ADD CONSTRAINT ck_session_model_selection_registered_identity
  CHECK (
    (connection = 'registered' AND connection_id IS NOT NULL
      AND catalog_source IS NULL AND catalog_snapshot_seq IS NULL
      AND catalog_model_id IS NULL AND free_only = false)
    OR (connection <> 'registered' AND connection_id IS NULL)
  );

-- 工作区聊天默认（与 0144 的 Run 默认同表不同列）。不设 ON DELETE：连接不允许物理删除。
-- `connection_id` 同时放开 NOT NULL：两枚默认各自独立设置，只设聊天默认时这一列就是 NULL。
-- 「两个都为 NULL」是合法状态（用户显式取消了两枚默认，聊天与 Run 都回到进程默认），
-- 因此不额外加「至少一条非空」的 CHECK——那会让「取消聊天默认」在没有 Run 默认时无法表达。
ALTER TABLE workspace_default_model_connection
  ALTER COLUMN connection_id DROP NOT NULL;

ALTER TABLE workspace_default_model_connection
  ADD COLUMN chat_connection_id uuid NULL REFERENCES model_connections (id);

-- 「清除本会话选择、恢复跟随默认」需要 DELETE：0089 只给了 SELECT/INSERT/UPDATE，
-- 因为归档不删行。这里放开的是**用户显式**的跟随默认操作，与归档无关；
-- 消息行仍带着它受理时冻结的快照与连接身份，历史归因不受影响。
GRANT DELETE ON session_model_selection TO relay_app;

-- 消息受理时冻结的连接身份。非空必然带冻结快照——没有快照就没有可核对的模型计划，
-- 单挂一个连接 ID 会让执行端无从判断配置是否已变。
ALTER TABLE assist_messages
  ADD COLUMN model_connection_id uuid NULL REFERENCES model_connections (id);

ALTER TABLE assist_messages
  ADD CONSTRAINT ck_assist_messages_model_connection_requires_snapshot
  CHECK (model_connection_id IS NULL OR model_selection_snapshot IS NOT NULL);

-- 已登记连接的验证归属。其他 kind 的连接身份由消息行/执行契约承载，这里保持 NULL，
-- 不把 `model_calls` 扩成第二套连接账本。
ALTER TABLE model_calls
  ADD COLUMN connection_id uuid NULL REFERENCES model_connections (id);

CREATE INDEX idx_model_calls_verify_connection
  ON model_calls (connection_id, started_at DESC)
  WHERE kind = 'VERIFY' AND connection_id IS NOT NULL;

COMMENT ON COLUMN model_calls.connection_id IS
  'kind=VERIFY 且验证目标是已登记连接时填写；其他调用为 NULL。';

COMMENT ON COLUMN session_model_selection.connection_id IS
  'connection=registered 时绑定的模型连接 ID；另两枚连接恒为 NULL。';
COMMENT ON COLUMN workspace_default_model_connection.connection_id IS
  'Run 默认连接（0144）。可空：两列都为 NULL 表示 Run 与聊天都回到进程默认。';
COMMENT ON COLUMN workspace_default_model_connection.chat_connection_id IS
  '工作区聊天默认连接：会话在无显式选择时用它冻结。与 connection_id（Run 默认）分列，互不写回。';
COMMENT ON COLUMN assist_messages.model_connection_id IS
  '消息受理时冻结的模型连接身份；执行端据此解析，不重新读当前默认连接。';

-- 回滚：DROP 新列与新约束、把取值 CHECK 改回两枚、`connection_id` 恢复 NOT NULL（前提是
-- 已无「只有聊天默认」的行，否则先回填再收紧）、REVOKE DELETE ON session_model_selection。
-- 无数据修复。

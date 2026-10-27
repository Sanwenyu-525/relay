-- 2026-10-27：工作区默认模型连接与 Run 的连接身份（P2 阶段三，ADR-036）。
--
-- 两件事：
--
--   1. `workspace_default_model_connection`：每个工作区至多一条默认连接。它决定**新的 Run**
--      用哪条连接冻结模型身份；会话选择仍只表达「聊天用哪个模型」，两者作用域不同，不互相写回。
--   2. `execution_contracts.connection_id` / `connection_credential_version`：Run 冻结时把
--      连接身份一并写进契约。执行端据此解析模型，而不是重新读「当前默认连接」——否则改默认
--      连接会让在途 Run 换 Provider，正是本模块要消灭的那类缺陷。
--
-- 为什么连接身份单独两列而不是塞进 `frozen_snapshot`：快照会原样嵌入上下文清单、也可能
-- 出现在界面与证据里；连接 ID 本身不敏感，但把「解析依据」和「可见计划」混在一处会让
-- `contract_hash` 的语义变得含糊（哈希只覆盖 frozen_snapshot）。两列都不参与哈希。
--
-- 凭据**代数**必须与连接 ID 一起冻结：轮换会覆盖同一引用下的秘密并加代数，执行端比对代数
-- 才能发现「凭据已换」；只冻结连接 ID 会让旧 Run 悄悄用新 Key 外呼。
--
-- 不改写任何既有迁移、不回填、不放宽 relay_app 权限。
-- API Breaking Change: No —— 纯新增一张表与两个可空列；旧契约两列为 NULL，走既有兼容路径。

CREATE TABLE workspace_default_model_connection (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id),
  -- 不设 ON DELETE：连接不允许删除（停用即失效），因此不存在悬空默认值的路径。
  connection_id uuid NOT NULL REFERENCES model_connections (id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 应用角色：读、首次设置、CAS 改写。没有 DELETE——「取消默认」应通过指向另一条连接表达，
-- 或者显式置空（这里不留 DELETE，避免一次误删让工作区静默退回进程默认）。
GRANT SELECT, INSERT, UPDATE ON workspace_default_model_connection TO relay_app;

ALTER TABLE execution_contracts ADD COLUMN connection_id uuid;
ALTER TABLE execution_contracts ADD COLUMN connection_credential_version integer;

-- 两列同现同缺：只有连接 ID 没有代数，执行端就无法判断凭据是否被轮换过。
ALTER TABLE execution_contracts ADD CONSTRAINT ck_execution_contracts_connection_identity CHECK (
  (connection_id IS NULL) = (connection_credential_version IS NULL)
  AND (connection_credential_version IS NULL OR connection_credential_version >= 1)
);

COMMENT ON TABLE workspace_default_model_connection IS
  '工作区默认模型连接（ADR-036 阶段三）。决定新 Run 的冻结来源；不写回进程配置。';
COMMENT ON COLUMN execution_contracts.connection_id IS
  'Run 冻结时的模型连接身份；执行端据此解析，不重新读当前默认连接。不参与 contract_hash。';
COMMENT ON COLUMN execution_contracts.connection_credential_version IS
  '冻结时的凭据代数；与连接当前代数不符即停止，防止旧 Run 悄悄使用轮换后的新 Key。';

-- 回滚：DROP TABLE workspace_default_model_connection；DROP 两个契约列。
-- 契约列可空且无既有读依赖，删除后旧 Run 自动回到「进程默认」兼容路径，无需数据修复。

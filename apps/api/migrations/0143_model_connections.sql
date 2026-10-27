-- 2026-10-27：多 Provider 模型连接登记（P2 阶段一，ADR-036）。
--
-- 目标：让「登记一条模型连接」成为可持久化的事实——名称、Provider 类型、HTTPS 端点、
-- 确切型号、调用预算、凭据引用、启用状态——同时**不**把任何密钥带进业务库。
--
-- 关键约束与本迁移的取舍：
--
--   * 凭据只存**不透明引用** `credential_ref`。秘密本身由操作系统凭据库（Windows DPAPI，
--     当前用户作用域）保护，见 `apps/credential-helper` 与 `credentials/`。本表永不存密钥、
--     密文、摘要或原始认证头；引用只是文件名级句柄（`[A-Za-z0-9][A-Za-z0-9_-]{7,63}`）。
--   * 预算列与 `ModelPortConfig` 同名同义（timeout / 单次输出 / 单次总量 / 作用域次数 /
--     作用域总量），解析时可直接投影，不需要第二套换算。约束与进程配置的上下界一致，
--     因此「登记时能通过的连接」不会被执行端以「配置非法」为由拒绝。
--   * 停用是**状态**而不是删除：已冻结在旧连接上的 Run 需要原身份继续可读、可诊断；
--     删除会让历史归因失去参照。撤销凭据由 `credential_version` 递增表达。
--   * `revision` 供 CAS：并发或重放的更新以 revision 单调递增收敛，旧值不覆盖新值。
--
-- 阶段边界（必须如实阅读）：本迁移落的是**登记与凭据管理**。连接尚未参与模型解析——
-- 执行端仍只按 Run 冻结计划或进程默认解析（`application/run-model-port.ts`）。
-- 「连接 → 会话选择 / Run 冻结」接线是下一阶段，届时新增冻结列而不是改本表；
-- 在那之前，本表里的连接是「已登记、可管理、尚不可执行」。
--
-- 不改写任何既有迁移、不回填、不放宽 `relay_app` 权限（只给这张新表 SELECT/INSERT/UPDATE）。
-- API Breaking Change: No —— 纯新增表与新端点。

CREATE TABLE model_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  -- 展示名，工作区内唯一：同名的两条连接会让「用的是哪条」无法回答。
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- 目前只有 OpenAI 兼容协议；保留列是为了将来扩展时不用改表语义。
  provider_kind text NOT NULL CHECK (provider_kind IN ('openai-compatible')),
  -- 空＝使用内置默认端点；非空时由 `parseModelBaseUrl` 在写入前保证是含公开 https 主机、
  -- 无凭据/query/fragment 的完整地址（本列只做形状兜底，语义校验在应用层）。
  base_url text NULL CHECK (base_url IS NULL OR base_url ~ '^https://'),
  -- 冻结的确切型号 ID：不存通配、不存 `openrouter/free` 这类随机路由。
  default_model text NOT NULL CHECK (default_model ~ '^.{1,200}$'),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  max_output_tokens integer NOT NULL DEFAULT 8192
    CHECK (max_output_tokens BETWEEN 256 AND 65536),
  max_call_tokens integer NOT NULL DEFAULT 65536
    CHECK (max_call_tokens BETWEEN 1024 AND 1048576),
  max_scope_calls integer NOT NULL DEFAULT 32 CHECK (max_scope_calls BETWEEN 1 AND 256),
  max_scope_tokens integer NOT NULL DEFAULT 262144
    CHECK (max_scope_tokens BETWEEN 1024 AND 2000000),
  -- 凭据引用：不透明句柄，同时是凭据库里的文件名。不允许分隔符或点号（杜绝 `../` 逃逸）。
  credential_ref text NOT NULL CHECK (credential_ref ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  -- 凭据版本：每次轮换 +1。冻结在旧版本上的调用据此发现「凭据已换」并停止。
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 预算必须自洽：作用域上限盖住单次上限，单次上限盖住单次输出上限。
  CHECK (max_call_tokens >= max_output_tokens),
  CHECK (max_scope_tokens >= max_call_tokens),
  UNIQUE (workspace_id, name)
);

-- 列表按工作区 + 状态取，索引与查询同形。
CREATE INDEX ix_model_connections_workspace_status
  ON model_connections (workspace_id, status, created_at);

-- 应用角色：登记、读取、CAS 更新、停用/启用。没有 DELETE——停用即失效，历史归因要留。
GRANT SELECT, INSERT, UPDATE ON model_connections TO relay_app;

COMMENT ON TABLE model_connections IS
  '工作区作用域的模型连接登记（P2 阶段一）。凭据只存不透明引用，秘密在操作系统凭据库。';
COMMENT ON COLUMN model_connections.credential_ref IS
  '凭据库中的不透明句柄；本列永不含密钥、密文或摘要。';
COMMENT ON COLUMN model_connections.credential_version IS
  '凭据轮换代数；冻结在旧代上的调用据此发现「凭据已换」并安全停止。';

-- 回滚：DROP TABLE model_connections 即可（无既有表引用它、无外键指向它）。
-- 凭据库中的 blob 不受影响，需要时用 `node dist/src/cli/model-credential.js delete <ref>` 清理。

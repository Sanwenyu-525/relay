-- M04 工具循环 B 片：本次任务范围授权，以及模型可请求的写入/删除/差异/检查动作。
-- 依据 docs/architecture/tool-adapters.md §1.2 与 §1.3：
--   * 范围授权与单动作 ACTION_APPROVAL 是两个对象。授权只在本次合法 Task/Run 与冻结边界内
--     提供有限 AUTO 条件；单动作批准仍绑定确切动作与参数，一次批准不覆盖未来未知动作。
--   * 删除文件、扩大范围始终单动作确认，因此不出现在 allowed_actions 里。
--   * 检查只执行 Delegate 时冻结的真实程序与结构化参数；模型只能按 check_id 点名，
--     不能提交任意 shell 字符串，也不能靠改名绕过命令配置。
--   * 全局 approval_passthrough 不改：FILE_WRITE / CLI_RUN 仍是非穿透适配器，
--     AUTO 降级为 ASK 的既有行为只在本次 Run 的有效授权下被局部豁免。

CREATE TABLE run_scope_grants (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  -- 授权版本：任何展宽或收紧都递增，准入按当前版本判定，旧版本不再适用。
  version bigint NOT NULL DEFAULT 1,
  -- 冻结时的规范根身份。根被整体替换后即使路径相同也不再适用，
  -- 因为「同一个目录」在物理上已经不是当初被授权的那一个。
  root_identity text NOT NULL,
  -- 允许免单动作审批执行的 Gateway action_type。删除不在其中：删除永远要再确认一次。
  allowed_actions text[] NOT NULL,
  -- 已配置检查的冻结清单：id、真实程序、结构化参数、输出上限与程序文件摘要。
  -- 模型只能引用 check_id；可执行内容由冻结快照决定，不由工具参数决定。
  checks jsonb NOT NULL,
  -- 本次授权边界的规范摘要，用于核对「模型请求没有超出授权」。
  boundary_digest text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  -- 有效期；过期后即使 Run 仍在执行也不再放行自动动作。
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  -- 运行结束后是否仍适用。默认 false：授权是「本次任务」的，不跨 Run 继承。
  survives_run_terminal boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_run_scope_grants_run UNIQUE (run_id),
  CONSTRAINT fk_run_scope_grants_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_run_scope_grants_run FOREIGN KEY (run_id) REFERENCES runs (id),
  CONSTRAINT fk_run_scope_grants_resource FOREIGN KEY (workspace_id, project_id, resource_id)
    REFERENCES managed_resources (workspace_id, project_id, id),
  CONSTRAINT ck_run_scope_grants_version CHECK (version >= 1),
  -- 授权不能为空集，也不能凭空出现：只接受首批真正支持的免审批动作。
  -- 检查统一记作 CLI_RUN —— 工具循环里模型只能按 check_id 点名冻结清单中的某一次检查，
  -- 「测什么 / 构建什么」的粒度由那份清单决定，不由动作名决定。
  CONSTRAINT ck_run_scope_grants_actions CHECK (
    cardinality(allowed_actions) >= 1
    AND allowed_actions <@ ARRAY['WRITE_FILE', 'APPLY_CHANGESET', 'CLI_RUN']),
  -- 删除与 Git 写入永不进入免审批集合，防止被一次性授权带走。
  CONSTRAINT ck_run_scope_grants_no_delete CHECK (
    NOT ('DELETE'::text = ANY(allowed_actions))),
  CONSTRAINT ck_run_scope_grants_checks CHECK (jsonb_typeof(checks) = 'array'),
  CONSTRAINT ck_run_scope_grants_digest CHECK (boundary_digest ~ '^[0-9a-f]{64}$'),
  -- 未撤销时不得留下撤销原因；已撤销必须说明原因，便于审计「为什么不再放行」。
  CONSTRAINT ck_run_scope_grants_revocation CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL AND revoked_reason <> ''))
);

CREATE INDEX ix_run_scope_grants_revoked ON run_scope_grants (workspace_id, project_id, revoked_at);

-- 授权撤销是审计事实，只能由专门的用例写入一次；应用角色不能改写授权边界，
-- 因此一次授权从签发起边界就是冻结的，撤销只改变「是否仍适用」。
GRANT SELECT, INSERT ON run_scope_grants TO relay_app;
GRANT UPDATE (revoked_at, revoked_reason, revision, updated_at) ON run_scope_grants TO relay_app;

-- 一次自动适配：模型工具请求可以声明自己是对哪一次冲突的重新适配。
-- 「只适配一次」由深度约束保证——适配的行不能再被适配。
ALTER TABLE run_tool_calls
  ADD COLUMN adaptation_of uuid REFERENCES run_tool_calls (id);
ALTER TABLE run_tool_calls
  ADD COLUMN adapted_path text;
ALTER TABLE run_tool_calls
  ADD CONSTRAINT ck_run_tool_calls_adaptation CHECK (
    (adaptation_of IS NULL AND adapted_path IS NULL)
    OR (adaptation_of IS NOT NULL AND adapted_path IS NOT NULL AND adapted_path <> ''));
-- 深度限制：只能适配原始请求，不能适配「已经适配过的请求」。
CREATE INDEX ix_run_tool_calls_adaptation ON run_tool_calls (adaptation_of)
  WHERE adaptation_of IS NOT NULL;
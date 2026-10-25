-- P1-A 项目级长期 Agent 成员（ADR-034 包 A）。
-- 成员是跨会话的稳定身份：角色、职责、状态、模型选择与运行方式都在这里；
-- 会话（Assist Session）、Task、Run 与实际执行权不共用这一身份。
-- 协调者是项目级单点事实（一项目至多一名），单独一行，不叠在成员行上。
CREATE TABLE project_agent_members (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- 角色模板键在应用层校验（AGENT_ROLE_KEYS）；模板不是成员，创建时把默认职责拷贝进 duties。
  role_key text NOT NULL,
  duties text NOT NULL CHECK (length(duties) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  run_mode text NOT NULL DEFAULT 'BUILTIN' CHECK (run_mode IN ('BUILTIN', 'EXTERNAL')),
  -- {mode:'INHERIT'} 或 {mode:'EXPLICIT', model, connection, free_only, config_fingerprint}：
  -- 解析口径与会话模型选择一致；INHERIT 的实际解析发生在执行时，配置时不校验。
  model_selection jsonb NOT NULL DEFAULT '{"mode":"INHERIT"}'::jsonb
    CHECK (jsonb_typeof(model_selection) = 'object' AND model_selection ->> 'mode' IN ('INHERIT', 'EXPLICIT')),
  -- 外部成员的可信绑定随 ADR-033 领取协议落地（P1-C）；本列先保存展示性标签，不构成授权。
  external_binding jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(external_binding) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE INDEX project_agent_members_project ON project_agent_members(workspace_id, project_id, created_at);

-- 一项目一行：协调者指派/更换是一个事实，不用成员行上的布尔位承担。
CREATE TABLE project_agent_coordinators (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  member_id uuid NOT NULL REFERENCES project_agent_members(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  command_id uuid NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON project_agent_members, project_agent_coordinators TO relay_app;

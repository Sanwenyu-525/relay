-- M04 会话模式与人设 助手配置：会话建立时冻结一种身份。
-- 依据 docs/superpowers/specs/2026-10-05-conversation-mode-and-assistant-readonlys-design.md §4 与
-- docs/decisions/ADR-018（会话级人设助手，Breaking Change：Yes 语义）：
--   * 用户要在聊天框切换两种模式。模式不是每条消息的临时开关，而是**会话身份**：
--     会话建立后冻结，中途切换等于换会话，因此权限等级不会在一条会话里前后漂移。
--   * 助手 不携带任何能力。名字、角色、口吻与只读目录范围是配置文本；真正的能力来自
--     连接与 Gateway 准入，快照里不允许出现 capabilities / connections 之类字段。
--   * read_scope 只能**缩小**受管目录范围，不能扩大；缺省 {} 表示该受管根全读，
--     与既有会话读目录的语义一致。
--
-- 本迁移**不改任何表结构**（assist_sessions 只增列）、不改已应用迁移、不回填历史行。
-- 既有会话按 conversation_mode='AGENT' 读出，不虚构 助手 关系。
--
-- session_tool_calls 与 ASSISTANT_READ origin 在 0060 一条迁移里做：它们同属「B 档只读执行」
-- 这一件事，拆开会让 origin 先于它服务的账本存在。

CREATE TABLE assistant_profiles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  -- 用户可见名。活跃名在 workspace 内唯一（大小写不敏感），归档后可重用。
  name text NOT NULL,
  role_description text NOT NULL,
  tone text,
  -- 只读目录范围：{} 或 { "roots": ["<受管根内相对路径>", ...] ]。只能缩小。
  read_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assistant_profile_name CHECK (length(btrim(name)) > 0),
  CONSTRAINT ck_assistant_profile_role CHECK (length(btrim(role_description)) > 0),
  CONSTRAINT ck_assistant_profile_revision CHECK (revision >= 1),
  CONSTRAINT ck_assistant_profile_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  -- 只读范围必须是缺省或 roots 数组；字符串等其他形状在这里就被挡住。
  CONSTRAINT ck_assistant_profile_read_scope CHECK (
    read_scope = '{}'::jsonb
    OR (jsonb_typeof(read_scope) = 'object' AND read_scope ? 'roots'
      AND jsonb_typeof(read_scope -> 'roots') = 'array'))
);

-- 部分唯一索引而不是全表唯一：归档的 助手 不再占用名字，新 助手 可以复用同一个名字。
CREATE UNIQUE INDEX uq_assistant_profile_active_name ON assistant_profiles (workspace_id, lower(name))
  WHERE status = 'ACTIVE';
CREATE INDEX ix_assistant_profile_workspace ON assistant_profiles (workspace_id, status, id);

ALTER TABLE assist_sessions ADD COLUMN conversation_mode text NOT NULL DEFAULT 'AGENT';
ALTER TABLE assist_sessions ADD COLUMN assistant_profile_id uuid REFERENCES assistant_profiles (id);
ALTER TABLE assist_sessions ADD COLUMN assistant_profile_revision bigint;
ALTER TABLE assist_sessions ADD COLUMN assistant_role_snapshot jsonb;
-- 「一次性问答」开关：false 时该轮不作为可续读历史。
ALTER TABLE assist_sessions ADD COLUMN remember boolean NOT NULL DEFAULT true;

-- 模式与 助手 字段必须同时齐备或同时缺席。
-- 这一条同时挡住两种形态：「BOT 会话没有 助手」与「AGENT 会话其实挂着人设」。
ALTER TABLE assist_sessions ADD CONSTRAINT ck_assist_session_mode CHECK (
  (conversation_mode = 'AGENT' AND assistant_profile_id IS NULL
    AND assistant_profile_revision IS NULL AND assistant_role_snapshot IS NULL)
  OR (conversation_mode = 'ASSISTANT' AND assistant_profile_id IS NOT NULL
    AND assistant_profile_revision IS NOT NULL AND assistant_role_snapshot IS NOT NULL
    AND jsonb_typeof(assistant_role_snapshot) = 'object'));

-- 人设快照是文本，不是授权：能力字段一旦出现在快照里就说明某处把权限写进了配置。
ALTER TABLE assist_sessions ADD CONSTRAINT ck_assist_session_role_snapshot CHECK (
  assistant_role_snapshot IS NULL OR (
    NOT (assistant_role_snapshot ? 'capabilities') AND NOT (assistant_role_snapshot ? 'connections')
    AND NOT (assistant_role_snapshot ? 'permissions')));

CREATE INDEX ix_assist_sessions_bot ON assist_sessions (assistant_profile_id, workspace_id, id)
  WHERE assistant_profile_id IS NOT NULL;

-- 助手配置是事实，只能由专用用例写入；应用角色对它没有直接 UPDATE/DELETE。
-- 归档走 UPDATE status + revision + updated_at，与 run_scope_grants 的撤销同形状：
-- 边界一次签发就不再改写，推进只改变「是否仍适用」。
GRANT SELECT, INSERT ON assistant_profiles TO relay_app;
GRANT UPDATE (name, role_description, tone, read_scope, status, revision, updated_at)
  ON assistant_profiles TO relay_app;
GRANT SELECT ON assist_sessions TO relay_app;
-- 建会话时写入身份列，读会话时读回；既有 INSERT/UPDATE 授权已覆盖新列。
GRANT UPDATE (conversation_mode, assistant_profile_id, assistant_profile_revision, assistant_role_snapshot,
  remember, revision, updated_at) ON assist_sessions TO relay_app;
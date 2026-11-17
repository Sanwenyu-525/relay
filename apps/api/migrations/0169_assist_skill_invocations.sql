-- 0169：第一方 Skill 执行事件（拒绝把“选择 Skill”冒充“调用轨迹”）
--
-- 背景（MEMORY-ACCEPTANCE-20261115 第二轮 P1）：
-- `assist_messages.skill_snapshot` 只记录这条消息选择了哪个冻结 Skill，无法回答
-- “真正执行了吗、何时开始、是否成功、失败原因是什么”。`assist_session_tool_calls`
-- 记录的是模型工具轮次，普通 MCP/文件工具也写同一张表；把两者混用会把工具调用误标成
-- Skill。本迁移只新增执行事件账本：
--   REQUESTED → RUNNING → SUCCEEDED / FAILED / CANCELLED
-- 事件与消息、会话、工作区强关联，`invocation_key` 唯一保证重放不重复。
--
-- 本迁移只追加，不修改 0164/0166/0168。它不写长期记忆正文，也不改变消息终态；
-- 输入/输出只存脱敏、截断后的摘要。
--
-- 回滚：DROP TABLE assist_skill_invocations。消息、Skill 输出、工具账本均不受影响。

CREATE TABLE assist_skill_invocations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES assist_sessions (id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES assist_messages (id) ON DELETE CASCADE,
  -- 同一消息同一 Skill 的一次执行；重复的生成重试复用同一 key，不产生第二行。
  invocation_key text NOT NULL,
  ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal BETWEEN 1 AND 100),
  skill_id text NOT NULL CHECK (length(skill_id) BETWEEN 1 AND 100),
  skill_version text NOT NULL CHECK (length(skill_version) BETWEEN 1 AND 100),
  skill_sha256 text NOT NULL CHECK (skill_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
    ('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  -- 只存摘要，不存完整输入/输出；可能包含用户文本，写入前必须脱敏与截断。
  input_summary text,
  output_summary text,
  error_kind text,
  error_detail text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_assist_skill_invocation_key UNIQUE (invocation_key),
  CONSTRAINT ck_assist_skill_invocation_settled CHECK (
    (status IN ('REQUESTED', 'RUNNING') AND settled_at IS NULL) OR
    (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND settled_at IS NOT NULL)),
  CONSTRAINT ck_assist_skill_invocation_running CHECK (
    status <> 'RUNNING' OR started_at IS NOT NULL)
);

CREATE INDEX ix_assist_skill_invocations_message
  ON assist_skill_invocations (session_id, message_id, requested_at, ordinal);
CREATE INDEX ix_assist_skill_invocations_session
  ON assist_skill_invocations (workspace_id, session_id, requested_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON assist_skill_invocations TO relay_app;

COMMENT ON TABLE assist_skill_invocations IS
  '第一方 Skill 的真实执行事件；普通 MCP/工具调用不得写入此表';
COMMENT ON COLUMN assist_skill_invocations.invocation_key IS
  '幂等调用身份：同一消息、Skill 版本与序号在重试时复用；不用于跨消息合并';
COMMENT ON COLUMN assist_skill_invocations.input_summary IS
  '脱敏并截断的输入摘要，不是完整参数；不得写入凭据、密钥或内部环境变量';

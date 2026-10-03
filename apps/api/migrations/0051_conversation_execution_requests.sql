-- 对话里的明确执行请求：一条原用户消息对应一条请求，保存原消息身份与内容基准、
-- 模型整理出的候选、阶段事实与关联的真实 Task/Run。模型只解释，不获得授权；
-- 授权来源永远是 source_message_id 指向的那条原消息。
CREATE TABLE conversation_execution_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  source_message_id uuid NOT NULL REFERENCES assist_messages (id),
  resource_id uuid NOT NULL REFERENCES managed_resources (id),
  -- 一次用户意图一个身份：同一 command_id 重放、同一原消息再次提交都命中同一条请求。
  command_id uuid NOT NULL,
  root_path text NOT NULL,
  base_content_sha256 bytea NOT NULL,
  decision text NOT NULL,
  candidate_status text NOT NULL DEFAULT 'PENDING',
  clarification jsonb,
  candidate jsonb,
  status text NOT NULL DEFAULT 'INTERPRETING',
  task_id uuid REFERENCES tasks (id),
  task_command_id uuid,
  ready_command_id uuid,
  delegate_command_id uuid,
  run_id uuid REFERENCES runs (id),
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation_execution_intent UNIQUE (workspace_id, command_id),
  CONSTRAINT uq_conversation_execution_source_message UNIQUE (source_message_id),
  CONSTRAINT ck_conversation_execution_decision
    CHECK (decision IN ('DISCUSS', 'CLARIFY', 'PREPARE')),
  CONSTRAINT ck_conversation_execution_candidate_status
    CHECK (candidate_status IN ('PENDING', 'READY', 'INVALID', 'UNAVAILABLE')),
  CONSTRAINT ck_conversation_execution_status CHECK (status IN (
    'INTERPRETING', 'DISCUSSED', 'CLARIFY', 'READY', 'TASK_PREPARED', 'DELEGATED', 'FAILED')),
  CONSTRAINT ck_conversation_execution_sha256
    CHECK (length(base_content_sha256) = 32),
  CONSTRAINT ck_conversation_execution_stage CHECK (
    status NOT IN ('TASK_PREPARED', 'DELEGATED')
      OR (task_id IS NOT NULL AND task_command_id IS NOT NULL)
  ),
  CONSTRAINT ck_conversation_execution_run CHECK (
    status <> 'DELEGATED' OR (delegate_command_id IS NOT NULL AND run_id IS NOT NULL)
  ),
  -- 三个阶段命令身份在请求创建时就固定，恢复时按原 command_id 重放，不新建第二个 Task/Run。
  CONSTRAINT ck_conversation_execution_commands CHECK (
    task_command_id IS NOT NULL AND ready_command_id IS NOT NULL AND delegate_command_id IS NOT NULL
  ),
  CONSTRAINT ck_conversation_execution_decision_stage CHECK (
    (decision = 'CLARIFY'
      AND status NOT IN ('DISCUSSED', 'READY', 'TASK_PREPARED', 'DELEGATED'))
    OR (decision <> 'CLARIFY' AND status <> 'CLARIFY')
  )
);

CREATE INDEX ix_conversation_execution_session
  ON conversation_execution_requests (session_id, created_at DESC, id);
CREATE INDEX ix_conversation_execution_task
  ON conversation_execution_requests (task_id) WHERE task_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON conversation_execution_requests TO relay_app;

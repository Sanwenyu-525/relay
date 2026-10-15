-- 自然语言状态维护（总纲 §0.8.1）：一条原用户消息对应一次状态维护请求，
-- 请求下挂若干条**类型化变更**，每条变更自带固定 command_id、变更前后引用与结算状态。
--
-- 这两张表**不复制业务事实**：目标、需求/知识、决策、任务、计划、进度、阻塞仍各归原
-- Owner（goals / knowledge / decisions / tasks / project_states / project_blockers）。
-- 这里只保存「原消息 → 确认内容 → 领域命令 → 回执」的关系，以及整组撤回所需的补偿轨迹。
--
-- 授权来源永远是 source_message_id 指向的那条原用户消息；模型只解释，不获得授权。
-- 这里也没有任何执行权：变更行不携带 Run/Task 执行身份，外部效果仍走原 Gateway 与完成用例。

CREATE TABLE conversation_state_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL REFERENCES projects (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  source_message_id uuid NOT NULL REFERENCES assist_messages (id),
  -- 三个阶段的命令身份在请求创建时就固定：解释、应用、整组撤回各自一条命令，
  -- 重放只回读原回执，不会产生第二组对象或版本。
  command_id uuid NOT NULL,
  apply_command_id uuid NOT NULL,
  undo_command_id uuid NOT NULL,
  -- 原消息正文摘要：内容漂移时按原基准拒绝，不按「后来重算的内容」接受。
  base_content_sha256 bytea NOT NULL,
  decision text NOT NULL DEFAULT 'DISCUSS',
  candidate_status text NOT NULL DEFAULT 'PENDING',
  status text NOT NULL DEFAULT 'INTERPRETING',
  candidate jsonb,
  clarification jsonb,
  -- 需要用户决定的连带承诺（§0.8.1「连带影响」）：非空时不得自动应用，必须先取得决定。
  decision_required jsonb,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation_state_request_command UNIQUE (workspace_id, command_id),
  -- 一次原消息一个维护请求：重复发送/重开只回读原请求，不会重复维护同一事实。
  CONSTRAINT uq_conversation_state_request_message UNIQUE (source_message_id),
  CONSTRAINT ck_conversation_state_request_decision
    CHECK (decision IN ('DISCUSS', 'CLARIFY', 'MAINTAIN')),
  CONSTRAINT ck_conversation_state_request_candidate
    CHECK (candidate_status IN ('PENDING', 'READY', 'INVALID', 'UNAVAILABLE')),
  CONSTRAINT ck_conversation_state_request_status CHECK (status IN (
    'INTERPRETING', 'DISCUSSED', 'CLARIFY', 'READY', 'APPLYING', 'APPLIED', 'PARTIAL',
    'FAILED', 'DECISION_REQUIRED', 'UNDOING', 'UNDONE', 'UNDO_PARTIAL', 'UNDO_BLOCKED')),
  CONSTRAINT ck_conversation_state_request_sha256
    CHECK (length(base_content_sha256) = 32),
  CONSTRAINT ck_conversation_state_request_decision_stage CHECK (
    (decision = 'CLARIFY' AND status NOT IN ('DISCUSSED', 'READY', 'APPLIED', 'PARTIAL'))
    OR (decision <> 'CLARIFY' AND status <> 'CLARIFY')
  ),
  -- 解释成功才允许进入应用；应用过的请求必须已经结算候选。
  CONSTRAINT ck_conversation_state_request_applied_candidate CHECK (
    status NOT IN ('APPLIED', 'PARTIAL', 'FAILED', 'UNDOING', 'UNDONE', 'UNDO_PARTIAL',
      'UNDO_BLOCKED')
      OR candidate_status IN ('READY', 'INVALID')
  )
);

CREATE INDEX ix_conversation_state_request_session
  ON conversation_state_requests (session_id, created_at DESC, id);
CREATE INDEX ix_conversation_state_request_project
  ON conversation_state_requests (project_id, created_at DESC, id);

CREATE TABLE conversation_state_changes (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES conversation_state_requests (id),
  -- 稳定顺序即「这次指令实际表达的先后」，撤回按逆序补偿。
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  change_kind text NOT NULL,
  -- 每条变更一条固定命令身份：应用与撤回都不重建对象。
  command_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'PENDING',
  -- 变更前后引用：before 用于回读与撤回前置核对，after 用于回执呈现与补偿目标。
  before_ref jsonb,
  after_ref jsonb,
  error jsonb,
  applied_at timestamptz,
  compensation_command_id uuid,
  compensated_at timestamptz,
  CONSTRAINT uq_conversation_state_change_ordinal UNIQUE (request_id, ordinal),
  CONSTRAINT uq_conversation_state_change_command UNIQUE (command_id),
  CONSTRAINT ck_conversation_state_change_kind CHECK (change_kind IN (
    'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
    'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
    'RESOLVE_BLOCKER')),
  CONSTRAINT ck_conversation_state_change_status CHECK (status IN (
    'PENDING', 'APPLIED', 'FAILED', 'SKIPPED', 'COMPENSATED', 'COMPENSATION_FAILED')),
  -- 已应用的变更必须留下 after_ref，否则「改了什么」无从核对、整组撤回也无从定位。
  CONSTRAINT ck_conversation_state_change_applied_ref CHECK (
    status <> 'APPLIED' OR (after_ref IS NOT NULL AND applied_at IS NOT NULL)
  ),
  CONSTRAINT ck_conversation_state_change_compensated CHECK (
    status <> 'COMPENSATED'
      OR (compensation_command_id IS NOT NULL AND compensated_at IS NOT NULL)
  )
);

CREATE INDEX ix_conversation_state_change_request
  ON conversation_state_changes (request_id, ordinal);
CREATE INDEX ix_conversation_state_change_applied
  ON conversation_state_changes (request_id) WHERE status = 'APPLIED';

GRANT SELECT, INSERT, UPDATE ON conversation_state_requests TO relay_app;
GRANT SELECT, INSERT, UPDATE ON conversation_state_changes TO relay_app;
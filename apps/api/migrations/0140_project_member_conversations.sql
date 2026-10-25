-- P1-B 成员私聊、群聊与消息（ADR-034 包 B；模型互相唤醒与消费结算归包 C）。
-- 会话是成员协作的持久记录：私聊一成员一线程、群聊一项目一线程，均跨会话保留；
-- 消息有持久身份、来源、意图与定向接收者，重复投递靠 command_id 回执去重，
-- 不依赖前端本地状态。
CREATE TABLE project_member_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  -- DIRECT：与单个成员的定向交流；GROUP：项目群聊（未定向消息由协调者接住）。
  kind text NOT NULL CHECK (kind IN ('DIRECT', 'GROUP')),
  member_id uuid REFERENCES project_agent_members(id),
  title text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  -- 讨论终止原因（RESOLVED / INSUFFICIENT_INFO / NO_NEW_EVIDENCE / NEEDS_USER_DECISION /
  -- TECHNICAL_BOUNDARY / NO_PROGRESS）：关闭不是删除，记录保留、可重开。
  close_reason text CHECK (close_reason IS NULL OR close_reason IN
    ('RESOLVED', 'INSUFFICIENT_INFO', 'NO_NEW_EVIDENCE', 'NEEDS_USER_DECISION', 'TECHNICAL_BOUNDARY', 'NO_PROGRESS')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'DIRECT' AND member_id IS NOT NULL) OR (kind = 'GROUP' AND member_id IS NULL)),
  CHECK (kind = 'GROUP' OR title IS NULL)
);
-- 私聊一线程、群聊一线程：部分唯一索引即「开启或继续」的唯一性裁决。
CREATE UNIQUE INDEX project_member_conversations_direct
  ON project_member_conversations (project_id, member_id) WHERE kind = 'DIRECT';
CREATE UNIQUE INDEX project_member_conversations_group
  ON project_member_conversations (project_id) WHERE kind = 'GROUP';
CREATE INDEX project_member_conversations_project
  ON project_member_conversations (workspace_id, project_id, created_at);

CREATE TABLE project_member_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES project_member_conversations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  seq bigint NOT NULL CHECK (seq > 0),
  -- HUMAN＝用户经工作台发送；MEMBER＝成员产出（成员回信路径随包 C 的唤醒接入）。
  sender_kind text NOT NULL CHECK (sender_kind IN ('HUMAN', 'MEMBER')),
  sender_member_id uuid REFERENCES project_agent_members(id),
  -- 定向接收者（群聊）：空数组＝未定向，按规则由协调者接住；私聊恒为对方成员。
  recipient_member_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipient_member_ids) = 'array'),
  intent text NOT NULL DEFAULT 'DISCUSS' CHECK (intent IN
    ('DISCUSS', 'QUESTION', 'SUGGESTION', 'STATUS_REPORT', 'CHECK_REQUEST', 'HANDOFF')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  -- HANDOFF 意图的交接载荷：只引用原事实（task_id / run_id / artifact_version_id /
  -- 基线说明 / 未决问题 / 下一步），不复制业务状态。
  handoff_payload jsonb,
  linked_task_id uuid REFERENCES tasks(id),
  linked_run_id uuid REFERENCES runs(id),
  -- 处理状态：RECORDED＝已落库；消费与结算（CLAIMED/PROCESSED/FAILED）随包 C 唤醒接入。
  processing_status text NOT NULL DEFAULT 'RECORDED' CHECK (processing_status IN ('RECORDED', 'CLAIMED', 'PROCESSED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);
CREATE INDEX project_member_messages_conversation
  ON project_member_messages (conversation_id, seq DESC);

GRANT SELECT, INSERT, UPDATE ON project_member_conversations, project_member_messages TO relay_app;

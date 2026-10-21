-- ADR-030：零点击自动记忆。自动写入的 Memory 与人工确认的 Memory 同表，
-- 只多一个「谁写的」维度；memory_auto_captures 记录提取批次、去重指纹与撤销状态。
-- 迁移只追加：不改已应用的 0009 / 0118 结构。

ALTER TABLE memory_items
  ADD COLUMN origin text NOT NULL DEFAULT 'HUMAN_CONFIRMED',
  ADD CONSTRAINT ck_memory_origin CHECK (origin IN ('HUMAN_CONFIRMED', 'AUTO_CAPTURE'));

-- 第三个开关与既有两个并列：关掉它只停止「以后自动提取」，已写入的自动记忆仍按原规则召回，
-- 用户可逐条撤销。默认开启，因为自动捕获正是用户要的行为。
ALTER TABLE workspace_memory_settings
  ADD COLUMN auto_capture boolean NOT NULL DEFAULT true;

CREATE TABLE memory_auto_captures (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  -- 原消息正文的 UTF-8 SHA256：撤销与去重都绑这条确切来源，不用编辑后的记忆正文。
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  -- title+text 归一化后的摘要：同一来源同一内容只提取一次。
  normalized_sha256 text NOT NULL CHECK (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  memory_id uuid NOT NULL REFERENCES memory_items (id),
  status text NOT NULL DEFAULT 'ACTIVE',
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  CONSTRAINT ck_memory_capture_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  -- 撤销必须留下「谁在什么时候」；ACTIVE 行不得预先带撤销时刻。
  CONSTRAINT ck_memory_capture_decision CHECK (
    (status = 'ACTIVE' AND decided_at IS NULL AND decided_by IS NULL) OR
    (status = 'RETIRED' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT uq_memory_capture_source UNIQUE (session_id, message_id, normalized_sha256),
  CONSTRAINT fk_memory_capture_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id)
);
CREATE INDEX ix_memory_captures_workspace ON memory_auto_captures (workspace_id, status, created_at DESC);
CREATE INDEX ix_memory_captures_session ON memory_auto_captures (session_id, created_at DESC);
CREATE INDEX ix_memory_items_origin ON memory_items (workspace_id, origin, status);

GRANT SELECT, INSERT, UPDATE ON memory_auto_captures TO relay_app;

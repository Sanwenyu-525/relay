-- 0132：用户消息撤回（工作台 §27.3、运行架构 §8.5）。
--
-- 语义：撤回一条用户消息＝把该消息及其后本会话关联的文件写入回退到该消息发送前的
-- 内容/存在性；原消息、工具记录和原回复保留，只标记撤回。文件前像在**每次写入真正落盘前**
-- 按消息记录（首写优先），不靠 Git HEAD 或事后补拍：发送前的状态只能从当时的真实字节得到。
--
-- 三张表：
--   * assist_message_file_preimages —— 逐消息、逐路径的写入前像（首写者胜出，不可改写）
--   * assist_message_recalls        —— 一次撤回请求的持久身份与结果摘要
--   * assist_message_recall_files   —— 该次撤回的逐文件预检/恢复结果
--
-- 撤回回执先写 RUNNING，文件恢复完成后才落终态；崩溃后按同一行重读，不重复发起另一组写入。

CREATE TABLE assist_message_file_preimages (
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  relative_path text NOT NULL,
  existed boolean NOT NULL,
  content bytea,
  sha256 text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  unavailable_reason text,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, relative_path),
  CONSTRAINT ck_assist_preimage_path CHECK (
    relative_path <> '' AND octet_length(relative_path) <= 1024
    AND left(relative_path, 1) <> '/'
    AND relative_path !~ '^[A-Za-z]:'
    AND position(chr(92) in relative_path) = 0
    AND relative_path !~ '(^|/)(\.\.?)(/|$)'
  ),
  CONSTRAINT ck_assist_preimage_hash CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_assist_preimage_source CHECK (source IN ('SESSION_WRITE', 'RUN_WRITE')),
  CONSTRAINT ck_assist_preimage_reason CHECK (
    unavailable_reason IS NULL OR
    unavailable_reason IN ('CONTENT_TOO_LARGE', 'READ_FAILED', 'TARGET_NOT_REGULAR', 'PATH_UNSAFE', 'CAPACITY_FULL')
  ),
  CONSTRAINT ck_assist_preimage_shape CHECK (
    (existed = false AND content IS NULL AND sha256 IS NULL AND size_bytes IS NULL
      AND unavailable_reason IS NULL)
    OR (existed = true AND
      ((sha256 IS NOT NULL AND content IS NOT NULL AND unavailable_reason IS NULL
          AND octet_length(content) = size_bytes)
        OR (content IS NULL AND unavailable_reason IS NOT NULL)))
  )
);
CREATE INDEX ix_assist_preimages_session ON assist_message_file_preimages (session_id, message_id);

CREATE TABLE assist_message_recalls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 被撤回的原用户消息与其直接回复；两条消息在终态时同时标记 withdrawn_at。
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  assistant_message_id uuid NOT NULL REFERENCES assist_messages (id),
  command_id text NOT NULL,
  status text NOT NULL,
  -- 本次恢复使用的受管根；没有文件写入的撤回没有根路径。
  root_path text,
  planned_files integer NOT NULL DEFAULT 0 CHECK (planned_files >= 0),
  restored_files integer NOT NULL DEFAULT 0 CHECK (restored_files >= 0),
  skipped_files integer NOT NULL DEFAULT 0 CHECK (skipped_files >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- 最近一次执行心跳；崩溃遗留的 RUNNING 以此判断何时可按同一回执接续。
  last_resumed_at timestamptz,
  CONSTRAINT uq_assist_message_recall_message UNIQUE (message_id),
  CONSTRAINT uq_assist_message_recall_command UNIQUE (workspace_id, command_id),
  CONSTRAINT ck_assist_message_recall_status CHECK (
    status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')
  ),
  CONSTRAINT ck_assist_message_recall_terminal CHECK (
    (status = 'RUNNING' AND completed_at IS NULL) OR
    (status <> 'RUNNING' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX ix_assist_message_recalls_session ON assist_message_recalls (session_id, requested_at DESC);

CREATE TABLE assist_message_recall_files (
  recall_id uuid NOT NULL REFERENCES assist_message_recalls (id),
  relative_path text NOT NULL,
  baseline_existed boolean NOT NULL,
  baseline_sha256 text,
  -- 前像属于哪条消息；CREATE 且首次写入前路径不存在时为 NULL。
  baseline_message_id uuid REFERENCES assist_messages (id),
  -- 撤回前该路径**最后一次已确认写入**应留下的内容摘要；NULL＝应当不存在。
  expected_current_sha256 text,
  observed_sha256 text,
  status text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recall_id, relative_path),
  CONSTRAINT ck_assist_recall_file_path CHECK (
    relative_path <> '' AND octet_length(relative_path) <= 1024
    AND left(relative_path, 1) <> '/'
    AND relative_path !~ '^[A-Za-z]:'
    AND position(chr(92) in relative_path) = 0
    AND relative_path !~ '(^|/)(\.\.?)(/|$)'
  ),
  CONSTRAINT ck_assist_recall_file_hash CHECK (
    (baseline_sha256 IS NULL OR baseline_sha256 ~ '^[0-9a-f]{64}$') AND
    (expected_current_sha256 IS NULL OR expected_current_sha256 ~ '^[0-9a-f]{64}$') AND
    (observed_sha256 IS NULL OR observed_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ck_assist_recall_file_status CHECK (status IN (
    'PLANNED', 'RESTORED', 'ALREADY_RESTORED', 'CONFLICT',
    'UNAVAILABLE', 'FAILED', 'SKIPPED', 'UNCERTAIN'
  ))
);

ALTER TABLE assist_messages
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by_recall_id uuid REFERENCES assist_message_recalls (id);
CREATE INDEX ix_assist_messages_withdrawn ON assist_messages (session_id, seq)
  WHERE withdrawn_at IS NOT NULL;

-- DELETE 仅用于 §27.3.4 过期快照清理；前像内容本身仍不可改写。
GRANT SELECT, INSERT, DELETE ON assist_message_file_preimages TO relay_app;
GRANT SELECT, INSERT, UPDATE ON assist_message_recalls TO relay_app;
GRANT SELECT, INSERT, UPDATE ON assist_message_recall_files TO relay_app;

-- ── §27.3.3 单层「撤销这次回退」：回退前保护副本与撤销回执（2026-10-24 接续追加）──
--
-- 撤回在**首个恢复写入前**保存本次目标文件的实际内容；「撤销这次回退」把最近一次
-- 完整成功撤回实际触及的文件恢复到该保护副本，作为**新的受控动作**（独立身份、
-- 幂等、预检冲突不写），不复活旧操作身份，也不提供对撤销的再撤销。
-- 保护副本不可用时撤回不执行（应用层收口），不承诺事后一定可撤销。

CREATE TABLE assist_message_recall_protections (
  recall_id uuid NOT NULL REFERENCES assist_message_recalls (id),
  relative_path text NOT NULL,
  -- 撤回开始写入前该文件是否存在于磁盘。
  existed boolean NOT NULL,
  -- 保护副本字节（可含二进制）；existed=false 时为 NULL。
  content bytea,
  sha256 text,
  size_bytes bigint,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recall_id, relative_path),
  CONSTRAINT ck_assist_protection_path CHECK (
    relative_path <> '' AND octet_length(relative_path) <= 1024
    AND left(relative_path, 1) <> '/'
    AND relative_path !~ '^[A-Za-z]:'
    AND position(chr(92) in relative_path) = 0
    AND relative_path !~ '(^|/)(\.\.?)(/|$)'
  ),
  CONSTRAINT ck_assist_protection_hash CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_assist_protection_reason CHECK (
    unavailable_reason IS NULL OR unavailable_reason IN ('CONTENT_TOO_LARGE', 'READ_FAILED', 'TARGET_NOT_REGULAR', 'CAPACITY_FULL')
  ),
  -- 与 preimages 同形：不存在→全空；存在→要么内容齐备，要么只有不可用原因。
  CONSTRAINT ck_assist_protection_shape CHECK (
    (existed = false AND content IS NULL AND sha256 IS NULL AND size_bytes IS NULL
      AND unavailable_reason IS NULL)
    OR (existed = true AND
      ((sha256 IS NOT NULL AND content IS NOT NULL AND unavailable_reason IS NULL
          AND octet_length(content) = size_bytes)
        OR (content IS NULL AND unavailable_reason IS NOT NULL)))
  )
);
CREATE INDEX ix_assist_protections_session
  ON assist_message_recall_protections (recall_id, relative_path);

CREATE TABLE assist_message_recall_undos (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 单层：一次撤回至多一条撤销（UNIQUE），且只能是「最近一次完整成功」的撤回（应用层判定）。
  source_recall_id uuid NOT NULL REFERENCES assist_message_recalls (id),
  command_id text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  root_path text NOT NULL,
  -- 逐文件预检与恢复结果（path/status/reason/protection 基线），回执事实在行上，不再建第二张逐文件表。
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_resumed_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT uq_assist_recall_undo_source UNIQUE (source_recall_id),
  CONSTRAINT uq_assist_recall_undo_command UNIQUE (workspace_id, command_id),
  CONSTRAINT ck_assist_recall_undo_status CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  CONSTRAINT ck_assist_recall_undo_terminal CHECK (
    (status = 'RUNNING' AND completed_at IS NULL) OR
    (status <> 'RUNNING' AND completed_at IS NOT NULL)
  )
);
CREATE INDEX ix_assist_recall_undos_session ON assist_message_recall_undos (session_id, requested_at);

-- DELETE 仅用于过期保护副本清理；副本内容本身仍不可改写。
GRANT SELECT, INSERT, DELETE ON assist_message_recall_protections TO relay_app;
GRANT SELECT, INSERT, UPDATE ON assist_message_recall_undos TO relay_app;

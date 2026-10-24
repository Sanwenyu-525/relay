-- 0132：用户消息撤回（工作台 §27.3、运行架构 §8.5）。
--
-- 语义：撤回一条用户消息＝把该消息及其后本会话关联的文件写入回退到该消息**发送前**的
-- 内容/存在性；原消息、工具记录和原回复保留，只标记撤回。恢复目标读**发送前基线**——
-- 每条用户消息在准入事务内对受管根建字节基线（2026-10-24 用户拍板按产品文档口径，
-- 取代此前的「首写前像」实现）；不靠 Git HEAD 或事后补拍。
--
-- 五张表：
--   * assist_message_baselines       —— 每条用户消息一份发送前基线（状态/原因/计数）
--   * assist_message_baseline_files  —— 基线内逐文件条目（存在性+摘要；字节在内容寻址库）
--   * assist_message_snapshot_blobs  —— 内容寻址字节库（同内容跨消息去重，供容量计量与保留清理）
--   * assist_message_recalls         —— 一次撤回请求的持久身份与结果摘要
--   * assist_message_recall_files    —— 该次撤回的逐文件预检/恢复结果
--
-- 撤回回执先写 RUNNING，文件恢复完成后才落终态；崩溃后按同一行重读，不重复发起另一组写入。

CREATE TABLE assist_message_baselines (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  session_id uuid NOT NULL REFERENCES assist_sessions (id),
  -- 基线绑定哪一条用户消息的「发送前」；同一消息只允许一份基线（准入重放复用它）。
  message_id uuid NOT NULL REFERENCES assist_messages (id),
  resource_id uuid NOT NULL,
  root_path text NOT NULL,
  -- COMPLETE = 覆盖范围内全部路径都已核对（无条目即「发送前不存在」）。
  -- INCOMPLETE = 采集到一半停止（文件数/总量/单文件超限、预算占满、读取失败等），
  -- 缺条目的路径不能区分「不存在」与「没扫到」，撤回时如实按不可恢复处理。
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  file_count integer NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assist_baseline_status CHECK (status IN ('COMPLETE', 'INCOMPLETE')),
  CONSTRAINT uq_assist_baseline_message UNIQUE (message_id)
);
CREATE INDEX ix_assist_baselines_session ON assist_message_baselines (session_id, message_id);

CREATE TABLE assist_message_baseline_files (
  baseline_id uuid NOT NULL REFERENCES assist_message_baselines (id) ON DELETE CASCADE,
  -- 受管根内的规范相对路径（POSIX 分隔），与 change_set_files / 会话写口径一致。
  relative_path text NOT NULL,
  -- 发送前内容摘要与字节库引用；「发送前不存在」的路径没有条目（COMPLETE 基线下）。
  -- 列名用 existed：exists 是 SQL 保留字，裸列名会被解析成 EXISTS 函数（实测 NULL 违例）。
  existed boolean NOT NULL,
  blob_sha256 text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  unavailable_reason text,
  PRIMARY KEY (baseline_id, relative_path),
  CONSTRAINT ck_assist_baseline_path CHECK (
    relative_path <> '' AND octet_length(relative_path) <= 1024
    AND left(relative_path, 1) <> '/'
    AND relative_path !~ '^[A-Za-z]:'
    AND position(chr(92) in relative_path) = 0
    AND relative_path !~ '(^|/)(\.\.?)(/|$)'
  ),
  CONSTRAINT ck_assist_baseline_hash CHECK (blob_sha256 IS NULL OR blob_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_assist_baseline_reason CHECK (
    unavailable_reason IS NULL OR
    unavailable_reason IN ('CONTENT_TOO_LARGE', 'READ_FAILED', 'TARGET_NOT_REGULAR', 'CAPACITY_FULL')
  ),
  -- 条目要么「发送前存在且有可用字节引用」，要么「存在但该路径不可恢复（记原因）」。
  CONSTRAINT ck_assist_baseline_shape CHECK (
    (existed = true AND blob_sha256 IS NOT NULL AND unavailable_reason IS NULL)
    OR (existed = true AND blob_sha256 IS NULL AND unavailable_reason IS NOT NULL)
  )
);

-- 内容寻址字节库：同一份字节跨消息/跨基线只存一行（§27.3.4 去重），事务内插入无孤儿
-- 中间态；事务回滚留下的无引用行只浪费磁盘、不冒充事实。容量与保留按本表计量。
CREATE TABLE assist_message_snapshot_blobs (
  blob_sha256 text PRIMARY KEY,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content bytea NOT NULL,
  refcount integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

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
GRANT SELECT, INSERT, DELETE ON assist_message_baselines TO relay_app;
GRANT SELECT, INSERT ON assist_message_baseline_files TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON assist_message_snapshot_blobs TO relay_app;
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

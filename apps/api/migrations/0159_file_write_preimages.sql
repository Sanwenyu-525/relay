-- 0159（AGENT-FILE-CONTEXT-V3）：文件写入前的精准保护证据。
--
-- 语义变更：不再为每条用户消息扫描整份受管根建立「发送前基线」。撤销
-- Relay 自己的文件变更时，恢复目标是该路径**第一次被 Relay 写入之前**的真实
-- 内容（MODIFY/DELETE）或「原本不存在」的事实（CREATE），而不是发消息那一刻
-- 的整目录快照。历史 assist_message_baselines 仍保留读取/恢复能力，不删除字节，
-- 也不把旧基线冒充成新的写入前快照。
--
-- 证据在 Prepare 阶段（真正落盘之前）读取并随动作身份同一事务落库；字节复用
-- 既有内容寻址库 assist_message_snapshot_blobs，不建第二套写入账本。
-- 每条路径一行，绑定产生它的 LogicalOperation；同一 Operation 重复 Prepare
-- 复用原证据（intent 幂等），不会被后来的读取刷新。

CREATE TABLE file_write_preimages (
  operation_id uuid NOT NULL REFERENCES logical_operations (id),
  -- 执行时使用的规范根（与 change_sets.canonical_root 同口径）。
  root_path text NOT NULL,
  -- 根内规范相对路径（POSIX 分隔）。
  relative_path text NOT NULL,
  -- 写入前该路径是否存在；false 即 CREATE 的「原本不存在」证据。
  existed boolean NOT NULL,
  -- 写入前的完整内容摘要与字节库引用；不存在或不可保护时为 NULL。
  blob_sha256 text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, relative_path),
  CONSTRAINT ck_file_write_preimage_path CHECK (
    relative_path <> '' AND octet_length(relative_path) <= 1024
    AND left(relative_path, 1) <> '/'
    AND relative_path !~ '^[A-Za-z]:'
    AND position(chr(92) in relative_path) = 0
    AND relative_path !~ '(^|/)(\.\.?)(/|$)'
  ),
  CONSTRAINT ck_file_write_preimage_hash CHECK (
    blob_sha256 IS NULL OR blob_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_file_write_preimage_reason CHECK (
    unavailable_reason IS NULL OR
    unavailable_reason IN ('CONTENT_TOO_LARGE', 'READ_FAILED', 'TARGET_NOT_REGULAR',
      'CAPACITY_FULL', 'ROOT_UNAVAILABLE')
  ),
  -- 存在→要么内容齐备，要么只有不可用原因；不存在→没有内容列。
  CONSTRAINT ck_file_write_preimage_shape CHECK (
    (existed = false AND blob_sha256 IS NULL AND size_bytes IS NULL
      AND unavailable_reason IS NULL)
    OR (existed = true AND
      ((blob_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND unavailable_reason IS NULL)
        OR (blob_sha256 IS NULL AND size_bytes IS NULL AND unavailable_reason IS NOT NULL)))
  )
);

-- DELETE 供既有保留期清理复用同一生命周期；不授予 UPDATE（前像一经冻结不可改写）。
GRANT SELECT, INSERT, DELETE ON file_write_preimages TO relay_app;

-- 撤回回执逐文件记录自己的恢复来源：新变更使用写入前精准证据，早期消息只能
-- 退回旧的整目录基线；两者不能混为同一事实。
ALTER TABLE assist_message_recall_files
  ADD COLUMN snapshot_source text NOT NULL DEFAULT 'LEGACY_MESSAGE_BASELINE',
  ADD COLUMN source_operation_id uuid REFERENCES logical_operations (id);
ALTER TABLE assist_message_recall_files
  ADD CONSTRAINT ck_assist_recall_file_snapshot_source CHECK (
    snapshot_source IN ('PRECISE_PREIMAGE', 'LEGACY_MESSAGE_BASELINE', 'NONE'));

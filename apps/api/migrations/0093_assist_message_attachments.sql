-- 0093：Assist 消息图片附件（输入框粘贴/拖拽图片，HTTP §10.85、数据库设计 §90）。
--
-- 定位：附件是**会话输入快照**，随消息发送、与消息同生命周期；不是资料（不进
-- knowledge/memory/decision 版本体系），也不是 artifact（不受管存储的版本目录与
-- 防篡改核对语义）。上传端点先落行（message_id 为 NULL 的未引用行），消息命令在
-- 同一事务内把附件绑定到新消息——绑定是消息命令的一部分，不是独立业务命令。
--
-- 为什么存 bytea 而不是受管存储文件：附件必须与消息在同一短事务提交（契约 04：
-- 必要业务事实同一短事务提交；外部副作用与数据库不假装原子），bytea 没有「写了
-- 文件没写库」的中间态；单用户本机、体积由 CHECK 上限约束，DB 体量可控。
-- 受管存储的不可变版本目录 + 防篡改核对是 artifact（业务产物）的语义，不套用。
--
-- 不变性：媒体类型、字节、内容在插入后不可变——应用角色没有 DELETE，也没有
-- UPDATE content 的授权路径（仓库层 UPDATE 仅允许 message_id 从 NULL 绑定为非 NULL，
-- 且 where message_id is null 兜底并发）；「每消息 ≤4 张、总量 ≤6 MiB」由消息命令
-- 在事务内裁决，不写触发器。
--
-- 兼容与回滚：全新表，无既有读取方，Breaking Change: No。回滚直接整表丢弃——
-- 附件只是会话输入快照，不是业务事实。
--
-- 编号说明：0092 为 computer-use 占用，本迁移顺延 0093。

CREATE TABLE assist_message_attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  -- NULL = 已上传未发送；绑定后不可再改（仓库层 where message_id is null）。
  message_id uuid REFERENCES assist_messages(id),
  name text NOT NULL CHECK (name <> '' AND char_length(name) <= 200),
  media_type text NOT NULL
    CHECK (media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  -- byte_length 与实际字节一致，防「元数据说小、内容很大」的错位。
  byte_length integer NOT NULL
    CHECK (byte_length > 0 AND byte_length <= 2097152 AND byte_length = octet_length(content)),
  content_hash bytea NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_assist_message_attachments_session
  ON assist_message_attachments (session_id, created_at);

CREATE INDEX ix_assist_message_attachments_message
  ON assist_message_attachments (message_id) WHERE message_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON assist_message_attachments TO relay_app;

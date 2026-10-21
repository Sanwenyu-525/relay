-- DEV-0042（接续 ADR-030、ADR-032）：记忆条目的「来源类别」。
--
-- origin 回答「谁写的」（人工确认 / 自动捕获）；source_kind 回答「这条内容来自谁的哪一段」：
--   MANUAL            人工保存（人自己选的，不经自动提取）
--   USER_STATEMENT    自动捕获，逐字引用自用户自己的话
--   MODEL_OBSERVATION 自动捕获，逐字引用自助手叙述（可能含工具结果或网页正文）
--   UNKNOWN           旧数据没有类别信息（0125 之前写下的自动记忆）
--
-- 迁移只追加：0119/0125 的结构不改。旧自动记忆回填 UNKNOWN——它们没有经过来源核验，
-- 不能假定是用户原话；旧人工记忆保持 MANUAL。

ALTER TABLE memory_items
  ADD COLUMN source_kind text NOT NULL DEFAULT 'MANUAL',
  ADD CONSTRAINT ck_memory_source_kind CHECK (source_kind IN
    ('MANUAL', 'USER_STATEMENT', 'MODEL_OBSERVATION', 'UNKNOWN'));

UPDATE memory_items SET source_kind = 'UNKNOWN' WHERE origin = 'AUTO_CAPTURE';

-- 捕获记账补「这一条是从原消息的哪一段提出来的」：逐字引用，便于事后复核来源类别。
ALTER TABLE memory_auto_captures
  ADD COLUMN source_quote text NOT NULL DEFAULT '';

-- 0009 的 CHECK 只允许 confirmed_by = 'user:local'，而 ADR-030 的零点击自动捕获写的是
-- 'auto-capture'：真实 PostgreSQL 上每一次自动捕获写入都被这条约束拒绝，又被写入路径的
-- 失败静默吞掉，于是「自动记住」从未真正落库（单测不碰库，一直没暴露）。
-- 这里只放宽到这两个取值，不新增第三个来源。
ALTER TABLE memory_versions DROP CONSTRAINT ck_memory_version_values;
ALTER TABLE memory_versions ADD CONSTRAINT ck_memory_version_values CHECK (
  version >= 1 AND title <> '' AND body_text <> ''
  AND confirmed_by in ('user:local', 'auto-capture')
  AND octet_length(body_text) <= 262144);

CREATE INDEX ix_memory_items_source_kind ON memory_items (workspace_id, origin, source_kind, status);

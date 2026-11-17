-- 0167：知识库组织与检索（知识集合、标签、知识关联、索引化检索）
--
-- 现状（0009 / 0017 / 0052 / 0053）：Knowledge 已有根 + 不可变版本、来源绑定、
-- 归档/恢复、项目导读与整理候选；缺少的是长期使用时真正需要的组织层：
--   * 知识集合（Collection）：逻辑分组，不复制正文；
--   * 标签（Tag）：跨集合的横向检索维度；
--   * 知识关联（Relation）：知识之间、知识与决定/规则之间的确切引用；
--   * 列表/检索索引：服务端分页、排序、中文倒排检索所需的列与索引。
--
-- 本迁移只追加，不改既有列语义：
--   * status 仍只有 ACTIVE / ARCHIVED；「过期」「被替代」是派生视图，不新增可写状态。
--   * 版本仍不可变；标签、集合、关联都指向 knowledge_items(id) 与确切版本，不复制正文。
--   * 旧行 summary / search_*_tokens 为空：摘要由应用层在下一次写入时补齐，
--     检索对「未索引行」按字面匹配兜底，旧知识不会消失。
--
-- 集合与标签的归属范围：workspace 级集合（project_id IS NULL）对整个工作空间可见；
-- project 级集合只对所属项目可见。知识归属仍由 knowledge_items.project_id 决定，
-- 集合不改变知识的作用域，也不授予额外读取权限。

ALTER TABLE knowledge_items
  ADD COLUMN summary text,
  ADD COLUMN search_title_tokens text NOT NULL DEFAULT '',
  ADD COLUMN search_body_tokens text NOT NULL DEFAULT '';

-- 旧行摘要：只取当前版本正文的前 200 字符。ARTIFACT_VERSION 的正文不在数据库里，
-- 保持 NULL，由读取方按需读取，不在这里拼一个假的摘要。
UPDATE knowledge_items k
  SET summary = left(v.content_text, 200)
  FROM knowledge_versions v
  WHERE v.knowledge_id = k.id AND v.version = k.current_version
    AND v.content_text IS NOT NULL;

ALTER TABLE knowledge_items
  ADD CONSTRAINT ck_knowledge_summary CHECK (summary IS NULL OR length(summary) <= 400);

COMMENT ON COLUMN knowledge_items.summary IS
  '当前版本正文的前 200 字符摘要；写入时生成，列表不为展示摘要去读正文';
COMMENT ON COLUMN knowledge_items.search_title_tokens IS
  '标题分词（中文双字 + 拉丁词，空格分隔）；GIN 表达式索引输入';
COMMENT ON COLUMN knowledge_items.search_body_tokens IS
  '正文分词（有界，前 4000 字符）；空值旧行按未索引行字面兜底';

-- 列表分页与排序：按更新时间 / 创建时间 / 标题三条稳定顺序。
CREATE INDEX ix_knowledge_items_list_updated
  ON knowledge_items (workspace_id, status, project_id, updated_at DESC, id DESC);
CREATE INDEX ix_knowledge_items_list_created
  ON knowledge_items (workspace_id, status, project_id, created_at DESC, id DESC);
CREATE INDEX ix_knowledge_items_list_title
  ON knowledge_items (workspace_id, status, project_id, title, id);
-- 倒排索引：标题权重 A、正文权重 B；查询侧用同一表达式算 ts_rank。
CREATE INDEX ix_knowledge_items_fts ON knowledge_items USING gin (
  (setweight(to_tsvector('simple', search_title_tokens), 'A') ||
   setweight(to_tsvector('simple', search_body_tokens), 'B')
));

CREATE TABLE knowledge_collections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  -- 规范化名称：去首尾空白、连续空白折叠、大小写折叠；唯一约束建在它上面。
  norm_name text NOT NULL CHECK (btrim(norm_name) <> ''),
  description text CHECK (description IS NULL OR length(description) <= 400),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_collection_identity UNIQUE (workspace_id, id),
  CONSTRAINT fk_knowledge_collection_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id)
);
-- PostgreSQL 的唯一约束把 NULL 视为互不相等：workspace 级与 project 级各建一条部分唯一索引。
CREATE UNIQUE INDEX uq_knowledge_collection_workspace_name
  ON knowledge_collections (workspace_id, norm_name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX uq_knowledge_collection_project_name
  ON knowledge_collections (workspace_id, project_id, norm_name) WHERE project_id IS NOT NULL;
CREATE INDEX ix_knowledge_collections_scope
  ON knowledge_collections (workspace_id, project_id, updated_at DESC);

-- 集合成员：多对多。集合与知识必须同属一个工作空间（复合外键保证），
-- 知识自身的 project 归属不因加入集合而改变。
CREATE TABLE knowledge_collection_items (
  collection_id uuid NOT NULL,
  knowledge_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, knowledge_id),
  CONSTRAINT fk_collection_item_collection FOREIGN KEY (workspace_id, collection_id)
    REFERENCES knowledge_collections (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_item_knowledge FOREIGN KEY (workspace_id, knowledge_id)
    REFERENCES knowledge_items (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_knowledge_collection_items_knowledge
  ON knowledge_collection_items (workspace_id, knowledge_id);

CREATE TABLE knowledge_tags (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  -- 展示名保留用户首次写入的大小写；norm_name 是唯一与匹配的依据。
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 48),
  norm_name text NOT NULL CHECK (btrim(norm_name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_tag_identity UNIQUE (workspace_id, id),
  CONSTRAINT uq_knowledge_tag_name UNIQUE (workspace_id, norm_name)
);
CREATE INDEX ix_knowledge_tags_workspace ON knowledge_tags (workspace_id, norm_name);

CREATE TABLE knowledge_tag_links (
  tag_id uuid NOT NULL,
  knowledge_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, knowledge_id),
  CONSTRAINT fk_tag_link_tag FOREIGN KEY (workspace_id, tag_id)
    REFERENCES knowledge_tags (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_tag_link_knowledge FOREIGN KEY (workspace_id, knowledge_id)
    REFERENCES knowledge_items (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_knowledge_tag_links_knowledge
  ON knowledge_tag_links (workspace_id, knowledge_id);

-- 知识关联：只保存确切 id；可选 target_version_id 表示「关联到某个版本」，
-- 为空表示「关联到当前版本」。不允许自关联，不允许跨工作空间（复合外键保证）。
CREATE TABLE knowledge_relations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  from_knowledge_id uuid NOT NULL,
  to_knowledge_id uuid NOT NULL,
  relation_kind text NOT NULL CHECK (relation_kind IN
    ('RELATES_TO', 'SUPERSEDES', 'DERIVED_FROM', 'CONSTRAINS', 'REFERENCES')),
  target_version bigint,
  note text CHECK (note IS NULL OR length(note) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_knowledge_relation_not_self CHECK (from_knowledge_id <> to_knowledge_id),
  CONSTRAINT fk_knowledge_relation_from FOREIGN KEY (workspace_id, from_knowledge_id)
    REFERENCES knowledge_items (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_knowledge_relation_to FOREIGN KEY (workspace_id, to_knowledge_id)
    REFERENCES knowledge_items (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_knowledge_relation_version FOREIGN KEY (to_knowledge_id, target_version)
    REFERENCES knowledge_versions (knowledge_id, version),
  CONSTRAINT uq_knowledge_relation UNIQUE (from_knowledge_id, to_knowledge_id, relation_kind)
);
CREATE INDEX ix_knowledge_relations_from
  ON knowledge_relations (workspace_id, from_knowledge_id, relation_kind);
CREATE INDEX ix_knowledge_relations_to
  ON knowledge_relations (workspace_id, to_knowledge_id, relation_kind);

COMMENT ON TABLE knowledge_collections IS
  '知识集合：逻辑分组，不复制正文；workspace 级与 project 级各有独立命名空间';
COMMENT ON TABLE knowledge_tags IS
  '标签：工作空间内规范化唯一（大小写与空白折叠），展示名保留首次写入形式';
COMMENT ON TABLE knowledge_relations IS
  '知识关联：确切 knowledge id（可选确切版本），不使用标题字符串建立关联';

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_collections TO relay_app;
GRANT SELECT, INSERT, DELETE ON knowledge_collection_items TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_tags TO relay_app;
GRANT SELECT, INSERT, DELETE ON knowledge_tag_links TO relay_app;
GRANT SELECT, INSERT, DELETE ON knowledge_relations TO relay_app;

-- Agent 使用记录：assist_messages.sources 已保存每次注入的确切来源，
-- 这里只补一个 JSONB 索引，让「这条知识被哪些消息用过」不必全表扫描。
CREATE INDEX ix_assist_messages_sources_gin
  ON assist_messages USING gin (sources jsonb_path_ops);

-- 回滚：先删索引与关联/标签/集合表，再删 knowledge_items 新增列。
-- 既有知识、版本、来源与状态不受影响；已写入的集合/标签/关联随表删除丢失。

-- N03 项目知识导读：Project 拥有导读编排本身，条目只保存确切引用，不复制正文、
-- 不维护第二份当前状态。PINNED 钉住确切知识版本，CURRENT 只作导航、读取时解析到
-- 当前版本；两种用途必须能分辨，AI 输入永远落到确切版本。
CREATE TABLE project_knowledge_guides (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_project_knowledge_guide UNIQUE (project_id),
  CONSTRAINT fk_project_knowledge_guide_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id)
);
CREATE INDEX ix_project_knowledge_guides_workspace ON project_knowledge_guides(workspace_id);
GRANT SELECT, INSERT ON project_knowledge_guides TO relay_app;
GRANT UPDATE (revision, updated_at) ON project_knowledge_guides TO relay_app;

-- 目标列用 IS NOT NULL 判定而不是等值比较：0044 曾把 CHECK 写成 target = ref_id，
-- 在 NULL 时求值为 NULL 而非 FALSE，脏行因此可落库。这里每个分支都显式要求
-- 「恰好一个目标列非空」，与 ref_kind 一一对应。
CREATE TABLE project_knowledge_guide_entries (
  guide_id uuid NOT NULL REFERENCES project_knowledge_guides(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  ref_kind text NOT NULL CHECK (ref_kind IN ('KNOWLEDGE', 'DECISION', 'RULE', 'ARTIFACT_VERSION')),
  reference_mode text NOT NULL CHECK (reference_mode IN ('PINNED', 'CURRENT')),
  knowledge_id uuid REFERENCES knowledge_items(id),
  decision_id uuid REFERENCES decisions(id),
  rule_id uuid REFERENCES rules(id),
  artifact_version_id uuid REFERENCES artifact_versions(id),
  pinned_version_id uuid REFERENCES knowledge_versions(id),
  target_id uuid GENERATED ALWAYS AS
    (coalesce(knowledge_id, decision_id, rule_id, artifact_version_id)) STORED,
  label text CHECK (label IS NULL OR btrim(label) <> ''),
  PRIMARY KEY (guide_id, ordinal),
  CONSTRAINT uq_guide_entry_ref UNIQUE (guide_id, ref_kind, target_id),
  CONSTRAINT ck_guide_entry_target CHECK (
      (ref_kind = 'KNOWLEDGE'        AND knowledge_id IS NOT NULL AND decision_id IS NULL
        AND rule_id IS NULL AND artifact_version_id IS NULL)
   OR (ref_kind = 'DECISION'         AND knowledge_id IS NULL AND decision_id IS NOT NULL
        AND rule_id IS NULL AND artifact_version_id IS NULL)
   OR (ref_kind = 'RULE'             AND knowledge_id IS NULL AND decision_id IS NULL
        AND rule_id IS NOT NULL AND artifact_version_id IS NULL)
   OR (ref_kind = 'ARTIFACT_VERSION' AND knowledge_id IS NULL AND decision_id IS NULL
        AND rule_id IS NULL AND artifact_version_id IS NOT NULL)),
  -- 只有固定引用才允许钉住知识的确切版本；DECISION/RULE/ARTIFACT_VERSION 本身即确切对象。
  CONSTRAINT ck_guide_entry_pin CHECK (
      (reference_mode = 'PINNED' AND ref_kind = 'KNOWLEDGE' AND pinned_version_id IS NOT NULL)
   OR (reference_mode = 'CURRENT' AND pinned_version_id IS NULL))
);
CREATE INDEX ix_guide_entries_knowledge ON project_knowledge_guide_entries(knowledge_id);
CREATE INDEX ix_guide_entries_pinned ON project_knowledge_guide_entries(pinned_version_id);

-- 条目是可替换的导航引用（编辑导读就是替换整份清单），因此给 DELETE；
-- 它们指向的知识版本、决定、规则与成果版本仍按原契约不可变。
GRANT SELECT, INSERT, DELETE ON project_knowledge_guide_entries TO relay_app;

-- N03 整理候选：候选是「可能重复」的人工提示与建议归类，不是模型判断。
-- 它不自动合并、不自动删除、不改写 Rule / Decision，也不自行产生知识版本；
-- 接受时由既有 CreateKnowledge / AddKnowledgeVersion 决定效果。
CREATE TABLE knowledge_curation_candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL REFERENCES artifacts(id),
  source_artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  source_artifact_revision bigint NOT NULL CHECK (source_artifact_revision >= 0),
  suggested_title text NOT NULL CHECK (btrim(suggested_title) <> ''),
  -- 只有字面完全相同才建议归入既有条目；否则为空，表示建议新建。
  suggested_knowledge_id uuid REFERENCES knowledge_items(id),
  accepted_knowledge_id uuid REFERENCES knowledge_items(id),
  accepted_knowledge_version_id uuid REFERENCES knowledge_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  rejected_at timestamptz,
  CONSTRAINT fk_curation_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  -- 决定只有两种终态，且不能同时成立。
  CONSTRAINT ck_curation_decision CHECK (
      (accepted_knowledge_version_id IS NULL AND decided_at IS NULL AND rejected_at IS NULL)
   OR (accepted_knowledge_version_id IS NOT NULL AND decided_at IS NOT NULL AND rejected_at IS NULL)
   OR (accepted_knowledge_version_id IS NULL AND decided_at IS NULL AND rejected_at IS NOT NULL)),
  CONSTRAINT ck_curation_accepted_pair CHECK (
      (accepted_knowledge_id IS NULL) = (accepted_knowledge_version_id IS NULL))
);
CREATE INDEX ix_curation_candidates_project
  ON knowledge_curation_candidates(workspace_id, project_id, created_at DESC);
CREATE INDEX ix_curation_candidates_knowledge
  ON knowledge_curation_candidates(suggested_knowledge_id);
GRANT SELECT, INSERT ON knowledge_curation_candidates TO relay_app;
GRANT UPDATE (accepted_knowledge_id, accepted_knowledge_version_id, decided_at, rejected_at)
  ON knowledge_curation_candidates TO relay_app;

-- N02 跨成果共创：候选组只关联同一次影响检查下已存在的候选目标，组合检查只保存
-- 「被一起看过的那的确切版本集合」。两者都不保存成果正文、不授予执行权，也都不把
-- 多个单项 PASS 折算成一个整体结论；逐项应用仍走既有 ApplyArtifactImpactCandidate。
CREATE TABLE artifact_impact_candidate_groups (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  impact_check_id uuid NOT NULL REFERENCES artifact_impact_checks(id),
  source_artifact_id uuid NOT NULL REFERENCES artifacts(id),
  source_before_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  source_after_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  source_artifact_revision bigint NOT NULL CHECK (source_artifact_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_impact_group_versions_distinct CHECK
    (source_before_version_id <> source_after_version_id)
);
CREATE INDEX ix_artifact_impact_candidate_groups_check
  ON artifact_impact_candidate_groups(impact_check_id, created_at DESC);
GRANT SELECT, INSERT ON artifact_impact_candidate_groups TO relay_app;

-- 每条目标都带真实外键：组不能引用不存在的版本。重复目标由唯一约束拒绝，
-- 允许顺序由 (group_id, ordinal) 主键承担。
CREATE TABLE artifact_impact_candidate_group_items (
  group_id uuid NOT NULL REFERENCES artifact_impact_candidate_groups(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  target_artifact_id uuid NOT NULL REFERENCES artifacts(id),
  target_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  relation text NOT NULL CHECK (relation <> ''),
  speculative boolean NOT NULL,
  PRIMARY KEY (group_id, ordinal),
  CONSTRAINT uq_impact_group_item_version UNIQUE (group_id, target_version_id)
);
CREATE INDEX ix_impact_group_items_target_version
  ON artifact_impact_candidate_group_items(target_version_id);
GRANT SELECT, INSERT ON artifact_impact_candidate_group_items TO relay_app;

-- 组合检查是覆盖快照，不是 Verification 会话：没有整体结论列，只能逐项记录当时
-- 看到的单项验证事实与缺口。
CREATE TABLE artifact_combination_checks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  group_id uuid NOT NULL REFERENCES artifact_impact_candidate_groups(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  acceptance_revision bigint NOT NULL CHECK (acceptance_revision >= 0),
  gaps jsonb NOT NULL CHECK (jsonb_typeof(gaps) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_artifact_combination_checks_group
  ON artifact_combination_checks(group_id, created_at DESC);
GRANT SELECT, INSERT ON artifact_combination_checks TO relay_app;

CREATE TABLE artifact_combination_check_items (
  combination_check_id uuid NOT NULL REFERENCES artifact_combination_checks(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  content_hash bytea NOT NULL,
  is_current_version boolean NOT NULL,
  readable boolean NOT NULL,
  verification_session_id uuid REFERENCES verification_sessions(id),
  verification_status text CHECK (
    verification_status IS NULL OR verification_status IN ('OPEN', 'PASS', 'RETRY', 'HUMAN')),
  PRIMARY KEY (combination_check_id, ordinal),
  CONSTRAINT uq_combination_check_item_version UNIQUE (combination_check_id, artifact_version_id),
  CONSTRAINT ck_combination_check_item_hash CHECK (octet_length(content_hash) = 32)
);
CREATE INDEX ix_combination_check_items_version
  ON artifact_combination_check_items(artifact_version_id);
GRANT SELECT, INSERT ON artifact_combination_check_items TO relay_app;

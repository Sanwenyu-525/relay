-- N02 基础依赖与确认选择；不保存成果正文或整体验收结论。
ALTER TABLE artifact_impact_candidate_groups
  ADD COLUMN dependencies jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(dependencies) = 'array' AND jsonb_array_length(dependencies) <= 90);

CREATE TABLE artifact_impact_group_selections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  group_id uuid NOT NULL REFERENCES artifact_impact_candidate_groups(id),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_impact_group_selections_group ON artifact_impact_group_selections(group_id, created_at DESC);
GRANT SELECT, INSERT ON artifact_impact_group_selections TO relay_app;

-- IMPACT_CHECK is a read-only Assist model intent. A check freezes exactly two
-- Artifact versions and keeps the model result separate from recorded lineage.
ALTER TABLE assist_messages DROP CONSTRAINT assist_messages_intent_check;
ALTER TABLE assist_messages ADD CONSTRAINT assist_messages_intent_check
  CHECK (intent IN ('DISCUSS', 'PROPOSE_CANDIDATE', 'PROPOSE_TASK', 'IMPACT_CHECK',
    'IMPACT_CANDIDATE'));

CREATE TABLE artifact_impact_checks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  source_before_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  source_after_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  artifact_revision bigint NOT NULL CHECK (artifact_revision >= 0),
  assist_session_id uuid NOT NULL REFERENCES assist_sessions(id),
  assist_message_id uuid NOT NULL UNIQUE REFERENCES assist_messages(id),
  direct_targets jsonb NOT NULL CHECK (jsonb_typeof(direct_targets) = 'array'),
  has_more boolean NOT NULL,
  input_truncated boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_artifact_impact_versions_distinct CHECK
    (source_before_version_id <> source_after_version_id)
);
CREATE INDEX ix_artifact_impact_checks_artifact ON artifact_impact_checks(artifact_id, created_at DESC);
GRANT SELECT, INSERT ON artifact_impact_checks TO relay_app;

CREATE TABLE artifact_impact_candidates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  impact_check_id uuid NOT NULL REFERENCES artifact_impact_checks(id),
  source_artifact_revision bigint NOT NULL CHECK (source_artifact_revision >= 0),
  target_artifact_id uuid NOT NULL REFERENCES artifacts(id),
  target_artifact_revision bigint NOT NULL CHECK (target_artifact_revision >= 0),
  target_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  assist_session_id uuid NOT NULL REFERENCES assist_sessions(id),
  assist_message_id uuid NOT NULL UNIQUE REFERENCES assist_messages(id),
  confirmed_possible boolean NOT NULL,
  applied_version_id uuid UNIQUE REFERENCES artifact_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX ix_artifact_impact_candidates_check ON artifact_impact_candidates(impact_check_id);
GRANT SELECT, INSERT ON artifact_impact_candidates TO relay_app;
GRANT UPDATE (applied_version_id, applied_at) ON artifact_impact_candidates TO relay_app;

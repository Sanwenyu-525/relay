-- M05/P14: immutable Project Blueprint candidates. Project/Task/State/View
-- remain the owners of applied facts; this table holds review and provenance.
CREATE TABLE project_blueprint_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
  origin text NOT NULL CHECK (origin IN ('USER_DRAFT', 'SKILL')),
  skill_message_id uuid REFERENCES assist_messages(id),
  supersedes_proposal_id uuid REFERENCES project_blueprint_proposals(id),
  candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'
    AND octet_length(candidate::text) <= 65536),
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline) = 'object'),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  candidate_sha256 text NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_blueprint_project_scope FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id),
  CONSTRAINT ck_blueprint_origin_message CHECK (
    (origin = 'USER_DRAFT' AND skill_message_id IS NULL)
    OR (origin = 'SKILL' AND skill_message_id IS NOT NULL)
  )
);
CREATE INDEX ix_blueprint_project_status
  ON project_blueprint_proposals (workspace_id, project_id, status,
    created_at DESC, id DESC);

CREATE FUNCTION guard_project_blueprint_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
     OLD.project_id IS DISTINCT FROM NEW.project_id OR
     OLD.origin IS DISTINCT FROM NEW.origin OR
     OLD.skill_message_id IS DISTINCT FROM NEW.skill_message_id OR
     OLD.supersedes_proposal_id IS DISTINCT FROM NEW.supersedes_proposal_id OR
     OLD.candidate IS DISTINCT FROM NEW.candidate OR
     OLD.baseline IS DISTINCT FROM NEW.baseline OR
     OLD.source IS DISTINCT FROM NEW.source OR
     OLD.candidate_sha256 IS DISTINCT FROM NEW.candidate_sha256 THEN
    RAISE EXCEPTION 'Project Blueprint candidate is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_project_blueprint_frozen BEFORE UPDATE ON project_blueprint_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_project_blueprint_frozen();

GRANT SELECT, INSERT, UPDATE ON project_blueprint_proposals TO relay_app;

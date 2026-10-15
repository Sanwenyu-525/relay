CREATE TABLE decision_premises (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  decision_id uuid NOT NULL REFERENCES decisions(id),
  decision_revision bigint NOT NULL,
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  knowledge_id uuid REFERENCES knowledge_items(id),
  hypothesis_id uuid REFERENCES hypotheses(id),
  baseline_ref jsonb NOT NULL CHECK (jsonb_typeof(baseline_ref) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((knowledge_id IS NULL) <> (hypothesis_id IS NULL))
);
CREATE INDEX decision_premises_decision ON decision_premises(workspace_id, decision_id);
CREATE TABLE decision_review_candidates (
  id uuid PRIMARY KEY,
  premise_id uuid NOT NULL REFERENCES decision_premises(id),
  decision_revision bigint NOT NULL,
  premise_revision bigint NOT NULL,
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  before_ref jsonb NOT NULL,
  after_ref jsonb NOT NULL,
  cause_command_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'KEPT', 'DISMISSED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  reason text CHECK (length(reason) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(premise_id, fingerprint),
  CHECK ((status = 'PENDING') = (resolved_at IS NULL AND reason IS NULL))
);
GRANT SELECT, INSERT, UPDATE ON decision_premises, decision_review_candidates TO relay_app;

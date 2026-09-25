-- P07 Review: exact target binding, immutable decisions, and persisted correction budget.
-- Existing migrations are append-only; the P06 finalized verification history is preserved.

CREATE TABLE review_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid REFERENCES projects (id),
  task_id uuid REFERENCES tasks (id),
  run_id uuid REFERENCES runs (id),
  verification_session_id uuid REFERENCES verification_sessions (id),
  criterion_id text,
  operation_id uuid,
  kind text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  revision bigint NOT NULL DEFAULT 0,
  target_hash bytea NOT NULL,
  target jsonb NOT NULL,
  evidence jsonb NOT NULL,
  effect jsonb NOT NULL,
  allowed_decisions text[] NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT ck_review_kind CHECK (kind IN ('CRITERION', 'RETRY_BUDGET', 'CHECKER_RETRY', 'ACTION_APPROVAL', 'STATE_PROPOSAL')),
  CONSTRAINT ck_review_status CHECK (status IN ('OPEN', 'DECIDED', 'EXPIRED')),
  CONSTRAINT ck_review_revision CHECK (revision >= 0),
  CONSTRAINT ck_review_hash CHECK (octet_length(target_hash) = 32),
  CONSTRAINT ck_review_json CHECK (jsonb_typeof(target) = 'object' AND jsonb_typeof(evidence) = 'object' AND jsonb_typeof(effect) = 'object'),
  CONSTRAINT ck_review_decisions CHECK (cardinality(allowed_decisions) > 0),
  CONSTRAINT ck_review_decided_at CHECK ((status = 'DECIDED') = (decided_at IS NOT NULL)),
  CONSTRAINT ck_review_operation CHECK ((kind = 'ACTION_APPROVAL') = (operation_id IS NOT NULL)),
  CONSTRAINT ck_review_criterion CHECK ((kind = 'CRITERION') = (criterion_id IS NOT NULL)),
  CONSTRAINT ck_review_session CHECK ((kind IN ('CRITERION', 'RETRY_BUDGET', 'CHECKER_RETRY')) = (verification_session_id IS NOT NULL))
);

CREATE UNIQUE INDEX uq_review_session_criterion
  ON review_requests (verification_session_id, criterion_id)
  WHERE kind = 'CRITERION';
CREATE UNIQUE INDEX uq_review_session_kind
  ON review_requests (verification_session_id, kind)
  WHERE kind IN ('RETRY_BUDGET', 'CHECKER_RETRY');
CREATE UNIQUE INDEX uq_review_operation ON review_requests (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX ix_review_inbox ON review_requests (workspace_id, status, created_at, id);
CREATE INDEX ix_review_run ON review_requests (run_id, created_at, id) WHERE run_id IS NOT NULL;

CREATE TABLE review_decisions (
  id uuid PRIMARY KEY,
  review_id uuid NOT NULL UNIQUE REFERENCES review_requests (id),
  command_id uuid NOT NULL,
  decision text NOT NULL,
  feedback text,
  retry_budget bigint,
  target_hash bytea NOT NULL,
  effect jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_review_decision CHECK (decision IN ('ACCEPT', 'REQUEST_CHANGES', 'SET_RETRY_BUDGET', 'RETRY_CHECKS', 'APPROVE', 'DENY')),
  CONSTRAINT ck_review_decision_hash CHECK (octet_length(target_hash) = 32),
  CONSTRAINT ck_review_decision_effect CHECK (jsonb_typeof(effect) = 'object'),
  CONSTRAINT ck_review_budget_value CHECK (retry_budget IS NULL OR retry_budget BETWEEN 1 AND 6)
);

CREATE TABLE run_correction_budgets (
  run_id uuid PRIMARY KEY REFERENCES runs (id),
  max_corrections bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_run_correction_budget CHECK (max_corrections BETWEEN 1 AND 6 AND revision >= 0)
);

-- Each Review-generated verification is a successor; no CheckResult is appended to
-- a finalized P06 session. Human evidence points at an immutable review decision.
ALTER TABLE verification_sessions ADD COLUMN parent_session_id uuid REFERENCES verification_sessions (id);
CREATE UNIQUE INDEX uq_verification_session_parent
  ON verification_sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON review_requests TO relay_app;
GRANT SELECT, INSERT ON review_decisions TO relay_app;
GRANT SELECT, INSERT, UPDATE ON run_correction_budgets TO relay_app;

CREATE TABLE task_time_estimates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  revision bigint NOT NULL CHECK (revision >= 1),
  acceptance_revision bigint NOT NULL,
  elapsed_ms bigint CHECK (elapsed_ms >= 0),
  execution_ms bigint CHECK (execution_ms >= 0),
  waiting_ms bigint CHECK (waiting_ms >= 0),
  review_ms bigint CHECK (review_ms >= 0),
  human_ms bigint CHECK (human_ms >= 0),
  source_note text NOT NULL CHECK (length(source_note) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, revision),
  FOREIGN KEY (task_id, acceptance_revision) REFERENCES task_acceptances(task_id, acceptance_revision)
);
CREATE TABLE period_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  available_ms bigint NOT NULL CHECK (available_ms > 0),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline) = 'object'),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK (ends_at > started_at)
);
CREATE INDEX period_plans_project ON period_plans(workspace_id, project_id, started_at DESC, id DESC);
GRANT SELECT, INSERT ON task_time_estimates TO relay_app;
GRANT SELECT, INSERT, UPDATE ON period_plans TO relay_app;

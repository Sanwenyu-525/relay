CREATE TABLE project_reminders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due_at timestamptz NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'ENABLED' CHECK (status IN ('ENABLED', 'PAUSED', 'DISABLED')),
  schedule_generation bigint NOT NULL DEFAULT 1 CHECK (schedule_generation >= 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  history jsonb NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_reminders_due ON project_reminders(workspace_id, due_at) WHERE status = 'ENABLED';
CREATE TABLE project_reminder_occurrences (
  id uuid PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES project_reminders(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  schedule_generation bigint NOT NULL,
  config_revision bigint NOT NULL,
  title text NOT NULL,
  due_at timestamptz NOT NULL,
  timezone text NOT NULL,
  missed boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'HANDLED', 'DISMISSED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  resolution_reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id, schedule_generation),
  CHECK ((status = 'PENDING') = (resolved_at IS NULL AND resolution_reason IS NULL))
);
CREATE INDEX project_reminder_occurrences_pending ON project_reminder_occurrences(workspace_id, created_at, id) WHERE status = 'PENDING';
GRANT SELECT, INSERT, UPDATE ON project_reminders, project_reminder_occurrences TO relay_app;

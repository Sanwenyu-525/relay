-- M05 P13: explicit Task planning metadata and recoverable user choices.
-- Today rankings are rebuilt from current facts; only Pin/Later/Focus are stored.
ALTER TABLE tasks
  ADD COLUMN priority text CHECK (priority IN ('LOW', 'NORMAL', 'HIGH')),
  ADD COLUMN due_local_date date,
  ADD COLUMN due_timezone text,
  ADD CONSTRAINT ck_tasks_due_pair CHECK
    ((due_local_date IS NULL AND due_timezone IS NULL) OR
     (due_local_date IS NOT NULL AND due_timezone IS NOT NULL AND due_timezone <> ''));

CREATE INDEX ix_tasks_today ON tasks (workspace_id, status, executor_kind, created_at, id);

CREATE TABLE today_selection_states (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_selections (
  task_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  pin boolean NOT NULL DEFAULT false,
  later_local_date date,
  later_timezone text,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_task_selections_task FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id),
  CONSTRAINT ck_task_selections_later_pair CHECK
    ((later_local_date IS NULL AND later_timezone IS NULL) OR
     (later_local_date IS NOT NULL AND later_timezone IS NOT NULL AND later_timezone <> '')),
  CONSTRAINT ck_task_selections_nonempty CHECK (pin OR later_local_date IS NOT NULL)
);
CREATE INDEX ix_task_selections_workspace ON task_selections (workspace_id, task_id);

CREATE TABLE focus_selections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  focus_local_date date NOT NULL,
  timezone text NOT NULL CHECK (timezone <> ''),
  goal_id uuid,
  project_id uuid,
  task_id uuid,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_focus_selections PRIMARY KEY (workspace_id, focus_local_date),
  CONSTRAINT fk_focus_goal FOREIGN KEY (workspace_id, goal_id)
    REFERENCES goals(workspace_id, id),
  CONSTRAINT fk_focus_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id),
  CONSTRAINT fk_focus_task FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks(workspace_id, id),
  CONSTRAINT ck_focus_one_target CHECK
    ((goal_id IS NOT NULL)::integer + (project_id IS NOT NULL)::integer +
     (task_id IS NOT NULL)::integer = 1)
);

GRANT SELECT, INSERT, UPDATE ON today_selection_states TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_selections, focus_selections TO relay_app;

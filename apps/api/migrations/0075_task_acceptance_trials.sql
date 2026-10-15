CREATE TABLE task_acceptance_trials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  acceptance_revision bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('ORIGINAL', 'EVIDENCE_VIEW')),
  sample_label text NOT NULL CHECK (length(sample_label) BETWEEN 1 AND 1024),
  material_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(material_ids) = 'array'),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'PAUSED', 'FINISHED')),
  started_at timestamptz NOT NULL,
  active_started_at timestamptz,
  finished_at timestamptz,
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  FOREIGN KEY (task_id, acceptance_revision) REFERENCES task_acceptances(task_id, acceptance_revision),
  CHECK ((status = 'RUNNING') = (active_started_at IS NOT NULL)),
  CHECK ((status = 'FINISHED') = (finished_at IS NOT NULL)),
  CHECK (mode <> 'ORIGINAL' OR material_ids = '[]'::jsonb)
);
CREATE INDEX task_acceptance_trials_task ON task_acceptance_trials(workspace_id, task_id, started_at DESC, id DESC);
CREATE TABLE task_acceptance_trial_observations (
  id uuid PRIMARY KEY,
  trial_id uuid NOT NULL REFERENCES task_acceptance_trials(id),
  trial_revision bigint NOT NULL CHECK (trial_revision >= 2),
  preparation_ms bigint CHECK (preparation_ms >= 0),
  total_acceptance_ms bigint CHECK (total_acceptance_ms >= 0),
  source_note text NOT NULL CHECK (length(source_note) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trial_id, trial_revision),
  CHECK (total_acceptance_ms IS NULL OR preparation_ms IS NULL OR total_acceptance_ms >= preparation_ms)
);
GRANT SELECT, INSERT, UPDATE ON task_acceptance_trials TO relay_app;
GRANT SELECT, INSERT ON task_acceptance_trial_observations TO relay_app;

-- External acceptance material is a reference, never a verification result.
-- Body/version ownership remains with Knowledge. Withdrawal preserves history.
CREATE TABLE task_acceptance_materials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  acceptance_revision bigint NOT NULL,
  criterion_id text,
  knowledge_version_id uuid NOT NULL REFERENCES knowledge_versions(id),
  tested_artifact_version_id uuid REFERENCES artifact_versions(id),
  source_label text,
  note text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WITHDRAWN')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  FOREIGN KEY (task_id, acceptance_revision)
    REFERENCES task_acceptances(task_id, acceptance_revision),
  FOREIGN KEY (task_id, acceptance_revision, criterion_id)
    REFERENCES acceptance_criteria(task_id, acceptance_revision, criterion_id),
  CHECK (criterion_id IS NULL OR length(criterion_id) BETWEEN 1 AND 128),
  CHECK (source_label IS NULL OR length(source_label) <= 1024),
  CHECK (note IS NULL OR length(note) <= 4000),
  CHECK ((status = 'ACTIVE' AND withdrawn_at IS NULL)
    OR (status = 'WITHDRAWN' AND withdrawn_at IS NOT NULL))
);
CREATE INDEX ix_task_acceptance_materials_task
  ON task_acceptance_materials(workspace_id, task_id, created_at DESC, id);
GRANT SELECT, INSERT, UPDATE ON task_acceptance_materials TO relay_app;

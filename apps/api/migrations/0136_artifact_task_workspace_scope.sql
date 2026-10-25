-- Refuse to bless existing cross-Workspace Artifact/Task references. Resolve
-- any reported rows explicitly before applying this append-only migration.
DO $$
DECLARE
  mismatch_count bigint;
BEGIN
  SELECT count(*)
  INTO mismatch_count
  FROM artifacts AS artifact
  JOIN tasks AS task ON task.id = artifact.task_id
  WHERE artifact.workspace_id IS DISTINCT FROM task.workspace_id;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      '0136 cannot add Artifact/Task Workspace scope: % existing row(s) conflict; inspect artifacts joined to tasks by task_id before retrying',
      mismatch_count
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE artifacts
  ADD CONSTRAINT fk_artifacts_workspace_task
  FOREIGN KEY (workspace_id, task_id)
  REFERENCES tasks (workspace_id, id)
  NOT VALID;

ALTER TABLE artifacts
  VALIDATE CONSTRAINT fk_artifacts_workspace_task;

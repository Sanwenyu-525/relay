-- P15: scoped Activity projection and exact, typed Artifact version provenance.
-- Historical Activity rows are attributed from authoritative owners. Unknown owners
-- abort the migration instead of disappearing from Workspace pagination.
ALTER TABLE activity_records ADD COLUMN workspace_id uuid;
ALTER TABLE activity_records ADD COLUMN run_id uuid;

UPDATE activity_records a SET workspace_id = COALESCE(
  (SELECT p.workspace_id FROM projects p WHERE p.id = a.project_id),
  (SELECT t.workspace_id FROM tasks t WHERE t.id = a.task_id),
  (SELECT w.id FROM workspaces w WHERE w.id::text = a.fact_refs->>'workspace_id'),
  (SELECT g.workspace_id FROM goals g WHERE g.id::text = a.fact_refs->>'goal_id'),
  (SELECT g.workspace_id FROM goals g
    WHERE a.fact_refs->>'target_kind' = 'GOAL' AND g.id::text = a.fact_refs->>'target_id'),
  (SELECT w.id FROM command_receipts c JOIN workspaces w
    ON c.scope_key IN ('workspace:' || w.id::text,
      'workspace:' || w.id::text || ':user:local') WHERE c.command_id = a.command_id)
);
UPDATE activity_records a SET run_id = COALESCE(
  (SELECT r.id FROM runs r WHERE r.id::text = a.fact_refs->>'run_id'),
  (SELECT q.run_id FROM review_requests q WHERE q.id::text = a.fact_refs->>'review_id'),
  (SELECT o.run_id FROM logical_operations o WHERE o.id::text = a.fact_refs->>'operation_id'),
  (SELECT c.run_id FROM run_control_requests c
    WHERE c.id::text = a.fact_refs->>'control_request_id')
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM activity_records WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'activity_records contain rows without an authoritative Workspace';
  END IF;
  IF EXISTS (SELECT 1 FROM activity_records a JOIN tasks t ON t.id = a.task_id
    WHERE t.workspace_id <> a.workspace_id) OR
    EXISTS (SELECT 1 FROM activity_records a JOIN runs r ON r.id = a.run_id
      WHERE r.workspace_id <> a.workspace_id) THEN
    RAISE EXCEPTION 'activity_records contain conflicting Workspace owners';
  END IF;
END $$;
ALTER TABLE activity_records ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE activity_records ADD CONSTRAINT fk_activity_records_workspace
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id);
ALTER TABLE activity_records ADD CONSTRAINT fk_activity_records_project_scope
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id);
ALTER TABLE activity_records ADD CONSTRAINT fk_activity_records_task_scope
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id);
ALTER TABLE activity_records ADD CONSTRAINT fk_activity_records_run_scope
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id);
CREATE INDEX ix_activity_records_workspace_page
  ON activity_records (workspace_id, created_at DESC, id DESC);
CREATE INDEX ix_activity_records_workspace_run_page
  ON activity_records (workspace_id, run_id, created_at DESC, id DESC)
  WHERE run_id IS NOT NULL;

CREATE TABLE artifact_lineage_edges (
  id uuid NOT NULL PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  child_version_id uuid NOT NULL REFERENCES artifact_versions (id),
  relation text NOT NULL,
  parent_kind text NOT NULL,
  parent_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_artifact_lineage_edge UNIQUE (child_version_id, relation, parent_kind, parent_id),
  CONSTRAINT ck_artifact_lineage_relation CHECK (
    (relation = 'DERIVED_FROM' AND parent_kind IN ('ARTIFACT_VERSION', 'KNOWLEDGE_VERSION')) OR
    (relation = 'REVISED_FROM' AND parent_kind = 'ARTIFACT_VERSION') OR
    (relation = 'GENERATED_BY' AND parent_kind = 'RUN_STEP') OR
    (relation = 'VERIFIED_BY' AND parent_kind = 'VERIFICATION_SESSION') OR
    (relation = 'ACCEPTED_BY' AND parent_kind = 'COMPLETION_RECORD')
  )
);
CREATE INDEX ix_artifact_lineage_parent
  ON artifact_lineage_edges (parent_kind, parent_id, child_version_id);

CREATE FUNCTION check_artifact_lineage_edge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child_workspace uuid; parent_workspace uuid;
BEGIN
  -- All writers in a Workspace use one transaction-scoped lock before checking
  -- the recursive closure, including direct SQL through the application role.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text, 20260926));
  SELECT a.workspace_id INTO child_workspace FROM artifact_versions v
    JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = NEW.child_version_id;
  IF child_workspace IS NULL OR child_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'lineage child is outside Workspace' USING ERRCODE = '23514';
  END IF;
  CASE NEW.parent_kind
    WHEN 'ARTIFACT_VERSION' THEN
      SELECT a.workspace_id INTO parent_workspace FROM artifact_versions v
        JOIN artifacts a ON a.id = v.artifact_id WHERE v.id = NEW.parent_id;
    WHEN 'KNOWLEDGE_VERSION' THEN
      SELECT k.workspace_id INTO parent_workspace FROM knowledge_versions v
        JOIN knowledge_items k ON k.id = v.knowledge_id WHERE v.id = NEW.parent_id;
    WHEN 'RUN_STEP' THEN
      SELECT r.workspace_id INTO parent_workspace FROM run_steps s
        JOIN runs r ON r.id = s.run_id WHERE s.id = NEW.parent_id;
    WHEN 'VERIFICATION_SESSION' THEN
      SELECT t.workspace_id INTO parent_workspace FROM verification_sessions v
        JOIN tasks t ON t.id = v.task_id WHERE v.id = NEW.parent_id;
    WHEN 'COMPLETION_RECORD' THEN
      SELECT t.workspace_id INTO parent_workspace FROM completion_records c
        JOIN tasks t ON t.id = c.task_id WHERE c.id = NEW.parent_id;
    ELSE RAISE EXCEPTION 'unknown lineage parent kind' USING ERRCODE = '23514';
  END CASE;
  IF parent_workspace IS NULL OR parent_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'lineage parent is outside Workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW.relation = 'REVISED_FROM' AND NOT EXISTS (
    SELECT 1 FROM artifact_versions child JOIN artifact_versions parent
      ON parent.id = NEW.parent_id WHERE child.id = NEW.child_version_id
      AND child.artifact_id = parent.artifact_id
      AND parent.version_number < child.version_number
  ) THEN
    RAISE EXCEPTION 'revision source must be an earlier version of the same Artifact'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.relation = 'GENERATED_BY' AND NOT EXISTS (
    SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
      JOIN run_steps s ON s.id = NEW.parent_id JOIN runs r ON r.id = s.run_id
      WHERE v.id = NEW.child_version_id AND r.task_id = a.task_id
        AND s.step_kind = 'PERSIST_CANDIDATE'
  ) THEN
    RAISE EXCEPTION 'generation step does not own Artifact Task' USING ERRCODE = '23514';
  END IF;
  IF NEW.relation = 'VERIFIED_BY' AND NOT EXISTS (
    SELECT 1 FROM verification_targets t WHERE t.session_id = NEW.parent_id
      AND t.artifact_version_id = NEW.child_version_id
  ) THEN
    RAISE EXCEPTION 'verification did not target Artifact version' USING ERRCODE = '23514';
  END IF;
  IF NEW.relation = 'ACCEPTED_BY' AND NOT EXISTS (
    SELECT 1 FROM completion_records c WHERE c.id = NEW.parent_id
      AND coalesce(c.state_delta->'artifact_version_ids', '[]'::jsonb)
        ? NEW.child_version_id::text
  ) THEN
    RAISE EXCEPTION 'completion did not accept Artifact version' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_kind = 'ARTIFACT_VERSION' THEN
    IF NEW.parent_id = NEW.child_version_id THEN
      RAISE EXCEPTION 'lineage version self-loop' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors(id) AS (
        SELECT e.parent_id FROM artifact_lineage_edges e
          WHERE e.child_version_id = NEW.parent_id AND e.parent_kind = 'ARTIFACT_VERSION'
        UNION
        SELECT e.parent_id FROM artifact_lineage_edges e JOIN ancestors a
          ON e.child_version_id = a.id WHERE e.parent_kind = 'ARTIFACT_VERSION'
      ) SELECT 1 FROM ancestors WHERE id = NEW.child_version_id
    ) THEN
      RAISE EXCEPTION 'lineage version cycle' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_artifact_lineage_validate BEFORE INSERT ON artifact_lineage_edges
  FOR EACH ROW EXECUTE FUNCTION check_artifact_lineage_edge();

GRANT SELECT, INSERT ON artifact_lineage_edges TO relay_app;

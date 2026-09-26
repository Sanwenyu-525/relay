-- M05 P14: Workspace-scoped keyset scans for the read-only Project and Task lists.
-- Existing Project/Inbox Task indexes remain in place for their older filter semantics.
CREATE INDEX ix_projects_workspace_created
  ON projects (workspace_id, created_at DESC, id DESC);

CREATE INDEX ix_tasks_workspace_created
  ON tasks (workspace_id, created_at DESC, id DESC);

-- Persist discovered lock conflicts and one reminder decision per exact intervention change.
CREATE TABLE artifact_lock_conflicts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  run_id uuid NOT NULL REFERENCES runs (id),
  task_id uuid NOT NULL REFERENCES tasks (id),
  artifact_id uuid NOT NULL REFERENCES artifacts (id),
  base_version_id uuid NOT NULL REFERENCES artifact_versions (id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_artifact_lock_conflicts_workspace ON artifact_lock_conflicts (workspace_id, created_at);

CREATE TABLE attention_notification_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  item_key text NOT NULL,
  change_key text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  delivery_status text NOT NULL DEFAULT 'CLAIMED'
    CHECK (delivery_status IN ('CLAIMED', 'DISPATCHED', 'DENIED', 'FAILED')),
  PRIMARY KEY (workspace_id, item_key, change_key),
  CHECK (length(item_key) BETWEEN 1 AND 160),
  CHECK (length(change_key) BETWEEN 1 AND 160)
);

GRANT SELECT, INSERT ON artifact_lock_conflicts TO relay_app;
GRANT SELECT, INSERT, UPDATE ON attention_notification_receipts TO relay_app;

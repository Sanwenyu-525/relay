-- A single durable lease serializes foreground desktop input across all Runs.
-- This is separate from resource_claims: the computer://desktop target is global,
-- while a Run may continue using its managed-directory resource normally.
CREATE TABLE computer_desktop_lease (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('FREE', 'HELD', 'QUARANTINED')),
  workspace_id uuid,
  run_id uuid,
  worker_id text,
  worker_epoch bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_computer_desktop_lease_run
    FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  CONSTRAINT ck_computer_desktop_lease_worker_epoch
    CHECK (worker_epoch IS NULL OR worker_epoch > 0),
  CHECK (
    (state = 'FREE' AND workspace_id IS NULL AND run_id IS NULL AND worker_id IS NULL AND worker_epoch IS NULL)
    OR
    (state IN ('HELD', 'QUARANTINED') AND workspace_id IS NOT NULL AND run_id IS NOT NULL
      AND ((worker_id IS NULL AND worker_epoch IS NULL) OR (worker_id IS NOT NULL AND worker_epoch IS NOT NULL)))
  )
);

INSERT INTO computer_desktop_lease (id, state) VALUES (1, 'FREE');

GRANT SELECT, UPDATE ON computer_desktop_lease TO relay_app;

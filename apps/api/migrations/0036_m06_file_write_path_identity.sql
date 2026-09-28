-- M06: new FILE_WRITE operations bind their frozen paths to Windows file identities.
-- Historical operations remain without this evidence and cannot gain it by rereading disk.
CREATE TABLE file_write_path_identity (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  capability_key text NOT NULL DEFAULT 'FILE_WRITE',
  action_type text NOT NULL,
  root_path text NOT NULL,
  root_id text NOT NULL,
  captures jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_file_write_path_operation_scope FOREIGN KEY
    (operation_id, workspace_id, project_id, run_id, resource_id, action_type)
    REFERENCES logical_operations (id, workspace_id, project_id, run_id, resource_id, action_type),
  CONSTRAINT fk_file_write_path_action FOREIGN KEY
    (operation_id, run_id, capability_key, action_type)
    REFERENCES logical_operations (id, run_id, capability_key, action_type),
  CONSTRAINT ck_file_write_path_action CHECK
    (capability_key = 'FILE_WRITE' AND action_type IN ('WRITE_FILE', 'APPLY_CHANGESET')),
  CONSTRAINT ck_file_write_root_id CHECK
    (root_id ~ '^[0-9a-f]{16}:[0-9a-f]{32}$'),
  CONSTRAINT ck_file_write_captures CHECK
    (jsonb_typeof(captures) = 'array' AND jsonb_array_length(captures) BETWEEN 1 AND 16)
);

GRANT SELECT, INSERT ON file_write_path_identity TO relay_app;

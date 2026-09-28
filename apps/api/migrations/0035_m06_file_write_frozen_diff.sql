-- M06: planned FILE_WRITE text diff evidence is frozen with its logical operation.
-- Target text remains solely in logical_operations.params. Historical operations are not backfilled.
CREATE TABLE file_write_frozen_diffs (
  operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  capability_key text NOT NULL DEFAULT 'FILE_WRITE',
  action_type text NOT NULL,
  relative_path text NOT NULL,
  file_action text NOT NULL,
  baseline_sha256 text NOT NULL,
  baseline_text text,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, relative_path),
  CONSTRAINT fk_frozen_diff_operation_scope FOREIGN KEY
    (operation_id, workspace_id, project_id, run_id, resource_id, action_type)
    REFERENCES logical_operations (id, workspace_id, project_id, run_id, resource_id, action_type),
  CONSTRAINT fk_frozen_diff_file_write FOREIGN KEY
    (operation_id, run_id, capability_key, action_type)
    REFERENCES logical_operations (id, run_id, capability_key, action_type),
  CONSTRAINT ck_frozen_diff_action CHECK
    (capability_key = 'FILE_WRITE' AND action_type IN ('WRITE_FILE', 'APPLY_CHANGESET')
     AND file_action IN ('MODIFY', 'DELETE')
     AND (action_type <> 'WRITE_FILE' OR
       (file_action = 'MODIFY' AND position('/' in relative_path) = 0))),
  CONSTRAINT ck_frozen_diff_path CHECK
    (relative_path <> '' AND octet_length(relative_path) <= 1024
     AND left(relative_path, 1) <> '/'
     AND relative_path !~ '^[A-Za-z]:'
     AND position(chr(92) in relative_path) = 0
     AND relative_path !~ '(^|/)(\.\.?)(/|$)'),
  CONSTRAINT ck_frozen_diff_hash CHECK (baseline_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_frozen_diff_availability CHECK (
    (baseline_text IS NOT NULL AND unavailable_reason IS NULL
      AND octet_length(baseline_text) <= 65536
      AND encode(sha256(convert_to(baseline_text, 'UTF8')), 'hex') = baseline_sha256)
    OR (baseline_text IS NULL AND unavailable_reason IN
      ('ROOT_CHANGED', 'PARENT_CHANGED', 'TARGET_NOT_REGULAR',
       'UNSAFE_OR_UNREADABLE', 'TEXT_TOO_LARGE', 'BASELINE_SHA_MISMATCH',
       'BINARY_OR_INVALID_UTF8')))
);

-- This is immutable intent evidence. The app role cannot revise it after Prepare.
GRANT SELECT, INSERT ON file_write_frozen_diffs TO relay_app;

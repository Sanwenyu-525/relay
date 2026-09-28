-- A desktop Job stop can be reused for recovery, but must retain the exact
-- FILE_WRITE Invocation and Worker identity observed before the Run is fenced.
ALTER TABLE invocation_attempts ADD CONSTRAINT uq_invocation_stop_proof_identity UNIQUE
  (id, operation_id, run_id, worker_id, worker_epoch);
ALTER TABLE logical_operations ADD CONSTRAINT uq_operation_stop_proof_source UNIQUE
  (id, run_id, capability_key, action_type);
ALTER TABLE run_commands ADD CONSTRAINT uq_run_command_stop_proof_identity UNIQUE (id, run_id);

CREATE TABLE file_write_stop_proofs (
  invocation_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  worker_id text NOT NULL,
  worker_epoch bigint NOT NULL,
  -- The outer Run command claim epoch is separate from runs.worker_epoch.
  dispatch_epoch bigint NOT NULL,
  command_id uuid NOT NULL,
  launch_id uuid NOT NULL,
  stop_evidence text NOT NULL,
  capability_key text NOT NULL DEFAULT 'FILE_WRITE',
  action_type text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_stop_proof_invocation FOREIGN KEY
    (invocation_id, operation_id, run_id, worker_id, worker_epoch)
    REFERENCES invocation_attempts (id, operation_id, run_id, worker_id, worker_epoch),
  CONSTRAINT fk_stop_proof_operation FOREIGN KEY
    (operation_id, run_id, capability_key, action_type)
    REFERENCES logical_operations (id, run_id, capability_key, action_type),
  CONSTRAINT fk_stop_proof_command FOREIGN KEY (command_id, run_id)
    REFERENCES run_commands (id, run_id),
  CONSTRAINT ck_stop_proof_file_write CHECK
    (capability_key = 'FILE_WRITE' AND action_type IN ('WRITE_FILE', 'APPLY_CHANGESET')),
  CONSTRAINT ck_stop_proof_epoch CHECK (worker_epoch > 0 AND dispatch_epoch > 0),
  CONSTRAINT ck_stop_proof_evidence CHECK (stop_evidence IN
    ('armed_job_terminated_and_active_count_zero',
     'armed_job_absent_after_last_handle_closed')),
  CONSTRAINT ck_stop_proof_launch_worker CHECK (worker_id ~
    ('^worker:desktop:' || launch_id::text ||
     ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);

CREATE INDEX ix_file_write_stop_proofs_run ON file_write_stop_proofs (run_id, recorded_at);
-- Application evidence is append-only; there is deliberately no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON file_write_stop_proofs TO relay_app;

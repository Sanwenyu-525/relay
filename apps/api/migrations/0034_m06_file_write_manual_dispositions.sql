-- A human may close a partially applied FILE_WRITE only after a trusted desktop
-- Job stop and a fresh read of every affected path. The original Invocation and
-- PARTIAL change set remain historical evidence; this row is the explicit decision.
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_status;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_status CHECK (status IN
  ('WAITING_APPROVAL', 'PREPARED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN',
   'DENIED', 'MANUALLY_CLOSED'));

ALTER TABLE change_sets ADD CONSTRAINT uq_change_set_disposition_source UNIQUE
  (id, invocation_id, operation_id, workspace_id, project_id, run_id, resource_id);
ALTER TABLE file_write_stop_proofs ADD CONSTRAINT uq_stop_proof_disposition_source UNIQUE
  (invocation_id, operation_id, run_id);

CREATE TABLE file_write_manual_dispositions (
  id uuid PRIMARY KEY,
  invocation_id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL,
  change_set_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  command_id uuid NOT NULL UNIQUE,
  actor_ref text NOT NULL,
  decision text NOT NULL,
  observation_sha256 text NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_disposition_change_set FOREIGN KEY
    (change_set_id, invocation_id, operation_id, workspace_id, project_id, run_id, resource_id)
    REFERENCES change_sets
      (id, invocation_id, operation_id, workspace_id, project_id, run_id, resource_id),
  CONSTRAINT fk_disposition_stop_proof FOREIGN KEY (invocation_id, operation_id, run_id)
    REFERENCES file_write_stop_proofs (invocation_id, operation_id, run_id),
  CONSTRAINT ck_disposition_decision CHECK (decision = 'KEEP_CURRENT_AND_FAIL_RUN'),
  CONSTRAINT ck_disposition_actor CHECK (actor_ref <> ''),
  CONSTRAINT ck_disposition_observation_hash CHECK (observation_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_disposition_observation CHECK (jsonb_typeof(observation) = 'object')
);

CREATE INDEX ix_file_write_dispositions_run ON file_write_manual_dispositions (run_id, created_at);
GRANT SELECT, INSERT ON file_write_manual_dispositions TO relay_app;

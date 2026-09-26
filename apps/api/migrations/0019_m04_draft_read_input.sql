-- M04: a DRAFT call can consume one already admitted Gateway read. Record the
-- structured input digest and the original action identity before Provider
-- invocation, including calls left STARTED by a worker crash. Historical calls
-- remain nullable because their exact structured inputs were not recorded.
ALTER TABLE model_calls
  ADD COLUMN input_sha256 text CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN read_operation_id uuid REFERENCES logical_operations(id),
  ADD COLUMN read_invocation_id uuid REFERENCES invocation_attempts(id),
  ADD CONSTRAINT model_calls_read_identity_pair CHECK
    ((read_operation_id IS NULL AND read_invocation_id IS NULL) OR
     (read_operation_id IS NOT NULL AND read_invocation_id IS NOT NULL)),
  ADD CONSTRAINT model_calls_read_origin CHECK
    (kind = 'DRAFT' OR
     (read_operation_id IS NULL AND read_invocation_id IS NULL));

CREATE INDEX ix_model_calls_read_operation ON model_calls (read_operation_id)
  WHERE read_operation_id IS NOT NULL;

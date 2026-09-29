-- Model-port verification (kind='VERIFY') is an instance-level connectivity
-- probe: no Run/Assist scope, no budget reservation. Results stay in the same
-- model_calls ledger so the settings page can read the last verification.
-- Drop every kind-scoped CHECK (enum + origin pair), then recreate both with
-- VERIFY included. model_calls_read_origin is kept (it does not mention SEMANTIC_CHECK).
DO $$
DECLARE
  cons record;
BEGIN
  FOR cons IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'model_calls'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%DRAFT%'
      AND pg_get_constraintdef(oid) LIKE '%SEMANTIC_CHECK%'
  LOOP
    EXECUTE format('ALTER TABLE model_calls DROP CONSTRAINT %I', cons.conname);
  END LOOP;
END $$;

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind
  CHECK (kind IN ('DRAFT', 'SEMANTIC_CHECK', 'ASSIST', 'VERIFY'));

ALTER TABLE model_calls ADD CONSTRAINT ck_model_calls_kind_origin CHECK (
  (kind = 'DRAFT' AND step_attempt_id IS NOT NULL AND manifest_id IS NOT NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  OR (kind = 'SEMANTIC_CHECK' AND step_attempt_id IS NOT NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NOT NULL AND criterion_id <> ''
    AND check_attempt IS NOT NULL)
  OR (kind = 'ASSIST' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NOT NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  OR (kind = 'VERIFY' AND step_attempt_id IS NULL AND manifest_id IS NULL
    AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
);

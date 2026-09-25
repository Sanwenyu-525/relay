-- M03: one durable order per Run. Existing product code only creates START;
-- the deterministic backfill also handles any previously inserted commands.
ALTER TABLE run_commands ADD COLUMN ordinal bigint;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY run_id ORDER BY created_at, id)::bigint AS position
  FROM run_commands
)
UPDATE run_commands AS command SET ordinal = numbered.position
FROM numbered WHERE command.id = numbered.id;

ALTER TABLE run_commands ALTER COLUMN ordinal SET NOT NULL;
ALTER TABLE run_commands ADD CONSTRAINT ck_run_commands_ordinal CHECK (ordinal > 0);
ALTER TABLE run_commands ADD CONSTRAINT uq_run_commands_run_ordinal UNIQUE (run_id, ordinal);

-- The Review decision is immutable and already binds the original operation,
-- normalized target, content hash and approval policy versions via its Review.
ALTER TABLE run_commands ADD COLUMN review_decision_id uuid REFERENCES review_decisions (id);
ALTER TABLE run_commands ADD CONSTRAINT uq_run_commands_review_decision UNIQUE (review_decision_id);
ALTER TABLE run_commands ADD CONSTRAINT ck_run_commands_review_resume CHECK (
  review_decision_id IS NULL OR kind = 'RESUME'
);

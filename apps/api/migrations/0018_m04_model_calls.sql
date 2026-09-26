-- M04: one durable evidence row per actual model invocation. This ledger does
-- not own Run, verification or Assist business status. STARTED after a crash
-- means the Provider outcome and charge are unknown, not zero or success.
CREATE TABLE model_calls (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('DRAFT', 'SEMANTIC_CHECK', 'ASSIST')),
  step_attempt_id uuid REFERENCES step_attempts(id),
  assist_message_id uuid REFERENCES assist_messages(id),
  manifest_id uuid REFERENCES context_manifests(id),
  criterion_id text,
  check_attempt integer CHECK (check_attempt > 0),
  provider text NOT NULL CHECK (provider <> ''),
  model text NOT NULL CHECK (model <> ''),
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_request_id text,
  status text NOT NULL DEFAULT 'STARTED'
    CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  usage_input_tokens integer CHECK (usage_input_tokens >= 0),
  usage_output_tokens integer CHECK (usage_output_tokens >= 0),
  error_kind text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK (
    (kind = 'DRAFT' AND step_attempt_id IS NOT NULL AND manifest_id IS NOT NULL
      AND assist_message_id IS NULL AND criterion_id IS NULL AND check_attempt IS NULL)
    OR (kind = 'SEMANTIC_CHECK' AND step_attempt_id IS NOT NULL AND manifest_id IS NULL
      AND assist_message_id IS NULL AND criterion_id IS NOT NULL AND criterion_id <> ''
      AND check_attempt IS NOT NULL)
    OR (kind = 'ASSIST' AND step_attempt_id IS NULL AND manifest_id IS NULL
      AND assist_message_id IS NOT NULL AND criterion_id IS NULL AND check_attempt IS NULL)
  ),
  CHECK ((status = 'STARTED' AND settled_at IS NULL AND error_kind IS NULL)
    OR (status = 'COMPLETED' AND settled_at IS NOT NULL AND error_kind IS NULL)
    OR (status = 'FAILED' AND settled_at IS NOT NULL AND error_kind IS NOT NULL)
    OR (status = 'CANCELLED' AND settled_at IS NOT NULL))
);

CREATE INDEX ix_model_calls_workspace ON model_calls (workspace_id, started_at DESC, id DESC);
CREATE INDEX ix_model_calls_step_attempt ON model_calls (step_attempt_id, started_at, id)
  WHERE step_attempt_id IS NOT NULL;
CREATE INDEX ix_model_calls_assist_message ON model_calls (assist_message_id, started_at, id)
  WHERE assist_message_id IS NOT NULL;

GRANT SELECT, INSERT ON model_calls TO relay_app;
GRANT UPDATE (status, provider_request_id, usage_input_tokens, usage_output_tokens,
  error_kind, settled_at) ON model_calls TO relay_app;

-- 0015 used zero for missing Assist usage. Historical double-zero values are
-- ambiguous, so migrate them conservatively to unknown rather than claim a
-- precise zero; known positive evidence remains untouched.
ALTER TABLE assist_messages ALTER COLUMN usage_input_tokens DROP DEFAULT;
ALTER TABLE assist_messages ALTER COLUMN usage_output_tokens DROP DEFAULT;
ALTER TABLE assist_messages ALTER COLUMN usage_input_tokens DROP NOT NULL;
ALTER TABLE assist_messages ALTER COLUMN usage_output_tokens DROP NOT NULL;
UPDATE assist_messages SET usage_input_tokens = NULL, usage_output_tokens = NULL
  WHERE role = 'USER' OR (usage_input_tokens = 0 AND usage_output_tokens = 0);

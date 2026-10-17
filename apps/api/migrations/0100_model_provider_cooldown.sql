-- Preserve provider Retry-After evidence so a restarted Worker or later message
-- does not immediately retry a model that explicitly asked the account to wait.
-- This stores no credential material and does not change the catalog's price facts.

CREATE TABLE model_provider_cooldowns (
  provider text NOT NULL CHECK (provider = 'openrouter'),
  scope text NOT NULL CHECK (scope IN ('ACCOUNT', 'MODEL')),
  model_id text NOT NULL,
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[0-9a-f]{64}$'),
  retry_after_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('UPSTREAM_PROVIDER_RATE_LIMIT',
    'PLATFORM_RATE_LIMIT', 'ACCOUNT_FREE_DAILY_EXHAUSTED')),
  model_call_id uuid NOT NULL REFERENCES model_calls(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (provider, scope, model_id, config_fingerprint),
  CHECK ((scope = 'ACCOUNT' AND model_id = '') OR
    (scope = 'MODEL' AND model_id ~ '^.{1,200}$'))
);

UPDATE assist_messages
SET model_attempt_state = model_attempt_state || jsonb_build_object('last_failure', null)
WHERE model_attempt_state IS NOT NULL AND NOT (model_attempt_state ? 'last_failure');

GRANT SELECT, INSERT, UPDATE ON model_provider_cooldowns TO relay_app;

-- Rollback is additive-safe: dropping this table forgets Retry-After evidence;
-- it does not remove model-call facts or alter user messages.

-- Prompt cache accounting. The Provider reports these per call; Relay only
-- records what the Provider actually said. NULL means the Provider did not
-- report the field, which is not zero: a missing cached_tokens must never read
-- as "no cache used". Historical rows stay unknown.
ALTER TABLE model_calls
  ADD COLUMN usage_cache_read_tokens integer CHECK (usage_cache_read_tokens >= 0),
  ADD COLUMN usage_cache_creation_tokens integer CHECK (usage_cache_creation_tokens >= 0),
  ADD CONSTRAINT ck_model_calls_cache_within_input CHECK (
    usage_cache_read_tokens IS NULL OR usage_cache_creation_tokens IS NULL
    OR usage_input_tokens IS NULL
    OR usage_cache_read_tokens + usage_cache_creation_tokens <= usage_input_tokens);

ALTER TABLE assist_messages
  ADD COLUMN usage_cache_read_tokens integer CHECK (usage_cache_read_tokens >= 0),
  ADD COLUMN usage_cache_creation_tokens integer CHECK (usage_cache_creation_tokens >= 0);

-- USER messages are never a model call, so cache columns stay NULL there.
ALTER TABLE assist_messages ADD CONSTRAINT ck_assist_messages_user_cache_null CHECK (
  role <> 'USER' OR (usage_cache_read_tokens IS NULL AND usage_cache_creation_tokens IS NULL));

-- model_calls only allows a column allowlist (0018); assist_messages keeps its
-- table-level UPDATE from 0015, so the new columns are already covered there.
GRANT UPDATE (usage_cache_read_tokens, usage_cache_creation_tokens)
  ON model_calls TO relay_app;

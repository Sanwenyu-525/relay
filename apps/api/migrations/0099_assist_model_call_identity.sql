-- Persist the active invocation identity before each provider request. A lost
-- Worker must stop on its STARTED model_calls row instead of repeating it.

UPDATE assist_messages
SET model_attempt_state = model_attempt_state || jsonb_build_object(
  'active_call_id', null,
  'active_candidate_index', null,
  'active_turn_id', null,
  'completed_turn_id', null,
  'completed_call_id', null
)
WHERE model_attempt_state IS NOT NULL
  AND NOT (model_attempt_state ? 'active_call_id');

-- Existing snapshots remain readable and all writes remain in the existing
-- Assist owner. The additive JSON fields are non-secret IDs and hashes only.

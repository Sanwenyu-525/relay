-- Freeze the chosen connection and bounded free-model candidate policy when a
-- user message is accepted. A later session selection or directory refresh must
-- not rewrite an already queued message's model identity.
-- API Breaking Change: No. Existing rows keep NULL and continue through the
-- process default model path; new snapshots are written only for explicit session selections.

ALTER TABLE assist_messages
  ADD COLUMN model_selection_snapshot jsonb NULL,
  ADD COLUMN model_attempt_state jsonb NULL,
  ADD CONSTRAINT assist_messages_model_snapshot_object_check
    CHECK (model_selection_snapshot IS NULL OR jsonb_typeof(model_selection_snapshot) = 'object'),
  ADD CONSTRAINT assist_messages_model_attempt_state_object_check
    CHECK (model_attempt_state IS NULL OR jsonb_typeof(model_attempt_state) = 'object'),
  ADD CONSTRAINT assist_messages_model_snapshot_state_pair_check
    CHECK ((model_selection_snapshot IS NULL) = (model_attempt_state IS NULL));

-- The existing assist_messages table grant is table-level and applies to these
-- appended columns. Rollback is additive-safe: old application code ignores
-- both columns; removing them would discard frozen identities for queued history.

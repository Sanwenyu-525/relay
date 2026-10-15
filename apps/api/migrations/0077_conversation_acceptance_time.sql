ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind
  CHECK (change_kind IN (
    'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
    'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
    'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK',
    'UNDO_STATE_CHANGE', 'REPORT_ACCEPTANCE_TIME'));
ALTER TABLE task_acceptance_trial_observations ADD COLUMN source_message_id uuid REFERENCES assist_messages(id);

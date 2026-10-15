CREATE TABLE work_segments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  expectation text NOT NULL CHECK (length(expectation) BETWEEN 1 AND 4000),
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline) = 'object'),
  source_message_id uuid REFERENCES assist_messages(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINISHED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result_snapshot jsonb,
  CHECK ((status = 'FINISHED') = (finished_at IS NOT NULL AND result_snapshot IS NOT NULL))
);
CREATE INDEX work_segments_project ON work_segments(workspace_id, project_id, started_at DESC, id DESC);
CREATE TABLE work_segment_events (
  id uuid PRIMARY KEY,
  segment_id uuid NOT NULL REFERENCES work_segments(id),
  kind text NOT NULL CHECK (kind IN ('REWORK', 'HUMAN_INTERVENTION')),
  task_id uuid REFERENCES tasks(id),
  source_run_id uuid REFERENCES runs(id),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  duration_ms bigint CHECK (duration_ms >= 0),
  status text NOT NULL DEFAULT 'CANDIDATE' CHECK (status IN ('CANDIDATE', 'CONFIRMED', 'WITHDRAWN')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON work_segments, work_segment_events TO relay_app;
ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind CHECK (change_kind IN (
  'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
  'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
  'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK',
  'UNDO_STATE_CHANGE', 'REPORT_ACCEPTANCE_TIME', 'CREATE_HYPOTHESIS', 'START_WORK_SEGMENT'));

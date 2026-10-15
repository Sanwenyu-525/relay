CREATE TABLE hypotheses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_version bigint NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  current_conclusion_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hypotheses_project ON hypotheses(workspace_id, project_id, created_at DESC, id DESC);
CREATE TABLE hypothesis_versions (
  id uuid PRIMARY KEY,
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  version bigint NOT NULL CHECK (version >= 1),
  claim text NOT NULL CHECK (length(claim) BETWEEN 1 AND 4000),
  method text NOT NULL CHECK (length(method) BETWEEN 1 AND 4000),
  criterion text NOT NULL CHECK (length(criterion) BETWEEN 1 AND 4000),
  source_knowledge_version_id uuid REFERENCES knowledge_versions(id),
  source_message_id uuid REFERENCES assist_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hypothesis_id, version)
);
CREATE TABLE hypothesis_observations (
  id uuid PRIMARY KEY,
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  hypothesis_version bigint NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  knowledge_version_id uuid REFERENCES knowledge_versions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (hypothesis_id, hypothesis_version) REFERENCES hypothesis_versions(hypothesis_id, version)
);
CREATE TABLE hypothesis_conclusions (
  id uuid PRIMARY KEY,
  hypothesis_id uuid NOT NULL REFERENCES hypotheses(id),
  hypothesis_version bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SUGGESTION', 'USER_CONFIRMED')),
  outcome text NOT NULL CHECK (outcome IN ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  evidence_sufficient boolean NOT NULL,
  method_reliable boolean NOT NULL,
  observation_ids jsonb NOT NULL CHECK (jsonb_typeof(observation_ids) = 'array'),
  suggestion_id uuid REFERENCES hypothesis_conclusions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (hypothesis_id, hypothesis_version) REFERENCES hypothesis_versions(hypothesis_id, version),
  CHECK ((kind = 'USER_CONFIRMED') = (suggestion_id IS NOT NULL))
);
ALTER TABLE hypotheses ADD FOREIGN KEY (current_conclusion_id) REFERENCES hypothesis_conclusions(id);
GRANT SELECT, INSERT, UPDATE ON hypotheses TO relay_app;
GRANT SELECT, INSERT ON hypothesis_versions, hypothesis_observations, hypothesis_conclusions TO relay_app;
ALTER TABLE conversation_state_changes DROP CONSTRAINT ck_conversation_state_change_kind;
ALTER TABLE conversation_state_changes ADD CONSTRAINT ck_conversation_state_change_kind CHECK (change_kind IN (
  'CREATE_GOAL', 'LINK_GOAL', 'CREATE_KNOWLEDGE', 'VERSION_KNOWLEDGE', 'CREATE_DECISION',
  'CREATE_TASK', 'ADD_TASK_DEPENDENCY', 'SET_NEXT_ACTION', 'SET_PHASE', 'ADD_BLOCKER',
  'RESOLVE_BLOCKER', 'SET_TASK_PLANNING', 'SYNC_EXTERNAL_RESULT', 'COMPLETE_TASK',
  'UNDO_STATE_CHANGE', 'REPORT_ACCEPTANCE_TIME', 'CREATE_HYPOTHESIS'));

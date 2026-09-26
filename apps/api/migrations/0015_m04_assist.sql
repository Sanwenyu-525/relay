-- M04: Assist sessions, messages and typed proposals (P12).
-- Assist serves conversation only: it never creates a Run, never holds a Task owner
-- and never writes business facts directly (runtime-context.md §5). Accepting a
-- proposal re-enters the same application commands a user would call manually.

CREATE TABLE assist_sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  title text NOT NULL CHECK (title <> ''),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_assist_sessions_scope
  ON assist_sessions (workspace_id, project_id, task_id, created_at DESC, id DESC);

-- Fixed message target: rows belong to exactly one session; a client that switches
-- pages cannot make an old reply land on a new Project/Task because the reply is
-- written to its own session only.
CREATE TABLE assist_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  seq bigint NOT NULL CHECK (seq > 0),
  role text NOT NULL CHECK (role IN ('USER', 'ASSISTANT')),
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  intent text NOT NULL DEFAULT 'DISCUSS'
    CHECK (intent IN ('DISCUSS', 'PROPOSE_CANDIDATE', 'PROPOSE_TASK')),
  content text,
  error_code text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  provider_request_id text,
  usage_input_tokens integer NOT NULL DEFAULT 0 CHECK (usage_input_tokens >= 0),
  usage_output_tokens integer NOT NULL DEFAULT 0 CHECK (usage_output_tokens >= 0),
  worker_id text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq),
  -- USER turns are always final text; ASSISTANT lifecycle is enforced by status.
  CHECK ((role = 'USER' AND status = 'COMPLETED' AND content IS NOT NULL
          AND usage_input_tokens = 0 AND usage_output_tokens = 0)
         OR role = 'ASSISTANT'),
  CHECK (role <> 'ASSISTANT' OR
         (status IN ('PENDING', 'RUNNING', 'CANCELLED') AND content IS NULL) OR
         (status = 'COMPLETED' AND content IS NOT NULL) OR
         (status = 'FAILED'))
);

-- Claim queue for the generation worker; settled rows leave this index.
CREATE INDEX ix_assist_messages_claim
  ON assist_messages (created_at, id) WHERE status = 'PENDING';

CREATE TABLE assist_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  message_id uuid NOT NULL REFERENCES assist_messages(id),
  kind text NOT NULL CHECK (kind IN ('CANDIDATE_MARKDOWN', 'TASK_DEFINITION')),
  project_id uuid REFERENCES projects(id),
  task_id uuid REFERENCES tasks(id),
  target_type text NOT NULL CHECK (target_type IN ('TASK', 'PROJECT')),
  target_id uuid NOT NULL,
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash <> ''),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'CANDIDATE_MARKDOWN' AND target_type = 'TASK'
          AND task_id IS NOT NULL AND target_id = task_id)
         OR (kind = 'TASK_DEFINITION' AND target_type = 'PROJECT'
             AND project_id IS NOT NULL AND task_id IS NULL AND target_id = project_id))
);

CREATE INDEX ix_assist_proposals_scope
  ON assist_proposals (workspace_id, status, created_at DESC, id DESC);

GRANT SELECT, INSERT, UPDATE ON assist_sessions, assist_messages, assist_proposals TO relay_app;

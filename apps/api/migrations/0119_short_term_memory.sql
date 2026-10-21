CREATE TABLE assist_memory_state (
  session_id uuid PRIMARY KEY REFERENCES assist_sessions(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  cleared_through_seq bigint NOT NULL DEFAULT 0 CHECK (cleared_through_seq >= 0),
  checkpoint_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assist_memory_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  session_revision bigint NOT NULL,
  authority_revision bigint NOT NULL,
  context_revision bigint NOT NULL,
  memory_revision bigint NOT NULL,
  settings_revision bigint NOT NULL,
  through_seq bigint NOT NULL CHECK (through_seq > 0),
  anchor_message_id uuid NOT NULL REFERENCES assist_messages(id),
  source_message_ids jsonb NOT NULL CHECK (jsonb_typeof(source_message_ids) = 'array'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  model_snapshot jsonb NOT NULL,
  reason text NOT NULL CHECK (reason IN ('MANUAL', 'AUTO')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  worker_id text,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  model_call_id uuid REFERENCES model_calls(id),
  checkpoint_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_assist_memory_active_request ON assist_memory_requests(session_id)
  WHERE status IN ('PENDING', 'RUNNING');
CREATE INDEX ix_assist_memory_requests_pending ON assist_memory_requests(created_at, id)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE TABLE assist_memory_checkpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  session_revision bigint NOT NULL,
  authority_revision bigint NOT NULL,
  context_revision bigint NOT NULL,
  through_seq bigint NOT NULL CHECK (through_seq > 0),
  source_message_ids jsonb NOT NULL CHECK (jsonb_typeof(source_message_ids) = 'array'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 12000),
  model_call_id uuid NOT NULL REFERENCES model_calls(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assist_memory_state ADD FOREIGN KEY (checkpoint_id) REFERENCES assist_memory_checkpoints(id);
ALTER TABLE assist_memory_requests ADD FOREIGN KEY (checkpoint_id) REFERENCES assist_memory_checkpoints(id);
CREATE TABLE assist_memory_uses (
  message_id uuid PRIMARY KEY REFERENCES assist_messages(id),
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  authority_revision bigint NOT NULL,
  context_revision bigint NOT NULL,
  memory_revision bigint NOT NULL,
  checkpoint_id uuid REFERENCES assist_memory_checkpoints(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON assist_memory_state, assist_memory_requests TO relay_app;
GRANT SELECT, INSERT, DELETE ON assist_memory_checkpoints TO relay_app;
GRANT SELECT, INSERT, DELETE ON assist_memory_uses TO relay_app;

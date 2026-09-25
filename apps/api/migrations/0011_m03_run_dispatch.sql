-- M03: durable Run commands and delivery, separate from Run business state.
-- The application transaction that creates a Run also inserts its START command
-- and outbox row. A notification is only a wakeup; polling these rows is required.

CREATE TABLE run_commands (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_command_id text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_run_commands_run FOREIGN KEY (workspace_id, run_id)
    REFERENCES runs (workspace_id, id),
  CONSTRAINT uq_run_commands_source UNIQUE (workspace_id, source_command_id),
  CONSTRAINT ck_run_commands_source CHECK (source_command_id <> ''),
  CONSTRAINT ck_run_commands_kind CHECK (kind IN ('START', 'RESUME', 'RECOVER'))
);

CREATE INDEX ix_run_commands_run ON run_commands (run_id, created_at, id);

CREATE TABLE run_command_outbox (
  command_id uuid PRIMARY KEY REFERENCES run_commands (id),
  status text NOT NULL DEFAULT 'PENDING',
  claim_epoch bigint,
  worker_id text,
  claimed_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_run_command_outbox_status CHECK
    (status IN ('PENDING', 'CLAIMED', 'DONE', 'BLOCKED')),
  CONSTRAINT ck_run_command_outbox_claim CHECK (
    (status = 'PENDING' AND claim_epoch IS NULL AND worker_id IS NULL
      AND claimed_at IS NULL AND settled_at IS NULL)
    OR (status = 'CLAIMED' AND claim_epoch IS NOT NULL AND worker_id IS NOT NULL
      AND worker_id <> '' AND claimed_at IS NOT NULL AND settled_at IS NULL)
    OR (status IN ('DONE', 'BLOCKED') AND settled_at IS NOT NULL)
  ),
  CONSTRAINT ck_run_command_outbox_epoch CHECK (claim_epoch IS NULL OR claim_epoch > 0)
);

CREATE INDEX ix_run_command_outbox_pending ON run_command_outbox (updated_at, command_id)
  WHERE status = 'PENDING';

-- One row per Run is the entire execution thread's invocation fence. Existing
-- runs.worker_id / worker_epoch are short-lived per-step claims and stay separate.
CREATE TABLE run_invocations (
  run_id uuid PRIMARY KEY REFERENCES runs (id),
  epoch bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'IDLE',
  worker_id text,
  command_id uuid REFERENCES run_commands (id),
  lease_until timestamptz,
  stop_evidence text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_run_invocations_epoch CHECK (epoch >= 0),
  CONSTRAINT ck_run_invocations_status CHECK (status IN ('IDLE', 'ACTIVE', 'STOP_REQUIRED')),
  CONSTRAINT ck_run_invocations_state CHECK (
    (status = 'IDLE' AND worker_id IS NULL AND command_id IS NULL
      AND lease_until IS NULL)
    OR (status IN ('ACTIVE', 'STOP_REQUIRED') AND worker_id IS NOT NULL
      AND worker_id <> '' AND command_id IS NOT NULL AND lease_until IS NOT NULL)
  )
);

CREATE INDEX ix_run_invocations_lease ON run_invocations (lease_until, run_id)
  WHERE status = 'ACTIVE';

-- Historical Run rows predate this transport. They do not receive synthetic
-- START commands, since doing so would silently execute old user work.
INSERT INTO run_invocations (run_id)
SELECT id FROM runs;

GRANT SELECT, INSERT ON run_commands TO relay_app;
GRANT SELECT, INSERT, UPDATE ON run_command_outbox, run_invocations TO relay_app;

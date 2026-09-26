-- One disposable, bounded prefix for the current Run DRAFT model call.
-- It is never an ArtifactVersion, verification result or Run completion fact.
CREATE TABLE run_draft_previews (
  run_id uuid PRIMARY KEY REFERENCES runs(id),
  step_attempt_id uuid NOT NULL REFERENCES step_attempts(id),
  attempt_claim_epoch bigint NOT NULL CHECK (attempt_claim_epoch > 0),
  run_worker_epoch bigint NOT NULL CHECK (run_worker_epoch > 0),
  worker_id text NOT NULL,
  invocation_epoch bigint CHECK (invocation_epoch IS NULL OR invocation_epoch > 0),
  model_call_id uuid NOT NULL UNIQUE REFERENCES model_calls(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  preview_text text NOT NULL CHECK (octet_length(preview_text) <= 16384),
  truncated boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON run_draft_previews TO relay_app;

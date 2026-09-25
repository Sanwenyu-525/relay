-- P08：持久控制、Run worker fence 与受控 Fake 发布动作身份。
-- 只追加迁移；0001–0006 的已应用内容不可改写。

ALTER TABLE tasks DROP CONSTRAINT ck_tasks_status;
ALTER TABLE tasks ADD CONSTRAINT ck_tasks_status
  CHECK (status IN ('INBOX', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'DONE', 'CANCELLED'));

ALTER TABLE runs
  ADD COLUMN worker_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN worker_id text,
  ADD COLUMN worker_lease_until timestamptz;
ALTER TABLE runs ADD CONSTRAINT ck_runs_worker_epoch CHECK (worker_epoch >= 0);
ALTER TABLE runs ADD CONSTRAINT ck_runs_worker_claim CHECK (
  (worker_id IS NULL AND worker_lease_until IS NULL)
  OR (worker_id IS NOT NULL AND worker_id <> '' AND worker_lease_until IS NOT NULL)
);
ALTER TABLE runs DROP CONSTRAINT ck_runs_resume_phase;
ALTER TABLE runs ADD CONSTRAINT ck_runs_resume_phase CHECK (
  resume_phase IS NULL OR resume_phase IN
    ('CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'VERIFYING', 'RETRYING', 'WAITING_APPROVAL')
);

CREATE TABLE run_control_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  type text NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  revision bigint NOT NULL DEFAULT 0,
  result_ref jsonb,
  supersedes_request_id uuid REFERENCES run_control_requests (id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT fk_run_control_run FOREIGN KEY (run_id, task_id) REFERENCES runs (id, task_id),
  CONSTRAINT fk_run_control_workspace FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  CONSTRAINT ck_run_control_type CHECK (type IN ('PAUSE', 'CANCEL', 'HANDOFF', 'CANCEL_TASK')),
  CONSTRAINT ck_run_control_status CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED', 'SUPERSEDED')),
  CONSTRAINT ck_run_control_revision CHECK (revision >= 0),
  CONSTRAINT ck_run_control_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object'),
  CONSTRAINT ck_run_control_decided CHECK ((status = 'PENDING') = (decided_at IS NULL)),
  CONSTRAINT ck_run_control_actor CHECK (requested_by <> '')
);
CREATE UNIQUE INDEX uq_run_control_pending ON run_control_requests (run_id) WHERE status = 'PENDING';
CREATE INDEX ix_run_control_history ON run_control_requests (run_id, requested_at DESC, id);

ALTER TABLE step_attempts ADD CONSTRAINT uq_step_attempt_id_step UNIQUE (id, step_id);

CREATE TABLE run_effect_actions (
  operation_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  attempt_id uuid NOT NULL UNIQUE,
  action_type text NOT NULL,
  target_ref text NOT NULL,
  params_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'PREPARED',
  result_ref jsonb,
  revision bigint NOT NULL DEFAULT 0,
  dispatch_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT fk_run_effect_step FOREIGN KEY (run_id, step_id) REFERENCES run_steps (run_id, id),
  CONSTRAINT fk_run_effect_attempt FOREIGN KEY (attempt_id, step_id) REFERENCES step_attempts (id, step_id),
  CONSTRAINT ck_run_effect_action_type CHECK (action_type = 'PUBLISH_CANDIDATE'),
  CONSTRAINT ck_run_effect_target CHECK (target_ref <> ''),
  CONSTRAINT ck_run_effect_hash CHECK (octet_length(params_hash) = 32),
  CONSTRAINT ck_run_effect_status CHECK (status IN ('PREPARED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  CONSTRAINT ck_run_effect_revision CHECK (revision >= 0),
  CONSTRAINT ck_run_effect_dispatch_count CHECK (dispatch_count >= 0),
  CONSTRAINT ck_run_effect_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object')
);
CREATE INDEX ix_run_effect_unresolved ON run_effect_actions (run_id, created_at)
  WHERE status IN ('DISPATCHING', 'UNKNOWN');

GRANT SELECT, INSERT, UPDATE ON run_control_requests, run_effect_actions TO relay_app;
GRANT SELECT, INSERT, UPDATE ON runs, tasks TO relay_app;

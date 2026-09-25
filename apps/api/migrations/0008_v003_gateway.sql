-- P09: one guarded Fake Gateway. Existing migrations remain SHA-stable.
-- A Connection enables an adapter, a Capability describes an action, and a
-- Permission is the independently revocable authority to perform it.

CREATE TABLE gateway_capabilities (
  capability_key text PRIMARY KEY,
  adapter_kind text NOT NULL,
  effect_kind text NOT NULL,
  CONSTRAINT ck_gateway_capability_kind CHECK (adapter_kind = 'FAKE' AND effect_kind IN ('READ', 'WRITE'))
);
INSERT INTO gateway_capabilities VALUES
  ('FAKE_WRITE', 'FAKE', 'WRITE'),
  ('FAKE_PUBLIC_READ', 'FAKE', 'READ');

CREATE TABLE gateway_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  adapter_kind text NOT NULL DEFAULT 'FAKE',
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_gateway_connections_scope UNIQUE (workspace_id, id),
  CONSTRAINT uq_gateway_connections_project_scope UNIQUE (workspace_id, project_id, id),
  CONSTRAINT fk_gateway_connections_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_gateway_connection_adapter CHECK (adapter_kind = 'FAKE'),
  CONSTRAINT ck_gateway_connection_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT ck_gateway_connection_version CHECK (version >= 1),
  CONSTRAINT ck_gateway_connection_config CHECK (config = '{}'::jsonb)
);

CREATE TABLE gateway_connection_capabilities (
  connection_id uuid NOT NULL REFERENCES gateway_connections (id),
  capability_key text NOT NULL REFERENCES gateway_capabilities (capability_key),
  PRIMARY KEY (connection_id, capability_key)
);

CREATE TABLE gateway_permission_policies (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  active_version bigint,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_gateway_permission_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT uq_gateway_policy_project_scope UNIQUE (workspace_id, project_id, id),
  CONSTRAINT ck_gateway_permission_status CHECK (status IN ('ACTIVE', 'REVOKED')),
  CONSTRAINT ck_gateway_permission_active CHECK (
    (status = 'ACTIVE' AND active_version IS NOT NULL AND active_version >= 1)
    OR (status = 'REVOKED' AND active_version IS NULL)
  ),
  CONSTRAINT ck_gateway_permission_revision CHECK (revision >= 0)
);

CREATE TABLE gateway_permission_versions (
  policy_id uuid NOT NULL REFERENCES gateway_permission_policies (id),
  version bigint NOT NULL,
  capability_key text NOT NULL REFERENCES gateway_capabilities (capability_key),
  action_type text NOT NULL,
  target_prefix text NOT NULL,
  decision text NOT NULL,
  max_payload_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version),
  CONSTRAINT ck_gateway_permission_decision CHECK (decision IN ('AUTO', 'ASK', 'DENY')),
  CONSTRAINT ck_gateway_permission_values CHECK (action_type <> '' AND target_prefix <> ''
    AND max_payload_bytes BETWEEN 0 AND 262144 AND version >= 1)
);
ALTER TABLE gateway_permission_policies ADD CONSTRAINT fk_gateway_permission_current
  FOREIGN KEY (id, active_version) REFERENCES gateway_permission_versions (policy_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_gateway_permission_scope ON gateway_permission_policies
  (workspace_id, project_id, id) WHERE status = 'ACTIVE';

CREATE TABLE managed_resources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  canonical_root text NOT NULL,
  identity_key text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  resource_epoch bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_managed_resource_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT uq_managed_resource_scope UNIQUE (workspace_id, id),
  CONSTRAINT uq_managed_resource_project_scope UNIQUE (workspace_id, project_id, id),
  CONSTRAINT uq_managed_resource_project_root UNIQUE (project_id, identity_key),
  CONSTRAINT ck_managed_resource_status CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT ck_managed_resource_root CHECK (canonical_root <> '' AND identity_key <> ''
    AND resource_epoch >= 0 AND revision >= 0)
);

CREATE TABLE resource_claims (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks (id),
  run_id uuid NOT NULL REFERENCES runs (id),
  worker_id text NOT NULL,
  worker_epoch bigint NOT NULL,
  claim_epoch bigint NOT NULL,
  claim_token uuid NOT NULL UNIQUE,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT fk_resource_claim_task_run FOREIGN KEY (task_id, run_id) REFERENCES runs (task_id, id),
  CONSTRAINT fk_resource_claim_resource_scope FOREIGN KEY (workspace_id, project_id, resource_id)
    REFERENCES managed_resources (workspace_id, project_id, id),
  CONSTRAINT fk_resource_claim_task_scope FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT fk_resource_claim_task_project FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (id, project_id),
  CONSTRAINT uq_resource_claim_identity UNIQUE
    (id, resource_id, task_id, run_id, worker_id, worker_epoch, claim_epoch, claim_token),
  CONSTRAINT ck_resource_claim_status CHECK (status IN ('HELD', 'QUARANTINED', 'RELEASED')),
  CONSTRAINT ck_resource_claim_epochs CHECK (worker_epoch >= 0 AND claim_epoch >= 1),
  CONSTRAINT ck_resource_claim_worker CHECK (worker_id <> ''),
  CONSTRAINT ck_resource_claim_release CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_resource_occupied ON resource_claims (resource_id)
  WHERE status IN ('HELD', 'QUARANTINED');

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  actor_ref text NOT NULL,
  config_version text NOT NULL,
  source_uri text NOT NULL,
  request_command_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'QUEUED',
  error text,
  knowledge_version_id uuid,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_import_job_scope UNIQUE (workspace_id, id),
  CONSTRAINT uq_import_job_project_scope UNIQUE (workspace_id, project_id, id),
  CONSTRAINT fk_import_job_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_import_job_status CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  CONSTRAINT ck_import_job_values CHECK (actor_ref <> '' AND config_version <> '' AND source_uri <> ''),
  CONSTRAINT ck_import_job_revision CHECK (revision >= 0)
);

CREATE TABLE logical_operations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid NOT NULL,
  origin text NOT NULL,
  task_id uuid,
  run_id uuid,
  step_id uuid,
  import_job_id uuid,
  intent_key text NOT NULL,
  connection_id uuid NOT NULL,
  connection_version bigint NOT NULL,
  connection_config jsonb NOT NULL,
  policy_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  capability_key text NOT NULL REFERENCES gateway_capabilities (capability_key),
  action_type text NOT NULL,
  normalized_target text NOT NULL,
  params_hash bytea NOT NULL,
  params jsonb NOT NULL,
  resource_id uuid,
  status text NOT NULL,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_logical_operation_run_intent UNIQUE (run_id, step_id, intent_key),
  CONSTRAINT uq_logical_operation_import_intent UNIQUE (import_job_id, intent_key),
  CONSTRAINT uq_logical_operation_id_workspace UNIQUE (id, workspace_id),
  CONSTRAINT uq_logical_operation_origin UNIQUE (id, origin),
  CONSTRAINT uq_logical_operation_run_resource UNIQUE (id, origin, run_id, task_id, resource_id),
  CONSTRAINT fk_logical_operation_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_logical_operation_connection FOREIGN KEY (workspace_id, project_id, connection_id)
    REFERENCES gateway_connections (workspace_id, project_id, id),
  CONSTRAINT fk_logical_operation_policy_scope FOREIGN KEY (workspace_id, project_id, policy_id)
    REFERENCES gateway_permission_policies (workspace_id, project_id, id),
  CONSTRAINT fk_logical_operation_policy_version FOREIGN KEY (policy_id, policy_version)
    REFERENCES gateway_permission_versions (policy_id, version),
  CONSTRAINT fk_logical_operation_task_project FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (id, project_id),
  CONSTRAINT fk_logical_operation_task_run FOREIGN KEY (task_id, run_id)
    REFERENCES runs (task_id, id),
  CONSTRAINT fk_logical_operation_run_scope FOREIGN KEY (workspace_id, run_id)
    REFERENCES runs (workspace_id, id),
  CONSTRAINT fk_logical_operation_run FOREIGN KEY (run_id, step_id)
    REFERENCES run_steps (run_id, id),
  CONSTRAINT fk_logical_operation_import FOREIGN KEY (workspace_id, project_id, import_job_id)
    REFERENCES import_jobs (workspace_id, project_id, id),
  CONSTRAINT fk_logical_operation_resource FOREIGN KEY (workspace_id, project_id, resource_id)
    REFERENCES managed_resources (workspace_id, project_id, id),
  CONSTRAINT ck_logical_operation_origin CHECK (
    (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND step_id IS NOT NULL AND import_job_id IS NULL)
    OR (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND step_id IS NULL AND import_job_id IS NOT NULL)
  ),
  CONSTRAINT ck_logical_operation_status CHECK (status IN
    ('WAITING_APPROVAL', 'PREPARED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'DENIED')),
  CONSTRAINT ck_logical_operation_hash CHECK (octet_length(params_hash) = 32),
  CONSTRAINT ck_logical_operation_params CHECK (
    jsonb_typeof(params) = 'object' AND connection_config = '{}'::jsonb),
  CONSTRAINT ck_logical_operation_values CHECK (intent_key <> '' AND action_type <> ''
    AND normalized_target <> '' AND connection_version >= 1),
  CONSTRAINT ck_logical_operation_resource CHECK (
    (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
    OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  )
);
CREATE INDEX ix_logical_operations_run ON logical_operations (run_id, step_id, id)
  WHERE run_id IS NOT NULL;

CREATE TABLE invocation_attempts (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  origin text NOT NULL,
  task_id uuid,
  run_id uuid,
  resource_id uuid,
  attempt_number bigint NOT NULL,
  status text NOT NULL,
  authority_revision bigint NOT NULL,
  connection_version bigint NOT NULL,
  connection_config jsonb NOT NULL,
  ownership_epoch bigint,
  worker_id text,
  worker_epoch bigint,
  resource_claim_id uuid,
  claim_token uuid,
  claim_epoch bigint,
  result_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT uq_invocation_attempt UNIQUE (operation_id, attempt_number),
  CONSTRAINT uq_invocation_id_operation UNIQUE (id, operation_id),
  CONSTRAINT fk_invocation_operation_origin FOREIGN KEY (operation_id, origin)
    REFERENCES logical_operations (id, origin),
  CONSTRAINT fk_invocation_operation_run FOREIGN KEY (operation_id, origin, run_id, task_id, resource_id)
    REFERENCES logical_operations (id, origin, run_id, task_id, resource_id),
  CONSTRAINT fk_invocation_claim_identity FOREIGN KEY
    (resource_claim_id, resource_id, task_id, run_id, worker_id, worker_epoch, claim_epoch, claim_token)
    REFERENCES resource_claims
    (id, resource_id, task_id, run_id, worker_id, worker_epoch, claim_epoch, claim_token),
  CONSTRAINT ck_invocation_status CHECK (status IN
    ('PREPARED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'NOT_EXECUTED')),
  CONSTRAINT ck_invocation_numbers CHECK (attempt_number >= 1 AND authority_revision >= 0
    AND connection_version >= 1),
  CONSTRAINT ck_invocation_config CHECK (connection_config = '{}'::jsonb),
  CONSTRAINT ck_invocation_run_identity CHECK (
    (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NULL
      AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
      AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
    OR (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND resource_id IS NOT NULL
      AND ownership_epoch IS NOT NULL AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL
      AND resource_claim_id IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL)
  ),
  CONSTRAINT ck_invocation_result CHECK (result_ref IS NULL OR jsonb_typeof(result_ref) = 'object')
);
CREATE UNIQUE INDEX uq_invocation_unsettled ON invocation_attempts (operation_id)
  WHERE status IN ('PREPARED', 'DISPATCHING', 'UNKNOWN');
CREATE INDEX ix_invocation_reconcile ON invocation_attempts (status, dispatched_at, id)
  WHERE status IN ('DISPATCHING', 'UNKNOWN');

CREATE TABLE approval_reservations (
  review_id uuid PRIMARY KEY REFERENCES review_requests (id),
  operation_id uuid NOT NULL UNIQUE REFERENCES logical_operations (id),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_reservation_pair UNIQUE (review_id, operation_id)
);
ALTER TABLE review_requests ADD CONSTRAINT uq_review_operation_identity UNIQUE (id, operation_id);
ALTER TABLE approval_reservations ADD CONSTRAINT fk_approval_review_operation
  FOREIGN KEY (review_id, operation_id) REFERENCES review_requests (id, operation_id);
CREATE TABLE invocation_approval_bindings (
  invocation_id uuid PRIMARY KEY,
  review_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  CONSTRAINT fk_invocation_approval_invocation FOREIGN KEY (invocation_id, operation_id)
    REFERENCES invocation_attempts (id, operation_id),
  CONSTRAINT fk_invocation_approval_reservation FOREIGN KEY (review_id, operation_id)
    REFERENCES approval_reservations (review_id, operation_id)
);

GRANT SELECT ON gateway_capabilities TO relay_app;
GRANT SELECT, INSERT, UPDATE ON gateway_connections, gateway_connection_capabilities,
  gateway_permission_policies, gateway_permission_versions, managed_resources, resource_claims, import_jobs,
  logical_operations, invocation_attempts, approval_reservations,
  invocation_approval_bindings TO relay_app;
REVOKE UPDATE ON gateway_permission_versions FROM relay_app;
REVOKE UPDATE ON gateway_connection_capabilities, approval_reservations,
  invocation_approval_bindings FROM relay_app;

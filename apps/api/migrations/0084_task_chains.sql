CREATE TABLE task_chains (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), project_id uuid NOT NULL REFERENCES projects(id),
 title text NOT NULL, baseline jsonb NOT NULL, status text NOT NULL DEFAULT 'DRAFT'
 CHECK (status IN ('DRAFT','ACTIVE','WAITING_RESUME','PAUSING','PAUSED','REVOKED','EXPIRED','BLOCKED','COMPLETED')),
 revision bigint NOT NULL DEFAULT 1, runtime_id uuid, max_tasks integer NOT NULL DEFAULT 0, max_model_calls integer NOT NULL DEFAULT 0,
 task_reservations integer NOT NULL DEFAULT 0, calls_started integer NOT NULL DEFAULT 0, expires_at timestamptz,
 reason text, stop_target text CHECK (stop_target IN ('PAUSED','REVOKED','EXPIRED')), control_request_id uuid REFERENCES run_control_requests(id),
 resume_command_id uuid, authorization_history jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_chain_items (
 id uuid PRIMARY KEY, chain_id uuid NOT NULL REFERENCES task_chains(id), ordinal integer NOT NULL CHECK (ordinal >= 0),
 task_id uuid NOT NULL REFERENCES tasks(id), task_revision bigint NOT NULL, acceptance_revision bigint NOT NULL,
 baseline jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED')),
 ready_command_id uuid NOT NULL UNIQUE, delegate_command_id uuid NOT NULL UNIQUE, run_id uuid UNIQUE REFERENCES runs(id),
 completion_id uuid REFERENCES completion_records(id), UNIQUE (chain_id, ordinal), UNIQUE (chain_id, task_id),
 FOREIGN KEY (task_id,acceptance_revision) REFERENCES task_acceptances(task_id,acceptance_revision)
);
CREATE INDEX task_chains_active ON task_chains(workspace_id,status);
GRANT SELECT,INSERT,UPDATE ON task_chains,task_chain_items TO relay_app;

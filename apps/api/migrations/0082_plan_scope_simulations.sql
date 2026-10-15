CREATE TABLE plan_scope_simulations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  source_plan_id uuid NOT NULL REFERENCES period_plans(id),
  source_plan_revision bigint NOT NULL CHECK (source_plan_revision >= 1),
  baseline jsonb NOT NULL CHECK (jsonb_typeof(baseline) = 'object'),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array'),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'SELECTED')),
  selected_option text CHECK (selected_option IN ('ALL', 'SHRINK', 'DEFER')),
  selected_plan_id uuid REFERENCES period_plans(id),
  selection_reason text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SELECTED') = (selected_option IS NOT NULL AND selected_plan_id IS NOT NULL AND selection_reason IS NOT NULL))
);
CREATE INDEX plan_scope_simulations_source ON plan_scope_simulations(workspace_id, source_plan_id, created_at DESC, id DESC);
GRANT SELECT, INSERT, UPDATE ON plan_scope_simulations TO relay_app;

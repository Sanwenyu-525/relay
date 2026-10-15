CREATE TABLE task_acceptance_comparisons (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  baseline_trial_id uuid NOT NULL REFERENCES task_acceptance_trials(id),
  baseline_revision bigint NOT NULL CHECK (baseline_revision >= 1),
  baseline_observation_id uuid REFERENCES task_acceptance_trial_observations(id),
  target_reduction_percent integer NOT NULL CHECK (target_reduction_percent BETWEEN 1 AND 100),
  sample_scope text NOT NULL CHECK (length(sample_scope) BETWEEN 1 AND 4000),
  frozen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX task_acceptance_comparisons_project
  ON task_acceptance_comparisons(workspace_id, project_id, frozen_at DESC, id DESC);
ALTER TABLE task_acceptance_trials ADD COLUMN comparison_id uuid REFERENCES task_acceptance_comparisons(id);
ALTER TABLE task_acceptance_trials ADD CONSTRAINT ck_acceptance_trial_comparison_mode
  CHECK (comparison_id IS NULL OR mode = 'EVIDENCE_VIEW');
CREATE INDEX task_acceptance_trials_comparison ON task_acceptance_trials(comparison_id) WHERE comparison_id IS NOT NULL;
ALTER TABLE task_acceptance_trial_observations ADD COLUMN correctness_outcome text NOT NULL DEFAULT 'UNKNOWN'
  CHECK (correctness_outcome IN ('UNKNOWN', 'NO_ISSUE_REPORTED', 'ISSUE_REPORTED'));
GRANT SELECT, INSERT ON task_acceptance_comparisons TO relay_app;

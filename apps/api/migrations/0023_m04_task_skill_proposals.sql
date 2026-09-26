-- M04/P12: Task-scoped Skill suggestions remain Assist proposals until an
-- explicit Task Owner command accepts a frozen, versioned contract change.
ALTER TABLE assist_proposals DROP CONSTRAINT assist_proposals_kind_check;
ALTER TABLE assist_proposals DROP CONSTRAINT assist_proposals_check;
ALTER TABLE assist_proposals ADD COLUMN base_acceptance_revision bigint;
ALTER TABLE assist_proposals ADD COLUMN skill_sha256 text;
ALTER TABLE assist_proposals ADD COLUMN skill_output_sha256 text;
ALTER TABLE assist_proposals ADD CONSTRAINT ck_assist_proposals_kind CHECK (
  kind IN ('CANDIDATE_MARKDOWN', 'TASK_DEFINITION',
    'TASK_CONTRACT_CHANGE', 'VERIFICATION_PLAN_CHANGE')
);
ALTER TABLE assist_proposals ADD CONSTRAINT ck_assist_proposals_target CHECK (
  (kind = 'CANDIDATE_MARKDOWN' AND target_type = 'TASK'
    AND task_id IS NOT NULL AND target_id = task_id)
  OR (kind = 'TASK_DEFINITION' AND target_type = 'PROJECT'
    AND project_id IS NOT NULL AND task_id IS NULL AND target_id = project_id)
  OR (kind IN ('TASK_CONTRACT_CHANGE', 'VERIFICATION_PLAN_CHANGE')
    AND target_type = 'TASK' AND task_id IS NOT NULL AND target_id = task_id
    AND base_acceptance_revision >= 1
    AND skill_sha256 ~ '^[0-9a-f]{64}$'
    AND skill_output_sha256 ~ '^[0-9a-f]{64}$')
);

-- Existing proposals keep nullable columns. A pending proposal's effect and
-- source identity cannot be rewritten before human acceptance.
CREATE FUNCTION guard_assist_proposal_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR
     OLD.session_id IS DISTINCT FROM NEW.session_id OR
     OLD.message_id IS DISTINCT FROM NEW.message_id OR
     OLD.kind IS DISTINCT FROM NEW.kind OR
     OLD.project_id IS DISTINCT FROM NEW.project_id OR
     OLD.task_id IS DISTINCT FROM NEW.task_id OR
     OLD.target_type IS DISTINCT FROM NEW.target_type OR
     OLD.target_id IS DISTINCT FROM NEW.target_id OR
     OLD.base_revision IS DISTINCT FROM NEW.base_revision OR
     OLD.base_acceptance_revision IS DISTINCT FROM NEW.base_acceptance_revision OR
     OLD.payload IS DISTINCT FROM NEW.payload OR
     OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR
     OLD.skill_sha256 IS DISTINCT FROM NEW.skill_sha256 OR
     OLD.skill_output_sha256 IS DISTINCT FROM NEW.skill_output_sha256 THEN
    RAISE EXCEPTION 'Assist proposal effect and source are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_assist_proposal_frozen BEFORE UPDATE ON assist_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_assist_proposal_frozen();

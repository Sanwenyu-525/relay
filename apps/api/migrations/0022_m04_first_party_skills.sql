-- M04/P12: an Assist request may freeze a bundled first-party Skill and its exact
-- dependency snapshot. Old messages remain NULL and keep their original behavior.
ALTER TABLE assist_messages ADD COLUMN skill_snapshot jsonb;
ALTER TABLE assist_messages ADD COLUMN skill_input jsonb;
ALTER TABLE assist_messages ADD COLUMN skill_output jsonb;
ALTER TABLE assist_messages ADD CONSTRAINT ck_assist_skill_snapshot CHECK (
  (skill_snapshot IS NULL AND skill_input IS NULL AND skill_output IS NULL) OR
  (role = 'ASSISTANT' AND skill_snapshot IS NOT NULL AND skill_input IS NOT NULL
    AND jsonb_typeof(skill_snapshot) = 'object' AND jsonb_typeof(skill_input) = 'object'
    AND (skill_output IS NULL OR
      (status = 'COMPLETED' AND jsonb_typeof(skill_output) = 'object')))
);

CREATE FUNCTION guard_assist_skill_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.skill_snapshot IS DISTINCT FROM NEW.skill_snapshot OR
     OLD.skill_input IS DISTINCT FROM NEW.skill_input THEN
    RAISE EXCEPTION 'frozen Assist Skill input cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.skill_output IS NOT NULL AND OLD.skill_output IS DISTINCT FROM NEW.skill_output THEN
    RAISE EXCEPTION 'settled Assist Skill output cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.skill_output IS NULL AND NEW.skill_output IS NOT NULL AND
     (OLD.status <> 'RUNNING' OR NEW.status <> 'COMPLETED') THEN
    RAISE EXCEPTION 'Assist Skill output must settle from RUNNING to COMPLETED'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_assist_skill_snapshot BEFORE UPDATE ON assist_messages
  FOR EACH ROW EXECUTE FUNCTION guard_assist_skill_snapshot();

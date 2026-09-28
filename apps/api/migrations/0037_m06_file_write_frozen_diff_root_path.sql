-- M06: new Windows WRITE_FILE evidence uses the managed-root-relative path.
-- Older basename-only rows remain unchanged and readable.
ALTER TABLE file_write_frozen_diffs
  DROP CONSTRAINT ck_frozen_diff_action;

ALTER TABLE file_write_frozen_diffs
  ADD CONSTRAINT ck_frozen_diff_action CHECK
    (capability_key = 'FILE_WRITE' AND action_type IN ('WRITE_FILE', 'APPLY_CHANGESET')
     AND file_action IN ('MODIFY', 'DELETE')
     AND (action_type <> 'WRITE_FILE' OR file_action = 'MODIFY'));

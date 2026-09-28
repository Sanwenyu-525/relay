-- Current lock selectors are owned by Artifact. Version content remains immutable.
CREATE TABLE artifact_text_locks (
  id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  base_version_id uuid NOT NULL REFERENCES artifact_versions(id),
  block_kind text NOT NULL CHECK (block_kind IN ('PARAGRAPH', 'SECTION')),
  block_index integer CHECK (block_index IS NULL OR block_index >= 0),
  locked_text text NOT NULL CHECK (locked_text <> ''),
  status text NOT NULL CHECK (status IN ('MAPPED', 'UNMAPPED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_artifact_text_lock_mapping CHECK (
    (status = 'MAPPED' AND block_index IS NOT NULL) OR
    (status = 'UNMAPPED' AND block_index IS NULL)
  )
);
CREATE INDEX ix_artifact_text_locks_artifact ON artifact_text_locks(artifact_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON artifact_text_locks TO relay_app;

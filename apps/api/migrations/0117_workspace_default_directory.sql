CREATE TABLE workspace_default_directories (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id),
  resource_id uuid REFERENCES managed_resources (id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON workspace_default_directories TO relay_app;

ALTER TABLE assist_sessions ADD COLUMN working_directory_source text;
ALTER TABLE assist_sessions ADD CONSTRAINT ck_assist_directory_source CHECK (
  working_directory_source IS NULL OR
  (working_resource_id IS NOT NULL AND working_directory_source IN ('USER_PICKED', 'WORKSPACE_DEFAULT'))
);

-- M05/P14: one versioned, built-in presentation selection per Project.
-- It has no authority over Task/Run execution, rules or permissions.
CREATE TABLE project_view_configurations (
  project_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  kind text NOT NULL CHECK (kind IN ('general', 'thesis', 'development')),
  template_version text NOT NULL DEFAULT '1' CHECK (template_version = '1'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_project_view_scope FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id)
);

INSERT INTO project_view_configurations (project_id, workspace_id, kind)
SELECT id, workspace_id, CASE project_type
  WHEN 'THESIS' THEN 'thesis'
  WHEN 'DEVELOPMENT' THEN 'development'
  ELSE 'general' END
FROM projects;

GRANT SELECT, INSERT, UPDATE ON project_view_configurations TO relay_app;

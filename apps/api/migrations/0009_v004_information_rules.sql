-- P10 typed long-term facts and a Rule revision fence for delegated Runs.
-- Existing migrations are append-only and remain SHA-stable.

ALTER TABLE workspace_execution_authority
  ADD COLUMN rule_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT ck_authority_rule_revision CHECK (rule_revision >= 0);

ALTER TABLE artifacts ADD CONSTRAINT uq_artifacts_workspace_identity UNIQUE (workspace_id, id);
ALTER TABLE artifacts ADD CONSTRAINT uq_artifacts_project_identity UNIQUE (workspace_id, project_id, id);
ALTER TABLE artifact_versions ADD CONSTRAINT uq_artifact_version_artifact_identity UNIQUE (id, artifact_id);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  scope_key text GENERATED ALWAYS AS (coalesce(project_id::text, 'WORKSPACE')) STORED,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  current_version bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT uq_knowledge_scope_identity UNIQUE (workspace_id, id, scope_key),
  CONSTRAINT fk_knowledge_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_knowledge_status CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT ck_knowledge_values CHECK (title <> '' AND current_version >= 1 AND revision >= 0)
);
CREATE TABLE knowledge_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  knowledge_id uuid NOT NULL,
  project_id uuid,
  scope_key text GENERATED ALWAYS AS (coalesce(project_id::text, 'WORKSPACE')) STORED,
  version bigint NOT NULL,
  source_kind text NOT NULL,
  media_type text NOT NULL,
  content_text text,
  content_sha256 bytea NOT NULL,
  source_uri text,
  source_artifact_id uuid,
  artifact_version_id uuid,
  availability text NOT NULL DEFAULT 'AVAILABLE',
  source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_version UNIQUE (knowledge_id, version),
  CONSTRAINT uq_knowledge_artifact_source UNIQUE (workspace_id, artifact_version_id),
  CONSTRAINT fk_knowledge_version_root FOREIGN KEY (workspace_id, knowledge_id)
    REFERENCES knowledge_items (workspace_id, id),
  CONSTRAINT fk_knowledge_version_scope FOREIGN KEY (workspace_id, knowledge_id, scope_key)
    REFERENCES knowledge_items (workspace_id, id, scope_key),
  CONSTRAINT fk_knowledge_version_artifact FOREIGN KEY (artifact_version_id, source_artifact_id)
    REFERENCES artifact_versions (id, artifact_id),
  CONSTRAINT fk_knowledge_version_artifact_workspace FOREIGN KEY (workspace_id, source_artifact_id)
    REFERENCES artifacts (workspace_id, id),
  CONSTRAINT fk_knowledge_version_artifact_project
    FOREIGN KEY (workspace_id, project_id, source_artifact_id)
    REFERENCES artifacts (workspace_id, project_id, id),
  CONSTRAINT ck_knowledge_version_kind CHECK (source_kind IN ('NOTE', 'MANAGED_TEXT', 'ARTIFACT_VERSION')),
  CONSTRAINT ck_knowledge_version_values CHECK (version >= 1 AND octet_length(content_sha256) = 32
    AND jsonb_typeof(source_refs) = 'object'),
  CONSTRAINT ck_knowledge_version_source CHECK (
    (source_kind IN ('NOTE', 'MANAGED_TEXT') AND content_text IS NOT NULL
      AND source_artifact_id IS NULL AND artifact_version_id IS NULL
      AND media_type IN ('text/plain', 'text/markdown')
      AND octet_length(content_text) <= 262144)
    OR (source_kind = 'ARTIFACT_VERSION' AND content_text IS NULL
      AND project_id IS NOT NULL AND source_artifact_id IS NOT NULL AND artifact_version_id IS NOT NULL
      AND media_type = 'text/markdown')
  ),
  CONSTRAINT ck_knowledge_version_availability CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE'))
);
ALTER TABLE knowledge_items ADD CONSTRAINT fk_knowledge_current_version
  FOREIGN KEY (id, current_version) REFERENCES knowledge_versions (knowledge_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_knowledge_scope ON knowledge_items (workspace_id, project_id, status, id);

CREATE TABLE memory_items (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  current_version bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_memory_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_memory_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT ck_memory_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT ck_memory_values CHECK (title <> '' AND current_version >= 1 AND revision >= 0)
);
CREATE TABLE memory_versions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memory_items (id),
  version bigint NOT NULL,
  title text NOT NULL,
  body_text text NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_memory_version UNIQUE (memory_id, version),
  CONSTRAINT ck_memory_version_values CHECK (version >= 1 AND title <> '' AND body_text <> ''
    AND confirmed_by = 'user:local' AND octet_length(body_text) <= 262144)
);
ALTER TABLE memory_items ADD CONSTRAINT fk_memory_current_version
  FOREIGN KEY (id, current_version) REFERENCES memory_versions (memory_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_memory_scope ON memory_items (workspace_id, project_id, status, id);

CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  project_id uuid,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  current_version bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  superseded_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_decision_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_decision_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_decision_successor FOREIGN KEY (workspace_id, superseded_by_id)
    REFERENCES decisions (workspace_id, id),
  CONSTRAINT ck_decision_status CHECK ((status = 'ACTIVE' AND superseded_by_id IS NULL)
    OR (status = 'SUPERSEDED' AND superseded_by_id IS NOT NULL)),
  CONSTRAINT ck_decision_values CHECK (title <> '' AND current_version >= 1 AND revision >= 0
    AND superseded_by_id IS DISTINCT FROM id)
);
CREATE TABLE decision_versions (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL REFERENCES decisions (id),
  version bigint NOT NULL,
  choice text NOT NULL,
  rationale text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  costs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_decision_version UNIQUE (decision_id, version),
  CONSTRAINT ck_decision_version_values CHECK (version >= 1 AND choice <> '' AND rationale <> ''
    AND jsonb_typeof(alternatives) = 'array' AND jsonb_typeof(costs) = 'array')
);
ALTER TABLE decisions ADD CONSTRAINT fk_decision_current_version
  FOREIGN KEY (id, current_version) REFERENCES decision_versions (decision_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_decision_scope ON decisions (workspace_id, project_id, status, id);

CREATE TABLE rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  scope text NOT NULL,
  project_id uuid,
  task_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE',
  current_version bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_rule_workspace_id UNIQUE (workspace_id, id),
  CONSTRAINT fk_rule_project FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id),
  CONSTRAINT fk_rule_task FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT fk_rule_task_project FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (id, project_id),
  CONSTRAINT ck_rule_scope CHECK ((scope = 'WORKSPACE' AND project_id IS NULL AND task_id IS NULL)
    OR (scope = 'PROJECT' AND project_id IS NOT NULL AND task_id IS NULL)
    OR (scope = 'TASK' AND project_id IS NOT NULL AND task_id IS NOT NULL)),
  CONSTRAINT ck_rule_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT ck_rule_values CHECK (current_version >= 1 AND revision >= 0)
);
CREATE TABLE rule_versions (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES rules (id),
  version bigint NOT NULL,
  rule_key text NOT NULL,
  statement text NOT NULL,
  strength text NOT NULL,
  applicability text NOT NULL,
  enforcement text NOT NULL,
  method text,
  target_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_rule_version UNIQUE (rule_id, version),
  CONSTRAINT ck_rule_version_values CHECK (version >= 1 AND rule_key <> '' AND statement <> ''
    AND jsonb_typeof(target_spec) = 'object'),
  CONSTRAINT ck_rule_strength CHECK (strength IN ('HARD', 'PREFERENCE')),
  CONSTRAINT ck_rule_applicability CHECK (applicability = 'AI_RUN'),
  CONSTRAINT ck_rule_enforcement CHECK (enforcement IN ('PRE_ACTION', 'POST_CHECK', 'SEMANTIC', 'HUMAN')),
  CONSTRAINT ck_rule_method CHECK (method IS NULL OR method IN
    ('HUMAN', 'MARKDOWN_STRUCTURE', 'CITATION_EXISTS', 'SEMANTIC'))
);
ALTER TABLE rules ADD CONSTRAINT fk_rule_current_version
  FOREIGN KEY (id, current_version) REFERENCES rule_versions (rule_id, version)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_rule_scope ON rules (workspace_id, project_id, task_id, status, id);

GRANT SELECT, INSERT, UPDATE ON knowledge_items, memory_items, decisions, rules TO relay_app;
GRANT SELECT, INSERT ON knowledge_versions, memory_versions, decision_versions, rule_versions TO relay_app;
GRANT SELECT, UPDATE (rule_revision) ON workspace_execution_authority TO relay_app;

CREATE TABLE workspace_memory_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  recall_enabled boolean NOT NULL DEFAULT true,
  automatic_compaction boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_message_sources (
  memory_id uuid NOT NULL,
  memory_version bigint NOT NULL,
  session_id uuid NOT NULL REFERENCES assist_sessions(id),
  message_id uuid NOT NULL REFERENCES assist_messages(id),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, memory_version),
  FOREIGN KEY (memory_id, memory_version) REFERENCES memory_versions(memory_id, version)
);
CREATE INDEX ix_memory_message_sources_session ON memory_message_sources(session_id);
GRANT SELECT, INSERT, UPDATE ON workspace_memory_settings TO relay_app;
GRANT SELECT, INSERT ON memory_message_sources TO relay_app;

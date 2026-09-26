-- M04: URL import jobs (USER_IMPORT) execute WEB_FETCH through the Gateway and
-- land the fetched page in Knowledge with provenance. Existing migrations remain
-- SHA-stable; this migration only widens the guarded shapes and binds the job
-- to its connection boundary.

-- A WEB_FETCH user import targets a URL, not a managed resource.
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'FILE_READ' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL));

-- Imported web pages are immutable Knowledge versions with a recorded source URL.
ALTER TABLE knowledge_versions DROP CONSTRAINT ck_knowledge_version_kind;
ALTER TABLE knowledge_versions ADD CONSTRAINT ck_knowledge_version_kind CHECK (
  source_kind IN ('NOTE', 'MANAGED_TEXT', 'ARTIFACT_VERSION', 'WEB_PAGE'));
ALTER TABLE knowledge_versions DROP CONSTRAINT ck_knowledge_version_source;
ALTER TABLE knowledge_versions ADD CONSTRAINT ck_knowledge_version_source CHECK (
  (source_kind IN ('NOTE', 'MANAGED_TEXT') AND content_text IS NOT NULL
    AND source_artifact_id IS NULL AND artifact_version_id IS NULL
    AND media_type IN ('text/plain', 'text/markdown')
    AND octet_length(content_text) <= 262144)
  OR (source_kind = 'ARTIFACT_VERSION' AND content_text IS NULL
    AND project_id IS NOT NULL AND source_artifact_id IS NOT NULL AND artifact_version_id IS NOT NULL
    AND media_type = 'text/markdown')
  OR (source_kind = 'WEB_PAGE' AND content_text IS NOT NULL
    AND source_uri IS NOT NULL AND source_artifact_id IS NULL AND artifact_version_id IS NULL
    AND media_type IN ('text/plain', 'text/markdown')
    AND octet_length(content_text) <= 262144));

-- The import job freezes its boundary: the WEB_FETCH connection chosen at
-- creation. Fake imports keep connection_id NULL; the fetched version is
-- linked back through knowledge_version_id.
ALTER TABLE import_jobs ADD COLUMN connection_id uuid;
ALTER TABLE import_jobs ADD CONSTRAINT fk_import_job_connection
  FOREIGN KEY (workspace_id, connection_id) REFERENCES gateway_connections (workspace_id, id);
ALTER TABLE import_jobs ADD CONSTRAINT fk_import_job_knowledge
  FOREIGN KEY (knowledge_version_id) REFERENCES knowledge_versions (id);

-- USER_IMPORT reviews keep a nullable job link so the inbox can locate the
-- waiting import without joining through the operation row.
ALTER TABLE review_requests ADD COLUMN import_job_id uuid;
ALTER TABLE review_requests ADD CONSTRAINT fk_review_import_job
  FOREIGN KEY (import_job_id) REFERENCES import_jobs (id);
CREATE INDEX ix_review_import_job ON review_requests (import_job_id, created_at, id)
  WHERE import_job_id IS NOT NULL;

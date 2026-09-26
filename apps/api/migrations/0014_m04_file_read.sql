-- M04: FILE_READ joins the Gateway as the first REAL adapter (read-only, idempotent).
-- Existing migrations remain SHA-stable; this migration only widens the guarded shapes.
-- A FILE_READ Connection binds exactly one canonical allowed root in its config.

ALTER TABLE gateway_capabilities DROP CONSTRAINT ck_gateway_capability_kind;
ALTER TABLE gateway_capabilities ADD CONSTRAINT ck_gateway_capability_kind CHECK (
  (adapter_kind = 'FAKE' AND effect_kind IN ('READ', 'WRITE'))
  OR (adapter_kind = 'REAL' AND effect_kind = 'READ'));
INSERT INTO gateway_capabilities VALUES ('FILE_READ', 'REAL', 'READ');

ALTER TABLE gateway_connections DROP CONSTRAINT ck_gateway_connection_adapter;
ALTER TABLE gateway_connections ADD CONSTRAINT ck_gateway_connection_adapter CHECK (
  adapter_kind = 'FAKE'
  OR (adapter_kind = 'REAL' AND config ? 'root_path'));
ALTER TABLE gateway_connections DROP CONSTRAINT ck_gateway_connection_config;
ALTER TABLE gateway_connections ADD CONSTRAINT ck_gateway_connection_config CHECK (
  config = '{}'::jsonb
  OR (jsonb_typeof(config->'root_path') = 'string' AND config->>'root_path' <> ''
      AND config = jsonb_build_object('root_path', config->'root_path')));

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_params;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_params CHECK (
  jsonb_typeof(params) = 'object' AND (connection_config = '{}'::jsonb
    OR (jsonb_typeof(connection_config->'root_path') = 'string'
        AND connection_config->>'root_path' <> ''
        AND connection_config = jsonb_build_object('root_path', connection_config->'root_path'))));
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'FILE_READ' AND origin = 'RUN' AND resource_id IS NOT NULL));

ALTER TABLE invocation_attempts DROP CONSTRAINT ck_invocation_config;
ALTER TABLE invocation_attempts ADD CONSTRAINT ck_invocation_config CHECK (
  connection_config = '{}'::jsonb
  OR (jsonb_typeof(connection_config->'root_path') = 'string'
      AND connection_config->>'root_path' <> ''
      AND connection_config = jsonb_build_object('root_path', connection_config->'root_path')));

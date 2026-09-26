-- M04: WEB_FETCH joins the Gateway as the second REAL adapter (public web GET only).
-- Existing migrations remain SHA-stable; this migration only widens the guarded shapes.
-- A WEB_FETCH Connection binds exactly one allowed host; a web action targets a URL,
-- not a filesystem resource, so its logical operations carry resource_id IS NULL.

INSERT INTO gateway_capabilities VALUES ('WEB_FETCH', 'REAL', 'READ');

ALTER TABLE gateway_connections DROP CONSTRAINT ck_gateway_connection_adapter;
ALTER TABLE gateway_connections ADD CONSTRAINT ck_gateway_connection_adapter CHECK (
  adapter_kind = 'FAKE'
  OR (adapter_kind = 'REAL' AND config ? 'root_path')
  OR (adapter_kind = 'REAL' AND config ? 'allowed_host'));
ALTER TABLE gateway_connections DROP CONSTRAINT ck_gateway_connection_config;
ALTER TABLE gateway_connections ADD CONSTRAINT ck_gateway_connection_config CHECK (
  config = '{}'::jsonb
  OR (jsonb_typeof(config->'root_path') = 'string' AND config->>'root_path' <> ''
      AND config = jsonb_build_object('root_path', config->'root_path'))
  OR (jsonb_typeof(config->'allowed_host') = 'string' AND config->>'allowed_host' <> ''
      AND config = jsonb_build_object('allowed_host', config->'allowed_host'))
  OR (jsonb_typeof(config->'allowed_host') = 'string' AND config->>'allowed_host' <> ''
      AND config->'allow_private' = 'true'::jsonb
      AND config = jsonb_build_object('allowed_host', config->'allowed_host',
          'allow_private', config->'allow_private')));

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_params;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_params CHECK (
  jsonb_typeof(params) = 'object' AND (connection_config = '{}'::jsonb
    OR (jsonb_typeof(connection_config->'root_path') = 'string'
        AND connection_config->>'root_path' <> ''
        AND connection_config = jsonb_build_object('root_path', connection_config->'root_path'))
    OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
        AND connection_config->>'allowed_host' <> ''
        AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host'))
    OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
        AND connection_config->>'allowed_host' <> ''
        AND connection_config->'allow_private' = 'true'::jsonb
        AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host',
            'allow_private', connection_config->'allow_private'))));
ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'FILE_READ' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL));

ALTER TABLE invocation_attempts DROP CONSTRAINT ck_invocation_config;
ALTER TABLE invocation_attempts ADD CONSTRAINT ck_invocation_config CHECK (
  connection_config = '{}'::jsonb
  OR (jsonb_typeof(connection_config->'root_path') = 'string'
      AND connection_config->>'root_path' <> ''
      AND connection_config = jsonb_build_object('root_path', connection_config->'root_path'))
  OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
      AND connection_config->>'allowed_host' <> ''
      AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host'))
  OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
      AND connection_config->>'allowed_host' <> ''
      AND connection_config->'allow_private' = 'true'::jsonb
      AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host',
          'allow_private', connection_config->'allow_private')));

-- WEB_FETCH runs bind no managed resource and take no claim: relax the RUN
-- identity shape for web-read invocations (all resource columns stay NULL).
ALTER TABLE invocation_attempts DROP CONSTRAINT ck_invocation_run_identity;
ALTER TABLE invocation_attempts ADD CONSTRAINT ck_invocation_run_identity CHECK (
  (origin = 'USER_IMPORT' AND task_id IS NULL AND run_id IS NULL AND resource_id IS NULL
    AND ownership_epoch IS NULL AND worker_id IS NULL AND worker_epoch IS NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
  OR (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND resource_id IS NOT NULL
    AND ownership_epoch IS NOT NULL AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL
    AND resource_claim_id IS NOT NULL AND claim_token IS NOT NULL AND claim_epoch IS NOT NULL)
  OR (origin = 'RUN' AND task_id IS NOT NULL AND run_id IS NOT NULL AND resource_id IS NULL
    AND ownership_epoch IS NOT NULL AND worker_id IS NOT NULL AND worker_epoch IS NOT NULL
    AND resource_claim_id IS NULL AND claim_token IS NULL AND claim_epoch IS NULL)
);

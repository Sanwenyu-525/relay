-- M04: CLI_RUN connections may carry an explicit allowlist of executables outside the
-- managed root (docs/superpowers/plans/2026-10-05-cli-executable-admission.md).
--
-- Existing migrations remain SHA-stable; this migration only widens the guarded shapes.
-- The interpretation model may *propose* a check entry, but an entry outside the managed
-- root is only runnable when the user has named it on the connection. Without a column
-- shape to record that consent there is nowhere to put it, so the three guards that pin
-- `connection_config` are re-stated together — widening only some of them produces the
-- same runtime violation on a different table (the 0054 lesson).
--
-- Shape only, matching the existing convention: which keys may appear, their types, and
-- that no unexpected key sneaks in. Capability/entry pairing (CLI_RUN only, root_path
-- present) is enforced in the application layer by resolveAllowedExecutables, exactly as
-- ck_gateway_connection_adapter and resolveConnectionConfig already do.
--
-- PostgreSQL forbids subqueries in CHECK constraints, so the element-level validation uses
-- jsonb_path_query_array (IMMUTABLE) instead of NOT EXISTS over jsonb_array_elements.
-- Verified against a live cluster before adoption: the six pre-existing shapes are still
-- accepted and nine malformed shapes are still rejected.

ALTER TABLE gateway_connections DROP CONSTRAINT ck_gateway_connection_config;
ALTER TABLE gateway_connections ADD CONSTRAINT ck_gateway_connection_config CHECK (
  config = '{}'::jsonb
  OR (jsonb_typeof(config->'root_path') = 'string' AND config->>'root_path' <> ''
      AND jsonb_typeof(config->'allowed_executables') IS NULL
      AND config = jsonb_build_object('root_path', config->'root_path'))
  OR (jsonb_typeof(config->'allowed_host') = 'string' AND config->>'allowed_host' <> ''
      AND jsonb_typeof(config->'allow_private') IS NULL
      AND config = jsonb_build_object('allowed_host', config->'allowed_host'))
  OR (jsonb_typeof(config->'allowed_host') = 'string' AND config->>'allowed_host' <> ''
      AND config->'allow_private' = 'true'::jsonb
      AND config = jsonb_build_object('allowed_host', config->'allowed_host',
          'allow_private', config->'allow_private'))
  OR (jsonb_typeof(config->'allowed_executables') = 'array'
      AND jsonb_array_length(config->'allowed_executables') BETWEEN 1 AND 32
      AND jsonb_path_query_array(config->'allowed_executables',
          '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
      AND jsonb_typeof(config->'root_path') IS NULL
      AND config = jsonb_build_object('allowed_executables', config->'allowed_executables'))
  OR (jsonb_typeof(config->'root_path') = 'string' AND config->>'root_path' <> ''
      AND jsonb_typeof(config->'allowed_executables') = 'array'
      AND jsonb_array_length(config->'allowed_executables') BETWEEN 1 AND 32
      AND jsonb_path_query_array(config->'allowed_executables',
          '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
      AND config = jsonb_build_object('root_path', config->'root_path',
          'allowed_executables', config->'allowed_executables')));

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_params;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_params CHECK (
  jsonb_typeof(params) = 'object' AND (connection_config = '{}'::jsonb
    OR (jsonb_typeof(connection_config->'root_path') = 'string'
        AND connection_config->>'root_path' <> ''
        AND jsonb_typeof(connection_config->'allowed_executables') IS NULL
        AND connection_config = jsonb_build_object('root_path', connection_config->'root_path'))
    OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
        AND connection_config->>'allowed_host' <> ''
        AND jsonb_typeof(connection_config->'allow_private') IS NULL
        AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host'))
    OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
        AND connection_config->>'allowed_host' <> ''
        AND connection_config->'allow_private' = 'true'::jsonb
        AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host',
            'allow_private', connection_config->'allow_private'))
    OR (jsonb_typeof(connection_config->'allowed_executables') = 'array'
        AND jsonb_array_length(connection_config->'allowed_executables') BETWEEN 1 AND 32
        AND jsonb_path_query_array(connection_config->'allowed_executables',
            '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
        AND jsonb_typeof(connection_config->'root_path') IS NULL
        AND connection_config = jsonb_build_object('allowed_executables', connection_config->'allowed_executables'))
    OR (jsonb_typeof(connection_config->'root_path') = 'string'
        AND connection_config->>'root_path' <> ''
        AND jsonb_typeof(connection_config->'allowed_executables') = 'array'
        AND jsonb_array_length(connection_config->'allowed_executables') BETWEEN 1 AND 32
        AND jsonb_path_query_array(connection_config->'allowed_executables',
            '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
        AND connection_config = jsonb_build_object('root_path', connection_config->'root_path',
            'allowed_executables', connection_config->'allowed_executables'))));

ALTER TABLE invocation_attempts DROP CONSTRAINT ck_invocation_config;
ALTER TABLE invocation_attempts ADD CONSTRAINT ck_invocation_config CHECK (
  connection_config = '{}'::jsonb
  OR (jsonb_typeof(connection_config->'root_path') = 'string'
      AND connection_config->>'root_path' <> ''
      AND jsonb_typeof(connection_config->'allowed_executables') IS NULL
      AND connection_config = jsonb_build_object('root_path', connection_config->'root_path'))
  OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
      AND connection_config->>'allowed_host' <> ''
      AND jsonb_typeof(connection_config->'allow_private') IS NULL
      AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host'))
  OR (jsonb_typeof(connection_config->'allowed_host') = 'string'
      AND connection_config->>'allowed_host' <> ''
      AND connection_config->'allow_private' = 'true'::jsonb
      AND connection_config = jsonb_build_object('allowed_host', connection_config->'allowed_host',
          'allow_private', connection_config->'allow_private'))
  OR (jsonb_typeof(connection_config->'allowed_executables') = 'array'
      AND jsonb_array_length(connection_config->'allowed_executables') BETWEEN 1 AND 32
      AND jsonb_path_query_array(connection_config->'allowed_executables',
          '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
      AND jsonb_typeof(connection_config->'root_path') IS NULL
      AND connection_config = jsonb_build_object('allowed_executables', connection_config->'allowed_executables'))
  OR (jsonb_typeof(connection_config->'root_path') = 'string'
      AND connection_config->>'root_path' <> ''
      AND jsonb_typeof(connection_config->'allowed_executables') = 'array'
      AND jsonb_array_length(connection_config->'allowed_executables') BETWEEN 1 AND 32
      AND jsonb_path_query_array(connection_config->'allowed_executables',
          '$[*] ? (@.type() != "string" || @ == "")') = '[]'::jsonb
      AND connection_config = jsonb_build_object('root_path', connection_config->'root_path',
          'allowed_executables', connection_config->'allowed_executables')));

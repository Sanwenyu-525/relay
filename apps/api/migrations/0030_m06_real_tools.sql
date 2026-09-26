-- M06: Real Files, Git, and CLI adapters join the Gateway.
-- Widens capability kinds to REAL WRITE and registers FILE_WRITE, GIT_READ, GIT_WRITE, CLI_RUN.
-- These capabilities bind to a canonical allowed root path on the local filesystem.

ALTER TABLE gateway_capabilities DROP CONSTRAINT ck_gateway_capability_kind;
ALTER TABLE gateway_capabilities ADD CONSTRAINT ck_gateway_capability_kind CHECK (
  (adapter_kind = 'FAKE' AND effect_kind IN ('READ', 'WRITE'))
  OR (adapter_kind = 'REAL' AND effect_kind IN ('READ', 'WRITE'))
);

INSERT INTO gateway_capabilities VALUES ('FILE_WRITE', 'REAL', 'WRITE');
INSERT INTO gateway_capabilities VALUES ('GIT_READ', 'REAL', 'READ');
INSERT INTO gateway_capabilities VALUES ('GIT_WRITE', 'REAL', 'WRITE');
INSERT INTO gateway_capabilities VALUES ('CLI_RUN', 'REAL', 'WRITE');

ALTER TABLE logical_operations DROP CONSTRAINT ck_logical_operation_resource;
ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_resource CHECK (
  (capability_key = 'FAKE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'FAKE_PUBLIC_READ' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'FILE_READ' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'RUN' AND resource_id IS NULL)
  OR (capability_key = 'WEB_FETCH' AND origin = 'USER_IMPORT' AND resource_id IS NULL)
  OR (capability_key = 'FILE_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'GIT_READ' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'GIT_WRITE' AND origin = 'RUN' AND resource_id IS NOT NULL)
  OR (capability_key = 'CLI_RUN' AND origin = 'RUN' AND resource_id IS NOT NULL)
);

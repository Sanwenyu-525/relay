CREATE TABLE local_directory_access (
  resource_id uuid PRIMARY KEY REFERENCES managed_resources (id),
  write_tier text NOT NULL,
  read_connection_id uuid NOT NULL REFERENCES gateway_connections (id),
  write_connection_id uuid REFERENCES gateway_connections (id),
  policy_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_local_directory_access_tier CHECK (write_tier IN ('READ_ONLY', 'ASK', 'AUTO')),
  CONSTRAINT ck_local_directory_access_policy_ids CHECK (jsonb_typeof(policy_ids) = 'object'),
  CONSTRAINT ck_local_directory_access_revision CHECK (revision >= 0)
);

GRANT SELECT, INSERT, UPDATE ON local_directory_access TO relay_app;

-- One gate covers this entire business database, including every Workspace.
-- DRAINING stops new admission; it does not freeze in-flight work or Saver writes.
CREATE TABLE runtime_admission_gate (
  singleton boolean PRIMARY KEY DEFAULT true,
  mode text NOT NULL DEFAULT 'NORMAL',
  revision bigint NOT NULL DEFAULT 0,
  CONSTRAINT ck_runtime_admission_singleton CHECK (singleton),
  CONSTRAINT ck_runtime_admission_mode CHECK (mode IN ('NORMAL', 'DRAINING')),
  CONSTRAINT ck_runtime_admission_revision CHECK (revision >= 0)
);

INSERT INTO runtime_admission_gate (singleton) VALUES (true);
GRANT SELECT, UPDATE (mode, revision) ON runtime_admission_gate TO relay_app;

-- A user supplement is stored once, as a USER message in the delegated session.
-- Parent visibility and model delivery reference that same source; neither starts a new Run.
CREATE TABLE assist_delegation_supplements (
  id uuid PRIMARY KEY,
  delegation_id uuid NOT NULL REFERENCES assist_delegations(id),
  source_message_id uuid NOT NULL UNIQUE REFERENCES assist_messages(id),
  parent_seen_at timestamptz,
  parent_seen_message_id uuid REFERENCES assist_messages(id),
  child_seen_at timestamptz,
  child_seen_message_id uuid REFERENCES assist_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((parent_seen_at IS NULL) = (parent_seen_message_id IS NULL)),
  CHECK ((child_seen_at IS NULL) = (child_seen_message_id IS NULL))
);
CREATE INDEX ix_delegation_supplements_source
  ON assist_delegation_supplements (delegation_id, created_at, id);
GRANT SELECT, INSERT, UPDATE ON assist_delegation_supplements TO relay_app;

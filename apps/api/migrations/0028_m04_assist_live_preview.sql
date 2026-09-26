-- M04 Assist DISCUSS live preview. This is disposable display data, never a
-- Message result or Proposal. One bounded prefix per assistant message keeps
-- Worker and API process state independent without storing raw model chunks.
CREATE TABLE assist_message_previews (
  message_id uuid PRIMARY KEY REFERENCES assist_messages(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  preview_text text NOT NULL CHECK (octet_length(preview_text) <= 16384),
  truncated boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON assist_message_previews TO relay_app;

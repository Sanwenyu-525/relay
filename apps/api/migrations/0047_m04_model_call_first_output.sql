-- First text is observed by the current generation owner. First preview is
-- recorded in the same transaction as its first successful write. Historical
-- calls stay unknown; deleting a disposable preview never deletes these facts.
ALTER TABLE model_calls
  ADD COLUMN first_text_delta_at timestamptz,
  ADD COLUMN first_preview_persisted_at timestamptz,
  ADD CONSTRAINT ck_model_calls_first_preview_text CHECK (
    first_preview_persisted_at IS NULL OR first_text_delta_at IS NOT NULL),
  ADD CONSTRAINT ck_model_calls_first_output_kind CHECK (
    kind IN ('DRAFT', 'ASSIST') OR
      (first_text_delta_at IS NULL AND first_preview_persisted_at IS NULL));

GRANT UPDATE (first_text_delta_at, first_preview_persisted_at)
  ON model_calls TO relay_app;

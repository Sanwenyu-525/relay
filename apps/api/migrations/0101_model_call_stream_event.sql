-- A model response may begin with reasoning or partial tool arguments before
-- producing any user-visible text. Keep that first-stream fact independent of
-- first_text_delta_at so a failed partial stream can never be auto-fallbacked.
ALTER TABLE model_calls ADD COLUMN first_stream_event_at timestamptz;

GRANT UPDATE (first_stream_event_at) ON model_calls TO relay_app;

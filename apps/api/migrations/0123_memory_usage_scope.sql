ALTER TABLE assist_memory_uses ADD COLUMN session_scope jsonb
  CHECK (session_scope IS NULL OR jsonb_typeof(session_scope) = 'object');

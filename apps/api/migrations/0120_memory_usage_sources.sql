ALTER TABLE assist_memory_uses ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(sources) = 'array');
ALTER TABLE assist_memory_uses ADD COLUMN has_tool_context boolean NOT NULL DEFAULT false;

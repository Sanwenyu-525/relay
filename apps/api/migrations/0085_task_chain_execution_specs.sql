ALTER TABLE task_chain_items ADD COLUMN execution_spec jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(execution_spec)='object');

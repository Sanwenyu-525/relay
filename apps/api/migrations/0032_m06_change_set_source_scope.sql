-- M06: bind each change set to the exact FILE_WRITE operation that produced it.
-- 0031 already binds invocation_id to operation_id, but independent project/run/resource
-- foreign keys do not prove those values belong to that operation.

ALTER TABLE logical_operations ADD CONSTRAINT ck_logical_operation_file_write_action CHECK (
  (capability_key <> 'FILE_WRITE' AND action_type NOT IN ('WRITE_FILE', 'APPLY_CHANGESET'))
  OR (capability_key = 'FILE_WRITE' AND action_type IN ('WRITE_FILE', 'APPLY_CHANGESET'))
);

ALTER TABLE logical_operations ADD CONSTRAINT uq_logical_operation_change_set_source UNIQUE
  (id, workspace_id, project_id, run_id, resource_id, action_type);

ALTER TABLE change_sets ADD CONSTRAINT fk_change_set_source FOREIGN KEY
  (operation_id, workspace_id, project_id, run_id, resource_id, action_type)
  REFERENCES logical_operations
  (id, workspace_id, project_id, run_id, resource_id, action_type);

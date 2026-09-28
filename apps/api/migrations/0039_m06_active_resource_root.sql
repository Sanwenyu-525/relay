-- Keep historical disabled resource identities without blocking explicit re-registration.
ALTER TABLE managed_resources DROP CONSTRAINT uq_managed_resource_project_root;
CREATE UNIQUE INDEX uq_managed_resource_active_project_root
  ON managed_resources (project_id, identity_key) WHERE status = 'ACTIVE';

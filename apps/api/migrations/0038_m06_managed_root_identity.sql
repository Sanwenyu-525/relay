-- New Windows resource registrations bind FILE_WRITE to the directory present at registration.
-- Existing rows remain NULL: current disk state cannot prove their historical identity.
ALTER TABLE managed_resources
  ADD COLUMN file_write_root_id text,
  ADD CONSTRAINT ck_managed_resource_file_write_root_id CHECK
    (file_write_root_id IS NULL OR file_write_root_id ~ '^[0-9a-f]{16}:[0-9a-f]{32}$');

-- The physical identity is registration evidence, not mutable resource configuration.
REVOKE UPDATE ON managed_resources FROM relay_app;
GRANT UPDATE (status, revision, resource_epoch) ON managed_resources TO relay_app;

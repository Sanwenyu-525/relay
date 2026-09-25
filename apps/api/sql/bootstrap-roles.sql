-- Relay database role bootstrap. Run as an administrative role on the target cluster.
--
-- Creates two real, non-superuser roles:
--   relay_migrator : owns the schema objects and holds DDL privileges (runs migrations).
--   relay_app      : the application role; only the SELECT/INSERT/UPDATE/DELETE granted by migrations.
-- Tests and production both use these roles; a superuser never impersonates the application role.
-- Passwords and authentication methods are decided by the operator in pg_hba.conf; this file
-- neither sets nor records credentials.
--
-- Usage (administrator):
--   psql -w -v ON_ERROR_STOP=1 -f sql/bootstrap-roles.sql
--   psql -w -v ON_ERROR_STOP=1 -c "create database relay_dev owner relay_migrator"
--
-- The application database must be owned by relay_migrator so that the migration role can create
-- objects in the public schema (PostgreSQL 15+ grants that schema to pg_database_owner).

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_migrator') THEN
    CREATE ROLE relay_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_app') THEN
    CREATE ROLE relay_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$bootstrap$;
-- 0003：运行时 schema readiness 兼容门。
--
-- 本迁移不引入 V003 的 Authority/Worker 表或业务语义；它只让 relay_app
-- 经受限视图读取迁移名称与 SHA-256 摘要，以便 /health/ready 能在不读取
-- relay_schema_migrations 台账的前提下判断当前发布物是否兼容。

CREATE VIEW relay_schema_migration_compatibility AS
SELECT name, encode(content_sha256, 'hex') AS content_sha256_hex
FROM relay_schema_migrations;

REVOKE ALL ON relay_schema_migration_compatibility FROM PUBLIC;
GRANT SELECT ON relay_schema_migration_compatibility TO relay_app;

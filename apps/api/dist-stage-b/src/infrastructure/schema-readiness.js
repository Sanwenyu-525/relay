import { sql } from 'kysely';
import { loadMigrationManifest, } from './migration-runner.js';
const SCHEMA_COMPATIBILITY_VIEW = 'relay_schema_migration_compatibility';
/**
 * 只读兼容门：本地发布物提供期望的迁移摘要，数据库只通过受限视图提供
 * 已应用摘要。它不会执行 migration，也不读取迁移台账表。
 */
export class SchemaReadinessChecker {
    migrationDirectory;
    manifest;
    constructor(migrationDirectory) {
        this.migrationDirectory = migrationDirectory;
    }
    async check(executor) {
        try {
            const [expected, actual] = await Promise.all([
                this.getManifest(),
                sql `
          select name, content_sha256_hex
          from relay_schema_migration_compatibility
          order by name
        `.execute(executor),
            ]);
            return { compatible: sameManifest(expected, actual.rows) };
        }
        catch {
            // 视图不存在、权限被撤回或查询失败时，数据库仍可连通但 schema 不能视为可用。
            return { compatible: false };
        }
    }
    getManifest() {
        if (this.manifest === undefined) {
            this.manifest = loadMigrationManifest(this.migrationDirectory);
        }
        return this.manifest;
    }
}
function sameManifest(expected, actual) {
    if (expected.length !== actual.length) {
        return false;
    }
    return expected.every((entry, index) => {
        const applied = actual[index];
        return (applied !== undefined &&
            applied.name === entry.name &&
            applied.content_sha256_hex === entry.contentSha256Hex);
    });
}

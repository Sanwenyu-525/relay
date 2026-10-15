import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import './pg-types.js';
export class RelayDatabase {
    pool;
    kysely;
    constructor(config, onBackgroundError) {
        this.pool = new Pool({
            connectionString: config.databaseUrl,
            max: config.databasePoolMax,
            connectionTimeoutMillis: config.databaseConnectTimeoutMs,
            application_name: 'relay-api',
        });
        this.pool.on('error', onBackgroundError);
        this.kysely = new Kysely({
            dialect: new PostgresDialect({ pool: this.pool }),
        });
    }
    /** 只读句柄；写入口必须由用例显式开启事务并把同一连接传给所有 Repository。 */
    get executor() {
        return this.kysely;
    }
    async ping() {
        try {
            await sql `select 1 as ok`.execute(this.kysely);
            return { ok: true };
        }
        catch {
            return { ok: false };
        }
    }
    async checkReadiness(schemaReadiness) {
        const database = await this.ping();
        if (!database.ok) {
            return { database: 'down', schema: 'unknown' };
        }
        const schema = await schemaReadiness.check(this.kysely);
        if (schema.compatible) {
            return { database: 'up', schema: 'up' };
        }
        // schema 查询失败后连接也可能已断开；不能用先前的 ping 把此情况误报为 schema 不兼容。
        const confirmedDatabase = await this.ping();
        return confirmedDatabase.ok
            ? { database: 'up', schema: 'down' }
            : { database: 'down', schema: 'unknown' };
    }
    async close() {
        await this.kysely.destroy();
    }
}

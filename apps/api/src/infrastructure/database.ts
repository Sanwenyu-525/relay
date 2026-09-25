import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import type { ApiConfig } from '../config/config.js';
import type { RelayDatabaseSchema } from './database-schema.js';
import type { SchemaReadinessChecker } from './schema-readiness.js';
import './pg-types.js';

export interface DatabaseProbe {
  readonly ok: boolean;
}

export interface DatabaseReadinessProbe {
  readonly database: 'up' | 'down';
  readonly schema: 'up' | 'down' | 'unknown';
}

/** Repository 与用例统一使用的连接句柄：根连接或同一事务连接都属于这个类型。 */
export type DbExecutor = Kysely<RelayDatabaseSchema>;

export class RelayDatabase {
  private readonly pool: Pool;
  private readonly kysely: Kysely<RelayDatabaseSchema>;

  constructor(
    config: Pick<
      ApiConfig,
      'databaseUrl' | 'databasePoolMax' | 'databaseConnectTimeoutMs'
    >,
    onBackgroundError: (error: Error) => void,
  ) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectTimeoutMs,
      application_name: 'relay-api',
    });
    this.pool.on('error', onBackgroundError);
    this.kysely = new Kysely<RelayDatabaseSchema>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });
  }

  /** 只读句柄；写入口必须由用例显式开启事务并把同一连接传给所有 Repository。 */
  get executor(): DbExecutor {
    return this.kysely;
  }

  async ping(): Promise<DatabaseProbe> {
    try {
      await sql`select 1 as ok`.execute(this.kysely);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async checkReadiness(
    schemaReadiness: SchemaReadinessChecker,
  ): Promise<DatabaseReadinessProbe> {
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

  async close(): Promise<void> {
    await this.kysely.destroy();
  }
}

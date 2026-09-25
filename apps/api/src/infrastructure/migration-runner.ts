import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Client } from 'pg';

import './pg-types.js';

/**
 * 单一迁移入口：版本化的显式 SQL + 内容完整性台账。
 *
 * 与 Kysely Migrator (0.29.6) 的兼容限制（见 experiments/typescript-p00/README.md 与 .research/upstream/kysely）：
 *   1. Kysely Migrator 的迁移是 TS/JS 模块，不是显式 SQL 文件；其台账只记录 name/timestamp，不记录内容摘要，
 *      因此“已应用迁移被改写”不会被发现。
 *   2. Kysely 的 PostgreSQL adapter 使用 session 级 `pg_advisory_lock`；SQL 失败进入 aborted transaction 后
 *      unlock 会返回 25P02，锁可能被带回调用方连接池。
 * 本工程的处理方式：不引入 Kysely Migrator，改为单一入口读取 `*.sql`，用简单协议一次执行整段 DDL，
 * 并在同一事务内用 `pg_advisory_xact_lock`（事务结束自动释放）串行化，把 DDL、台账行与内容摘要一起提交。
 * 迁移连接是每次运行独立的短生命周期连接，不与 API 连接池共享。
 */

/** 事务级 advisory lock 命名空间；测试用同一常量验证并发迁移会串行化。 */
export const MIGRATION_LOCK_NAMESPACE = 'relay:schema-migrations:v1';

export const MIGRATION_LEDGER_TABLE = 'relay_schema_migrations';

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;
const MIGRATION_CONNECT_TIMEOUT_MS = 10000;

export class MigrationIntegrityError extends Error {
  override readonly name = 'MigrationIntegrityError';
}

export class MigrationDefinitionError extends Error {
  override readonly name = 'MigrationDefinitionError';
}

export interface MigrationRunResult {
  /** 本次实际执行的迁移名（按文件名顺序）。 */
  readonly applied: readonly string[];
  /** 本次运行前已应用、且内容摘要一致的迁移名。 */
  readonly alreadyApplied: readonly string[];
  /** 提交后台账中的总行数。 */
  readonly ledgerRows: number;
}

interface LoadedMigration {
  readonly name: string;
  readonly sha256: Buffer;
  readonly sql: string;
}

/**
 * 应用 readiness 所需的本地迁移清单。只含名称与已随发布物固定的摘要，
 * 不暴露 SQL 正文，也不授予应用角色读取迁移台账。
 */
export interface MigrationManifestEntry {
  readonly name: string;
  readonly contentSha256Hex: string;
}

export interface RunMigrationsOptions {
  readonly connectionString: string;
  readonly directory: string;
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<MigrationRunResult> {
  const migrations = await loadMigrations(options.directory);
  const client = new Client({
    connectionString: options.connectionString,
    application_name: 'relay-migrator',
    connectionTimeoutMillis: MIGRATION_CONNECT_TIMEOUT_MS,
  });

  await client.connect();

  try {
    await client.query('begin');

    try {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        MIGRATION_LOCK_NAMESPACE,
      ]);
      await ensureLedgerTable(client);

      const recorded = await readLedger(client);
      verifyAppliedMigrations(migrations, recorded, options.directory);

      const applied: string[] = [];
      const alreadyApplied: string[] = [];

      for (const migration of migrations) {
        if (recorded.has(migration.name)) {
          alreadyApplied.push(migration.name);
          continue;
        }

        // 显式 SQL 在简单协议下一次执行整段 DDL；不使用扩展协议，避免多语句被拆成预处理语句。
        await client.query(migration.sql);
        await client.query(
          `insert into ${MIGRATION_LEDGER_TABLE} (name, content_sha256) values ($1, $2)`,
          [migration.name, migration.sha256],
        );
        applied.push(migration.name);
      }

      await client.query('commit');

      return {
        applied,
        alreadyApplied,
        ledgerRows: recorded.size + applied.length,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** 读取目录并计算内容摘要；文件名即迁移名，必须按 4 位序号前缀排序执行。 */
export async function loadMigrations(directory: string): Promise<readonly LoadedMigration[]> {
  const resolvedDirectory = resolve(directory);
  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  const migrations: LoadedMigration[] = [];

  for (const fileName of fileNames) {
    if (!MIGRATION_FILE_PATTERN.test(fileName)) {
      throw new MigrationDefinitionError(
        `${fileName} must be named <4-digit version>_<lower_snake_case>.sql`,
      );
    }

    const content = await readFile(join(resolvedDirectory, fileName));

    migrations.push({
      name: fileName.slice(0, -'.sql'.length),
      sha256: createHash('sha256').update(content).digest(),
      sql: content.toString('utf8'),
    });
  }

  return migrations;
}

/** 与迁移入口使用同一目录读取与 SHA-256 规则，供只读 schema 兼容检查使用。 */
export async function loadMigrationManifest(
  directory: string,
): Promise<readonly MigrationManifestEntry[]> {
  const migrations = await loadMigrations(directory);

  return migrations.map((migration) => ({
    name: migration.name,
    contentSha256Hex: migration.sha256.toString('hex'),
  }));
}

function verifyAppliedMigrations(
  migrations: readonly LoadedMigration[],
  recorded: ReadonlyMap<string, Buffer>,
  directory: string,
): void {
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));

  for (const [name, digest] of recorded) {
    const current = byName.get(name);

    if (current === undefined) {
      throw new MigrationIntegrityError(
        `applied migration ${name} is missing from ${resolve(directory)}`,
      );
    }

    if (!digest.equals(current.sha256)) {
      throw new MigrationIntegrityError(
        `applied migration ${name} content digest changed; applied migrations must not be edited`,
      );
    }
  }
}

async function ensureLedgerTable(client: Client): Promise<void> {
  await client.query(`create table if not exists ${MIGRATION_LEDGER_TABLE} (
    name text not null,
    content_sha256 bytea not null,
    applied_at timestamptz not null default now(),
    constraint pk_relay_schema_migrations primary key (name),
    constraint ck_relay_schema_migrations_sha256 check (octet_length(content_sha256) = 32)
  )`);
}

async function readLedger(client: Client): Promise<Map<string, Buffer>> {
  const result = await client.query<{ name: string; content_sha256: Buffer }>(
    `select name, content_sha256 from ${MIGRATION_LEDGER_TABLE} order by name`,
  );

  return new Map(result.rows.map((row) => [row.name, Buffer.from(row.content_sha256)]));
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // 连接已断时无法回滚；事务会随连接关闭由服务端终止。
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Client, Pool } from 'pg';

import type { DbExecutor } from '../../src/infrastructure/database.js';
import type { RelayDatabaseSchema } from '../../src/infrastructure/database-schema.js';
import { postgresErrorCode } from '../../src/infrastructure/postgres-error.js';
import { loadMigrations } from '../../src/infrastructure/migration-runner.js';
import '../../src/infrastructure/pg-types.js';

/**
 * 集成测试共用基建：真实临时集群由 scripts/run-integration.ps1 建立，
 * 这里只负责连接、随机库名与断言辅助。三种连接使用真实角色，不用超级用户冒充应用角色。
 */

export const MIGRATIONS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required: run "pnpm run test:integration" so the wrapper can build the temporary PostgreSQL cluster`,
    );
  }

  return value;
}

/** 应用角色连接（应用进程使用）。 */
export const APP_DATABASE_URL = requireEnvironment('RELAY_TEST_DATABASE_URL');
/** 迁移角色连接（持有 DDL）。 */
export const MIGRATION_DATABASE_URL = requireEnvironment('RELAY_TEST_MIGRATION_DATABASE_URL');
/** 集群管理员连接：只用于建立/删除测试数据库与观测，不作为应用角色。 */
export const ADMIN_DATABASE_URL = requireEnvironment('RELAY_TEST_ADMIN_DATABASE_URL');

export const ADMIN_DATABASE_NAME = databaseNameOf(ADMIN_DATABASE_URL);

export interface TestDatabase {
  readonly db: DbExecutor;
  close(): Promise<void>;
}

export function openDatabase(connectionString: string, applicationName: string): TestDatabase {
  const pool = new Pool({
    connectionString,
    max: 4,
    application_name: applicationName,
  });
  const db = new Kysely<RelayDatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    close: async () => {
      await db.destroy();
    },
  };
}

export function databaseNameOf(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//u, ''));
}

export function withDatabaseName(connectionString: string, databaseName: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${databaseName}`;

  return parsed.toString();
}

export async function runAdminStatement(
  statement: string,
  values: readonly unknown[] = [],
): Promise<void> {
  const client = new Client({
    connectionString: ADMIN_DATABASE_URL,
    application_name: 'relay-api-test-admin',
  });

  await client.connect();

  try {
    await client.query(statement, values as unknown[]);
  } finally {
    await client.end();
  }
}

export interface TemporaryDatabase {
  readonly name: string;
  readonly appUrl: string;
  readonly migrationUrl: string;
  readonly adminUrl: string;
  drop(): Promise<void>;
}

/**
 * 建立随机命名的临时数据库，owner 为迁移角色（迁移角色因此可在 public schema 建表），
 * 应用角色仍只有迁移授予的权限。结束后必须删除，避免留下测试库。
 */
export async function createTemporaryDatabase(suffix: string): Promise<TemporaryDatabase> {
  const name = `relay_api_test_${suffix}_${Math.random().toString(36).slice(2, 10)}`;

  await runAdminStatement(`create database ${name} owner relay_migrator`);

  return {
    name,
    appUrl: withDatabaseName(APP_DATABASE_URL, name),
    migrationUrl: withDatabaseName(MIGRATION_DATABASE_URL, name),
    adminUrl: withDatabaseName(ADMIN_DATABASE_URL, name),
    drop: async () => {
      await runAdminStatement(`drop database if exists ${name} with (force)`);
    },
  };
}

export async function relationExists(db: DbExecutor, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select to_regclass(${name}) is not null as exists
  `.execute(db);

  return result.rows[0]?.exists ?? false;
}

/** 断言某条语句以指定 SQLSTATE 失败；成功则测试失败。 */
export async function expectSqlState(
  expectedCode: string,
  label: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    assert.equal(
      postgresErrorCode(error),
      expectedCode,
      `${label} failed with an unexpected SQLSTATE (${String(error)})`,
    );
    return;
  }

  throw new Error(`${label} was expected to fail with SQLSTATE ${expectedCode}`);
}

/**
 * 当前仓库的完整迁移清单（名称 + 内容摘要），直接来自真实迁移目录。
 *
 * 备份/恢复类测试需要的不是「迁移一共多少条」这个会随每次加迁移而失效的常量，而是
 * 「被备份的数据库确实持有与仓库当前源码完全一致的那一套迁移」。因此这里返回可逐条
 * 比对的清单，由断言与数据库里的实际 ledger 对照。
 */
export async function currentMigrationManifest(): Promise<readonly {
  readonly name: string;
  readonly sha256Hex: string;
}[]> {
  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY);

  return migrations.map((migration) => ({
    name: migration.name,
    sha256Hex: migration.sha256.toString('hex'),
  }));
}

/**
 * 断言某连接上的迁移 ledger 与仓库当前迁移清单逐条一致（名称与内容摘要都相同）。
 *
 * 两个方向都要查：多出来的行说明备份混入了别的东西，缺少或摘要不符的行说明备份/恢复
 * 没有带走真实完整的迁移集合。只比条数会把「48 条里换掉一条」读成通过，因此不采用。
 */
export async function assertLedgerMatchesCurrentMigrations(
  db: DbExecutor,
  label: string,
): Promise<number> {
  const result = await sql<{ name: string; content_sha256: Buffer }>`
    select name, content_sha256 from relay_schema_migrations order by name
  `.execute(db);
  const recorded = result.rows.map((row) => ({
    name: row.name, sha256Hex: Buffer.from(row.content_sha256).toString('hex'),
  }));

  return assertMigrationLedgerMatchesManifest(recorded, label);
}

/** 同一断言的纯数据入口：给持有裸 `pg.Client` 的测试用（那里没有 DbExecutor）。 */
export async function assertMigrationLedgerMatchesManifest(
  recorded: readonly { readonly name: string; readonly sha256Hex: string }[],
  label: string,
): Promise<number> {
  const manifest = await currentMigrationManifest();
  const actual = new Map(recorded.map((entry) => [entry.name, entry.sha256Hex]));
  const expected = new Map(manifest.map((entry) => [entry.name, entry.sha256Hex]));

  assert.ok(expected.size > 0, '仓库必须至少有一份迁移，否则这条断言没有意义');
  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  const changed = [...expected.keys()].filter((name) =>
    actual.has(name) && actual.get(name) !== expected.get(name));

  assert.deepEqual({ missing, extra, changed }, { missing: [], extra: [], changed: [] },
    `${label}: ledger 必须与仓库当前迁移清单逐条一致（名称与内容摘要）`);
  return expected.size;
}

/** 仓库当前迁移条数；只用于与运行器自己报告的 ledgerRows 对照，不是独立断言。 */
export async function currentMigrationCount(): Promise<number> {
  const manifest = await currentMigrationManifest();
  assert.ok(manifest.length > 0, '仓库必须至少有一份迁移');
  return manifest.length;
}

/**
 * 在临时目录生成迁移目录副本，用于“已应用文件缺失/内容变更/名称非法/DDL 失败”等负例。
 * 真实迁移文件只读，测试副本在结束后删除。
 */
export async function createMigrationDirectoryFixture(
  mutate: (files: Map<string, string>) => void,
): Promise<string> {
  const files = new Map<string, string>();

  for (const entry of await readdir(MIGRATIONS_DIRECTORY)) {
    if (entry.endsWith('.sql')) {
      files.set(entry, await readFile(join(MIGRATIONS_DIRECTORY, entry), 'utf8'));
    }
  }

  mutate(files);

  const directory = await mkdtemp(join(tmpdir(), 'relay-api-migrations-'));

  for (const [name, content] of files) {
    await writeFile(join(directory, name), content, 'utf8');
  }

  return directory;
}
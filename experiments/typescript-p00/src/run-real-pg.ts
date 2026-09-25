import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { sql } from 'kysely';
import { Pool } from 'pg';

import {
  assertSafeIdentifier,
  quoteIdentifier,
  randomIdentifier,
  requireEnvironment,
} from './config.js';
import {
  connectProbeDatabase,
  destroyProbeDatabase,
} from './database.js';
import {
  MigrationIntegrityError,
  migrateWithIntegrity,
  migrateWithKyselyOnly,
} from './migrations.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const experimentRoot = resolve(sourceDirectory, '..');
const sourceMigration = join(
  experimentRoot,
  'migrations',
  '001_create_probe.ts',
);
const temporaryMigrationRoot = resolve(experimentRoot, '.tmp-migrations');
const temporaryMigrationBarrierRoot = resolve(
  experimentRoot,
  '.tmp-migration-barriers',
);
const inputPaths = [
  'migrations/001_create_probe.ts',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/run-real-pg.ps1',
  'src/config.ts',
  'src/database.ts',
  'src/migrate-child.ts',
  'src/migrations.ts',
  'src/run-real-pg.ts',
  'tsconfig.json',
] as const;
const concurrentMigrationPauseMilliseconds = 1_500;

interface Report {
  assertions: readonly string[];
  cleanup: {
    test_database: string;
  };
  environment: {
    node: string;
    postgres: string;
  };
  finished_at: string;
  input_sha256: Readonly<Record<(typeof inputPaths)[number], string>>;
  run_id: string;
  started_at: string;
  status: 'AWAITING_SERVER_CLEANUP' | 'FAILED';
}

async function main(): Promise<void> {
  assert.equal(
    process.versions.node.split('.')[0],
    '24',
    'Use the portable Node 24 runtime; this command must not certify system Node 22.',
  );

  const adminUrl = requireEnvironment('P00_PG_ADMIN_URL');
  const resultPath = resolve(requireEnvironment('P00_RESULT_PATH'));
  const runId = requireEnvironment('P00_RUN_ID');
  const adminUser = new URL(adminUrl).username;
  assertSafeIdentifier(adminUser, 'P00 PostgreSQL admin role');

  const adminPool = new Pool({ connectionString: adminUrl });
  const databaseName = randomIdentifier('relay_p00');
  const databaseUrl = databaseUrlFor(adminUrl, databaseName);
  const assertions: string[] = [];
  const startedAt = new Date().toISOString();
  let postgresVersion = 'unavailable';
  let databaseCreated = false;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  let databaseCleanup = 'test database was not created';

  try {
    await adminPool.query(
      `create database ${quoteIdentifier(databaseName, 'test database')} with owner ${quoteIdentifier(adminUser, 'admin role')} template template0`,
    );
    databaseCreated = true;

    postgresVersion = await queryPostgresVersion(adminPool);
    await testKyselyNativeMigrationBehavior(databaseUrl, assertions);
    await testIntegrityMigrationBehavior(databaseUrl, assertions);
    await testMigrationAtomicRollback(databaseUrl, assertions);
    await testSqlFailureDoesNotRetainMigrationLock(databaseUrl, assertions);
    await testConcurrentMigration(databaseUrl, assertions);
    await testTransactionRollback(databaseUrl, assertions);
    await testBigintMapping(databaseUrl, assertions);
    await testApplicationRoleDdl(databaseUrl, assertions);
    await testConditionalUpdateCas(databaseUrl, assertions);

  } catch (error) {
    testFailure = error;
  } finally {
    try {
      if (databaseCreated) {
        await dropTestDatabase(adminPool, databaseName);
        databaseCleanup = 'test runner terminated its sessions and dropped only its generated database';
      }
    } catch (error) {
      cleanupFailure = error;
      databaseCleanup = 'test database cleanup failed';
    }

    try {
      await adminPool.end();
    } catch (error) {
      cleanupFailure ??= error;
      databaseCleanup = 'test database cleanup or pool shutdown failed';
    }
  }

  const report: Report = {
    assertions,
    cleanup: {
      test_database: databaseCleanup,
    },
    environment: {
      node: process.versions.node,
      postgres: postgresVersion,
    },
    finished_at: new Date().toISOString(),
    input_sha256: await calculateInputHashes(),
    run_id: runId,
    started_at: startedAt,
    status:
      testFailure || cleanupFailure ? 'FAILED' : 'AWAITING_SERVER_CLEANUP',
  };
  await writeReport(resultPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);

  if (testFailure) {
    throw testFailure;
  }

  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

async function testKyselyNativeMigrationBehavior(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_native');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);

  try {
    const first = await migrateWithKyselyOnly(
      connection.db,
      fixture.directory,
      schema,
    );
    assert.deepEqual(first.executed, ['001_create_probe']);

    await appendFile(fixture.file, '\n// test-only content change\n', 'utf8');
    const changed = await migrateWithKyselyOnly(
      connection.db,
      fixture.directory,
      schema,
    );
    assert.deepEqual(
      changed.executed,
      [],
      'Kysely treats a changed file with the same migration name as applied.',
    );
    assertions.push('Kysely 内置迁移器对相同名称的已应用文件不校验内容摘要。');

    await rm(fixture.file);
    await assert.rejects(
      () =>
        migrateWithKyselyOnly(connection.db, fixture.directory, schema),
      /previously executed migration 001_create_probe is missing/,
    );
    assertions.push('Kysely 内置迁移器拒绝已应用迁移文件缺失。');
  } finally {
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testIntegrityMigrationBehavior(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_integrity');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);

  try {
    const first = await migrateWithIntegrity(
      connection,
      fixture.directory,
      schema,
    );
    assert.deepEqual(first.executed, ['001_create_probe']);

    const second = await migrateWithIntegrity(
      connection,
      fixture.directory,
      schema,
    );
    assert.deepEqual(second.executed, []);
    assertions.push('重复迁移不重复执行已应用迁移。');

    await appendFile(fixture.file, '\n// test-only content change\n', 'utf8');
    await assert.rejects(
      () => migrateWithIntegrity(connection, fixture.directory, schema),
      MigrationIntegrityError,
    );
    assertions.push('补充的单一迁移入口拒绝已应用迁移内容改变。');

    await rm(fixture.file);
    await assert.rejects(
      () => migrateWithIntegrity(connection, fixture.directory, schema),
      MigrationIntegrityError,
    );
    assertions.push('补充的单一迁移入口拒绝已应用迁移文件缺失。');
  } finally {
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testMigrationAtomicRollback(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_atomic');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);

  try {
    await writeFile(
      join(fixture.directory, '002_injected_failure.ts'),
      `import type { Kysely } from 'kysely';\nimport type { Migration } from 'kysely/migration';\n\nexport function createProbeMigration(schema: string): Migration {\n  return {\n    async up(db: Kysely<any>): Promise<void> {\n      await db.schema.withSchema(schema).createTable('p00_atomic_should_rollback').addColumn('id', 'integer', (column) => column.primaryKey()).execute();\n      throw new Error('injected migration failure');\n    },\n  };\n}\n`,
      'utf8',
    );
    await assert.rejects(
      () => migrateWithIntegrity(connection, fixture.directory, schema),
      /injected migration failure/,
    );

    const schemaExists = await sql<{ exists: boolean }>`
      select to_regnamespace(${schema}) is not null as exists
    `.execute(connection.db);
    assert.equal(schemaExists.rows[0]?.exists, false);
    assertions.push('迁移 DDL、Kysely 迁移记录和摘要清单在同一事务内遇故障时一起回滚。');
  } finally {
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testSqlFailureDoesNotRetainMigrationLock(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_sql_failure');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);
  let recoveryConnection:
    | ReturnType<typeof connectProbeDatabase>
    | undefined;

  try {
    const failingMigration = join(fixture.directory, '002_sql_failure.ts');
    await writeFile(
      failingMigration,
      `import { sql } from 'kysely';\nimport type { Kysely } from 'kysely';\nimport type { Migration } from 'kysely/migration';\n\nexport function createProbeMigration(schema: string): Migration {\n  return {\n    async up(db: Kysely<any>): Promise<void> {\n      await sql\`select * from p00_relation_that_does_not_exist\`.execute(db);\n    },\n  };\n}\n`,
      'utf8',
    );
    await assert.rejects(
      () => migrateWithIntegrity(connection, fixture.directory, schema),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '25P02',
    );

    const callerConnection = await sql<{ value: number }>`select 1 as value`.execute(
      connection.db,
    );
    assert.equal(callerConnection.rows[0]?.value, 1);

    const schemaExists = await sql<{ exists: boolean }>`
      select to_regnamespace(${schema}) is not null as exists
    `.execute(connection.db);
    assert.equal(schemaExists.rows[0]?.exists, false);

    const advisoryLocks = await sql<{ held: bigint }>`
      select count(*)::bigint as held
      from pg_locks
      where locktype = 'advisory'
        and granted
    `.execute(connection.db);
    assert.equal(advisoryLocks.rows[0]?.held, 0n);

    await rm(failingMigration);
    recoveryConnection = connectProbeDatabase(
      databaseUrlWithLockTimeout(databaseUrl, '500ms'),
    );
    const recovered = await migrateWithIntegrity(
      recoveryConnection,
      fixture.directory,
      schema,
    );
    assert.deepEqual(recovered.executed, ['001_create_probe']);
    assertions.push('真实 SQL 错误后 Kysely 的 unlock 报 25P02；调用者连接仍可查询，专属迁移连接随即销毁，回滚完成、无遗留 advisory lock，另一连接在 500ms lock_timeout 下可重新迁移。');
  } finally {
    if (recoveryConnection) {
      await destroyProbeDatabase(recoveryConnection);
    }
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testConcurrentMigration(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);

  try {
    const rawSchema = randomIdentifier('p00_concurrent_raw');
    const rawRun = await runConcurrentMigrationChildren(
      connection.db,
      'raw',
      databaseUrl,
      fixture.directory,
      rawSchema,
      concurrentMigrationPauseMilliseconds,
    );
    const rawLockWaitObserved = rawRun.advisoryLockWaitObserved;
    const rawResults = rawRun.results;
    assert.equal(rawResults.length, 2);
    assert.deepEqual(rawResults.map((result) => result.executed.length).sort(), [0, 1]);
    assert.equal(rawLockWaitObserved, true);

    const rawRows = await connection.db
      .withSchema(rawSchema)
      .selectFrom('p00_kysely_migration')
      .select('name')
      .execute();
    assert.deepEqual(rawRows.map((row) => row.name), ['001_create_probe']);
    assertions.push('两个独立 Node 24 进程在可控 pause 下争用 Kysely 原生 advisory lock；观察到 PostgreSQL 锁等待，且一方执行一条、另一方执行零条迁移。');

    const integritySchema = randomIdentifier('p00_concurrent_integrity');
    const integrityRun = await runConcurrentMigrationChildren(
      connection.db,
      'integrity',
      databaseUrl,
      fixture.directory,
      integritySchema,
      concurrentMigrationPauseMilliseconds,
    );
    const integrityLockWaitObserved = integrityRun.advisoryLockWaitObserved;
    const integrityResults = integrityRun.results;
    assert.equal(integrityResults.length, 2);
    assert.deepEqual(
      integrityResults.map((result) => result.executed.length).sort(),
      [0, 1],
    );
    assert.equal(integrityLockWaitObserved, true);

    const migrationRows = await connection.db
      .withSchema(integritySchema)
      .selectFrom('p00_kysely_migration')
      .select('name')
      .execute();
    assert.deepEqual(
      migrationRows.map((row) => row.name),
      ['001_create_probe'],
    );

    const digestRows = await connection.db
      .withSchema(integritySchema)
      .selectFrom('p00_migration_integrity')
      .select(['content_sha256', 'name'])
      .execute();
    const expectedDigest = createHash('sha256')
      .update(await readFile(fixture.file))
      .digest();
    assert.equal(digestRows.length, 1);
    assert.equal(digestRows[0]?.name, '001_create_probe');
    assert.equal(
      Buffer.from(digestRows[0]!.content_sha256).equals(expectedDigest),
      true,
    );
    assertions.push('两个独立 Node 24 进程在可控 pause 下争用哈希迁移入口；观察到 PostgreSQL 锁等待，且迁移记录与 SHA-256 清单各恰有一条、摘要一致。');
  } finally {
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testTransactionRollback(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_rollback');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);

  try {
    await migrateWithIntegrity(connection, fixture.directory, schema);
    await assert.rejects(
      () =>
        connection.db.transaction().execute(async (transaction) => {
          await transaction
            .withSchema(schema)
            .insertInto('p00_probe_records')
            .values({ id: 'rolled_back', note: 'must not persist', revision: 0n })
            .execute();
          throw new Error('inject rollback');
        }),
      /inject rollback/,
    );

    const row = await connection.db
      .withSchema(schema)
      .selectFrom('p00_probe_records')
      .select('id')
      .where('id', '=', 'rolled_back')
      .executeTakeFirst();
    assert.equal(row, undefined);
    assertions.push('同一 Kysely 事务中抛错后写入回滚。');
  } finally {
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testBigintMapping(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_bigint');
  const connection = connectProbeDatabase(databaseUrl);
  const expected = 9_007_199_254_740_993n;

  try {
    await connection.db.schema.createSchema(schema).execute();
    await connection.db.schema
      .withSchema(schema)
      .createTable('p00_bigint_values')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('value', 'bigint', (column) => column.notNull())
      .execute();
    await connection.db
      .withSchema(schema)
      .insertInto('p00_bigint_values')
      .values({ id: 'above_number_limit', value: expected })
      .execute();

    const row = await connection.db
      .withSchema(schema)
      .selectFrom('p00_bigint_values')
      .select('value')
      .where('id', '=', 'above_number_limit')
      .executeTakeFirstOrThrow();
    assert.equal(typeof row.value, 'bigint');
    assert.equal(row.value, expected);
    assertions.push('PostgreSQL bigint 大于 2^53 时经 pg INT8 解析器返回 bigint，未转为 number。');
  } finally {
    await destroyProbeDatabase(connection);
  }
}

async function testApplicationRoleDdl(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_role');
  const role = randomIdentifier('relay_p00_app');
  const fixture = await createMigrationFixture();
  const connection = connectProbeDatabase(databaseUrl);
  let applicationConnection:
    | ReturnType<typeof connectProbeDatabase>
    | undefined;

  try {
    await migrateWithIntegrity(connection, fixture.directory, schema);
    await sql.raw('revoke create on schema public from public').execute(
      connection.db,
    );
    await sql.raw(`create role ${quoteIdentifier(role, 'application role')} login`).execute(
      connection.db,
    );
    await sql.raw(
      `grant usage on schema ${quoteIdentifier(schema, 'schema')} to ${quoteIdentifier(role, 'application role')}`,
    ).execute(connection.db);
    await sql.raw(
      `grant select, insert on table ${quoteIdentifier(schema, 'schema')}.p00_probe_records to ${quoteIdentifier(role, 'application role')}`,
    ).execute(connection.db);

    applicationConnection = connectProbeDatabase(databaseUrlFor(databaseUrl, undefined, role));
    await assert.rejects(
      () =>
        sql.raw(
          `create table ${quoteIdentifier(schema, 'schema')}.p00_forbidden_ddl (id integer)`,
        ).execute(applicationConnection!.db),
      isInsufficientPrivilege,
    );
    await assert.rejects(
      () =>
        sql.raw('create table public.p00_forbidden_ddl (id integer)').execute(
          applicationConnection!.db,
        ),
      isInsufficientPrivilege,
    );
    assertions.push('应用角色仅获 DML 所需权限，不能在测试 schema 或 public schema 执行 DDL。');
  } finally {
    if (applicationConnection) {
      await destroyProbeDatabase(applicationConnection);
    }
    await sql.raw(
      `revoke all privileges on all tables in schema ${quoteIdentifier(schema, 'schema')} from ${quoteIdentifier(role, 'application role')}`,
    ).execute(connection.db);
    await sql.raw(
      `revoke all privileges on schema ${quoteIdentifier(schema, 'schema')} from ${quoteIdentifier(role, 'application role')}`,
    ).execute(connection.db);
    await sql.raw(`drop role if exists ${quoteIdentifier(role, 'application role')}`).execute(
      connection.db,
    );
    await destroyProbeDatabase(connection);
    await fixture.cleanup();
  }
}

async function testConditionalUpdateCas(
  databaseUrl: string,
  assertions: string[],
): Promise<void> {
  const schema = randomIdentifier('p00_cas');
  const connection = connectProbeDatabase(databaseUrl);

  try {
    await connection.db.schema.createSchema(schema).execute();
    await connection.db.schema
      .withSchema(schema)
      .createTable('p00_cas_rows')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('revision', 'bigint', (column) => column.notNull())
      .execute();
    await connection.db
      .withSchema(schema)
      .insertInto('p00_cas_rows')
      .values({ id: 'shared', revision: 0n })
      .execute();

    const attempts = await Promise.all(
      [0, 1].map(async () => {
        const result = await connection.db
          .withSchema(schema)
          .updateTable('p00_cas_rows')
          .set({ revision: sql<bigint>`revision + 1` })
          .where('id', '=', 'shared')
          .where('revision', '=', 0n)
          .executeTakeFirst();
        return result.numUpdatedRows;
      }),
    );
    assert.equal(attempts.filter((count) => count === 1n).length, 1);
    assert.equal(attempts.filter((count) => count === 0n).length, 1);

    const row = await connection.db
      .withSchema(schema)
      .selectFrom('p00_cas_rows')
      .select('revision')
      .where('id', '=', 'shared')
      .executeTakeFirstOrThrow();
    assert.equal(row.revision, 1n);
    assertions.push('两个并发条件更新中仅一个 revision=0 的 CAS 成功。');
  } finally {
    await destroyProbeDatabase(connection);
  }
}

function databaseUrlFor(
  base: string,
  database?: string,
  user?: string,
): string {
  const url = new URL(base);

  if (database) {
    url.pathname = `/${database}`;
  }

  if (user) {
    url.username = user;
    url.password = '';
  }

  return url.toString();
}

async function createMigrationFixture(): Promise<{
  cleanup: () => Promise<void>;
  directory: string;
  file: string;
}> {
  const directory = join(temporaryMigrationRoot, randomUUID().replaceAll('-', ''));
  const file = join(directory, '001_create_probe.ts');
  await mkdir(directory, { recursive: true });
  await copyFile(sourceMigration, file);

  return {
    cleanup: () => cleanupTemporaryMigrationDirectory(directory),
    directory,
    file,
  };
}

async function cleanupTemporaryMigrationDirectory(directory: string): Promise<void> {
  await cleanupTemporaryDirectory(
    temporaryMigrationRoot,
    directory,
    '.tmp-migrations',
  );
}

async function createMigrationBarrier(): Promise<{
  cleanup: () => Promise<void>;
  directory: string;
  releaseFile: string;
}> {
  const directory = join(
    temporaryMigrationBarrierRoot,
    randomUUID().replaceAll('-', ''),
  );
  await mkdir(directory, { recursive: true });
  return {
    cleanup: () =>
      cleanupTemporaryDirectory(
        temporaryMigrationBarrierRoot,
        directory,
        '.tmp-migration-barriers',
      ),
    directory,
    releaseFile: join(directory, 'release'),
  };
}

async function waitForMigrationBarrier(
  directory: string,
  expectedChildren: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = await readdir(directory, { withFileTypes: true });
    const readyChildren = entries.filter(
      (entry) => entry.isFile() && entry.name.startsWith('ready-'),
    ).length;
    if (readyChildren === expectedChildren) {
      return true;
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 25);
    });
  }
  return false;
}

async function cleanupTemporaryDirectory(
  expectedRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  let actualDirectory: string;

  try {
    actualDirectory = await realpath(directory);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }

  const actualRoot = await realpath(expectedRoot);
  const pathWithinRoot = relative(actualRoot, actualDirectory);
  if (
    pathWithinRoot.length === 0 ||
    pathWithinRoot.startsWith('..') ||
    isAbsolute(pathWithinRoot)
  ) {
    throw new Error(`refusing to recursively delete a path outside ${label}`);
  }

  await rm(actualDirectory, { force: true, recursive: true });
}

async function runMigrationChild(
  mode: 'integrity' | 'raw',
  databaseUrl: string,
  migrationDirectory: string,
  schema: string,
  pauseMilliseconds: number,
  barrierDirectory: string,
): Promise<{ executed: readonly string[]; ok: true }> {
  const tsxCli = join(experimentRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const childScript = join(sourceDirectory, 'migrate-child.ts');
  const childDatabaseUrl = databaseUrlWithApplicationName(
    databaseUrl,
    `relay_p00_${mode}_migration_child`,
  );
  const output = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [tsxCli, childScript], {
        cwd: experimentRoot,
        env: {
          ...process.env,
          P00_MIGRATION_DIRECTORY: migrationDirectory,
          P00_MIGRATION_BARRIER_DIRECTORY: barrierDirectory,
          P00_MIGRATION_MODE: mode,
          P00_MIGRATION_PAUSE_MS: String(pauseMilliseconds),
          P00_MIGRATION_SCHEMA: schema,
          P00_PG_URL: childDatabaseUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', rejectChild);
      child.once('close', (code) => {
        resolveChild({ code, stderr, stdout });
      });
    },
  );

  assert.equal(
    output.code,
    0,
    `migration child failed: ${sanitizeChildOutput(output.stderr || output.stdout)}`,
  );

  const parsed: unknown = JSON.parse(output.stdout);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal((parsed as { ok?: unknown }).ok, true);
  const executed = (parsed as { executed?: unknown }).executed;
  assert.ok(Array.isArray(executed));
  assert.ok(executed.every((name) => typeof name === 'string'));

  return {
    executed,
    ok: true,
  };
}

async function runConcurrentMigrationChildren(
  observerDb: ReturnType<typeof connectProbeDatabase>['db'],
  mode: 'integrity' | 'raw',
  databaseUrl: string,
  migrationDirectory: string,
  schema: string,
  pauseMilliseconds: number,
): Promise<{
  advisoryLockWaitObserved: boolean;
  results: readonly { executed: readonly string[]; ok: true }[];
}> {
  const barrier = await createMigrationBarrier();
  const children = Promise.all([
    runMigrationChild(
      mode,
      databaseUrl,
      migrationDirectory,
      schema,
      pauseMilliseconds,
      barrier.directory,
    ),
    runMigrationChild(
      mode,
      databaseUrl,
      migrationDirectory,
      schema,
      pauseMilliseconds,
      barrier.directory,
    ),
  ]);

  try {
    const ready = await waitForMigrationBarrier(barrier.directory, 2);
    assert.equal(ready, true, 'both migration children must reach the start barrier');
    await writeFile(barrier.releaseFile, '', { flag: 'wx' });
    const advisoryLockWaitObserved = await waitForAdvisoryLockWait(
      observerDb,
      mode,
    );
    const results = await children;
    return { advisoryLockWaitObserved, results };
  } catch (error) {
    await writeFile(barrier.releaseFile, '', { flag: 'a' });
    await Promise.allSettled([children]);
    throw error;
  } finally {
    await barrier.cleanup();
  }
}

async function waitForAdvisoryLockWait(
  db: ReturnType<typeof connectProbeDatabase>['db'],
  mode: 'integrity' | 'raw',
): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await sql<{ waiting: bigint }>`
      select count(*)::bigint as waiting
      from pg_stat_activity
      where datname = current_database()
        and application_name = ${`relay_p00_${mode}_migration_child`}
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
        and (
          query like '%pg_advisory_lock%'
          or query like '%pg_advisory_xact_lock%'
        )
    `.execute(db);
    if ((result.rows[0]?.waiting ?? 0n) > 0n) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  return false;
}

function databaseUrlWithApplicationName(
  databaseUrl: string,
  applicationName: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function databaseUrlWithLockTimeout(
  databaseUrl: string,
  lockTimeout: string,
): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c lock_timeout=${lockTimeout}`);
  return url.toString();
}

async function queryPostgresVersion(pool: Pool): Promise<string> {
  const result = await pool.query<{ server_version: string }>(
    'show server_version',
  );
  return result.rows[0]?.server_version ?? 'unknown';
}

async function dropTestDatabase(pool: Pool, databaseName: string): Promise<void> {
  await pool.query(
    'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
    [databaseName],
  );
  await pool.query(`drop database if exists ${quoteIdentifier(databaseName, 'test database')}`);
}

async function calculateInputHashes(): Promise<
  Readonly<Record<(typeof inputPaths)[number], string>>
> {
  const entries = await Promise.all(
    inputPaths.map(async (relativePath) => {
      const contents = await readFile(join(experimentRoot, relativePath));
      return [
        relativePath,
        createHash('sha256').update(contents).digest('hex'),
      ] as const;
    }),
  );
  return Object.fromEntries(entries) as Readonly<
    Record<(typeof inputPaths)[number], string>
  >;
}

async function writeReport(resultPath: string, report: Report): Promise<void> {
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function sanitizeChildOutput(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted-postgres-url]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function isInsufficientPrivilege(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42501'
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

void main();

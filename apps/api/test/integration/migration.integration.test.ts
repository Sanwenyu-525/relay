import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { Client } from 'pg';
import { sql } from 'kysely';

import {
  MIGRATION_LOCK_NAMESPACE,
  MigrationDefinitionError,
  MigrationIntegrityError,
  runMigrations,
} from '../../src/infrastructure/migration-runner.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  createMigrationDirectoryFixture,
  createTemporaryDatabase,
  expectSqlState,
  openDatabase,
  relationExists,
} from './integration-support.js';

/**
 * 迁移入口的真实 PostgreSQL 验证：空库迁移、重复启动、并发串行化、历史完整性与同事务回滚。
 * 每个负例都使用独立临时数据库或临时迁移目录，不影响其他测试文件共用的测试库。
 */

const V001_TABLES = [
  'workspaces',
  'workspace_execution_authority',
  'projects',
  'goals',
  'project_goals',
  'tasks',
  'task_acceptances',
  'acceptance_criteria',
  'task_explicit_goals',
  'task_dependencies',
  'project_states',
  'project_blockers',
  'project_risks',
  'artifacts',
  'artifact_versions',
  'human_acceptances',
  'completion_records',
  'state_completion_refs',
  'state_artifact_refs',
  'command_receipts',
  'activity_records',
];

const V001_MIGRATION = '0001_v001_human_core';
const V001_FILE = `${V001_MIGRATION}.sql`;
/** 迁移目录中的全部迁移（按文件名排序）；新增 migration 时这里保持一致。 */
const ALL_MIGRATIONS = [
  '0001_v001_human_core',
  '0002_p02_task_goal_alignment',
  '0003_schema_readiness',
  '0004_v002_runs',
  '0005_v002_verification',
  '0006_v002_reviews',
  '0007_v003_recovery_control',
  '0008_v003_gateway',
  '0009_v004_information_rules',
  '0010_v005_context_revision',
  '0011_m03_run_dispatch',
  '0012_m03_run_events',
  '0013_m03_run_command_order',
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

test('applies V001 on an empty database and does not repeat it on a second run', async () => {
  const database = await createTemporaryDatabase('fresh');

  try {
    const initial = await runMigrations({
      connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY,
    });

    assert.deepEqual(initial.applied, ALL_MIGRATIONS);
    assert.deepEqual(initial.alreadyApplied, []);
    assert.equal(initial.ledgerRows, ALL_MIGRATIONS.length);

    const migration = openDatabase(database.migrationUrl, 'relay-api-test-migration');

    try {
      for (const table of V001_TABLES) {
        assert.equal(await relationExists(migration.db, table), true, `${table} must exist`);
      }

      const ledger = await sql<{ name: string; content_sha256: Buffer }>`
        select name, content_sha256 from relay_schema_migrations order by name
      `.execute(migration.db);

      assert.deepEqual(
        ledger.rows.map((row) => row.name),
        [...ALL_MIGRATIONS],
      );
      assert.equal(Buffer.from(ledger.rows[0]?.content_sha256 ?? Buffer.alloc(0)).length, 32);
    } finally {
      await migration.close();
    }

    // 应用角色可以用迁移后的表，但看不到迁移台账（台账不授予应用角色）。
    const app = openDatabase(database.appUrl, 'relay-api-test-app');

    try {
      const probe = await sql`select 1 as ok from workspaces limit 1`.execute(app.db);
      assert.equal(probe.rows.length, 0);

      await expectSqlState(
        '42501',
        'application role reading relay_schema_migrations',
        () => sql`select name from relay_schema_migrations`.execute(app.db),
      );

      const compatibility = await sql<{ name: string; content_sha256_hex: string }>`
        select name, content_sha256_hex
        from relay_schema_migration_compatibility
        order by name
      `.execute(app.db);
      assert.deepEqual(
        compatibility.rows.map((row) => row.name),
        [...ALL_MIGRATIONS],
      );
      assert.match(compatibility.rows[0]?.content_sha256_hex ?? '', /^[0-9a-f]{64}$/u);
    } finally {
      await app.close();
    }

    const repeated = await runMigrations({
      connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY,
    });

    assert.deepEqual(repeated.applied, []);
    assert.deepEqual(repeated.alreadyApplied, ALL_MIGRATIONS);
    assert.equal(repeated.ledgerRows, ALL_MIGRATIONS.length);
  } finally {
    await database.drop();
  }
});

test('rejects an applied migration whose file is missing or whose content changed', async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  const missingDirectory = await createMigrationDirectoryFixture((files) => {
    files.delete(V001_FILE);
  });
  const changedDirectory = await createMigrationDirectoryFixture((files) => {
    files.set(V001_FILE, `${files.get(V001_FILE) ?? ''}\n-- edited after the migration was applied\n`);
  });

  try {
    await assert.rejects(
      runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: missingDirectory }),
      MigrationIntegrityError,
    );
    await assert.rejects(
      runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: changedDirectory }),
      MigrationIntegrityError,
    );
  } finally {
    await rm(missingDirectory, { recursive: true, force: true });
    await rm(changedDirectory, { recursive: true, force: true });
  }
});

test('rejects a migration file that is not versioned by a 4-digit prefix', async () => {
  const invalidDirectory = await createMigrationDirectoryFixture((files) => {
    files.set('v001_human_core.sql', '-- not versioned\n');
  });

  try {
    await assert.rejects(
      runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: invalidDirectory }),
      MigrationDefinitionError,
    );
  } finally {
    await rm(invalidDirectory, { recursive: true, force: true });
  }
});

test('rolls back DDL, ledger row and digest together when a migration fails', async () => {
  const database = await createTemporaryDatabase('rollback');
  const brokenDirectory = await createMigrationDirectoryFixture((files) => {
    files.set(
      V001_FILE,
      `${files.get(V001_FILE) ?? ''}\ncreate table rollback_probe (id uuid not null);\ncreate table rollback_probe (id uuid not null);\n`,
    );
  });

  try {
    await assert.rejects(
      runMigrations({ connectionString: database.migrationUrl, directory: brokenDirectory }),
      (error: unknown) => (error as { code?: string }).code === '42P07',
    );

    const migration = openDatabase(database.migrationUrl, 'relay-api-test-migration');

    try {
      assert.equal(
        await relationExists(migration.db, 'workspaces'),
        false,
        'partial DDL must be rolled back',
      );
      assert.equal(
        await relationExists(migration.db, 'rollback_probe'),
        false,
        'the failing statement must be rolled back',
      );
      assert.equal(
        await relationExists(migration.db, 'relay_schema_migrations'),
        false,
        'the ledger table is created in the same transaction and must be rolled back too',
      );
    } finally {
      await migration.close();
    }
  } finally {
    await rm(brokenDirectory, { recursive: true, force: true });
    await database.drop();
  }
});

test('waits for the migration advisory lock instead of running DDL concurrently', async () => {
  const database = await createTemporaryDatabase('lockwait');
  const holder = new Client({
    connectionString: database.adminUrl,
    application_name: 'relay-api-test-lock-holder',
  });

  await holder.connect();

  try {
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      MIGRATION_LOCK_NAMESPACE,
    ]);

    const pending = runMigrations({
      connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY,
    });
    const early = await Promise.race([
      pending.then(() => 'settled' as const),
      delay(500).then(() => 'pending' as const),
    ]);

    assert.equal(early, 'pending', 'migrations must wait for the advisory lock');

    await holder.query('commit');

    const result = await pending;
    assert.deepEqual(result.applied, ALL_MIGRATIONS);
  } finally {
    await holder.end();
    await database.drop();
  }
});

test('runs concurrent migrations on one database exactly once', async () => {
  const database = await createTemporaryDatabase('concurrent');

  try {
    const [first, second] = await Promise.all([
      runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY }),
      runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY }),
    ]);

    assert.equal(
      first.applied.length + second.applied.length,
      ALL_MIGRATIONS.length,
      'exactly one process must apply each migration',
    );
    assert.equal(first.ledgerRows, ALL_MIGRATIONS.length);
    assert.equal(second.ledgerRows, ALL_MIGRATIONS.length);

    const migration = openDatabase(database.migrationUrl, 'relay-api-test-migration');

    try {
      const ledger = await sql<{ count: bigint }>`
        select count(*) as count from relay_schema_migrations
      `.execute(migration.db);

      assert.equal(ledger.rows[0]?.count, BigInt(ALL_MIGRATIONS.length));
      assert.equal(await relationExists(migration.db, 'workspaces'), true);
    } finally {
      await migration.close();
    }
  } finally {
    await database.drop();
  }
});

test('uses real non-superuser roles for the migration and application connections', async () => {
  const migration = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-migration');
  const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-app');

  try {
    const roles = await sql<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean }>`
      select rolname, rolsuper, rolcreatedb
      from pg_roles
      where rolname in ('relay_migrator', 'relay_app')
      order by rolname
    `.execute(migration.db);

    assert.deepEqual(roles.rows, [
      { rolname: 'relay_app', rolsuper: false, rolcreatedb: false },
      { rolname: 'relay_migrator', rolsuper: false, rolcreatedb: false },
    ]);

    // 应用连接使用 relay_app，且只连到本次运行的临时测试库。
    const current = await sql<{ current_database: string; current_user: string }>`
      select current_database(), current_user
    `.execute(app.db);

    assert.equal(current.rows[0]?.current_user, 'relay_app');
    assert.match(current.rows[0]?.current_database ?? '', /^relay_api_test_/u);
  } finally {
    await app.close();
    await migration.close();
  }
});

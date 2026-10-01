import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { Client } from 'pg';
import { sql } from 'kysely';

import { withTransaction } from '../../src/application/unit-of-work.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';

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
  '0014_m04_file_read',
  '0015_m04_assist',
  '0016_m04_web_fetch',
  '0017_m04_web_import',
  '0018_m04_model_calls',
  '0019_m04_draft_read_input',
  '0020_m05_today_selections',
  '0021_m05_activity_lineage',
  '0022_m04_first_party_skills',
  '0023_m04_task_skill_proposals',
  '0024_m05_view_configuration',
  '0025_m05_project_blueprints',
  '0026_m04_model_call_budgets',
  '0027_m05_workspace_lists',
  '0028_m04_assist_live_preview',
  '0029_m04_run_draft_live_preview',
  '0030_m06_real_tools',
  '0031_m06_change_sets',
  '0032_m06_change_set_source_scope',
  '0033_m06_file_write_stop_proofs',
  '0034_m06_file_write_manual_dispositions',
  '0035_m06_file_write_frozen_diff',
  '0036_m06_file_write_path_identity',
  '0037_m06_file_write_frozen_diff_root_path',
  '0038_m06_managed_root_identity',
  '0039_m06_active_resource_root',
  '0040_collaboration_artifact_text_locks',
  '0041_collaboration_impact_checks',
  '0042_collaboration_attention',
  '0043_model_call_verify',
  '0044_project_continuation_points',
  '0045_continuation_point_ref_target_guard',
  '0046_assist_provider_error_kind',
  '0047_m04_model_call_first_output',
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

test('first-output migration leaves pre-existing settled calls NULL', async () => {
  const database = await createTemporaryDatabase('first_output_legacy');
  const directory = await createMigrationDirectoryFixture((files) => {
    files.delete('0047_m04_model_call_first_output.sql');
  });
  const app = openDatabase(database.appUrl, 'relay-api-test-legacy-call');
  try {
    await runMigrations({ connectionString: database.migrationUrl, directory });
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const messageId = randomUUID();
    await withTransaction(app.db, async (r) => {
      await r.workspaces.insertWorkspace({ id: workspaceId, name: 'Legacy timing' });
      await r.workspaces.insertAuthorityRow(workspaceId);
      await r.assist.insertSession({ id: sessionId, workspaceId, projectId: null,
        taskId: null, title: 'Legacy call' });
      await r.assist.insertMessage({ id: messageId, sessionId, seq: 1n,
        role: 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
        content: 'Historical response', sources: [] });
    });
    const calls = new ModelCallRepository(app.db);
    const callId = randomUUID();
    await calls.begin(callId, { workspaceId, kind: 'ASSIST', assistMessageId: messageId },
      new FakeModelPort().identity);
    await calls.settle(callId, { status: 'COMPLETED' });
    const applied = await runMigrations({ connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY });
    assert.deepEqual(applied.applied, ['0047_m04_model_call_first_output']);
    await calls.recordFirstTextDelta(callId, new Date());
    await calls.recordFirstPreviewPersisted(callId);
    const legacy = await calls.read(callId);
    assert.ok(legacy);
    assert.equal(legacy?.status, 'COMPLETED');
    assert.equal(legacy.first_text_delta_at, null);
    assert.equal(legacy.first_preview_persisted_at, null);
  } finally {
    await app.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});

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
      const modelCallPrivileges = (await sql<{ can_change_origin: boolean;
        can_settle: boolean; can_record_text: boolean; can_record_preview: boolean }>`select
          has_column_privilege(current_user, 'model_calls', 'step_attempt_id', 'UPDATE')
            as can_change_origin,
          has_column_privilege(current_user, 'model_calls', 'status', 'UPDATE')
            as can_settle,
          has_column_privilege(current_user, 'model_calls', 'first_text_delta_at', 'UPDATE')
            as can_record_text,
          has_column_privilege(current_user, 'model_calls', 'first_preview_persisted_at', 'UPDATE')
            as can_record_preview`.execute(app.db)).rows[0]!;
      assert.deepEqual(modelCallPrivileges, { can_change_origin: false, can_settle: true,
        can_record_text: true, can_record_preview: true });

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

test('0021 attributes historical unscoped Activity or aborts on an orphan', async () => {
  const database = await createTemporaryDatabase('activity_backfill');
  const beforeDirectory = await createMigrationDirectoryFixture((files) => {
    files.delete('0021_m05_activity_lineage.sql');
  });
  const migration = openDatabase(database.migrationUrl, 'relay-api-test-activity-backfill');
  try {
    await runMigrations({ connectionString: database.migrationUrl, directory: beforeDirectory });
    const workspaceId = randomUUID();
    const goalId = randomUUID();
    const focusCommand = randomUUID();
    const orphanId = randomUUID();
    await sql`insert into workspaces (id, name) values (${workspaceId}, 'Backfill')`
      .execute(migration.db);
    await sql`insert into goals (id, workspace_id, title, status)
      values (${goalId}, ${workspaceId}, 'Goal', 'ACTIVE')`.execute(migration.db);
    await sql`insert into command_receipts (scope_key, command_id, command_type,
      payload_hash, payload_hash_algorithm, canonicalization_version, result_ref)
      values (${'workspace:' + workspaceId + ':user:local'}, ${focusCommand},
        'SetFocusSelection', ${Buffer.alloc(32)}, 'sha256', '1', '{}'::jsonb)`
      .execute(migration.db);
    await sql`insert into activity_records (id, actor_kind, actor_ref, command_id,
      project_id, task_id, event_type, fact_refs) values
      (${randomUUID()}, 'HUMAN', 'cli', null, null, null,
        'WORKSPACE_INITIALIZED', ${JSON.stringify({ workspace_id: workspaceId })}::jsonb),
      (${randomUUID()}, 'HUMAN', 'user:local', null, null, null,
        'GOAL_CREATED', ${JSON.stringify({ goal_id: goalId })}::jsonb),
      (${randomUUID()}, 'HUMAN', 'user:local', ${focusCommand}, null, null,
        'TODAY_FOCUS_CHANGED', ${JSON.stringify({ target_kind: null })}::jsonb),
      (${orphanId}, 'SYSTEM', 'old', null, null, null,
        'UNATTRIBUTED', '{}'::jsonb)`.execute(migration.db);
    await assert.rejects(() => runMigrations({ connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY }), /without an authoritative Workspace/u);
    const ledger = await sql<{ count: bigint }>`select count(*)::bigint as count
      from relay_schema_migrations where name = '0021_m05_activity_lineage'`
      .execute(migration.db);
    assert.equal(ledger.rows[0]?.count, 0n);
    await sql`delete from activity_records where id = ${orphanId}`.execute(migration.db);
    await runMigrations({ connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY });
    const attributed = await sql<{ workspace_id: string }>`select workspace_id
      from activity_records order by created_at, id`.execute(migration.db);
    assert.equal(attributed.rows.length, 3);
    assert.ok(attributed.rows.every((row) => row.workspace_id === workspaceId));
  } finally {
    await migration.close();
    await rm(beforeDirectory, { recursive: true, force: true });
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

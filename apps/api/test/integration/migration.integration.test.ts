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
  '0048_m07_admission_gate',
  '0049_m04_model_call_cache_usage',
  '0050_n02_impact_candidate_groups', '0051_conversation_execution_requests',
  '0052_n03_project_knowledge_guide', '0053_n03_knowledge_curation_candidates',
  '0054_m04_agent_tool_loop', '0055_m05_message_queue', '0056_m04_run_scope_grants',
  '0057_m04_run_tool_call_events', '0058_m06_user_action_origin',
  '0059_m04_assistant_conversation_modes', '0060_m04_assistant_readonly_origin',
  '0061_m04_cli_run_allowed_executables',
  '0062_natural_language_state_maintenance',
  '0063_project_daily_view_baselines',
  '0064_natural_language_state_binding',
  '0065_project_daily_view_presentation_seq',
  '0066_natural_language_task_planning',
  '0067_natural_language_recheck_remediation',
  '0068_natural_language_external_sync',
  '0069_project_return_reviews',
  '0070_natural_language_undo',
  '0071_builtin_methods_and_chat_commands',
  '0072_learning_mode_records',
  '0073_model_tool_turn_assistant_message',
  '0074_task_acceptance_materials',
  '0075_task_acceptance_trials',
  '0076_task_acceptance_comparisons',
  '0077_conversation_acceptance_time',
  '0078_project_hypotheses',
  '0079_decision_review_candidates',
  '0080_work_segments',
  '0081_personal_planning',
  '0082_plan_scope_simulations',
  '0083_project_reminders',
  '0084_task_chains',
  '0085_task_chain_execution_specs',
  '0086_impact_group_dependencies',
  '0087_agent_conversation_main_loop',
  '0088_model_catalog_snapshot',
  '0089_session_model_selection',
  '0090_assist_session_pin',
  '0091_composer_draft_assist',
  '0092_computer_use',
  '0093_assist_message_attachments',
  '0094_session_model_selection_source_guard',
  '0095_session_model_selection_openrouter_provenance',
  '0096_computer_control_state',
  '0097_conversation_diff_baseline',
  '0098_assist_message_model_snapshot',
  '0099_assist_model_call_identity',
  '0100_model_provider_cooldown',
  '0101_model_call_stream_event',
  '0102_run_tool_call_preview',
  '0103_github_read',
  '0104_assist_session_unread',
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

test('first-output migration leaves pre-existing settled calls NULL', async () => {
  const database = await createTemporaryDatabase('first_output_legacy');
  const directory = await createMigrationDirectoryFixture((files) => {
    // 这三条都要缺席：第一轮之后 assist_messages/model_calls 还没有缓存列，
    // 而本测试要在第二轮写入历史调用行，再验证它们补列后仍保持 NULL。
    files.delete('0047_m04_model_call_first_output.sql');
    files.delete('0048_m07_admission_gate.sql');
    files.delete('0049_m04_model_call_cache_usage.sql');
    files.delete('0050_n02_impact_candidate_groups.sql');
    files.delete('0051_conversation_execution_requests.sql');
    files.delete('0052_n03_project_knowledge_guide.sql');
    files.delete('0053_n03_knowledge_curation_candidates.sql');
    files.delete('0054_m04_agent_tool_loop.sql');
    // 0056 依赖 0054 建出的 run_tool_calls，0055 属于后续消息队列批次：
    // 这一轮只重放「缓存列之前」的历史事实，两者都不该出现。0057 登记 run_tool_calls
    // 为事件来源，同样依赖 0054 建出的这张表，必须与 0054 一起缺席。
    files.delete('0055_m05_message_queue.sql');
    files.delete('0056_m04_run_scope_grants.sql');
    files.delete('0057_m04_run_tool_call_events.sql');
    // 0058 只放宽三条 CHECK，但它重述的既有分支来自 0054/0016；与 0054 一起缺席才能保持
    // 「历史迁移目录」这一夹具的前提自洽。
    files.delete('0058_m06_user_action_origin.sql');
    files.delete('0073_model_tool_turn_assistant_message.sql');
    // 0086 给 artifact_impact_candidate_groups 加依赖列，而建出这张表的 0050 在本夹具里
    // 被删掉了；它与 0050 必须同进同出，否则第一轮就会报「关系不存在」而不是走到断言。
    files.delete('0086_impact_group_dependencies.sql');
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
    // 补列前按旧结构结算，历史行没有缓存用量。
    await sql`update model_calls set status = 'COMPLETED', settled_at = clock_timestamp()
      where id = ${callId}`.execute(app.db);
    const applied = await runMigrations({ connectionString: database.migrationUrl,
      directory: MIGRATIONS_DIRECTORY });
    assert.deepEqual(applied.applied, ['0047_m04_model_call_first_output',
      '0048_m07_admission_gate', '0049_m04_model_call_cache_usage',
      '0050_n02_impact_candidate_groups', '0051_conversation_execution_requests',
      '0052_n03_project_knowledge_guide', '0053_n03_knowledge_curation_candidates',
    '0054_m04_agent_tool_loop', '0055_m05_message_queue', '0056_m04_run_scope_grants',
      '0057_m04_run_tool_call_events', '0058_m06_user_action_origin',
      '0073_model_tool_turn_assistant_message',
      // 0086 与 0050 同进同出，所以第二轮在这里补上；0087 只依赖 0008/0015 建出的表，
      // 不依赖被删掉的那一批，因此它留在历史夹具里，第二轮不会重复应用。
      '0086_impact_group_dependencies']);
    await calls.recordFirstTextDelta(callId, new Date());
    await calls.recordFirstPreviewPersisted(callId);
    const legacy = await calls.read(callId);
    assert.ok(legacy);
    assert.equal(legacy?.status, 'COMPLETED');
    assert.equal(legacy.first_text_delta_at, null);
    assert.equal(legacy.first_preview_persisted_at, null);
    // 历史调用从未上报缓存：补列后必须保持未知，而不是回填 0。
    assert.equal(legacy.usage_cache_read_tokens, null);
    assert.equal(legacy.usage_cache_creation_tokens, null);
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

test('0057 registers run tool calls as a Run event source without backfilling history', async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  const migration = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-tool-call-events');

  try {
    // 触发器确实建在 run_tool_calls 上，且只登记 INSERT 与 UPDATE 两件事。
    const triggers = await sql<{ tgname: string; definition: string }>`
      select tgname, pg_get_triggerdef(oid) as definition
      from pg_trigger
      where tgrelid = 'public.run_tool_calls'::regclass and not tgisinternal
      order by tgname
    `.execute(migration.db);
    assert.deepEqual(triggers.rows.map((row) => row.tgname),
      ['tr_run_events_tool_call_insert', 'tr_run_events_tool_call_update']);

    // WHEN 只看状态推进的三列。revision 每次推进都会变，纳入它会让同一次推进多发一条提示。
    // INSERT 触发器没有 WHEN（写入即新事实），因此只对 UPDATE 触发器断言。
    const updateTrigger = triggers.rows.find((row) => row.tgname === 'tr_run_events_tool_call_update');
    assert.ok(updateTrigger, 'the UPDATE trigger must exist');
    assert.match(updateTrigger.definition, /relay_append_run_event\(\)/u);
    // pg_get_triggerdef 会把标识符小写化，比较时忽略大小写。
    assert.match(updateTrigger.definition, /status IS DISTINCT FROM new\.status/iu);
    assert.match(updateTrigger.definition, /operation_id IS DISTINCT FROM new\.operation_id/iu);
    assert.match(updateTrigger.definition, /result_ref IS DISTINCT FROM new\.result_ref/iu);
    assert.doesNotMatch(updateTrigger.definition, /revision/iu);

    // CHECK 只能放宽：六个原取值必须逐字保留，否则历史行下一次写入就会违反约束
    // （0054 重述 ck_logical_operation_resource 时漏掉分支造成 9 例失败，同一类教训）。
    const check = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'ck_run_events_kind' and conrelid = 'public.run_events'::regclass
    `.execute(migration.db);
    const definition = check.rows[0]?.definition ?? '';
    for (const kind of ['RUN_CHANGED', 'STEP_CHANGED', 'ATTEMPT_CHANGED', 'REVIEW_CHANGED',
      'CONTROL_CHANGED', 'EFFECT_CHANGED', 'TOOL_CALL_CHANGED']) {
      assert.ok(definition.includes(`'${kind}'`), `ck_run_events_kind must keep ${kind}`);
    }

    // 函数必须认识这张表：0012 的 CASE 遇到未登记来源直接 RAISE EXCEPTION，
    // 漏掉分支会让工具调用行的每一次写入都失败。
    const fn = await sql<{ definition: string }>`
      select pg_get_functiondef('public.relay_append_run_event()'::regprocedure) as definition
    `.execute(migration.db);
    assert.match(fn.rows[0]?.definition ?? '', /run_tool_calls/u);
    assert.match(fn.rows[0]?.definition ?? '', /TOOL_CALL_CHANGED/u);
    // 锁序不能动：事件序号在 Run 行锁下取 max(seq)+1。
    assert.match(fn.rows[0]?.definition ?? '', /FOR UPDATE/u);
  } finally {
    await migration.close();
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

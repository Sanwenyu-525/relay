import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';

/**
 * 迁移与 Workspace 初始化入口的真实进程验证：两个 CLI 都以迁移角色/应用角色连接，
 * 不依赖手工改库，并且重复运行不会重复建表或重复创建 Workspace。
 */

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_ENTRY_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli');
const MIGRATE_ENTRY = resolve(CLI_ENTRY_DIRECTORY, 'migrate.js');
const INIT_WORKSPACE_ENTRY = resolve(CLI_ENTRY_DIRECTORY, 'init-workspace.js');

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-app');

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
});

after(async () => {
  await app.close();
});

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(entry: string, args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: apiRoot,
      env: {
        ...process.env,
        RELAY_DB_URL: APP_DATABASE_URL,
        RELAY_MIGRATION_DB_URL: MIGRATION_DATABASE_URL,
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
    child.on('error', rejectResult);
    child.on('close', (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}

test('migrate entry reports the applied migrations without repeating them', async () => {
  const first = await runCli(MIGRATE_ENTRY, []);

  assert.equal(first.code, 0, first.stderr);
  const payload = JSON.parse(first.stdout) as {
    applied: string[];
    already_applied: string[];
    ledger_rows: number;
  };

  assert.deepEqual(payload.applied, []);
  // 迁移由 persistence/api 集成测试先行应用；这里只验证 CLI 不重复应用已落地的迁移。
    assert.deepEqual(payload.already_applied, [
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
      '0050_n02_impact_candidate_groups',
      '0051_conversation_execution_requests',
      '0052_n03_project_knowledge_guide',
      '0053_n03_knowledge_curation_candidates',
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
      // 0092–0104：Computer Plugin / 附件 / 模型目录 / GitHub 只读 / 会话未读。
      // 本清单此前停留在 0091（自 0092 起一直未更新，属既有失败），本次一并补齐。
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
      // 0105–0108：F26 浏览器自动化（能力、后端健康、任务状态、授权词表）。
      '0105_browser_automation',
      '0106_browser_backend_state',
      '0107_browser_sessions',
      '0108_scope_grant_browser_actions',
      '0109_local_directory_access',
      '0110_computer_control_state_privileges',
      '0111_assist_session_last_message',
      '0112_local_directory_full_access',
      '0113_assist_session_fork',
    ]);
  assert.equal(payload.ledger_rows, 113);
});

test('migrate entry fails explicitly without a migration connection', async () => {
  const child = spawn(process.execPath, [MIGRATE_ENTRY], {
    cwd: apiRoot,
    env: { ...process.env, RELAY_DB_URL: APP_DATABASE_URL, RELAY_MIGRATION_DB_URL: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolveCode) => {
    child.on('close', resolveCode);
  });

  assert.equal(code, 2);
  assert.match(stderr, /RELAY_MIGRATION_DB_URL is required/u);
});

test('init-workspace entry creates the workspace with its authority row and replays retries', async () => {
  const workspaceId = randomUUID();
  const commandId = randomUUID();
  const args = ['--name', 'cli-integration-workspace', '--workspace-id', workspaceId, '--command-id', commandId];

  const created = await runCli(INIT_WORKSPACE_ENTRY, args);

  assert.equal(created.code, 0, created.stderr);
  const createdPayload = JSON.parse(created.stdout) as {
    replayed: boolean;
    result: { workspace_id: string; workspace_revision: string; authority_revision: string };
  };

  assert.equal(createdPayload.replayed, false);
  assert.equal(createdPayload.result.workspace_id, workspaceId);
  assert.equal(createdPayload.result.authority_revision, '0');

  const replayed = await runCli(INIT_WORKSPACE_ENTRY, args);

  assert.equal(replayed.code, 0, replayed.stderr);
  const replayedPayload = JSON.parse(replayed.stdout) as {
    replayed: boolean;
    result: { workspace_id: string };
  };

  assert.equal(replayedPayload.replayed, true);
  assert.deepEqual(replayedPayload.result, createdPayload.result);

  const workspaces = await sql<{ count: bigint }>`
    select count(*) as count from workspaces where id = ${workspaceId}
  `.execute(app.db);

  assert.equal(workspaces.rows[0]?.count, 1n);

  const authority = await sql<{ count: bigint }>`
    select count(*) as count from workspace_execution_authority where workspace_id = ${workspaceId}
  `.execute(app.db);

  assert.equal(authority.rows[0]?.count, 1n);

  const activities = await sql<{ count: bigint }>`
    select count(*) as count from activity_records where command_id = ${commandId}
  `.execute(app.db);

  assert.equal(activities.rows[0]?.count, 1n);
});

test('init-workspace entry refuses a retry that reuses command_id with a new target', async () => {
  const result = await runCli(INIT_WORKSPACE_ENTRY, [
    '--name',
    'cli-integration-workspace',
    '--command-id',
    randomUUID(),
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--command-id requires --workspace-id/u);
});

test('init-workspace entry requires a name', async () => {
  const result = await runCli(INIT_WORKSPACE_ENTRY, []);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /RELAY_WORKSPACE_NAME is required/u);
});

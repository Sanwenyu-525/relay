import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';
import { Client } from 'pg';

import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep, type AdvanceRunStepResult } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import type { CriterionMethod } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { buildCheckPlan, checkPlanHash, planFromFrozenSnapshot } from '../../src/workflow/check-plan.js';
import type { FakeScenario } from '../../src/workflow/context-fixture.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import { createDataRoot } from './api-harness.js';

/**
 * P06：Verification 与完成 Gate 的真实 PostgreSQL 验收（内部应用端口 advanceRunStep）。
 *
 * 覆盖 C01、C04–C07、D04–D06 的自动路径：VERIFY 总决策 PASS/RETRY/HUMAN/RETRY_CHECKER、
 * 修正回路（同一 Artifact 的新版本）、自动完成短事务、完成 Gate 的前置核对与整笔回滚。
 * 全部使用真实数据库与真实受管内容存储，不使用 Mock DB。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p06-verification');

let storageRoot: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  storageRoot = await createDataRoot();
});

after(async () => {
  await dropCompletionFailureTrigger();
  await app.close();
});

interface CriterionSpec {
  readonly criterionId: string;
  readonly statement: string;
  readonly required: boolean;
  readonly method: CriterionMethod;
  readonly targetSpec?: JsonObject;
}

interface RunFixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly storage: ManagedContentStore;
  readonly workerId: string;
}

let fixtureCounter = 0;

async function setupDelegatedRun(criteria: readonly CriterionSpec[]): Promise<RunFixture> {
  fixtureCounter += 1;

  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const projectId = randomUUID();

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `p06-ws-${fixtureCounter}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({
      id: projectId,
      workspaceId,
      title: `p06-project-${fixtureCounter}`,
      projectType: 'GENERAL',
    });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({
      id: taskId,
      workspaceId,
      projectId,
      title: `p06-task-${fixtureCounter}`,
      status: 'READY',
      mode: 'ME',
      acceptanceRevision: 1n,
      executorKind: 'HUMAN',
      ownershipEpoch: 0n,
      currentCompletionId: null,
    });
    await repositories.tasks.insertAcceptanceVersion({
      taskId,
      acceptanceRevision: 1n,
      objective: '完成 P06 验证与自动完成闭环',
      requiredOutputSpec: {},
      source: 'CREATE',
    });

    for (const criterion of criteria) {
      await repositories.tasks.insertCriterion({
        taskId,
        acceptanceRevision: 1n,
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        required: criterion.required,
        method: criterion.method,
        targetSpec: criterion.targetSpec ?? {},
      });
    }
  });

  const outcome = await delegateTask(app.db, {
    workspaceId,
    taskId,
    commandId: randomUUID(),
    expectedTaskRevision: '0',
  });

  return {
    workspaceId,
    projectId,
    taskId,
    runId: outcome.result.run_id,
    storage: new ManagedContentStore(storageRoot),
    workerId: `worker-${fixtureCounter}`,
  };
}

async function advance(
  fixture: RunFixture,
  fakeScenario?: FakeScenario,
): Promise<AdvanceRunStepResult> {
  return advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
    ...(fakeScenario === undefined ? {} : { fakeScenario }),
  });
}

/** 装配上下文 → 起草 → 落盘候选：Run 停在 VERIFYING，等待验证。 */
async function advanceToVerifying(fixture: RunFixture, fakeScenario?: FakeScenario): Promise<void> {
  for (const expected of ['BUILD_CONTEXT', 'DRAFT', 'PERSIST_CANDIDATE'] as const) {
    const result = await advance(fixture, fakeScenario);

    assert.equal(result.status, 'STEP_SUCCEEDED', `expected ${expected}: ${JSON.stringify(result)}`);
  }

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'VERIFYING');
}

async function readRun(runId: string): Promise<{
  status: string;
  terminal_at: Date | null;
  current_step_id: string | null;
}> {
  const result = await sql<{ status: string; terminal_at: Date | null; current_step_id: string | null }>`
    select status, terminal_at, current_step_id from runs where id = ${runId}
  `.execute(app.db);

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('run not found');
  }

  return row;
}

async function readTask(taskId: string): Promise<{
  status: string;
  mode: string;
  executor_kind: string;
  executor_run_id: string | null;
  ownership_epoch: bigint;
  current_completion_id: string | null;
  acceptance_revision: bigint;
  revision: bigint;
}> {
  const result = await sql<{
    status: string;
    mode: string;
    executor_kind: string;
    executor_run_id: string | null;
    ownership_epoch: bigint;
    current_completion_id: string | null;
    acceptance_revision: bigint;
    revision: bigint;
  }>`
    select status, mode, executor_kind, executor_run_id, ownership_epoch, current_completion_id,
           acceptance_revision, revision
    from tasks where id = ${taskId}
  `.execute(app.db);

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('task not found');
  }

  return row;
}

interface SessionRow {
  readonly id: string;
  readonly status: string;
  readonly verdict: string | null;
  readonly correction_budget_used: bigint;
  readonly check_plan: { readonly entries: readonly { readonly criterion_id: string; readonly required: boolean }[] };
  readonly check_plan_hash: Buffer;
  readonly revision: bigint;
}

async function listSessions(runId: string): Promise<readonly SessionRow[]> {
  const result = await sql<SessionRow>`
    select id, status, verdict, correction_budget_used, check_plan, check_plan_hash, revision
    from verification_sessions
    where run_id = ${runId}
    order by created_at, id
  `.execute(app.db);

  return result.rows;
}

async function latestSession(runId: string): Promise<SessionRow> {
  const sessions = await listSessions(runId);
  const last = sessions.at(-1);

  if (last === undefined) {
    throw new Error('no verification session for this run');
  }

  return last;
}

async function listCheckResults(
  sessionId: string,
): Promise<readonly { readonly criterion_id: string; readonly check_attempt: number; readonly result: string; readonly required: boolean; readonly severity: string }[]> {
  const result = await sql<{
    criterion_id: string;
    check_attempt: number;
    result: string;
    required: boolean;
    severity: string;
  }>`
    select criterion_id, check_attempt, result, required, severity
    from check_results where session_id = ${sessionId}
    order by criterion_id, check_attempt
  `.execute(app.db);

  return result.rows;
}

async function listSteps(
  runId: string,
): Promise<readonly { readonly id: string; readonly step_kind: string; readonly status: string }[]> {
  const result = await sql<{ id: string; step_kind: string; status: string }>`
    select id, step_kind, status from run_steps where run_id = ${runId} order by step_index
  `.execute(app.db);

  return result.rows;
}

async function stepId(runId: string, stepKind: string): Promise<string> {
  const step = (await listSteps(runId)).find((candidate) => candidate.step_kind === stepKind);

  if (step === undefined) {
    throw new Error(`step ${stepKind} not found`);
  }

  return step.id;
}

async function countArtifactVersions(taskId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count
    from artifact_versions v
    join artifacts a on a.id = v.artifact_id
    where a.task_id = ${taskId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function listArtifactVersions(taskId: string): Promise<readonly {
  readonly artifact_id: string;
  readonly id: string;
  readonly version_number: bigint;
  readonly source_ref: string | null;
}[]> {
  const result = await sql<{
    artifact_id: string;
    id: string;
    version_number: bigint;
    source_ref: string | null;
  }>`
    select v.artifact_id, v.id, v.version_number, v.source_ref
    from artifact_versions v
    join artifacts a on a.id = v.artifact_id
    where a.task_id = ${taskId}
    order by v.version_number
  `.execute(app.db);

  return result.rows;
}

async function countCompletionRecords(taskId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from completion_records where task_id = ${taskId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countStateCompletionRefs(projectId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from state_completion_refs where project_id = ${projectId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countCompletionActivities(taskId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count
    from activity_records
    where task_id = ${taskId} and event_type = 'TASK_COMPLETED'
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countManifests(runId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from context_manifests where run_id = ${runId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countAttempts(stepIdValue: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from step_attempts where step_id = ${stepIdValue}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function expectStepSucceeded(
  result: AdvanceRunStepResult,
  stepKind: string,
): Promise<Extract<AdvanceRunStepResult, { readonly status: 'STEP_SUCCEEDED' }>> {
  assert.equal(result.status, 'STEP_SUCCEEDED', JSON.stringify(result));

  if (result.status !== 'STEP_SUCCEEDED') {
    throw new Error(`expected STEP_SUCCEEDED: ${JSON.stringify(result)}`);
  }

  assert.equal(result.step_kind, stepKind);

  return result;
}

/**
 * 用迁移角色执行 DDL/越权写入：故障注入与“Worker 越权删减基准”都用它，
 * 应用角色没有 acceptance_criteria 的 DELETE 权限，因此删减只能在测试侧模拟。
 */
async function withMigrationClient(work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({
    connectionString: MIGRATION_DATABASE_URL,
    application_name: 'relay-api-test-p06-migrator',
  });

  await client.connect();

  try {
    await work(client);
  } finally {
    await client.end();
  }
}

/** 用迁移角色注入一次性失败触发器：让自动完成事务在写入完成凭据时中断。 */
async function createCompletionFailureTrigger(taskId: string): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query(`create or replace function relay_test_fail_completion_records() returns trigger
      language plpgsql as $$
      begin
        if new.task_id = '${taskId}'::uuid then
          raise exception 'injected failure: completion_records is blocked for this task';
        end if;
        return new;
      end;
      $$`);
    await client.query('drop trigger if exists trg_relay_test_fail_completion on completion_records');
    await client.query(`create trigger trg_relay_test_fail_completion before insert on completion_records
      for each row execute function relay_test_fail_completion_records()`);
  });
}

async function dropCompletionFailureTrigger(): Promise<void> {
  await withMigrationClient(async (client) => {
    await client.query('drop trigger if exists trg_relay_test_fail_completion on completion_records');
    await client.query('drop function if exists relay_test_fail_completion_records()');
  });
}

/* -------------------------------------------------------------------------- */
/* 自动完成闭环                                                                */
/* -------------------------------------------------------------------------- */

test('verifies deterministically and completes the task in one short transaction', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);

  const verified = await expectStepSucceeded(await advance(fixture), 'VERIFY');

  assert.equal(verified.run_status, 'VERIFYING');

  const session = await latestSession(fixture.runId);

  assert.equal(session.status, 'PASS');
  assert.equal(session.verdict, 'PASS');
  assert.equal(session.correction_budget_used, 0n);

  const completed = await expectStepSucceeded(await advance(fixture), 'COMPLETE');

  assert.equal(completed.run_status, 'COMPLETED');

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'COMPLETED');
  assert.notEqual(run.terminal_at, null);

  const task = await readTask(fixture.taskId);

  assert.equal(task.status, 'DONE');
  assert.notEqual(task.current_completion_id, null);
  assert.equal(task.executor_kind, 'HUMAN');
  assert.equal(task.executor_run_id, null);
  // 完成保留当次 mode 供展示（runtime-context 第 5 节）；执行权释放再次递增 epoch。
  assert.equal(task.mode, 'DELEGATE_AI');
  assert.equal(task.ownership_epoch, 2n);

  const completions = await sql<{
    id: string;
    basis_kind: string;
    human_acceptance_id: string | null;
    verification_session_id: string | null;
    run_id: string | null;
  }>`
    select id, basis_kind, human_acceptance_id, verification_session_id, run_id
    from completion_records where task_id = ${fixture.taskId}
  `.execute(app.db);

  assert.equal(completions.rows.length, 1);
  assert.equal(completions.rows[0]?.basis_kind, 'AUTO');
  assert.equal(completions.rows[0]?.human_acceptance_id, null);
  assert.equal(completions.rows[0]?.verification_session_id, session.id);
  assert.equal(completions.rows[0]?.run_id, fixture.runId);
  assert.equal(completions.rows[0]?.id, task.current_completion_id);
  assert.equal(await countStateCompletionRefs(fixture.projectId), 1n);

  const activities = await sql<{ actor_kind: string; actor_ref: string; command_id: string | null }>`
    select actor_kind, actor_ref, command_id from activity_records
    where task_id = ${fixture.taskId} and event_type = 'TASK_COMPLETED'
  `.execute(app.db);

  assert.equal(activities.rows.length, 1);
  assert.equal(activities.rows[0]?.actor_kind, 'AI');
  assert.equal(activities.rows[0]?.actor_ref, `run:${fixture.runId}`);
  assert.equal(activities.rows[0]?.command_id, null);
});

/* -------------------------------------------------------------------------- */
/* C05：引用存在不等于论断被支持                                                */
/* -------------------------------------------------------------------------- */

test('C05: an existing citation cannot cover an unsupported claim', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-cite', statement: '引用标识存在', required: true, method: 'CITATION_EXISTS' },
    { criterionId: 'c-semantic', statement: '论断被来源支持', required: true, method: 'SEMANTIC' },
  ]);

  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');

  const verified = await advance(fixture, 'SEMANTIC_UNSUPPORTED');

  assert.equal(verified.status, 'CORRECTION_SCHEDULED', JSON.stringify(verified));

  const session = await latestSession(fixture.runId);

  assert.equal(session.status, 'RETRY');
  assert.notEqual(session.verdict, 'PASS');

  const results = await listCheckResults(session.id);

  assert.deepEqual(
    results.map((row) => [row.criterion_id, row.result]),
    [
      ['c-cite', 'PASS'],
      ['c-semantic', 'FAIL'],
    ],
  );
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
});

/* -------------------------------------------------------------------------- */
/* C06：检查器故障                                                             */
/* -------------------------------------------------------------------------- */

test('C06: a checker ERROR retries the check without new evidence and then stays unresolved', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture, 'CHECKER_ERROR');

  const versionsBefore = await countArtifactVersions(fixture.taskId);

  assert.equal(versionsBefore, 1n);
  assert.equal((await listSessions(fixture.runId)).length, 0);

  const retryable = await advance(fixture, 'CHECKER_ERROR');

  assert.equal(retryable.status, 'RETRYABLE', JSON.stringify(retryable));

  // 不 finalize、不新建产物版本、只新建一份仍未决的 session：只重跑检查器。
  assert.equal(await countArtifactVersions(fixture.taskId), versionsBefore);
  assert.equal((await listSessions(fixture.runId)).length, 1);
  assert.equal((await latestSession(fixture.runId)).status, 'OPEN');

  const second = await expectStepSucceeded(await advance(fixture, 'CHECKER_ERROR'), 'VERIFY');

  assert.equal(second.run_status, 'WAITING_APPROVAL');

  const session = await latestSession(fixture.runId);

  assert.equal(session.status, 'HUMAN');
  assert.notEqual(session.status, 'PASS');
  assert.equal(await countArtifactVersions(fixture.taskId), versionsBefore);

  const results = await listCheckResults(session.id);

  assert.deepEqual(
    results.map((row) => [row.criterion_id, row.check_attempt, row.result]),
    [
      ['c1', 1, 'ERROR'],
      ['c1', 2, 'ERROR'],
    ],
  );
});

/* -------------------------------------------------------------------------- */
/* C07：两条边界                                                               */
/* -------------------------------------------------------------------------- */

test('C07: a required PREFERENCE failure does not block PASS', async () => {
  const fixture = await setupDelegatedRun([
    {
      criterionId: 'c-preference',
      statement: '措辞偏好',
      required: true,
      method: 'SEMANTIC',
      targetSpec: { severity: 'PREFERENCE' },
    },
  ]);

  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');

  const verified = await expectStepSucceeded(await advance(fixture, 'SEMANTIC_UNSUPPORTED'), 'VERIFY');

  assert.equal(verified.run_status, 'VERIFYING');

  const session = await latestSession(fixture.runId);

  assert.equal(session.status, 'PASS');

  const results = await listCheckResults(session.id);

  assert.deepEqual(
    results.map((row) => [row.criterion_id, row.result, row.severity]),
    [['c-preference', 'FAIL', 'PREFERENCE']],
  );
});

test('C07: a required HARD failure is not covered by a passing semantic check', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-hard', statement: '引用标识存在', required: true, method: 'CITATION_EXISTS' },
    { criterionId: 'c-semantic', statement: '论断被来源支持', required: true, method: 'SEMANTIC' },
  ]);

  await advanceToVerifying(fixture, 'NO_CITATION');

  const verified = await advance(fixture, 'NO_CITATION');

  assert.equal(verified.status, 'CORRECTION_SCHEDULED', JSON.stringify(verified));

  const session = await latestSession(fixture.runId);

  assert.notEqual(session.status, 'PASS');

  const results = await listCheckResults(session.id);

  assert.deepEqual(
    results.map((row) => [row.criterion_id, row.result, row.severity]),
    [
      ['c-hard', 'FAIL', 'HARD'],
      ['c-semantic', 'PASS', 'HARD'],
    ],
  );
});

/* -------------------------------------------------------------------------- */
/* 修正回路与预算                                                              */
/* -------------------------------------------------------------------------- */

test('schedules a correction round that adds a new version of the same artifact', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-cite', statement: '引用标识存在', required: true, method: 'CITATION_EXISTS' },
  ]);

  await advanceToVerifying(fixture, 'CITATION_MISSING_ONCE');

  const corrected = await advance(fixture, 'CITATION_MISSING_ONCE');

  assert.equal(corrected.status, 'CORRECTION_SCHEDULED', JSON.stringify(corrected));

  if (corrected.status !== 'CORRECTION_SCHEDULED') {
    throw new Error('expected CORRECTION_SCHEDULED');
  }

  assert.equal(corrected.run_status, 'RETRYING');
  assert.equal(corrected.correction_round, '1');

  const firstSession = await latestSession(fixture.runId);

  assert.equal(firstSession.status, 'RETRY');
  assert.equal(firstSession.correction_budget_used, 1n);
  assert.equal(corrected.session_id, firstSession.id);

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'RETRYING');
  assert.equal(run.current_step_id, await stepId(fixture.runId, 'BUILD_CONTEXT'));

  // 四个步骤回到 PENDING（不新建步骤行、不让步骤计划增长）。
  assert.deepEqual(
    (await listSteps(fixture.runId)).map((step) => `${step.step_kind}:${step.status}`),
    [
      'BUILD_CONTEXT:PENDING',
      'DRAFT:PENDING',
      'PERSIST_CANDIDATE:PENDING',
      'VERIFY:PENDING',
      'COMPLETE:PENDING',
    ],
  );

  const historyBefore = await listCheckResults(firstSession.id);

  assert.deepEqual(
    historyBefore.map((row) => row.result),
    ['FAIL'],
  );

  // 第二轮：装配上下文（带上一轮失败证据）→ 起草 → 落盘新版本 → 验证。
  await advanceToVerifying(fixture, 'CITATION_MISSING_ONCE');
  const verified = await expectStepSucceeded(await advance(fixture, 'CITATION_MISSING_ONCE'), 'VERIFY');

  assert.equal(verified.run_status, 'VERIFYING');

  const versions = await listArtifactVersions(fixture.taskId);

  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.artifact_id, versions[1]?.artifact_id);
  assert.equal(versions[1]?.version_number, 2n);
  assert.equal(versions[0]?.source_ref, `run:${fixture.runId}/step:PERSIST_CANDIDATE`);
  assert.equal(versions[1]?.source_ref, `run:${fixture.runId}/step:PERSIST_CANDIDATE/round:1`);

  // 每一轮都有独立的不可变 Manifest，修正轮带上失败证据。
  assert.equal(await countManifests(fixture.runId), 2n);

  const manifests = await sql<{ payload: { readonly correction?: { readonly round: number; readonly failures: readonly { readonly criterion_id: string }[] } } }>`
    select payload from context_manifests where run_id = ${fixture.runId} order by created_at, id
  `.execute(app.db);

  assert.equal(manifests.rows[0]?.payload.correction, undefined);
  assert.equal(manifests.rows[1]?.payload.correction?.round, 1);
  assert.deepEqual(
    manifests.rows[1]?.payload.correction?.failures.map((failure) => failure.criterion_id),
    ['c-cite'],
  );

  const sessions = await listSessions(fixture.runId);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[1]?.status, 'PASS');

  // 历史证据不被改写：旧 session 仍是 RETRY，旧结果行原样保留。
  assert.deepEqual(await listCheckResults(firstSession.id), historyBefore);
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);

  const completed = await expectStepSucceeded(await advance(fixture, 'CITATION_MISSING_ONCE'), 'COMPLETE');

  assert.equal(completed.run_status, 'COMPLETED');
  assert.equal((await readTask(fixture.taskId)).status, 'DONE');
});

test('exhausting the correction budget stops at HUMAN and blocks completion', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-semantic', statement: '论断被来源支持', required: true, method: 'SEMANTIC' },
  ]);

  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');

  for (const expectedRound of [1n, 2n]) {
    const corrected = await advance(fixture, 'SEMANTIC_UNSUPPORTED');

    assert.equal(corrected.status, 'CORRECTION_SCHEDULED', JSON.stringify(corrected));

    const session = await latestSession(fixture.runId);

    assert.equal(session.status, 'RETRY');
    assert.equal(session.correction_budget_used, expectedRound);

    await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');
  }

  const third = await expectStepSucceeded(await advance(fixture, 'SEMANTIC_UNSUPPORTED'), 'VERIFY');

  assert.equal(third.run_status, 'WAITING_APPROVAL');

  const sessions = await listSessions(fixture.runId);

  assert.equal(sessions.length, 3);
  assert.equal(sessions[2]?.status, 'HUMAN');
  assert.equal(sessions[2]?.correction_budget_used, 2n);

  const blocked = await advance(fixture, 'SEMANTIC_UNSUPPORTED');

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

  if (blocked.status !== 'COMPLETION_BLOCKED') {
    throw new Error('expected COMPLETION_BLOCKED');
  }

  assert.equal(blocked.reason, 'VERIFICATION_NOT_PASSED');
  assert.equal(blocked.run_status, 'WAITING_APPROVAL');
  assert.equal((await readTask(fixture.taskId)).status, 'IN_PROGRESS');
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
});

/* -------------------------------------------------------------------------- */
/* C04 / C01 / 撤销适用性 / 基准删减                                            */
/* -------------------------------------------------------------------------- */

test('C04: a required human criterion keeps the run out of COMPLETED', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-human', statement: '人工核对摘要与引用', required: true, method: 'HUMAN' },
  ]);

  await advanceToVerifying(fixture);

  const verified = await expectStepSucceeded(await advance(fixture), 'VERIFY');

  assert.equal(verified.run_status, 'WAITING_APPROVAL');
  assert.equal((await latestSession(fixture.runId)).status, 'HUMAN');

  const blocked = await advance(fixture);

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

  // 完成前置不满足：步骤保持 PENDING、Run 不变、不抛错。
  assert.equal(
    (await listSteps(fixture.runId)).find((step) => step.step_kind === 'COMPLETE')?.status,
    'PENDING',
  );
  assert.equal((await readRun(fixture.runId)).status, 'WAITING_APPROVAL');
  assert.equal((await readTask(fixture.taskId)).status, 'IN_PROGRESS');
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
});

test('C01: an acceptance change after PASS blocks completion of the old verification', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  assert.equal((await latestSession(fixture.runId)).status, 'PASS');

  // 验收契约变化：新建 acceptance_revision 并把 Task 指向它（与 Reopen 等价的写入）。
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.insertAcceptanceVersion({
      taskId: fixture.taskId,
      acceptanceRevision: 2n,
      objective: '完成 P06 验证与自动完成闭环（新周期）',
      requiredOutputSpec: {},
      source: 'CONTRACT_CHANGE',
    });
    await repositories.tasks.insertCriterion({
      taskId: fixture.taskId,
      acceptanceRevision: 2n,
      criterionId: 'c1',
      statement: '必需节与结构完整',
      required: true,
      method: 'MARKDOWN_STRUCTURE',
      targetSpec: {},
    });
    await repositories.tasks.bumpTaskRevision(fixture.taskId);
  });

  await sql`
    update tasks set acceptance_revision = 2 where id = ${fixture.taskId}
  `.execute(app.db);

  const blocked = await advance(fixture);

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

  if (blocked.status !== 'COMPLETION_BLOCKED') {
    throw new Error('expected COMPLETION_BLOCKED');
  }

  assert.equal(blocked.reason, 'ACCEPTANCE_REVISION_CHANGED');
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
  assert.equal((await readTask(fixture.taskId)).status, 'IN_PROGRESS');
});

test('a revoked PASS blocks completion while keeping the original result rows', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  const session = await latestSession(fixture.runId);
  const resultsBefore = await listCheckResults(session.id);

  await withTransaction(app.db, async (repositories) => {
    await repositories.verifications.insertApplicabilityRevocation({
      sessionId: session.id,
      reason: '发现检查器缺陷，撤销该 PASS 的适用性',
      sourceRef: `verifier:${session.id}`,
    });
  });

  const blocked = await advance(fixture);

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

  if (blocked.status !== 'COMPLETION_BLOCKED') {
    throw new Error('expected COMPLETION_BLOCKED');
  }

  assert.equal(blocked.reason, 'VERIFICATION_REVOKED');
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);

  const after = await latestSession(fixture.runId);

  assert.equal(after.status, 'PASS');
  assert.deepEqual(await listCheckResults(session.id), resultsBefore);
});

test('deleting the required criterion after delegation cannot change the frozen plan', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c-required', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
    { criterionId: 'c-extra', statement: '另一项必需条件', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  // Worker 无权删减基准：删掉一条 required criterion 后，验证仍按冻结契约执行。
  await withMigrationClient(async (client) => {
    await client.query(
      `delete from acceptance_criteria
       where task_id = $1::uuid and acceptance_revision = 1 and criterion_id = 'c-required'`,
      [fixture.taskId],
    );
  });

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  const session = await latestSession(fixture.runId);
  const contract = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${fixture.runId}
  `.execute(app.db);
  const snapshot = contract.rows[0]?.frozen_snapshot;

  if (snapshot === undefined) {
    throw new Error('execution contract not found');
  }

  const expectedPlan = buildCheckPlan(planFromFrozenSnapshot(snapshot));

  assert.deepEqual(
    session.check_plan.entries.map((entry) => [entry.criterion_id, entry.required]),
    [
      ['c-extra', true],
      ['c-required', true],
    ],
  );
  assert.equal(session.check_plan_hash.equals(checkPlanHash(expectedPlan)), true);
  assert.equal(session.status, 'PASS');
});

/* -------------------------------------------------------------------------- */
/* D04 / D05 / D06                                                             */
/* -------------------------------------------------------------------------- */

test('D04: completing after PASS adds no new version, session or draft attempt', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  const versionsBefore = await countArtifactVersions(fixture.taskId);
  const sessionsBefore = (await listSessions(fixture.runId)).length;
  const draftAttemptsBefore = await countAttempts(await stepId(fixture.runId, 'DRAFT'));

  const completed = await expectStepSucceeded(await advance(fixture), 'COMPLETE');

  assert.equal(completed.run_status, 'COMPLETED');
  assert.equal(await countArtifactVersions(fixture.taskId), versionsBefore);
  assert.equal((await listSessions(fixture.runId)).length, sessionsBefore);
  assert.equal(await countAttempts(await stepId(fixture.runId, 'DRAFT')), draftAttemptsBefore);
  assert.equal(await countCompletionRecords(fixture.taskId), 1n);
});

test('D05: a failing completion transaction rolls back as a whole and converges on retry', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  await createCompletionFailureTrigger(fixture.taskId);

  try {
    await assert.rejects(async () => {
      await advance(fixture);
    });
  } finally {
    await dropCompletionFailureTrigger();
  }

  const taskAfterFailure = await readTask(fixture.taskId);

  assert.equal(taskAfterFailure.status, 'IN_PROGRESS');
  assert.equal(taskAfterFailure.current_completion_id, null);
  assert.equal(taskAfterFailure.executor_run_id, fixture.runId);
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
  assert.equal(await countStateCompletionRefs(fixture.projectId), 0n);
  assert.equal(await countCompletionActivities(fixture.taskId), 0n);
  assert.equal((await readRun(fixture.runId)).status, 'VERIFYING');

  // 触发器移除后重试：只产生一份完成事实。
  const completed = await expectStepSucceeded(await advance(fixture), 'COMPLETE');

  assert.equal(completed.run_status, 'COMPLETED');
  assert.equal(await countCompletionRecords(fixture.taskId), 1n);
  assert.equal(await countStateCompletionRefs(fixture.projectId), 1n);
  assert.equal(await countCompletionActivities(fixture.taskId), 1n);
});

test('D06: replaying an already completed run is terminal and writes nothing more', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ]);

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');
  await expectStepSucceeded(await advance(fixture), 'COMPLETE');

  const replay = await advance(fixture);

  assert.equal(replay.status, 'RUN_TERMINAL', JSON.stringify(replay));

  if (replay.status !== 'RUN_TERMINAL') {
    throw new Error('expected RUN_TERMINAL');
  }

  assert.equal(replay.run_status, 'COMPLETED');
  assert.equal(await countCompletionRecords(fixture.taskId), 1n);
  assert.equal(await countCompletionActivities(fixture.taskId), 1n);
  assert.equal(await countStateCompletionRefs(fixture.projectId), 1n);
});

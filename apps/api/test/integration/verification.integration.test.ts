import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';
import { Client } from 'pg';

import { delegateTask } from '../../src/application/delegate-task.js';
import { readCompletionEvidence } from '../../src/application/completion-evidence-queries.js';
import { resolveReview } from '../../src/application/review-decisions.js';
import { listInboxReviews, readReview } from '../../src/application/review-queries.js';
import { requestActionApproval, requestStateProposal } from '../../src/application/request-review.js';
import { advanceRunStep, type AdvanceRunStepResult } from '../../src/application/run-steps.js';
import { runStateCommand } from '../../src/application/state-commands.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import type { CriterionMethod, ModelCallRow } from '../../src/infrastructure/database-schema.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { buildCheckPlan, checkPlanHash, planFromFrozenSnapshot } from '../../src/workflow/check-plan.js';
import type { FakeScenario } from '../../src/workflow/context-fixture.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import { createDataRoot, startTestApi, workspacePath, expectCommandAccepted, expectProblem } from './api-harness.js';

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

async function setupDelegatedRun(
  criteria: readonly CriterionSpec[],
  expectedOutputs: JsonObject = {},
): Promise<RunFixture> {
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
      requiredOutputSpec: expectedOutputs,
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

/**
 * 模拟已在旧版本中合法冻结、但新版本已无法支持的要求；同步重算 contract_hash，避免
 * 把摘要失配误当作 Gate 行为。
 */
async function replaceFrozenExpectedOutputs(runId: string, expectedOutputs: JsonObject): Promise<void> {
  const contract = await sql<{ frozen_snapshot: JsonObject }>`
    select frozen_snapshot from execution_contracts where run_id = ${runId}
  `.execute(app.db);
  const frozenSnapshot = contract.rows[0]?.frozen_snapshot;

  if (frozenSnapshot === undefined) {
    throw new Error('execution contract not found');
  }

  const updatedSnapshot: JsonObject = { ...frozenSnapshot, expected_outputs: expectedOutputs };
  const contractHash = createHash('sha256').update(canonicalizeJson(updatedSnapshot), 'utf8').digest();

  await withMigrationClient(async (client) => {
    await client.query(
      `update execution_contracts
       set frozen_snapshot = $2::jsonb, contract_hash = $3
       where run_id = $1::uuid`,
      [runId, JSON.stringify(updatedSnapshot), contractHash],
    );
  });
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
  ], { artifacts: ['MARKDOWN_DOCUMENT'] });

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
  const evidence = await readCompletionEvidence(app.db, fixture.storage,
    fixture.workspaceId, completions.rows[0]!.id);
  assert.equal(evidence.basis_kind, 'AUTO');
  assert.equal(evidence.is_current, true);
  assert.equal(evidence.human_acceptance, null);
  assert.equal(evidence.acceptance.availability, 'AVAILABLE');
  assert.equal(evidence.verification_session?.availability, 'AVAILABLE');
  assert.equal(evidence.verification_session?.id, session.id);
  assert.equal(evidence.verification_session?.run_id, fixture.runId);
  assert.equal(evidence.verification_session?.verdict, 'PASS');
  assert.equal(evidence.verification_session?.applicable, true);
  assert.equal(evidence.artifact_versions.length, 1);
  assert.equal(evidence.artifact_versions[0]?.availability, 'AVAILABLE');
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

test('completion gate rejects unsupported or malformed frozen output requirements without writing completion facts', async () => {
  for (const expectedOutputs of [
    { artifacts: ['MARKDOWN_DOCUMENT', 'TEST_REPORT'] },
    { artifacts: 'MARKDOWN_DOCUMENT' },
  ] satisfies readonly JsonObject[]) {
    const fixture = await setupDelegatedRun([
      { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
    ], { artifacts: ['MARKDOWN_DOCUMENT'] });

    await replaceFrozenExpectedOutputs(fixture.runId, expectedOutputs);

    await advanceToVerifying(fixture);
    await expectStepSucceeded(await advance(fixture), 'VERIFY');

    const completeStepId = await stepId(fixture.runId, 'COMPLETE');
    const attemptsBefore = await countAttempts(completeStepId);
    const blocked = await advance(fixture);

    assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

    if (blocked.status !== 'COMPLETION_BLOCKED') {
      throw new Error('expected COMPLETION_BLOCKED');
    }

    assert.equal(blocked.reason, 'DECLARED_OUTPUTS_UNSATISFIED');
    assert.equal(await countAttempts(completeStepId), attemptsBefore);
    assert.equal(await countCompletionRecords(fixture.taskId), 0n);
    assert.equal(await countStateCompletionRefs(fixture.projectId), 0n);
    assert.equal(await countCompletionActivities(fixture.taskId), 0n);
    assert.equal((await readTask(fixture.taskId)).status, 'IN_PROGRESS');
    assert.equal((await readRun(fixture.runId)).status, 'VERIFYING');
  }
});

test('completion gate rejects a PASS whose exact verification targets do not cover the frozen Markdown requirement', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'c1', statement: '必需节与结构完整', required: true, method: 'MARKDOWN_STRUCTURE' },
  ], { artifacts: ['MARKDOWN_DOCUMENT'] });

  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');

  const session = await latestSession(fixture.runId);

  await withMigrationClient(async (client) => {
    await client.query('delete from verification_targets where session_id = $1::uuid', [session.id]);
  });

  const completeStepId = await stepId(fixture.runId, 'COMPLETE');
  const blocked = await advance(fixture);

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));

  if (blocked.status !== 'COMPLETION_BLOCKED') {
    throw new Error('expected COMPLETION_BLOCKED');
  }

  assert.equal(blocked.reason, 'DECLARED_OUTPUTS_UNSATISFIED');
  assert.equal(await countAttempts(completeStepId), 0n);
  assert.equal(await countCompletionRecords(fixture.taskId), 0n);
  assert.equal(await countStateCompletionRefs(fixture.projectId), 0n);
  assert.equal(await countCompletionActivities(fixture.taskId), 0n);
  assert.equal((await readTask(fixture.taskId)).status, 'IN_PROGRESS');
  assert.equal((await readRun(fixture.runId)).status, 'VERIFYING');
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
  const calls = (await sql<ModelCallRow>`select mc.* from model_calls mc
    join step_attempts a on a.id = mc.step_attempt_id
    join run_steps s on s.id = a.step_id
    where s.run_id = ${fixture.runId} order by mc.started_at, mc.id`.execute(app.db)).rows;
  assert.deepEqual(calls.map((call) => call.kind), ['DRAFT', 'SEMANTIC_CHECK']);
  assert.ok(calls[0]!.manifest_id);
  assert.equal(calls[0]!.status, 'COMPLETED');
  assert.ok(calls[0]!.usage_input_tokens !== null && calls[0]!.usage_input_tokens > 0);
  assert.equal(calls[1]!.criterion_id, 'c-semantic');
  assert.equal(calls[1]!.check_attempt, 1);
  assert.equal(calls[1]!.status, 'COMPLETED');
  assert.equal(calls[1]!.usage_input_tokens, null, 'fake checker does not report usage');
  const semanticEvidence = (await sql<{ evidence_refs: { model_call_id?: string } }>`
    select evidence_refs from check_results where session_id = ${session.id}
      and criterion_id = 'c-semantic'`.execute(app.db)).rows[0]!.evidence_refs;
  assert.equal(semanticEvidence.model_call_id, calls[1]!.id);
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
  assert.equal((await readTask(fixture.taskId)).status, 'WAITING');
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
  assert.equal((await readTask(fixture.taskId)).status, 'WAITING');
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

test('P07 C04/C09: Review ACCEPT creates an immutable successor PASS and preserves AI ownership until completion', async () => {
  const fixture = await setupDelegatedRun([
    { criterionId: 'structure', statement: 'Markdown 结构合格', required: true, method: 'MARKDOWN_STRUCTURE' },
    { criterionId: 'human', statement: '人工确认结论', required: true, method: 'HUMAN' },
  ]);
  await advanceToVerifying(fixture);
  const verified = await expectStepSucceeded(await advance(fixture), 'VERIFY');
  assert.equal(verified.run_status, 'WAITING_APPROVAL');
  assert.equal((await advance(fixture)).status, 'COMPLETION_BLOCKED');

  const reviews = await listInboxReviews(app.db, fixture.workspaceId);
  assert.equal(reviews.items.length, 1);
  const review = reviews.items[0];
  assert.equal(review?.kind, 'CRITERION');
  assert.equal(review?.target.criterion_id, 'human');
  const commandId = randomUUID();
  const input = {
    workspaceId: fixture.workspaceId, reviewId: review!.id, commandId,
    expectedRevision: review!.revision, targetHash: review!.target_hash,
    decision: 'ACCEPT' as const,
  };
  const decided = await resolveReview(app.db, input);
  assert.equal(decided.replayed, false);
  assert.equal(decided.result.effect.verdict, 'PASS');
  assert.equal((await resolveReview(app.db, input)).replayed, true);
  const sessions = await listSessions(fixture.runId);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.status, 'HUMAN');
  assert.equal(sessions[1]?.status, 'PASS');
  const successor = await sql<{ parent_session_id: string }>`select parent_session_id from verification_sessions where id = ${sessions[1]!.id}`.execute(app.db);
  assert.equal(successor.rows[0]?.parent_session_id, sessions[0]?.id);
  const evidence = await sql<{ evidence_refs: JsonObject }>`select evidence_refs from check_results where session_id = ${sessions[1]!.id} and criterion_id = 'human'`.execute(app.db);
  assert.equal(evidence.rows[0]?.evidence_refs.review_decision_id, decided.result.decision_id);
  assert.equal((await readTask(fixture.taskId)).executor_run_id, fixture.runId);
  assert.equal((await readRun(fixture.runId)).status, 'VERIFYING');
  await expectStepSucceeded(await advance(fixture), 'COMPLETE');
  assert.equal((await readTask(fixture.taskId)).status, 'DONE');
});

test('P07 C02: a Review for the current candidate cannot authorize a later selected version', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'human', statement: '人工确认', required: true, method: 'HUMAN' }]);
  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  const originalId = review.target.artifact_version_id as string;
  await withTransaction(app.db, async (repositories) => {
    const original = await repositories.artifacts.readArtifactVersion(originalId);
    assert.ok(original);
    const newer = await repositories.artifacts.insertArtifactVersion({
      id: randomUUID(), artifactId: original.artifact_id, versionNumber: original.version_number + 1n,
      storageRef: original.storage_ref, contentHash: original.content_hash, size: original.size,
      mediaType: original.media_type, sourceKind: 'AI', sourceRef: `test:new-version:${randomUUID()}`,
    });
    const persist = await repositories.runs.readStepByKind(fixture.runId, 'PERSIST_CANDIDATE');
    assert.ok(persist);
    await sql`update run_steps set result_ref = jsonb_set(result_ref, '{artifact_version_id}', to_jsonb(${newer.id}::text)) where id = ${persist.id}`.execute(app.db);
  });
  await assert.rejects(resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash, decision: 'ACCEPT',
  }), (error: unknown) => (error as { code?: string }).code === 'INVALID_TRANSITION');
  assert.equal((await readReview(app.db, fixture.workspaceId, review.id)).status, 'EXPIRED');
  assert.equal((await listSessions(fixture.runId)).length, 1);
});

test('P07: REQUEST_CHANGES consumes one correction round and does not alter the old HUMAN session', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'human', statement: '人工确认', required: true, method: 'HUMAN' }]);
  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  const decided = await resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash,
    decision: 'REQUEST_CHANGES', feedback: '补充来源解释',
  });
  assert.equal(decided.result.effect.run_status, 'RETRYING');
  const sessions = await listSessions(fixture.runId);
  assert.deepEqual(sessions.map((session) => session.status), ['HUMAN', 'RETRY']);
  assert.equal((await readRun(fixture.runId)).status, 'RETRYING');
  await advanceToVerifying(fixture);
  assert.equal(await countArtifactVersions(fixture.taskId), 2n);
});

test('P07: a bounded budget decision persists and VERIFY reads the new cap', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'semantic', statement: '来源支持论断', required: true, method: 'SEMANTIC' }]);
  await withTransaction(app.db, async (repositories) => { await repositories.reviews.setCorrectionBudget(fixture.runId, 1n); });
  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');
  assert.equal((await advance(fixture, 'SEMANTIC_UNSUPPORTED')).status, 'CORRECTION_SCHEDULED');
  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');
  const human = await expectStepSucceeded(await advance(fixture, 'SEMANTIC_UNSUPPORTED'), 'VERIFY');
  assert.equal(human.run_status, 'WAITING_APPROVAL');
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  assert.equal(review.kind, 'RETRY_BUDGET');
  await assert.rejects(resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash,
    decision: 'SET_RETRY_BUDGET', retryBudget: 1,
  }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_FAILED');
  const decided = await resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash,
    decision: 'SET_RETRY_BUDGET', retryBudget: 3,
  });
  assert.equal(decided.result.effect.correction_budget, '3');
  const budget = await sql<{ max_corrections: bigint }>`select max_corrections from run_correction_budgets where run_id = ${fixture.runId}`.execute(app.db);
  assert.equal(budget.rows[0]?.max_corrections, 3n);
  assert.equal((await readRun(fixture.runId)).status, 'RETRYING');
  await advanceToVerifying(fixture, 'SEMANTIC_UNSUPPORTED');
  assert.equal((await advance(fixture, 'SEMANTIC_UNSUPPORTED')).status, 'CORRECTION_SCHEDULED');
});

test('P07 A02: State proposal accepts a typed command once and rejects a stale base revision', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'structure', statement: '结构', required: true, method: 'MARKDOWN_STRUCTURE' }]);
  const proposed = await requestStateProposal(app.db, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, commandId: randomUUID(),
    baseRevision: '0', action: 'SET_PHASE', params: { phase_key: 'EXECUTING' }, reason: '项目进入执行阶段',
  });
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  assert.equal(review.id, proposed.result.review_id);
  const accepted = await resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash, decision: 'ACCEPT',
  });
  assert.equal(accepted.result.effect.state_revision, '1');
  const phase = await sql<{ phase_key: string }>`select phase_key from project_states where project_id = ${fixture.projectId}`.execute(app.db);
  assert.equal(phase.rows[0]?.phase_key, 'EXECUTING');
  const stale = await requestStateProposal(app.db, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, commandId: randomUUID(),
    baseRevision: '1', action: 'SET_PHASE', params: { phase_key: 'REVIEW' }, reason: '待检查',
  });
  await runStateCommand(app.db, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, commandId: randomUUID(),
    expectedRevision: '1', action: 'SET_PHASE', params: { phase_key: 'PLANNING' },
  });
  const staleReview = await readReview(app.db, fixture.workspaceId, stale.result.review_id);
  assert.equal(staleReview.status, 'EXPIRED');
  await assert.rejects(resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: staleReview.id, commandId: randomUUID(),
    expectedRevision: staleReview.revision, targetHash: staleReview.target_hash, decision: 'ACCEPT',
  }), (error: unknown) => (error as { code?: string }).code === 'REVISION_CONFLICT');
});

test('P07 A02: State proposal and typed State command serialize the same Task and State revision', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'structure', statement: '结构', required: true, method: 'MARKDOWN_STRUCTURE' }]);
  const proposed = await requestStateProposal(app.db, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, commandId: randomUUID(),
    baseRevision: '0', action: 'SET_NEXT_ACTION', params: { next_action_task_id: fixture.taskId }, reason: '建议下一步',
  });
  const review = await readReview(app.db, fixture.workspaceId, proposed.result.review_id);
  const outcomes = await Promise.allSettled([
    resolveReview(app.db, {
      workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
      expectedRevision: review.revision, targetHash: review.target_hash, decision: 'ACCEPT',
    }),
    runStateCommand(app.db, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, commandId: randomUUID(),
      expectedRevision: '0', action: 'SET_NEXT_ACTION', params: { next_action_task_id: fixture.taskId },
    }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') assert.equal((outcome.reason as { code?: string }).code, 'REVISION_CONFLICT');
  }
  const state = await sql<{ revision: bigint; next_action_task_id: string }>`
    select revision, next_action_task_id from project_states where project_id = ${fixture.projectId}
  `.execute(app.db);
  assert.equal(state.rows[0]?.revision, 1n);
  assert.equal(state.rows[0]?.next_action_task_id, fixture.taskId);
});

test('P07 C09: denied operation approval keeps the operation identity and does not dispatch a step', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'structure', statement: '结构', required: true, method: 'MARKDOWN_STRUCTURE' }]);
  await expectStepSucceeded(await advance(fixture), 'BUILD_CONTEXT');
  await expectStepSucceeded(await advance(fixture), 'DRAFT');
  const operationId = randomUUID();
  const step = await stepId(fixture.runId, 'PERSIST_CANDIDATE');
  const requested = await requestActionApproval(app.db, {
    workspaceId: fixture.workspaceId, runId: fixture.runId, stepId: step,
    operationId, actionType: 'TEST_OPERATION', normalizedTarget: 'example',
    paramsHash: 'a'.repeat(64), contentHash: null, reason: '需要用户批准',
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal((await advance(fixture)).status, 'WAITING_REVIEW');
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  assert.equal(review.id, requested.reviewId);
  await resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash, decision: 'DENY',
  });
  assert.equal((await advance(fixture)).status, 'WAITING_REVIEW');
  assert.equal((await readTask(fixture.taskId)).executor_run_id, fixture.runId);
  const attempts = await countAttempts(step);
  assert.equal(attempts, 0n);
});

test('P07 C09: approved reserved operation without a frozen Mock action queues no graph command', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'structure', statement: '结构', required: true,
    method: 'MARKDOWN_STRUCTURE' }]);
  await expectStepSucceeded(await advance(fixture), 'BUILD_CONTEXT');
  await expectStepSucceeded(await advance(fixture), 'DRAFT');
  const operationId = randomUUID();
  const step = await stepId(fixture.runId, 'PERSIST_CANDIDATE');
  const requested = await requestActionApproval(app.db, {
    workspaceId: fixture.workspaceId, runId: fixture.runId, stepId: step,
    operationId, actionType: 'TEST_OPERATION', normalizedTarget: 'example',
    paramsHash: 'a'.repeat(64), contentHash: null, reason: '需要用户批准',
    expiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal((await advance(fixture)).status, 'WAITING_REVIEW');
  const review = (await listInboxReviews(app.db, fixture.workspaceId)).items[0]!;
  assert.equal(review.id, requested.reviewId);
  const decided = await resolveReview(app.db, {
    workspaceId: fixture.workspaceId, reviewId: review.id, commandId: randomUUID(),
    expectedRevision: review.revision, targetHash: review.target_hash, decision: 'APPROVE',
  });
  assert.deepEqual(decided.result.effect, { action_authorized: true,
    operation_id: operationId, external_effect_executed: false });
  const facts = await sql<{ operation_rows: bigint; resume_commands: bigint }>`
    select (select count(*)::bigint from logical_operations where id = ${operationId}) as operation_rows,
      (select count(*)::bigint from run_commands where run_id = ${fixture.runId}
        and kind = 'RESUME') as resume_commands
  `.execute(app.db);
  assert.deepEqual(facts.rows[0], { operation_rows: 0n, resume_commands: 0n });
  assert.equal((await readRun(fixture.runId)).status, 'WAITING_APPROVAL');
  assert.equal(await countAttempts(step), 0n);
});

test('P07 HTTP: Inbox, detail and decision share the target hash and command receipt contract', async () => {
  const fixture = await setupDelegatedRun([{ criterionId: 'human', statement: '人工确认', required: true, method: 'HUMAN' }]);
  await advanceToVerifying(fixture);
  await expectStepSucceeded(await advance(fixture), 'VERIFY');
  const path = workspacePath(fixture.workspaceId, '/reviews');
  const firstApi = await startTestApi();
  let review: { id: string; revision: string; target_hash: string; kind: string };
  try {
    const listed = await firstApi.get(path);
    assert.equal(listed.status, 200, listed.text);
    review = (listed.body as { items: Array<typeof review> }).items[0]!;
    assert.equal(review.kind, 'CRITERION');
  } finally {
    await firstApi.stop();
  }

  // 重启 API 进程后仍可读取并决定同一份持久 Review。
  const api = await startTestApi();
  try {
    const detail = await api.get(`${path}/${review.id}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal((detail.body as { target_hash: string }).target_hash, review.target_hash);
    const runList = await api.get(workspacePath(fixture.workspaceId, `/runs/${fixture.runId}/reviews`));
    assert.equal(runList.status, 200, runList.text);
    assert.equal((runList.body as { items: Array<{ id: string }> }).items[0]?.id, review.id);
    const commandId = randomUUID();
    const body = { command_id: commandId, expected_revision: review.revision, target_hash: review.target_hash, decision: 'ACCEPT' };
    const accepted = await api.post(`${path}/${review.id}/decisions`, body);
    assert.equal((expectCommandAccepted(accepted, 200, commandId)).review_id, review.id);
    const replay = await api.post(`${path}/${review.id}/decisions`, body);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.headers['command-replayed'], 'true');
    const stale = await api.post(`${path}/${review.id}/decisions`, { ...body, command_id: randomUUID() });
    expectProblem(stale, 409, 'REVISION_CONFLICT');
    const hidden = await api.get(workspacePath(randomUUID(), `/reviews/${review.id}`));
    expectProblem(hidden, 404, 'RESOURCE_NOT_FOUND');
  } finally {
    await api.stop();
  }
});

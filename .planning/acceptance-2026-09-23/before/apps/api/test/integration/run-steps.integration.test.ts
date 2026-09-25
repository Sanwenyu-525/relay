import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep, recordStaleAttemptResult } from '../../src/application/run-steps.js';
import { withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import { createDataRoot } from './api-harness.js';

/**
 * P05：Run/Step/Attempt 的真实 PostgreSQL 验收（内部应用端口 advanceRunStep）。
 *
 * 覆盖固定 Fake 推进到 VERIFYING、步骤结果去重、SCHEMA_INVALID 重试与失败释放执行权、
 * 迟到 epoch 被拒绝（B08）。全部使用真实数据库与真实受管内容存储，不使用 Mock DB。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-p05-run-steps');

let storageRoot: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });

  storageRoot = await createDataRoot();
});

after(async () => {
  await app.close();
});

interface DelegatedRunFixture {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly storage: ManagedContentStore;
  readonly workerId: string;
}

let fixtureCounter = 0;

async function setupDelegatedRun(): Promise<DelegatedRunFixture> {
  fixtureCounter += 1;

  const workspaceId = randomUUID();
  const taskId = randomUUID();

  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `p05-ws-${fixtureCounter}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);

    const projectId = randomUUID();

    await repositories.projects.insertProject({
      id: projectId,
      workspaceId,
      title: `p05-project-${fixtureCounter}`,
      projectType: 'GENERAL',
    });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');

    await repositories.tasks.insertTask({
      id: taskId,
      workspaceId,
      projectId,
      title: `p05-task-${fixtureCounter}`,
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
      objective: '完成 P05 Run 步骤验证',
      requiredOutputSpec: {},
      source: 'CREATE',
    });
    await repositories.tasks.insertCriterion({
      taskId,
      acceptanceRevision: 1n,
      criterionId: 'c1',
      statement: '人工核对摘要与引用',
      required: true,
      method: 'HUMAN',
      targetSpec: {},
    });
  });

  const outcome = await delegateTask(app.db, {
    workspaceId,
    taskId,
    commandId: randomUUID(),
    expectedTaskRevision: '0',
  });

  return {
    workspaceId,
    taskId,
    runId: outcome.result.run_id,
    storage: new ManagedContentStore(storageRoot),
    workerId: `worker-${fixtureCounter}`,
  };
}

async function readRun(runId: string): Promise<{
  status: string;
  terminal_at: Date | null;
  current_step_id: string | null;
  ownership_epoch: bigint;
}> {
  const result = await sql<{
    status: string;
    terminal_at: Date | null;
    current_step_id: string | null;
    ownership_epoch: bigint;
  }>`
    select status, terminal_at, current_step_id, ownership_epoch from runs where id = ${runId}
  `.execute(app.db);

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('run not found');
  }

  return row;
}

async function readTask(taskId: string): Promise<{
  status: string;
  executor_kind: string;
  executor_run_id: string | null;
  ownership_epoch: bigint;
}> {
  const result = await sql<{
    status: string;
    executor_kind: string;
    executor_run_id: string | null;
    ownership_epoch: bigint;
  }>`
    select status, executor_kind, executor_run_id, ownership_epoch from tasks where id = ${taskId}
  `.execute(app.db);

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error('task not found');
  }

  return row;
}

async function stepId(runId: string, stepKind: string): Promise<string> {
  const result = await sql<{ id: string }>`
    select id from run_steps where run_id = ${runId} and step_kind = ${stepKind}
  `.execute(app.db);

  const row = result.rows[0];

  if (row === undefined) {
    throw new Error(`step ${stepKind} not found`);
  }

  return row.id;
}

async function countManifests(runId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from context_manifests where run_id = ${runId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countTaskVersions(taskId: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count
    from artifact_versions v
    join artifacts a on a.id = v.artifact_id
    where a.task_id = ${taskId}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

async function countAttempts(stepIdValue: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    select count(*) as count from step_attempts where step_id = ${stepIdValue}
  `.execute(app.db);

  return result.rows[0]?.count ?? 0n;
}

test('advances the fixed workflow through PERSIST_CANDIDATE and stops at VERIFYING', async () => {
  const fixture = await setupDelegatedRun();

  const build = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(build.status, 'STEP_SUCCEEDED');

  if (build.status !== 'STEP_SUCCEEDED') {
    throw new Error('expected BUILD_CONTEXT success');
  }

  assert.equal(build.run_status, 'PLANNING');

  const draft = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(draft.status, 'STEP_SUCCEEDED');

  if (draft.status !== 'STEP_SUCCEEDED') {
    throw new Error('expected DRAFT success');
  }

  assert.equal(draft.run_status, 'RUNNING');

  const persist = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(persist.status, 'STEP_SUCCEEDED');

  if (persist.status !== 'STEP_SUCCEEDED') {
    throw new Error('expected PERSIST_CANDIDATE success');
  }

  assert.equal(persist.run_status, 'VERIFYING');

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'VERIFYING');
  assert.equal(run.terminal_at, null);

  // Task 仍由该 Run 占有：候选保持待验证，不写 DONE、不释放执行权。
  const task = await readTask(fixture.taskId);

  assert.equal(task.status, 'IN_PROGRESS');
  assert.equal(task.executor_run_id, fixture.runId);
  assert.equal(task.executor_kind, 'AI');
  assert.equal(task.ownership_epoch, 1n);

  const steps = await sql<{ step_kind: string; status: string }>`
    select step_kind, status from run_steps where run_id = ${fixture.runId} order by step_index
  `.execute(app.db);

  assert.deepEqual(
    steps.rows.map((row) => `${row.step_kind}:${row.status}`),
    [
      'BUILD_CONTEXT:SUCCEEDED',
      'DRAFT:SUCCEEDED',
      'PERSIST_CANDIDATE:SUCCEEDED',
      'VERIFY:PENDING',
      'COMPLETE:PENDING',
    ],
  );

  assert.equal(await countManifests(fixture.runId), 1n);
  assert.equal(await countTaskVersions(fixture.taskId), 1n);

  const versions = await sql<{ source_kind: string; source_ref: string }>`
    select v.source_kind, v.source_ref
    from artifact_versions v
    join artifacts a on a.id = v.artifact_id
    where a.task_id = ${fixture.taskId}
  `.execute(app.db);

  assert.equal(versions.rows[0]?.source_kind, 'AI');
  assert.equal(versions.rows[0]?.source_ref, `run:${fixture.runId}/step:PERSIST_CANDIDATE`);

  // P06：VERIFY 真正执行。本 fixture 只有一条必需 HUMAN criterion → 总决策 HUMAN：
  // 步骤成功、Run 转 WAITING_APPROVAL、session 保留为 HUMAN（不等于 PASS，也不写 DONE）。
  const verify = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(verify.status, 'STEP_SUCCEEDED', JSON.stringify(verify));

  if (verify.status !== 'STEP_SUCCEEDED') {
    throw new Error('expected VERIFY success');
  }

  assert.equal(verify.step_kind, 'VERIFY');
  assert.equal(verify.run_status, 'WAITING_APPROVAL');

  const verified = await readRun(fixture.runId);

  assert.equal(verified.status, 'WAITING_APPROVAL');
  assert.equal(verified.terminal_at, null);

  const taskAfterVerify = await readTask(fixture.taskId);

  assert.equal(taskAfterVerify.status, 'IN_PROGRESS');
  assert.equal(taskAfterVerify.executor_run_id, fixture.runId);

  const session = await sql<{ status: string }>`
    select status from verification_sessions where run_id = ${fixture.runId}
  `.execute(app.db);

  assert.equal(session.rows[0]?.status, 'HUMAN');

  // 完成 Gate 不满足：等待人工，不是执行失败；步骤保持 PENDING、Run 不变、不抛错。
  const blocked = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(blocked.status, 'COMPLETION_BLOCKED', JSON.stringify(blocked));
  assert.equal(await countTaskVersions(fixture.taskId), 1n);
});

test('replays a stable attempt key without a second attempt or duplicate writes', async () => {
  const fixture = await setupDelegatedRun();

  const build = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
    // 场景进入 Manifest payload：FakeModelPort 的行为由 BUILD_CONTEXT 装配的上下文决定。
    fakeScenario: 'SCHEMA_INVALID',
  });

  assert.equal(build.status, 'STEP_SUCCEEDED');

  const draftStepId = await stepId(fixture.runId, 'DRAFT');
  const attemptKey = 'draft-fixed#1';

  const first = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
    attemptKey,
  });

  assert.equal(first.status, 'RETRYABLE');
  assert.equal(await countAttempts(draftStepId), 1n);

  const replay = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
    attemptKey,
  });

  assert.equal(replay.status, 'REPLAYED');

  // 去重：没有第二条尝试，也没有重复写 Manifest 或产物版本。
  assert.equal(await countAttempts(draftStepId), 1n);
  assert.equal(await countManifests(fixture.runId), 1n);
  assert.equal(await countTaskVersions(fixture.taskId), 0n);
});

test('fails the run after the second schema error and releases execution back to the human', async () => {
  const fixture = await setupDelegatedRun();

  const before = await readTask(fixture.taskId);

  assert.equal(before.ownership_epoch, 1n);

  const build = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
    // 场景在 BUILD_CONTEXT 装配上下文时固化进 Manifest。
    fakeScenario: 'SCHEMA_INVALID',
  });

  assert.equal(build.status, 'STEP_SUCCEEDED');

  const firstDraft = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(firstDraft.status, 'RETRYABLE');

  const secondDraft = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.equal(secondDraft.status, 'RUN_FAILED');

  if (secondDraft.status !== 'RUN_FAILED') {
    throw new Error('expected RUN_FAILED');
  }

  assert.equal(secondDraft.task_status, 'READY');

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'FAILED');
  assert.notEqual(run.terminal_at, null);

  const task = await readTask(fixture.taskId);

  assert.equal(task.status, 'READY');
  assert.equal(task.executor_kind, 'HUMAN');
  assert.equal(task.executor_run_id, null);
  // 释放执行权再次递增 epoch：授予时 1，失败释放后 2。
  assert.equal(task.ownership_epoch, 2n);

  const draftStep = await sql<{ status: string }>`
    select status from run_steps where run_id = ${fixture.runId} and step_kind = 'DRAFT'
  `.execute(app.db);

  assert.equal(draftStep.rows[0]?.status, 'FAILED');
});

test('rejects a late attempt result with a stale claim epoch and keeps the step position (B08)', async () => {
  const fixture = await setupDelegatedRun();

  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });
  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });
  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });

  const draftStepId = await stepId(fixture.runId, 'DRAFT');

  // 模拟一个迟到 worker：插入并领取一个新的 DRAFT 尝试，claim_epoch 变为 1。
  const lateAttempt = await withTransaction(app.db, async (repositories) => {
    const inserted = await repositories.runs.insertStepAttempt({
      id: randomUUID(),
      stepId: draftStepId,
      attemptNumber: 2n,
      attemptKey: 'late-draft#2',
    });

    const claimed = await repositories.runs.claimAttempt({
      attemptId: inserted.row.id,
      workerId: 'worker-late',
      leaseUntil: new Date(Date.now() + 30_000),
    });

    assert.notEqual(claimed, undefined);

    return claimed;
  });

  assert.notEqual(lateAttempt, undefined);

  if (lateAttempt === undefined) {
    throw new Error('late attempt was not claimed');
  }

  assert.equal(lateAttempt.claim_epoch, 1n);

  // 用旧 epoch（0）登记结果：只写核对证据，不推进、不产生第二条版本。
  const rejected = await recordStaleAttemptResult(app.db, {
    attemptId: lateAttempt.id,
    expectedClaimEpoch: 0n,
    resultRef: { kind: 'CONTENT', content: '迟到结果' },
    evidence: { reason: 'STALE_CLAIM_EPOCH' },
  });

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.attempt?.status, 'REJECTED_STALE');

  const draftStep = await sql<{ status: string }>`
    select status from run_steps where run_id = ${fixture.runId} and step_kind = 'DRAFT'
  `.execute(app.db);

  assert.equal(draftStep.rows[0]?.status, 'SUCCEEDED');
  assert.equal(await countTaskVersions(fixture.taskId), 1n);
});

test('refuses to advance a run whose ownership epoch no longer matches the task', async () => {
  const fixture = await setupDelegatedRun();

  // 模拟执行权在外部被转移：Task 的 ownership_epoch 递增而 Run 快照不变。
  await sql`update tasks set ownership_epoch = ownership_epoch + 1 where id = ${fixture.taskId}`.execute(
    app.db,
  );

  const result = await advanceRunStep(app.db, {
    runId: fixture.runId,
    workerId: fixture.workerId,
    storage: fixture.storage,
  });

  assert.deepEqual(result, { status: 'STALE_OWNERSHIP', run_id: fixture.runId });

  const run = await readRun(fixture.runId);

  assert.equal(run.status, 'CREATED');
  assert.equal(await countManifests(fixture.runId), 0n);
});

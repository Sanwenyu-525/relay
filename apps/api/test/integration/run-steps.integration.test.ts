import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';
import { Client } from 'pg';

import { delegateTask } from '../../src/application/delegate-task.js';
import {
  advanceRunStep,
  recordStaleAttemptResult,
  type RecordStaleAttemptResult,
} from '../../src/application/run-steps.js';
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

test('a status-only Task revision during Context build does not discard its unchanged inputs', async () => {
  const fixture = await setupDelegatedRun();
  const build = await advanceRunStep(app.db, {
    runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage,
    hooks: { beforeCommit: async () => {
      await sql`update tasks set revision = revision + 1 where id = ${fixture.taskId}`.execute(app.db);
    } },
  });
  assert.equal(build.status, 'STEP_SUCCEEDED');
  assert.equal(build.step_kind, 'BUILD_CONTEXT');
  assert.equal(await countManifests(fixture.runId), 1n);
  const draft = await advanceRunStep(app.db, {
    runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage,
  });
  assert.equal(draft.status, 'STEP_SUCCEEDED');
  assert.equal(draft.step_kind, 'DRAFT');
  assert.equal(await countManifests(fixture.runId), 1n);
});

test('Task title and acceptance input changes rebuild Context before Draft', async () => {
  const fixture = await setupDelegatedRun();
  const advance = () => advanceRunStep(app.db, {
    runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage,
  });
  const firstBuild = await advance();
  assert.equal(firstBuild.status, 'STEP_SUCCEEDED');
  assert.equal(firstBuild.step_kind, 'BUILD_CONTEXT');
  const task = await withTransaction(app.db, (repositories) =>
    repositories.tasks.readTask(fixture.taskId));
  assert.ok(task);
  await withTransaction(app.db, async (repositories) => {
    const changed = await repositories.tasks.updateTaskTitle(
      fixture.taskId, task.revision, 'Updated Context title');
    assert.ok(changed);
  });
  const titleBuild = await advance();
  assert.equal(titleBuild.status, 'STEP_SUCCEEDED');
  assert.equal(titleBuild.step_kind, 'BUILD_CONTEXT');
  await withTransaction(app.db, async (repositories) => {
    await repositories.tasks.insertAcceptanceVersion({
      taskId: fixture.taskId, acceptanceRevision: 2n,
      objective: 'Updated acceptance input', requiredOutputSpec: {}, source: 'REOPEN',
    });
  });
  await sql`update tasks set acceptance_revision = 2, revision = revision + 1
    where id = ${fixture.taskId}`.execute(app.db);
  const acceptanceBuild = await advance();
  assert.equal(acceptanceBuild.status, 'STEP_SUCCEEDED');
  assert.equal(acceptanceBuild.step_kind, 'BUILD_CONTEXT');
  assert.equal(await countManifests(fixture.runId), 3n);
  const draft = await advance();
  assert.equal(draft.status, 'STEP_SUCCEEDED');
  assert.equal(draft.step_kind, 'DRAFT');
});

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

  assert.equal(taskAfterVerify.status, 'WAITING');
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
    await repositories.runs.claimWorker(fixture.runId, 'worker-late', new Date(Date.now() + 30_000));
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
  assert.equal(rejected.attempt?.status, 'RUNNING');
  assert.equal(rejected.attempt?.claim_epoch, 1n);
  assert.equal(rejected.attempt?.worker_id, 'worker-late');
  assert.notEqual(rejected.attempt?.lease_until, null);

  const firstStaleAudit = await sql<{
    event_type: string;
    fact_refs: { submitted_claim_epoch: string; observed_claim_epoch: string; observed_status: string };
  }>`
    select event_type, fact_refs
    from activity_records
    where task_id = ${fixture.taskId} and event_type = 'STEP_ATTEMPT_RESULT_REJECTED_STALE'
  `.execute(app.db);

  assert.equal(firstStaleAudit.rows.length, 1);
  assert.equal(firstStaleAudit.rows[0]?.event_type, 'STEP_ATTEMPT_RESULT_REJECTED_STALE');
  assert.equal(firstStaleAudit.rows[0]?.fact_refs.submitted_claim_epoch, '0');
  assert.equal(firstStaleAudit.rows[0]?.fact_refs.observed_claim_epoch, '1');
  assert.equal(firstStaleAudit.rows[0]?.fact_refs.observed_status, 'RUNNING');

  const accepted = await recordStaleAttemptResult(app.db, {
    attemptId: lateAttempt.id,
    expectedClaimEpoch: 1n,
    resultRef: { kind: 'CONTENT', content: '当前领取者结果' },
    evidence: { source: 'CURRENT_CLAIM' },
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.attempt?.status, 'SUCCEEDED');
  assert.equal(accepted.attempt?.claim_epoch, 1n);
  assert.equal(accepted.attempt?.worker_id, null);
  assert.equal(accepted.attempt?.lease_until, null);

  const terminalLate = await recordStaleAttemptResult(app.db, {
    attemptId: lateAttempt.id,
    expectedClaimEpoch: 0n,
    resultRef: { kind: 'CONTENT', content: '终态后的旧结果' },
    evidence: { reason: 'STALE_AFTER_SUCCESS' },
  });

  assert.equal(terminalLate.accepted, false);
  assert.equal(terminalLate.attempt?.status, 'SUCCEEDED');
  assert.equal(terminalLate.attempt?.result_ref?.content, '当前领取者结果');

  const repeated = await recordStaleAttemptResult(app.db, {
    attemptId: lateAttempt.id,
    expectedClaimEpoch: 1n,
    resultRef: { kind: 'CONTENT', content: '重复结果' },
    evidence: { reason: 'DUPLICATE_RESULT' },
  });

  assert.equal(repeated.accepted, false);

  const staleAuditCount = await sql<{ count: bigint }>`
    select count(*) as count
    from activity_records
    where task_id = ${fixture.taskId} and event_type = 'STEP_ATTEMPT_RESULT_REJECTED_STALE'
  `.execute(app.db);

  assert.equal(staleAuditCount.rows[0]?.count, 3n);

  const draftStep = await sql<{ status: string }>`
    select status from run_steps where run_id = ${fixture.runId} and step_kind = 'DRAFT'
  `.execute(app.db);

  assert.equal(draftStep.rows[0]?.status, 'SUCCEEDED');
  assert.equal(await countTaskVersions(fixture.taskId), 1n);
});

test('a row-lock synchronized stale/current result race leaves the current claim available to commit (B08)', async () => {
  const fixture = await setupDelegatedRun();

  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });
  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });
  await advanceRunStep(app.db, { runId: fixture.runId, workerId: fixture.workerId, storage: fixture.storage });

  const draftStepId = await stepId(fixture.runId, 'DRAFT');
  const attempt = await withTransaction(app.db, async (repositories) => {
    await repositories.runs.claimWorker(fixture.runId, 'worker-current', new Date(Date.now() + 30_000));
    const inserted = await repositories.runs.insertStepAttempt({
      id: randomUUID(),
      stepId: draftStepId,
      attemptNumber: 2n,
      attemptKey: 'stale-current-race#2',
    });
    const claimed = await repositories.runs.claimAttempt({
      attemptId: inserted.row.id,
      workerId: 'worker-current',
      leaseUntil: new Date(Date.now() + 30_000),
    });

    if (claimed === undefined) {
      throw new Error('current attempt was not claimed');
    }

    return claimed;
  });

  const lockClient = new Client({
    connectionString: MIGRATION_DATABASE_URL,
    application_name: 'relay-api-test-r05-claim-lock',
  });
  let transactionOpen = false;
  let stalePromise: Promise<RecordStaleAttemptResult> | undefined;
  let currentPromise: Promise<RecordStaleAttemptResult> | undefined;

  await lockClient.connect();

  try {
    await lockClient.query('begin');
    transactionOpen = true;
    await lockClient.query('select id from step_attempts where id = $1::uuid for update', [attempt.id]);

    // 显式行锁是两个提交的 barrier：旧提交不应等待或改写被锁住的当前 Attempt；
    // 当前提交在释放锁后才以 epoch=1 完成。
    stalePromise = recordStaleAttemptResult(app.db, {
      attemptId: attempt.id,
      expectedClaimEpoch: 0n,
      resultRef: { kind: 'CONTENT', content: '并发旧结果' },
      evidence: { reason: 'STALE_RACE' },
    });
    currentPromise = recordStaleAttemptResult(app.db, {
      attemptId: attempt.id,
      expectedClaimEpoch: 1n,
      resultRef: { kind: 'CONTENT', content: '并发当前结果' },
      evidence: { source: 'CURRENT_RACE' },
    });

    const stale = await resolvesWithin(stalePromise, 1_000, 'stale result waited on the current attempt row');

    assert.equal(stale.accepted, false);
    assert.equal(stale.attempt?.status, 'RUNNING');
    assert.equal(stale.attempt?.claim_epoch, 1n);
    assert.equal(stale.attempt?.worker_id, 'worker-current');

    await lockClient.query('commit');
    transactionOpen = false;

    const current = await currentPromise;

    assert.equal(current.accepted, true);
    assert.equal(current.attempt?.status, 'SUCCEEDED');
    assert.equal(current.attempt?.result_ref?.content, '并发当前结果');
  } finally {
    if (transactionOpen) {
      await lockClient.query('rollback');
    }

    await Promise.allSettled([stalePromise, currentPromise].filter((promise): promise is Promise<RecordStaleAttemptResult> => promise !== undefined));
    await lockClient.end();
  }

  const finalAttempt = await sql<{
    status: string;
    claim_epoch: bigint;
    worker_id: string | null;
    lease_until: Date | null;
    result_ref: { content: string } | null;
  }>`
    select status, claim_epoch, worker_id, lease_until, result_ref
    from step_attempts where id = ${attempt.id}
  `.execute(app.db);

  assert.deepEqual(finalAttempt.rows[0], {
    status: 'SUCCEEDED',
    claim_epoch: 1n,
    worker_id: null,
    lease_until: null,
    result_ref: { kind: 'CONTENT', content: '并发当前结果' },
  });
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

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

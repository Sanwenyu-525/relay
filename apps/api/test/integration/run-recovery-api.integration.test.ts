import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { delegateTask } from '../../src/application/delegate-task.js';
import { planExecutionAdmission } from '../../src/application/execution-concurrency.js';
import { advanceRunStep, SimulatedWorkerCrash } from '../../src/application/run-steps.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } from './integration-support.js';
import { createDataRoot, expectCommandAccepted, expectProblem, startTestApi, workspacePath } from './api-harness.js';

/**
 * 受控恢复路由（POST /runs/:run_id/recovery，runtime-context §2.12 遗留缺口的出口）。
 *
 * 已验证的契约：
 *   * 只有「领取租约已过期 + 归属匹配 + 人工/OS 停机依据」的滞留领取才能被恢复；
 *   * 恢复走与 Supervisor 相同的 Owner（会话锁复核 → fence → 效果核对 → 重投），
 *     不绕过 Worker fence，不重复创建外部操作（同一 operation_id 重投）；
 *   * UNKNOWN 的外部操作如实 BLOCKED，等待人工核对，不假装成功；
 *   * 命令幂等：同一 command_id 重放返回原回执，不二次恢复。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-run-recovery-api');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

async function fixture(): Promise<{
  workspaceId: string; projectId: string; taskId: string; runId: string; workerId: string;
  storage: ManagedContentStore;
}> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `recovery-api-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: 'Recovery API', projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
    await repositories.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'Recovery API run',
      status: 'READY', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
      currentCompletionId: null });
    await repositories.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '核对受控恢复', requiredOutputSpec: {}, source: 'CREATE' });
    await repositories.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'structure',
      statement: 'Markdown 结构核对', required: true, method: 'HUMAN', targetSpec: {} });
  });
  const delegated = await delegateTask(app.db, { workspaceId, taskId, commandId: randomUUID(),
    expectedTaskRevision: '0' });
  return { workspaceId, projectId, taskId, runId: delegated.result.run_id,
    workerId: `worker-${randomUUID()}`, storage: new ManagedContentStore(dataRoot) };
}

/** 手工占用 START 命令的投递链：invocation ACTIVE + outbox CLAIMED + Run worker 租约。 */
async function claimExpiredDelivery(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const commandId = await startCommandId(f.runId);
    const claim = await repositories.dispatch.claimInvocation(f.runId, commandId, f.workerId, 60_000);
    await repositories.dispatch.claimOutbox(commandId, f.workerId, claim.epoch);
    const worker = await repositories.runs.claimWorker(f.runId, f.workerId,
      new Date(Date.now() + 60_000));
    if (worker === undefined) throw new Error('claim Run worker');
    return commandId;
  });
}

/** 只占投递链（invocation + outbox），不动 Run 级 worker：步骤推进自持 Run worker 租约。 */
async function claimDeliveryOnly(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  return withTransaction(app.db, async (repositories) => {
    const commandId = await startCommandId(f.runId);
    const claim = await repositories.dispatch.claimInvocation(f.runId, commandId, f.workerId, 60_000);
    await repositories.dispatch.claimOutbox(commandId, f.workerId, claim.epoch);
    return commandId;
  });
}

async function startCommandId(runId: string): Promise<string> {
  const command = await sql<{ id: string }>`
    select id from run_commands where run_id = ${runId} order by created_at, id limit 1
  `.execute(app.db);
  const commandId = command.rows[0]?.id;
  if (commandId === undefined) throw new Error('missing Run START command');
  return commandId;
}

async function expireInvocationLease(runId: string): Promise<void> {
  await sql`update run_invocations set lease_until = now() - interval '1 second'
    where run_id = ${runId}`.execute(app.db);
}

async function postRecovery(f: Awaited<ReturnType<typeof fixture>>, api: Awaited<ReturnType<typeof startTestApi>>,
  input: { commandId: string; stoppedWorkerId?: string; stopEvidence?: string }) {
  return api.post(workspacePath(f.workspaceId, `/runs/${f.runId}/recovery`), {
    command_id: input.commandId,
    stopped_worker_id: input.stoppedWorkerId ?? f.workerId,
    stop_evidence: input.stopEvidence ?? 'OS confirmed worker pid exited and is no longer running',
  });
}

async function fenceCount(runId: string): Promise<bigint> {
  const rows = await sql<{ count: bigint }>`
    select count(*)::bigint as count from run_worker_fences where run_id = ${runId}
  `.execute(app.db);
  return rows.rows[0]?.count ?? 0n;
}

test('execution concurrency admission counts only lease-fresh executions', async () => {
  const f = await fixture();
  // Run 命令领取（活租约）计入；租约过期（滞留恢复语义）不再计入。
  await claimExpiredDelivery(f);
  assert.deepEqual(
    [await planExecutionAdmission(app.db, 1)].map((a) => [a.active, a.admitted]),
    [[1, false]]);
  await expireInvocationLease(f.runId);
  assert.deepEqual(
    [await planExecutionAdmission(app.db, 1)].map((a) => [a.active, a.admitted]),
    [[0, true]]);

  // 会话生成 RUNNING：心跳新鲜计入，心跳停摆（更新时刻过期）不计入——
  // 该行由生成租约清扫收敛，闸不把已停的执行当作占位。
  const sessionId = randomUUID();
  const messageId = randomUUID();
  await sql`insert into assist_sessions (id, workspace_id, title, context_budget_tokens)
    values (${sessionId}, ${f.workspaceId}, 'gate-probe', 262144)`.execute(app.db);
  await sql`insert into assist_messages (id, session_id, seq, role, status)
    values (${messageId}, ${sessionId}, 1, 'ASSISTANT', 'RUNNING')`.execute(app.db);
  assert.equal((await planExecutionAdmission(app.db, 8)).active, 1);
  await sql`update assist_messages set updated_at = now() - interval '10 minutes'
    where id = ${messageId}`.execute(app.db);
  assert.equal((await planExecutionAdmission(app.db, 8)).active, 0);

  // 成员唤醒 CLAIMED：活租约计入，租约过期不计入。
  const memberId = randomUUID();
  const conversationId = randomUUID();
  const memberMessageId = randomUUID();
  await sql`insert into project_agent_members (id, workspace_id, project_id, name, role_key, duties)
    values (${memberId}, ${f.workspaceId}, ${f.projectId}, '闸探针成员', 'DEVELOPMENT', '闸探针')`
    .execute(app.db);
  await sql`insert into project_member_conversations (id, workspace_id, project_id, kind, member_id)
    values (${conversationId}, ${f.workspaceId}, ${f.projectId}, 'DIRECT', ${memberId})`.execute(app.db);
  await sql`insert into project_member_messages (id, conversation_id, workspace_id, project_id, seq,
      sender_kind, content, processing_status, claimed_by, claimed_at, lease_expires_at)
    values (${memberMessageId}, ${conversationId}, ${f.workspaceId}, ${f.projectId}, 1, 'HUMAN',
      '闸探针消息', 'CLAIMED', 'gate-worker', now(), now() + interval '60 seconds')`.execute(app.db);
  assert.equal((await planExecutionAdmission(app.db, 8)).active, 1);
  await sql`update project_member_messages set lease_expires_at = now() - interval '1 second'
    where id = ${memberMessageId}`.execute(app.db);
  assert.equal((await planExecutionAdmission(app.db, 8)).active, 0);
});

test('expired stranded claim is requeued by human-attested stop evidence and the next worker resumes', async () => {
  const f = await fixture();
  const commandId = await claimExpiredDelivery(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    const commandIdForApi = randomUUID();
    const response = await postRecovery(f, api, { commandId: commandIdForApi });
    const result = expectCommandAccepted(response, 200, commandIdForApi);
    assert.deepEqual(result, { run_id: f.runId, outcome: 'REQUEUED', fenced: true,
      unresolved_operation_ids: [], blocked_reason: null });

    const delivery = await sql<{ invocation_status: string; outbox_status: string; stop_evidence: string | null }>`
      select i.status as invocation_status, o.status as outbox_status, i.stop_evidence
      from run_invocations i join run_command_outbox o on o.command_id = ${commandId}
      where i.run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual(delivery.rows[0], { invocation_status: 'IDLE', outbox_status: 'PENDING',
      stop_evidence: `human-attested:command=${commandIdForApi};OS confirmed worker pid exited and is no longer running` });
    // fence 事实持久化，证据带命令身份；Run 业务状态没有被恢复动作改写。
    assert.equal(await fenceCount(f.runId), 1n);
    const run = await sql<{ status: string; worker_id: string | null }>`
      select status, worker_id from runs where id = ${f.runId}`.execute(app.db);
    assert.deepEqual(run.rows[0], { status: 'CREATED', worker_id: null });
    const fencedEvents = await sql<{ evidence: string }>`
      select fact_refs ->> 'stopped_evidence' as evidence from activity_records
      where event_type = 'RUN_WORKER_FENCED' and fact_refs ->> 'run_id' = ${f.runId}
    `.execute(app.db);
    assert.match(fencedEvents.rows[0]?.evidence ?? '', /^human-attested:command=/u);

    // 重投后同一命令可以被下一个 Worker 正常领取并推进（不重复创建 Run/命令）。
    const resumed = await advanceRunStep(app.db, { runId: f.runId, workerId: `${f.workerId}-next`,
      storage: f.storage });
    assert.equal(resumed.status, 'STEP_SUCCEEDED', JSON.stringify(resumed));
  } finally { await api.stop(); }
});

test('a live lease is refused with RUN_RECOVERY_CLAIM_NOT_EXPIRED and nothing is touched', async () => {
  const f = await fixture();
  await claimExpiredDelivery(f);
  const api = await startTestApi({ dataRoot });
  try {
    const problem = expectProblem(await postRecovery(f, api, { commandId: randomUUID() }),
      409, 'RUN_RECOVERY_CLAIM_NOT_EXPIRED');
    assert.match(problem.detail, /租约/u);
    const delivery = await sql<{ outbox_status: string }>`
      select o.status as outbox_status from run_command_outbox o
      join run_commands c on c.id = o.command_id where c.run_id = ${f.runId}
    `.execute(app.db);
    assert.equal(delivery.rows[0]?.outbox_status, 'CLAIMED');
    assert.equal(await fenceCount(f.runId), 0n);
  } finally { await api.stop(); }
});

test('a mismatched worker id is refused with RUN_RECOVERY_WORKER_MISMATCH', async () => {
  const f = await fixture();
  await claimExpiredDelivery(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    expectProblem(await postRecovery(f, api, { commandId: randomUUID(),
      stoppedWorkerId: `worker-other-${randomUUID()}` }), 409, 'RUN_RECOVERY_WORKER_MISMATCH');
    assert.equal(await fenceCount(f.runId), 0n);
  } finally { await api.stop(); }
});

test('a run without a stranded claim reports RUN_RECOVERY_NOT_REQUIRED', async () => {
  const f = await fixture();
  const api = await startTestApi({ dataRoot });
  try {
    expectProblem(await postRecovery(f, api, { commandId: randomUUID() }),
      409, 'RUN_RECOVERY_NOT_REQUIRED');
    assert.equal(await fenceCount(f.runId), 0n);
  } finally { await api.stop(); }
});

test('unknown run in the workspace is 404', async () => {
  const f = await fixture();
  const api = await startTestApi({ dataRoot });
  try {
    const response = await api.post(workspacePath(f.workspaceId, `/runs/${randomUUID()}/recovery`), {
      command_id: randomUUID(), stopped_worker_id: f.workerId,
      stop_evidence: 'OS confirmed worker pid exited and is no longer running',
    });
    expectProblem(response, 404, 'RESOURCE_NOT_FOUND');
  } finally { await api.stop(); }
});

test('too-short stop evidence is 422 and grants nothing', async () => {
  const f = await fixture();
  await claimExpiredDelivery(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    const response = await postRecovery(f, api, { commandId: randomUUID(), stopEvidence: 'short' });
    // schema 先拒（400 schema validation）；即便绕过 schema，应用层也以 422 拒绝。
    assert.ok([400, 422].includes(response.status), `unexpected status ${response.status}: ${response.text}`);
    assert.equal(await fenceCount(f.runId), 0n);
  } finally { await api.stop(); }
});

test('replay of the same command_id returns the original receipt without a second recovery', async () => {
  const f = await fixture();
  const commandId = await claimExpiredDelivery(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    const replayCommandId = randomUUID();
    const first = await postRecovery(f, api, { commandId: replayCommandId });
    const firstResult = expectCommandAccepted(first, 200, replayCommandId);
    assert.equal(await fenceCount(f.runId), 1n);
    const second = await postRecovery(f, api, { commandId: replayCommandId });
    const secondResult = expectCommandAccepted(second, 200, replayCommandId);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(second.headers['command-replayed'], 'true');
    assert.equal(await fenceCount(f.runId), 1n);
    const delivery = await sql<{ outbox_status: string }>`
      select o.status as outbox_status from run_command_outbox o where o.command_id = ${commandId}
    `.execute(app.db);
    assert.equal(delivery.rows[0]?.outbox_status, 'PENDING');
  } finally { await api.stop(); }
});

test('a missing published target is requeued and the next dispatch reuses the same operation_id', async () => {
  const f = await fixture();
  // 先推进到发布并在派发后崩溃（崩溃的 Worker 保留 Run 级租约），再占用投递链并过期。
  for (const kind of ['BUILD_CONTEXT', 'DRAFT'] as const) {
    const result = await advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: async () => { throw new SimulatedWorkerCrash('after dispatch'); } } }),
    SimulatedWorkerCrash);
  const before = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
    select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  assert.deepEqual([before.rows[0]?.status, before.rows[0]?.dispatch_count], ['DISPATCHING', 1]);
  const commandId = await claimDeliveryOnly(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    const recoveryCommandId = randomUUID();
    const result = expectCommandAccepted(
      await postRecovery(f, api, { commandId: recoveryCommandId }), 200, recoveryCommandId);
    assert.equal(result.outcome, 'REQUEUED');
    assert.deepEqual(result.unresolved_operation_ids, []);
    // 目标缺失 → 同一 operation_id 回到 PREPARED，等待下一次派发，不新建操作。
    const reset = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
      select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual([reset.rows[0]?.operation_id, reset.rows[0]?.status, reset.rows[0]?.dispatch_count],
      [before.rows[0]?.operation_id, 'PREPARED', 1]);
    const delivery = await sql<{ invocation_status: string; outbox_status: string }>`
      select i.status as invocation_status, o.status as outbox_status
      from run_invocations i join run_command_outbox o on o.command_id = ${commandId}
      where i.run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual(delivery.rows[0], { invocation_status: 'IDLE', outbox_status: 'PENDING' });
    // 下一个 Worker 重投同一操作并成功：dispatch_count 2，操作身份不变。
    const next = await advanceRunStep(app.db, { runId: f.runId, workerId: `${f.workerId}-next`,
      storage: f.storage });
    assert.equal(next.status, 'STEP_SUCCEEDED', JSON.stringify(next));
    const after = await sql<{ operation_id: string; status: string; dispatch_count: number }>`
      select operation_id, status, dispatch_count from run_effect_actions where run_id = ${f.runId}
    `.execute(app.db);
    assert.deepEqual([after.rows[0]?.operation_id, after.rows[0]?.status, after.rows[0]?.dispatch_count],
      [before.rows[0]?.operation_id, 'SUCCEEDED', 2]);
  } finally { await api.stop(); }
});

test('tampered published target stays UNKNOWN, reports BLOCKED and waits for human verification', async () => {
  const f = await fixture();
  // 先推进到发布并在派发后崩溃（崩溃的 Worker 保留 Run 级租约），再占用投递链并过期。
  for (const kind of ['BUILD_CONTEXT', 'DRAFT'] as const) {
    const result = await advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage });
    assert.equal(result.status, 'STEP_SUCCEEDED', `${kind}: ${JSON.stringify(result)}`);
  }
  await assert.rejects(advanceRunStep(app.db, { runId: f.runId, workerId: f.workerId, storage: f.storage,
    hooks: { afterEffectDispatch: async () => { throw new SimulatedWorkerCrash('after dispatch'); } } }),
    SimulatedWorkerCrash);
  const effect = await sql<{ operation_id: string; target_ref: string }>`
    select operation_id, target_ref from run_effect_actions where run_id = ${f.runId}
  `.execute(app.db);
  const draft = await sql<{ result_ref: { content: string } }>`
    select result_ref from run_steps where run_id = ${f.runId} and step_kind = 'DRAFT'
  `.execute(app.db);
  await f.storage.publish({ artifactId: f.runId, versionId: effect.rows[0]!.operation_id,
    content: Buffer.from('different content', 'utf8') });
  assert.ok(draft.rows[0]?.result_ref.content);
  const commandId = await claimDeliveryOnly(f);
  await expireInvocationLease(f.runId);
  const api = await startTestApi({ dataRoot });
  try {
    const firstId = randomUUID();
    const first = expectCommandAccepted(
      await postRecovery(f, api, { commandId: firstId }), 200, firstId);
    assert.equal(first.outcome, 'BLOCKED');
    assert.deepEqual(first.unresolved_operation_ids, [effect.rows[0]?.operation_id]);
    assert.match(String(first.blocked_reason), /UNKNOWN/u);
    assert.equal(await fenceCount(f.runId), 1n);
    const delivery = await sql<{ outbox_status: string }>`
      select o.status as outbox_status from run_command_outbox o join run_commands c on c.id = o.command_id
      where c.run_id = ${f.runId}
    `.execute(app.db);
    assert.equal(delivery.rows[0]?.outbox_status, 'CLAIMED');
    const effectStatus = await sql<{ status: string }>`
      select status from run_effect_actions where operation_id = ${effect.rows[0]!.operation_id}
    `.execute(app.db);
    assert.equal(effectStatus.rows[0]?.status, 'UNKNOWN');

    // 人工核对之前再次恢复仍然 BLOCKED（不重复重投、不把 UNKNOWN 当成功）。
    const secondId = randomUUID();
    const second = expectCommandAccepted(
      await postRecovery(f, api, { commandId: secondId }), 200, secondId);
    assert.equal(second.outcome, 'BLOCKED');
    assert.equal(await fenceCount(f.runId), 1n);
  } finally { await api.stop(); }
});

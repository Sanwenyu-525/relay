import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { forkAssistSession } from '../../src/application/assist-session-controls.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { DbExecutor } from '../../src/infrastructure/database.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import {
  createDataRoot, expectCommandAccepted, expectProblem, startTestApi,
  workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 会话物理删除的真实 PostgreSQL 集成（ADR-027、迁移 0116）。
 *
 * 这里取证的是单测覆盖不到的三件事：
 *   * 删除顺序真的能穿过全部 NO ACTION 外键，并把**会话自有**的账本删干净；
 *   * 被别的对象引用时整条拒绝、零删除——保留边界不是文案，是一组真实的 exists 判定；
 *   * 行消失之后幂等仍然有效：同 command_id 重放读的是回执账本，不是那条已经不存在的会话。
 *
 * 不取证：真实模型产生的调用、Windows 窗口、界面观感。删除「不可撤销」是产品口径，
 * 不是可测行为——这里只测「没有恢复命令能把行带回来」这一事实（行与消息确实不存在）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-assist-session-delete-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `session-delete-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title = '待删除的讨论'): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

function post(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
  return api.post(workspacePath(workspaceId, `/assist-sessions/${sessionId}/delete`), body);
}

async function countOf(
  query: { execute(db: DbExecutor): Promise<{ rows: readonly unknown[] }> },
): Promise<number> {
  const row = (await query.execute(app.db)).rows[0] as { c?: string } | undefined;
  return Number(row?.c ?? '0');
}

/** 播种一条会话自有账本：消息、附件、生成预览、辅助模型调用、模型选择与 diff 基线。 */
async function seedLedger(workspaceId: string, sessionId: string): Promise<{
  readonly messageId: string; readonly attachmentId: string; readonly modelCallId: string }> {
  const messageId = randomUUID();
  const attachmentId = randomUUID();
  const modelCallId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${messageId}, ${sessionId}, 1, 'USER', 'COMPLETED', 'DISCUSS', '删除这一轮')`
    .execute(app.db);
  await sql`insert into assist_message_previews (message_id, preview_text)
    values (${messageId}, '正在生成')`.execute(app.db);
  await withTransaction(app.db, async (repositories) => {
    await repositories.assist.insertAttachment({ id: attachmentId, workspaceId, sessionId,
      name: 'image.png', mediaType: 'image/png', content: Buffer.from([1, 2, 3]),
      contentHash: Buffer.from('11'.repeat(32), 'hex') });
  });
  await sql`insert into model_calls (id, workspace_id, kind, assist_message_id, provider, model,
      config_fingerprint, status)
    values (${modelCallId}, ${workspaceId}, 'ASSIST', ${messageId}, 'test-provider',
      'test-model', ${'0'.repeat(64)}, 'STARTED')`.execute(app.db);
  await sql`insert into session_model_selection (session_id, connection, model, config_fingerprint,
      selected_by_command_id)
    values (${sessionId}, 'default', 'test-model', ${'0'.repeat(64)}, ${randomUUID()})`.execute(app.db);
  await sql`insert into conversation_diff_baselines (workspace_id, session_id, resource_id,
      root_path, files)
    values (${workspaceId}, ${sessionId}, ${randomUUID()}, '/tmp/delete-root', '[]'::jsonb)`
    .execute(app.db);
  return { messageId, attachmentId, modelCallId };
}

test('删除清空会话自有账本：消息、附件、预览、模型计量、选择与 diff 基线全删，会话行消失', async () => {
  const workspaceId = await newWorkspace('ledger');
  const sessionId = await newSession(workspaceId);
  const seeded = await seedLedger(workspaceId, sessionId);
  const commandId = randomUUID();

  const response = await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: '0' });
  const result = expectCommandAccepted(response, 200, commandId) as
    { session_id: string; revision: string; deleted_messages: number;
      deleted_attachments: number; deleted_at: string };

  assert.equal(result.session_id, sessionId);
  assert.equal(result.revision, '0', '回执里的修订就是删除前核对过的那一版');
  assert.equal(result.deleted_messages, 1);
  assert.equal(result.deleted_attachments, 1);
  assert.match(result.deleted_at, /^\d{4}-\d{2}-\d{2}T/u);

  // 会话行与消息真的不在了，不是软删除标记。
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_previews
    where message_id = ${seeded.messageId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_attachments
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from model_calls
    where id = ${seeded.modelCallId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from session_model_selection
    where session_id = ${sessionId}`), 0);
  // 0097 的 session_id 是普通列，没有外键兜底：必须显式删掉，不能留悬空账本。
  assert.equal(await countOf(sql`select count(*)::text as c from conversation_diff_baselines
    where session_id = ${sessionId}`), 0);

  // 读入口按不可见处理。
  const readBack = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  expectProblem(readBack, 404, 'RESOURCE_NOT_FOUND');

  // activity_records 只增不减：删除命令自身留下唯一痕迹，且不复制正文。
  const audit = (await sql<{ event_type: string; fact_refs: Record<string, unknown> }>`
    select event_type, fact_refs from activity_records
    where command_id = ${commandId}`.execute(app.db)).rows[0];
  assert.equal(audit?.event_type, 'ASSIST_SESSION_DELETED');
  assert.equal(audit?.fact_refs.session_id, sessionId);
  assert.equal(audit?.fact_refs.deleted_messages, 1);
  assert.equal(JSON.stringify(audit?.fact_refs).includes('删除这一轮'), false,
    '审计只记身份与行数，不复制标题或正文');
});

test('行消失之后幂等仍读回执账本：同 command_id 同载荷重放原结果，换载荷 COMMAND_ID_REUSED', async () => {
  const workspaceId = await newWorkspace('replay');
  const sessionId = await newSession(workspaceId);
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: '0' };

  expectCommandAccepted(await post(workspaceId, sessionId, body), 200, commandId);

  const replay = await post(workspaceId, sessionId, body);
  const replayed = expectCommandAccepted(replay, 200, commandId) as { session_id: string };
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.equal(replayed.session_id, sessionId);
  // 回执只有一条，重放没有新增第二发。
  assert.equal(await countOf(sql`select count(*)::text as c from command_receipts
    where command_id = ${commandId}`), 1);

  const reused = await post(workspaceId, sessionId, { command_id: commandId, expected_revision: '1' });
  expectProblem(reused, 409, 'COMMAND_ID_REUSED');
});

test('陈旧基线不删除任何行：409 REVISION_CONFLICT 带出服务端实际修订', async () => {
  const workspaceId = await newWorkspace('stale');
  const sessionId = await newSession(workspaceId);
  await seedLedger(workspaceId, sessionId);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '7' });
  const problem = expectProblem(response, 409, 'REVISION_CONFLICT');
  assert.equal(problem.conflict?.expected_revision, '7');
  assert.equal(problem.conflict?.actual_revision, '0');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 1);
});

test('在途消息挡住删除：整条拒绝、零删除，与归档共用同一道栅栏', async () => {
  const workspaceId = await newWorkspace('inflight');
  const sessionId = await newSession(workspaceId);
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent)
    values (${randomUUID()}, ${sessionId}, 1, 'ASSISTANT', 'RUNNING', 'DISCUSS')`.execute(app.db);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  expectProblem(response, 409, 'INVALID_TRANSITION');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages where session_id = ${sessionId}`), 1);
});

test('被分叉引用时拒绝删除：blocking_reasons 带 FORK_CHILDREN，父子两行都还在', async () => {
  const workspaceId = await newWorkspace('fork');
  const sessionId = await newSession(workspaceId);
  // 分叉要求可搬历史（2026-10-24）：先落一轮已完成的消息，子会话才建得出来。
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${randomUUID()}, ${sessionId}, 1, 'USER', 'COMPLETED', 'DISCUSS', '说过一句话')`
    .execute(app.db);
  const fork = await forkAssistSession(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), expectedRevision: '0' });

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['FORK_CHILDREN']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${fork.result.session_id}`), 1);
});

test('有学习记录时拒绝删除：学习记录有自己的删除入口，不能借删会话绕过', async () => {
  const workspaceId = await newWorkspace('learning');
  const sessionId = await newSession(workspaceId);
  await sql`insert into learning_session_controls (session_id, workspace_id)
    values (${sessionId}, ${workspaceId})`.execute(app.db);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['LEARNING_RECORDS']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
});

test('跨 Workspace 的会话按不可见处理：404 且一行不动', async () => {
  const ownerWorkspace = await newWorkspace('owner');
  const otherWorkspace = await newWorkspace('other');
  const sessionId = await newSession(ownerWorkspace);

  const response = await post(otherWorkspace, sessionId, {
    command_id: randomUUID(), expected_revision: '0' });
  expectProblem(response, 404, 'RESOURCE_NOT_FOUND');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions where id = ${sessionId}`), 1);
});

test('0116 只补会话删除需要的 DELETE 授权：会话表可删，任务表仍不可删', async () => {
  // 迁移账本归 migrator 所有，应用角色不读；迁移是否应用由 migration.integration.test.ts 的
  // 全量清单守（0116 已加入其中）。这里只看权限本身的边界。
  const privileges = (await sql<{ sessions: boolean; tasks: boolean }>`
    select has_table_privilege('relay_app', 'assist_sessions', 'DELETE') as sessions,
      has_table_privilege('relay_app', 'tasks', 'DELETE') as tasks`
    .execute(app.db)).rows[0];
  assert.equal(privileges?.sessions, true);
  assert.equal(privileges?.tasks, false, '授权只覆盖会话自有账本，不外溢到任务');
});

test('删除后无法恢复：不存在能读回消息或会话的只读入口', async () => {
  const workspaceId = await newWorkspace('no-restore');
  const sessionId = await newSession(workspaceId);
  await seedLedger(workspaceId, sessionId);
  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: '0' }), 200, commandId);

  for (const path of [`/assist-sessions/${sessionId}`, `/assist-sessions/${sessionId}/messages`]) {
    expectProblem(await api.get(workspacePath(workspaceId, path)), 404, 'RESOURCE_NOT_FOUND');
  }
  const list = await api.get(workspacePath(workspaceId, '/assist-sessions?status=ALL'));
  assert.equal((list.body as { items: readonly unknown[] }).items.length, 0);
});

// ---------------------------------------------------------------------------
// 0127 / 0128 后加账本（禅道 #119）：计划、目标、轮次、额度授予与委派账本都是会话
// 自有记录，删除时由删除 Owner 在同一短事务内按外键顺序清理；委派账本的跨会话
// 引用（子会话、子会话结论消息）则整条阻断。以下用例取证三件事：
//   * 正常业务路径落定的计划/目标会话删除不再撞外键 500，也不留残行；
//   * 0127 的「计划 ← 目标 ← 消息」NO ACTION 互指在删除顺序里被显式打破；
//   * 0128 的主子代理关系按跨对象事实阻断，委派账本不随子会话消失。
// ---------------------------------------------------------------------------

/** 播种一版 0127 计划（指定版本号、状态与来源消息，用于多版本与目标启动来源）。 */
async function seedPlan(workspaceId: string, sessionId: string, version: number,
    status: 'CURRENT' | 'SUPERSEDED', sourceMessageId: string): Promise<string> {
  const planId = randomUUID();
  await sql`insert into assist_plans (id, workspace_id, session_id, version, status, goal,
    source_message_id)
    values (${planId}, ${workspaceId}, ${sessionId}, ${version}, ${status}, '梳理流程',
    ${sourceMessageId})`.execute(app.db);
  return planId;
}

/** 播种一个 0127 目标；终结态按 CHECK 要求带上 closed_at。 */
async function seedGoal(workspaceId: string, sessionId: string, status: string,
    planVersionId: string | null): Promise<string> {
  const goalId = randomUUID();
  const closedAt = ['COMPLETED', 'CANCELLED', 'FAILED'].includes(status)
    ? sql`now()` : sql`null`;
  await sql`insert into assist_goals (id, workspace_id, session_id, plan_version_id,
    objective, status, closed_at)
    values (${goalId}, ${workspaceId}, ${sessionId}, ${planVersionId}, '梳理流程', ${status},
    ${closedAt})`.execute(app.db);
  return goalId;
}

/** 播种一条目标轮次消息（goal_id 快照指向目标）与对应轮次结算行。 */
async function seedGoalRound(sessionId: string, goalId: string, seq: number,
    outcome: string): Promise<string> {
  const messageId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content,
    chat_mode, goal_id)
    values (${messageId}, ${sessionId}, ${seq}, 'USER', 'COMPLETED', 'DISCUSS', '推进目标',
    'GOAL', ${goalId})`.execute(app.db);
  await sql`insert into assist_goal_rounds (id, goal_id, message_id, round_index, outcome)
    values (${randomUUID()}, ${goalId}, ${messageId}, 1, ${outcome})`.execute(app.db);
  return messageId;
}

/** 播种一次额度授予（用户「继续」的授权账本行）。 */
async function seedBudgetGrant(goalId: string): Promise<void> {
  await sql`insert into assist_goal_budget_grants (id, goal_id, command_id, granted_calls,
    granted_tokens)
    values (${randomUUID()}, ${goalId}, ${randomUUID()}, 5, 10000)`.execute(app.db);
}

/** 播种一条 0128 委派账本行（子会话身份可空，对应「创建时未落、执行前回填」）。 */
async function seedDelegation(workspaceId: string, parentSessionId: string,
    parentMessageId: string, childSessionId: string | null): Promise<string> {
  const delegationId = randomUUID();
  await sql`insert into assist_delegations (id, workspace_id, parent_session_id,
    child_session_id, role, objective, output_requirements, parent_message_id)
    values (${delegationId}, ${workspaceId}, ${parentSessionId}, ${childSessionId},
    'INVESTIGATE', '调查现状', '给出只读结论', ${parentMessageId})`.execute(app.db);
  return delegationId;
}

/** 播种一次委派尝试（结论消息可空）。 */
async function seedDelegationAttempt(delegationId: string,
    resultMessageId: string | null): Promise<void> {
  await sql`insert into assist_delegation_attempts (id, delegation_id, attempt_index,
    result_message_id)
    values (${randomUUID()}, ${delegationId}, 1, ${resultMessageId})`.execute(app.db);
}

/** 播种一条已完成消息，返回消息 id。 */
async function seedCompletedMessage(sessionId: string, seq: number,
    content: string): Promise<string> {
  const messageId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent, content)
    values (${messageId}, ${sessionId}, ${seq}, 'USER', 'COMPLETED', 'DISCUSS', ${content})`
    .execute(app.db);
  return messageId;
}

/**
 * 走真实业务路径得到一个「计划已落库」的会话：PLAN 消息受理 + 受控生成 tick 返回
 * 合法计划信封。与删除诊断探针同一构造，这里不留探针脚手架，直接作正式回归。
 */
async function generatePlanSession(workspaceId: string, title: string): Promise<string> {
  const sessionId = await newSession(workspaceId, title);
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '只制定计划', chatMode: 'PLAN' });
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async () => ({ kind: 'CONTENT',
      content: JSON.stringify({ reply: '方案已经成形。', plan: { goal: '梳理流程',
        scope: ['web'], steps: [{ title: '读现状' }],
        verification: [{ statement: '人工走查', method: 'HUMAN' }], open_questions: [] } }),
      providerRequestId: 'session-delete-plan',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
        cacheCreationTokens: null } }),
  };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, {
      workerId: `session-delete-${randomUUID()}`, storage: new ManagedContentStore(api.dataRoot),
      modelPort: port, leaseMs: 60000, maxMessages: 1 });
    if (outcome?.messageId === sent.result.assistant_message_id &&
      outcome.status !== 'DISCARDED') break;
  }
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(message?.status, 'COMPLETED', '受控生成应把计划消息结算为 COMPLETED');
  assert.equal((await repositories.planGoals.listPlans(sessionId)).length, 1);
  return sessionId;
}

async function currentRevision(sessionId: string): Promise<string> {
  const session = await createRepositories(app.db).assist.readSession(sessionId);
  return String(session?.revision);
}

test('正常落定的计划会话可删除：计划版本随会话清理，成功后同命令重放读回执账本', async () => {
  const workspaceId = await newWorkspace('plan-real');
  const sessionId = await generatePlanSession(workspaceId, '待删除的计划讨论');
  const commandId = randomUUID();
  const body = { command_id: commandId, expected_revision: await currentRevision(sessionId) };

  const result = expectCommandAccepted(await post(workspaceId, sessionId, body), 200, commandId) as
    { session_id: string; deleted_messages: number };
  assert.equal(result.session_id, sessionId);
  assert.ok(result.deleted_messages >= 2, '受理消息与计划回复都在会话自有账本里');

  assert.equal(await countOf(sql`select count(*)::text as c from assist_plans
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);

  const replay = await post(workspaceId, sessionId, body);
  const replayed = expectCommandAccepted(replay, 200, commandId) as { session_id: string };
  assert.equal(replay.headers['command-replayed'], 'true');
  assert.equal(replayed.session_id, sessionId);
});

test('多版本计划与从计划启动的目标一并清理：目标、轮次、额度授予不留残行', async () => {
  const workspaceId = await newWorkspace('plan-versions');
  const sessionId = await newSession(workspaceId, '多版本计划');
  const firstMessageId = await seedCompletedMessage(sessionId, 1, '第一版计划');
  const secondMessageId = await seedCompletedMessage(sessionId, 2, '第二版计划');
  const planV1 = await seedPlan(workspaceId, sessionId, 1, 'SUPERSEDED', firstMessageId);
  await seedPlan(workspaceId, sessionId, 2, 'CURRENT', secondMessageId);
  const goalId = await seedGoal(workspaceId, sessionId, 'ACTIVE', planV1);
  await seedGoalRound(sessionId, goalId, 3, 'CONTINUE');
  await seedBudgetGrant(goalId);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: await currentRevision(sessionId) }),
    200, commandId);

  for (const table of ['assist_plans', 'assist_goals', 'assist_messages']) {
    assert.equal(await countOf(sql`select count(*)::text as c from ${sql.raw(table)}
      where session_id = ${sessionId}`), 0, `${table} 应随会话清理`);
  }
  // 轮次与额度授予按 goal_id 挂在目标下，没有 session_id 列，经目标行核对。
  for (const table of ['assist_goal_rounds', 'assist_goal_budget_grants']) {
    assert.equal(await countOf(sql`select count(*)::text as c from ${sql.raw(table)} r
      join assist_goals g on g.id = r.goal_id
      where g.session_id = ${sessionId}`), 0, `${table} 应随会话清理`);
  }
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);
});

test('纯目标会话（无计划）删除：CANCELLED 与 COMPLETED 两个终结态都不再撞外键', async () => {
  const workspaceId = await newWorkspace('pure-goal');
  for (const status of ['CANCELLED', 'COMPLETED'] as const) {
    const sessionId = await newSession(workspaceId, `纯目标-${status}`);
    const goalId = await seedGoal(workspaceId, sessionId, status, null);
    await seedGoalRound(sessionId, goalId, 1, status === 'CANCELLED' ? 'CANCELLED' : 'COMPLETE');
    await seedBudgetGrant(goalId);

    const commandId = randomUUID();
    expectCommandAccepted(await post(workspaceId, sessionId, {
      command_id: commandId,
      expected_revision: await currentRevision(sessionId) }), 200, commandId);

    for (const table of ['assist_goals', 'assist_messages']) {
      assert.equal(await countOf(sql`select count(*)::text as c from ${sql.raw(table)}
        where session_id = ${sessionId}`), 0, `${status} 会话的 ${table} 应随会话清理`);
    }
    for (const table of ['assist_goal_rounds', 'assist_goal_budget_grants']) {
      assert.equal(await countOf(sql`select count(*)::text as c from ${sql.raw(table)} r
        join assist_goals g on g.id = r.goal_id
        where g.session_id = ${sessionId}`), 0, `${status} 会话的 ${table} 应随会话清理`);
    }
    assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
      where id = ${sessionId}`), 0);
  }
});

test('在途消息挡住计划会话删除：409 INVALID_TRANSITION，计划版本零删除', async () => {
  const workspaceId = await newWorkspace('plan-inflight');
  const sessionId = await generatePlanSession(workspaceId, '在途挡删除的计划讨论');
  // 在途只发生在 ASSISTANT 侧（USER 轮落库即终态）：与既有在途栅栏用例同一形状。
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent)
    values (${randomUUID()}, ${sessionId}, 3, 'ASSISTANT', 'PENDING', 'DISCUSS')`.execute(app.db);

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: await currentRevision(sessionId) });
  expectProblem(response, 409, 'INVALID_TRANSITION');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_plans
    where session_id = ${sessionId}`), 1, '整条拒绝时计划版本一行不删');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 3);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 1);
});

test('过期修订挡住计划会话删除：409 REVISION_CONFLICT，计划版本零删除', async () => {
  const workspaceId = await newWorkspace('plan-stale');
  const sessionId = await newSession(workspaceId, '过期修订的计划讨论');
  const sourceMessageId = await seedCompletedMessage(sessionId, 1, '第一版计划');
  await seedPlan(workspaceId, sessionId, 1, 'CURRENT', sourceMessageId);

  const problem = expectProblem(await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: '7' }), 409, 'REVISION_CONFLICT');
  assert.equal(problem.conflict?.actual_revision, await currentRevision(sessionId));
  assert.equal(await countOf(sql`select count(*)::text as c from assist_plans
    where session_id = ${sessionId}`), 1, '修订冲突不删除任何行');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 1);
});

test('删除带委派账本的主会话：委派尝试与账本随会话清理', async () => {
  const workspaceId = await newWorkspace('delegation-ledger');
  const sessionId = await newSession(workspaceId, '委派主会话');
  const parentMessageId = await seedCompletedMessage(sessionId, 1, '发起委派');
  const delegationId = await seedDelegation(workspaceId, sessionId, parentMessageId, null);
  await seedDelegationAttempt(delegationId, null);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, {
    command_id: commandId, expected_revision: await currentRevision(sessionId) }),
    200, commandId);

  assert.equal(await countOf(sql`select count(*)::text as c from assist_delegations
    where parent_session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_delegation_attempts
    where delegation_id = ${delegationId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);
});

test('主会话下还有子代理会话时拒绝删除：SUBAGENT_CHILDREN，父子两行都在', async () => {
  const workspaceId = await newWorkspace('subagent-children');
  const sessionId = await newSession(workspaceId, '委派主会话');
  const childId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.assist.insertSession({ id: childId, workspaceId, projectId: null,
      taskId: null, title: '子代理调查', parentSessionId: sessionId,
      budgetScopeSessionId: sessionId });
  });

  const response = await post(workspaceId, sessionId, {
    command_id: randomUUID(), expected_revision: await currentRevision(sessionId) });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['SUBAGENT_CHILDREN']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${childId}`), 1);
});

test('子会话被父会话委派账本引用时拒绝删除：DELEGATION_LEDGER_REFERENCED，账本保留', async () => {
  const workspaceId = await newWorkspace('delegation-child');
  const parentSessionId = await newSession(workspaceId, '委派主会话');
  const parentMessageId = await seedCompletedMessage(parentSessionId, 1, '发起委派');
  const childSessionId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.assist.insertSession({ id: childSessionId, workspaceId, projectId: null,
      taskId: null, title: '子代理调查', parentSessionId,
      budgetScopeSessionId: parentSessionId });
  });
  const childMessageId = await seedCompletedMessage(childSessionId, 1, '子代理结论');
  const delegationId = await seedDelegation(workspaceId, parentSessionId, parentMessageId,
    childSessionId);
  await seedDelegationAttempt(delegationId, childMessageId);

  const response = await post(workspaceId, childSessionId, {
    command_id: randomUUID(), expected_revision: await currentRevision(childSessionId) });
  const problem = expectProblem(response, 409, 'SESSION_DELETE_BLOCKED');
  assert.deepEqual((problem.conflict as { blocking_reasons: string[] }).blocking_reasons,
    ['DELEGATION_LEDGER_REFERENCED']);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_delegations
    where id = ${delegationId}`), 1, '委派账本是父会话的执行史，不随子会话消失');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_delegation_attempts
    where delegation_id = ${delegationId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${childSessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${childSessionId}`), 1);
});

test('0133 只补删除账本所需的 DELETE 授权：0127/0128 六表可删，任务表不可删', async () => {
  const privileges = (await sql<{ plans: boolean; goals: boolean; rounds: boolean;
    grants: boolean; delegations: boolean; attempts: boolean; tasks: boolean }>`
    select has_table_privilege('relay_app', 'assist_plans', 'DELETE') as plans,
      has_table_privilege('relay_app', 'assist_goals', 'DELETE') as goals,
      has_table_privilege('relay_app', 'assist_goal_rounds', 'DELETE') as rounds,
      has_table_privilege('relay_app', 'assist_goal_budget_grants', 'DELETE') as grants,
      has_table_privilege('relay_app', 'assist_delegations', 'DELETE') as delegations,
      has_table_privilege('relay_app', 'assist_delegation_attempts', 'DELETE') as attempts,
      has_table_privilege('relay_app', 'tasks', 'DELETE') as tasks`
    .execute(app.db)).rows[0];
  assert.equal(privileges?.plans, true);
  assert.equal(privileges?.goals, true);
  assert.equal(privileges?.rounds, true);
  assert.equal(privileges?.grants, true);
  assert.equal(privileges?.delegations, true);
  assert.equal(privileges?.attempts, true);
  assert.equal(privileges?.tasks, false, '授权只覆盖会话自有账本，不外溢到任务');
});

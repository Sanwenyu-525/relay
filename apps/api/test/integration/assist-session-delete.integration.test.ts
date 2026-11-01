import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { forkAssistSession } from '../../src/application/assist-session-controls.js';
import { createTask } from '../../src/application/create-task.js';
import { applyConversationExecution } from '../../src/application/conversation-execution.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
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

/* ---------------------------------------------------------------------------------------------
 * 2026-10-31：删除路径补齐 0116 之后新建的账本（迁移 0154）。
 *
 * 用户看到的是「删除失败 + 请通过 request_id 在本机日志核对」，真实原因有两类，都不是业务阻断：
 *   * 0116 之后建的表只授了 SELECT / INSERT / UPDATE，删到它们就 permission denied；
 *   * `assist_delegation_supplements` 这类 NO ACTION 外键没有被删除路径覆盖。
 * 下面逐类取证：会话删得掉、账本清得干净、被保留的事实一行不少。
 * ------------------------------------------------------------------------------------------- */

async function newProject(workspaceId: string, title: string): Promise<string> {
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.projects.insertProject({ id: projectId, workspaceId, title,
      projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  return projectId;
}

/** 播种一份发送前基线与其逐文件条目（0132）：文件条目没有 DELETE 授权前会 permission denied。 */
async function seedRecallLedger(workspaceId: string, sessionId: string,
    messageId: string, assistantMessageId: string): Promise<void> {
  const baselineId = randomUUID();
  const recallId = randomUUID();
  await sql`insert into assist_message_baselines (id, workspace_id, session_id, message_id,
      resource_id, root_path, status, reason, file_count, total_bytes)
    values (${baselineId}, ${workspaceId}, ${sessionId}, ${messageId}, ${randomUUID()},
      '/tmp/recall-root', 'COMPLETE', '', 1, 3)`.execute(app.db);
  await sql`insert into assist_message_baseline_files (baseline_id, relative_path, existed,
      blob_sha256, size_bytes)
    values (${baselineId}, 'src/a.ts', true, ${'a'.repeat(64)}, 3)`.execute(app.db);
  await sql`insert into assist_message_recalls (id, workspace_id, session_id, message_id,
      assistant_message_id, command_id, status, root_path, planned_files, restored_files,
      skipped_files, completed_at)
    values (${recallId}, ${workspaceId}, ${sessionId}, ${messageId}, ${assistantMessageId},
      ${`recall-${recallId}`}, 'COMPLETED', '/tmp/recall-root', 1, 1, 0, now())`.execute(app.db);
  await sql`insert into assist_message_recall_files (recall_id, relative_path, baseline_existed,
      baseline_sha256, status)
    values (${recallId}, 'src/a.ts', true, ${'a'.repeat(64)}, 'RESTORED')`.execute(app.db);
  await sql`insert into assist_message_recall_protections (recall_id, relative_path, existed,
      content, sha256, size_bytes)
    values (${recallId}, 'src/a.ts', true, ${Buffer.from([1, 2, 3])}, ${'b'.repeat(64)}, 3)`
    .execute(app.db);
  await sql`insert into assist_message_recall_undos (id, workspace_id, session_id,
      source_recall_id, command_id, status, root_path, completed_at)
    values (${randomUUID()}, ${workspaceId}, ${sessionId}, ${recallId},
      ${`undo-${recallId}`}, 'COMPLETED', '/tmp/recall-root', now())`.execute(app.db);
}

/**
 * 用**生产入口**落一份「撤回已经结算完成」的状态，返回撤回与其基线身份。
 *
 * 与 `seedRecallLedger` 的区别就是这一轮要测的东西：`finalizeRecall` 会把撤回 id 写回
 * 被撤回的那两条消息的 `withdrawn_by_recall_id`（0132 的 NO ACTION 外键）。手写 SQL 播种
 * 建不出这枚反向引用，删除路径于是测不到它——2026-11-01 独立验收发现的 P0 正是这样漏掉的。
 */
async function seedFinalizedRecall(workspaceId: string, sessionId: string,
    messageId: string, assistantMessageId: string): Promise<{
  readonly recallId: string; readonly baselineId: string; readonly undoId: string;
}> {
  const baselineId = randomUUID();
  const recallId = randomUUID();
  const undoId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    const recall = repositories.messageRecall;
    await recall.insertBaseline({ id: baselineId, workspaceId, sessionId, messageId,
      resourceId: randomUUID(), rootPath: '/tmp/recall-root', status: 'COMPLETE', reason: '',
      fileCount: 1, totalBytes: 3n });
    await recall.insertBaselineFiles(baselineId, [{ relativePath: 'src/a.ts',
      blobSha256: 'a'.repeat(64), sizeBytes: 3n, unavailableReason: null }]);
    await recall.insertRecall({ id: recallId, workspaceId, sessionId, messageId,
      assistantMessageId, commandId: `recall-${recallId}`, rootPath: '/tmp/recall-root',
      plannedFiles: 1,
      files: [{ relativePath: 'src/a.ts', baselineExisted: true, baselineSha256: 'a'.repeat(64),
        baselineMessageId: null, expectedCurrentSha256: null, observedSha256: null,
        status: 'RESTORED', reason: null }] });
    await recall.insertProtections(recallId, [{ relativePath: 'src/a.ts', existed: true,
      content: Buffer.from([1, 2, 3]), sha256: 'b'.repeat(64), sizeBytes: 3n,
      unavailableReason: null }]);
    const undo = await recall.insertUndo({ id: undoId, workspaceId, sessionId,
      sourceRecallId: recallId, commandId: `undo-${recallId}`, rootPath: '/tmp/recall-root' });
    // 撤回与撤销各自结算为 COMPLETED：这一步才产生消息侧的反向引用。
    await recall.finalizeRecall({ id: recallId, status: 'COMPLETED', restoredFiles: 1,
      skippedFiles: 0, detail: { file_count: 1, restored_count: 1, skipped_count: 0 },
      withdrawnMessageIds: [messageId, assistantMessageId] });
    await recall.finalizeUndo(undo.id, 'COMPLETED',
      [{ path: 'src/a.ts', status: 'RESTORED', reason: null }] as unknown as JsonObject,
      { file_count: 1, restored_count: 1, skipped_count: 0 });
  });
  return { recallId, baselineId, undoId };
}

test('有自动记忆来源的会话可删除：来源凭据随会话清理，长期记忆正文与版本保留', async () => {
  const workspaceId = await newWorkspace('memory-source');
  const sessionId = await newSession(workspaceId, '带自动记忆的讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '以后回复都用中文');
  const memoryId = randomUUID();
  // memory_items 与 memory_versions 互指（当前版本外键是 DEFERRABLE 的），必须在同一个事务里落。
  await app.db.transaction().execute(async (tx) => {
    await sql`insert into memory_items (id, workspace_id, project_id, title)
      values (${memoryId}, ${workspaceId}, null, '语言偏好')`.execute(tx);
    await sql`insert into memory_versions (id, memory_id, version, title, body_text,
        confirmed_by, confirmed_at)
      values (${randomUUID()}, ${memoryId}, 1, '语言偏好', '回复用中文', 'user:local', now())`
      .execute(tx);
  });
  await sql`insert into memory_message_sources (memory_id, memory_version, session_id,
      message_id, content_sha256)
    values (${memoryId}, 1, ${sessionId}, ${messageId}, ${'c'.repeat(64)})`.execute(app.db);
  await sql`insert into memory_auto_captures (id, workspace_id, session_id, message_id,
      source_sha256, normalized_sha256, memory_id)
    values (${randomUUID()}, ${workspaceId}, ${sessionId}, ${messageId}, ${'c'.repeat(64)},
      ${'d'.repeat(64)}, ${memoryId})`.execute(app.db);

  // 策略与实现一致：来源凭据是会话自有账本，不再阻断删除（2026-10-31 撤销 MEMORY_SOURCES）。
  assert.deepEqual(await createRepositories(app.db).assist.listDeleteBlockers(sessionId), []);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId);

  assert.equal(await countOf(sql`select count(*)::text as c from memory_message_sources
    where session_id = ${sessionId}`), 0, '来源绑定是会话自有凭据，随会话消失');
  assert.equal(await countOf(sql`select count(*)::text as c from memory_auto_captures
    where session_id = ${sessionId}`), 0);
  // 长期记忆是用户的长期事实：删聊天不等于遗忘，正文与版本必须整体还在。
  assert.equal(await countOf(sql`select count(*)::text as c from memory_items
    where id = ${memoryId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from memory_versions
    where memory_id = ${memoryId}`), 1);
});

test('有撤回基线与撤回请求的会话可删除：基线、逐文件条目、保护副本与撤销行一并清掉', async () => {
  const workspaceId = await newWorkspace('recall-ledger');
  const sessionId = await newSession(workspaceId, '撤回过的讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '写一个文件');
  const assistantMessageId = await seedCompletedMessage(sessionId, 2, '已写入');
  await seedRecallLedger(workspaceId, sessionId, messageId, assistantMessageId);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId);

  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baselines
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recalls
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_undos
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baseline_files`), 0,
    '逐文件条目随基线消失，不留悬空行');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_files`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_protections`), 0);
});

test('真实完成撤回的会话可删除：消息侧反向引用在删除事务内解除，撤回账本整组消失', async () => {
  const workspaceId = await newWorkspace('recall-finalized');
  const sessionId = await newSession(workspaceId, '撤回已结算的讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '写一个文件');
  const assistantMessageId = await seedCompletedMessage(sessionId, 2, '已写入');
  const ledger = await seedFinalizedRecall(workspaceId, sessionId, messageId, assistantMessageId);

  // 先确认这是撤回**结算完成之后**的真实状态，而不是一份只多了几行的空账本。
  const withdrawn = (await sql<{ marked: boolean; recallRef: string | null }>`
    select withdrawn_at is not null as marked, withdrawn_by_recall_id::text as "recallRef"
    from assist_messages where id = ${messageId}`.execute(app.db)).rows[0];
  assert.equal(withdrawn?.marked, true);
  assert.equal(withdrawn?.recallRef, ledger.recallId,
    '撤回行被本会话的消息反向指着：这条外键是 NO ACTION，不是延迟约束');
  assert.deepEqual(await createRepositories(app.db).assist.listDeleteBlockers(sessionId), [],
    '已结算的撤回不是跨对象引用，不该挡住删除');

  const commandId = randomUUID();
  const result = expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId) as
    { deleted_messages: number };
  assert.equal(result.deleted_messages, 2, '用户消息与其回复都随会话消失');

  // 按这一组身份逐个核对：撤回行、基线、逐文件条目、保护副本、撤销与消息会话都不留残行。
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baselines
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baseline_files
    where baseline_id = ${ledger.baselineId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recalls
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_files
    where recall_id = ${ledger.recallId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_protections
    where recall_id = ${ledger.recallId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_undos
    where session_id = ${sessionId}`), 0);
  // 全库不变量：删完之后没有任何消息还指着已经不存在的撤回行。
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages m
    where m.withdrawn_by_recall_id is not null and not exists (
      select 1 from assist_message_recalls r where r.id = m.withdrawn_by_recall_id)`), 0,
    '不留悬空的撤回反向引用');
});

test('撤回会话的删除事务中途失败时整条回滚：消息、反向引用与撤回账本一行不少', async () => {
  const workspaceId = await newWorkspace('recall-rollback');
  const sessionId = await newSession(workspaceId, '删除失败的撤回讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '写一个文件');
  const assistantMessageId = await seedCompletedMessage(sessionId, 2, '已写入');
  const ledger = await seedFinalizedRecall(workspaceId, sessionId, messageId, assistantMessageId);
  const revision = await currentRevision(sessionId);

  // 在**同一短事务**里跑到仓储层删除，再按后半程失败（真实故障点：删除之后的审计写入失败）
  // 抛出。此前已经执行的每一条 DELETE 都必须一起消失——撤回账本不能停在
  // 「父行没了、子行还指着它」的半截状态。
  await assert.rejects(() => withTransaction(app.db, async (repositories) => {
    await repositories.assist.deleteSession(sessionId, BigInt(revision));
    throw new Error('simulated failure after the ledger deletes');
  }), /simulated failure after the ledger deletes/u);

  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 1, '回滚后会话行还在：删除没有半提交');
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 2);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baselines
    where session_id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_baseline_files
    where baseline_id = ${ledger.baselineId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recalls
    where session_id = ${sessionId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_files
    where recall_id = ${ledger.recallId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_protections
    where recall_id = ${ledger.recallId}`), 1);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recall_undos
    where session_id = ${sessionId}`), 1);
  // 解除反向引用只允许发生在「整条会话确定物理删除」的那一版事务里：回滚后它必须原样还在。
  assert.equal((await sql`select id from assist_messages where id = ${messageId}
    and withdrawn_by_recall_id = ${ledger.recallId}`.execute(app.db)).rows.length, 1,
    '回滚不能替消息改掉撤回来源：撤回账本仍是完整历史');

  // 回滚之后重删仍然成立：失败的那一趟没有把库改成删不掉的形状。
  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_message_recalls
    where id = ${ledger.recallId}`), 0);
});

test('写过待办清单的会话可删除：快照、事件与轮次归属都不留残行', async () => {
  const workspaceId = await newWorkspace('todo-ledger');
  const sessionId = await newSession(workspaceId, '带清单的讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '先列个清单');
  const toolCallId = randomUUID();
  const items = JSON.stringify([{ id: 't1', title: '读现状', status: 'PENDING' }]);
  await sql`insert into assist_session_todo_snapshots (session_id, workspace_id, version, items,
      last_tool_call_id, last_message_id)
    values (${sessionId}, ${workspaceId}, 1, ${items}::jsonb, ${toolCallId}, ${messageId})`
    .execute(app.db);
  await sql`insert into assist_session_todo_events (id, session_id, workspace_id, version, items,
      tool_call_id, message_id, origin_version)
    values (${randomUUID()}, ${sessionId}, ${workspaceId}, 1, ${items}::jsonb, ${toolCallId},
      ${messageId}, 0)`.execute(app.db);
  await sql`insert into assist_session_todo_turn_scopes (session_id, message_id, scope_key, basis)
    values (${sessionId}, ${messageId}, ${`turn:${messageId}`}, 'OPENED')`.execute(app.db);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId);

  assert.equal(await countOf(sql`select count(*)::text as c from assist_session_todo_snapshots
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_session_todo_events
    where session_id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_session_todo_turn_scopes
    where session_id = ${sessionId}`), 0);
});

test('发起过执行请求的会话可删除：请求行留成脱钩凭据，独立 Task 与已发生事实都不动', async () => {
  const workspaceId = await newWorkspace('execution-source');
  const projectId = await newProject(workspaceId, '执行来源项目');
  const sessionId = await newSession(workspaceId, '发起过执行的讨论');
  const messageId = await seedCompletedMessage(sessionId, 1, '把这件事交给执行');
  const resourceId = randomUUID();
  await sql`insert into managed_resources (id, workspace_id, project_id, canonical_root,
      identity_key, status)
    values (${resourceId}, ${workspaceId}, ${projectId}, '/tmp/execution-root',
      'execution-root', 'ACTIVE')`.execute(app.db);
  // 独立任务：会话删除不得把它一并抹掉（「不隐式删除独立任务」）。
  const task = await createTask(app.db, { workspaceId, commandId: randomUUID(), projectId,
    title: '独立任务', objective: '把首页标题改一下', criteria: [], expectedOutputs: {},
    mode: 'ME' });
  const requestId = randomUUID();
  await sql`insert into conversation_execution_requests (id, workspace_id, project_id, session_id,
      source_message_id, resource_id, command_id, root_path, base_content_sha256, decision,
      candidate_status, status, task_id, task_command_id, ready_command_id, delegate_command_id,
      execution_kind)
    values (${requestId}, ${workspaceId}, ${projectId}, ${sessionId}, ${messageId},
      ${resourceId}, ${randomUUID()}, '/tmp/execution-root', ${Buffer.from('11'.repeat(32), 'hex')},
      'PREPARE', 'READY', 'TASK_PREPARED', ${task.result.task_id}, ${randomUUID()},
      ${randomUUID()}, ${randomUUID()}, 'FILE_SCOPE')`.execute(app.db);

  // 候选已定的请求不再阻断删除：它是一条可脱钩的来源凭据。
  assert.deepEqual(await createRepositories(app.db).assist.listDeleteBlockers(sessionId), []);

  const commandId = randomUUID();
  expectCommandAccepted(await post(workspaceId, sessionId, { command_id: commandId,
    expected_revision: await currentRevision(sessionId) }), 200, commandId);

  assert.equal(await countOf(sql`select count(*)::text as c from assist_sessions
    where id = ${sessionId}`), 0);
  assert.equal(await countOf(sql`select count(*)::text as c from assist_messages
    where session_id = ${sessionId}`), 0);
  const request = (await sql<{ task_id: string | null; source_message_seq: string | null;
    digest: string | null; detached: string | null }>`select task_id,
      source_message_seq::text as source_message_seq,
      case when source_message_sha256 is null then null
        else length(source_message_sha256)::text end as digest,
      source_detached_at::text as detached
      from conversation_execution_requests where id = ${requestId}`.execute(app.db)).rows[0];
  assert.equal(request?.task_id, task.result.task_id, '执行请求仍指回它产生的 Task');
  assert.equal(request?.source_message_seq, '1', '来源序号留在请求行上');
  assert.equal(request?.digest, '32', '来源正文摘要留在请求行上（只可核对，不可还原）');
  assert.notEqual(request?.detached, null, '脱钩时刻写下了：这条来源已经不存在');
  assert.equal(await countOf(sql`select count(*)::text as c from tasks
    where id = ${task.result.task_id}`), 1, '独立任务不受会话删除影响');

  // 脱钩之后的请求不能再推进出第二个 Task/Run：来源已无法核对，失败关闭。
  await assert.rejects(
    () => applyConversationExecution(app.db, { workspaceId, requestId }),
    (caught: unknown) => String(caught).includes('这段讨论已被删除'));
});

test('0154 只补删除路径需要的 DELETE 授权：新账本可删，任务与长期记忆仍不可删', async () => {
  const privileges = (await sql<{ baselineFiles: boolean; recalls: boolean; recallFiles: boolean;
    undos: boolean; todos: boolean; todoEvents: boolean; turnScopes: boolean;
    supplements: boolean; tasks: boolean; memory: boolean }>`
    select has_table_privilege('relay_app', 'assist_message_baseline_files', 'DELETE') as "baselineFiles",
      has_table_privilege('relay_app', 'assist_message_recalls', 'DELETE') as "recalls",
      has_table_privilege('relay_app', 'assist_message_recall_files', 'DELETE') as "recallFiles",
      has_table_privilege('relay_app', 'assist_message_recall_undos', 'DELETE') as "undos",
      has_table_privilege('relay_app', 'assist_session_todo_snapshots', 'DELETE') as "todos",
      has_table_privilege('relay_app', 'assist_session_todo_events', 'DELETE') as "todoEvents",
      has_table_privilege('relay_app', 'assist_session_todo_turn_scopes', 'DELETE') as "turnScopes",
      has_table_privilege('relay_app', 'assist_delegation_supplements', 'DELETE') as "supplements",
      has_table_privilege('relay_app', 'tasks', 'DELETE') as "tasks",
      has_table_privilege('relay_app', 'memory_items', 'DELETE') as "memory"`
    .execute(app.db)).rows[0];
  assert.equal(privileges?.baselineFiles, true);
  assert.equal(privileges?.recalls, true);
  assert.equal(privileges?.recallFiles, true);
  assert.equal(privileges?.undos, true);
  assert.equal(privileges?.todos, true);
  assert.equal(privileges?.todoEvents, true);
  assert.equal(privileges?.turnScopes, true);
  assert.equal(privileges?.supplements, true);
  assert.equal(privileges?.tasks, false, '授权不覆盖独立任务');
  assert.equal(privileges?.memory, false, '长期记忆有自己的停用入口，删会话不等于遗忘');
});

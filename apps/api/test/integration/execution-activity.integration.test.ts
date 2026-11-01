import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { readExecutionActivity }
  from '../../src/application/execution-activity-projection.js';
import { createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction }
  from '../../src/application/unit-of-work.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase }
  from './integration-support.js';

/**
 * ENG-OBS-02：会话执行活动投影的只读出口（迁移 0156 + /assist-sessions/:id/activity）。
 *
 * 这里锁住四类事实：
 *   1. 观察时间只由真实业务写入产生，读取投影不回填、不改写账本；
 *   2. 阶段跟着真实证据走（排队/领取/模型首响应/工具执行/审批/失败/待核对），
 *      在途窗口不会被提前判成「永久未执行」；
 *   3. UNKNOWN 的后续核对只更新投影，原动作身份、settled_at 与账本状态逐字不变；
 *   4. 消息分页以最新优先，`has_more` 由 limit+1 的可见行决定，过滤间隙不误判。
 *
 * 所有用例都跑在真实 PostgreSQL 上；HTTP 用例同时核对路由响应形状。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-execution-activity');
const roots: string[] = [];
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => {
  await api?.stop();
  await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly policyId: string;
  readonly canonicalRoot: string;
}

/** 一个带真实受管目录、连接与策略的最小会话作用域；工具恢复判定需要这些身份。 */
async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'relay-执行活动-'));
  roots.push(root);
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `activity-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '活动投影项目', projectType: 'DEVELOPMENT' });
  });
  const resource = await registerManagedResource(app.db,
    { workspaceId, projectId, rootPath: root });
  const connectionId = await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(workspaceId, 'update');
    const connection = await repositories.gateway.insertConnection({ id: randomUUID(),
      workspaceId, projectId, config: { root_path: resource.canonicalRoot } });
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_READ');
    await repositories.gateway.addConnectionCapability(connection.id, 'FILE_QUERY');
    await repositories.workspaces.bumpAuthority(workspaceId);
    return connection.id;
  });
  const policy = await createGatewayPolicy(app.db, { workspaceId, projectId,
    capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, taskId: null, title: '执行活动会话' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '请读取这份文件', intent: 'DISCUSS' });
  return { workspaceId, projectId, sessionId: session.result.session_id,
    messageId: requested.result.assistant_message_id, resourceId: resource.resourceId,
    connectionId, policyId: policy.policyId, canonicalRoot: resource.canonicalRoot };
}

async function claim(f: Fixture): Promise<void> {
  const claimed = await createRepositories(app.db).assist
    .claimPendingMessage(f.messageId, `activity-worker-${randomUUID()}`);
  assert.equal(claimed, true, '测试消息应当能在未被领取时被本用例领取');
}

async function activity(f: Fixture, options: { detail?: 'summary' | 'full';
  limit?: number } = {}) {
  const snapshot = await readExecutionActivity(app.db, { workspaceId: f.workspaceId,
    sessionId: f.sessionId, ...options });
  const message = snapshot.messages.find((item) => item.message_id === f.messageId);
  assert.ok(message !== undefined, '投影必须包含本用例刚创建的消息');
  return { snapshot, message };
}

async function insertOperation(f: Fixture, input: { id?: string; intentKey: string;
  status: 'PREPARED' | 'WAITING_APPROVAL' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED'
    | 'UNKNOWN' | 'DENIED'; updatedAt?: Date }): Promise<string> {
  const id = input.id ?? randomUUID();
  await sql`insert into logical_operations (id, workspace_id, project_id, origin,
    task_id, run_id, step_id, import_job_id, intent_key,
    connection_id, connection_version, connection_config, policy_id, policy_version,
    capability_key, action_type, normalized_target, params_hash, params, resource_id, status,
    updated_at)
    values (${id}, ${f.workspaceId}, ${f.projectId}, 'AGENT_SESSION_READ',
      null, null, null, null, ${input.intentKey},
      ${f.connectionId}, 1, ${JSON.stringify({ root_path: f.canonicalRoot })}::jsonb,
      ${f.policyId}, 1, 'FILE_READ', 'READ_FILE', ${f.canonicalRoot},
      ${Buffer.alloc(32)}, '{}'::jsonb, ${f.resourceId}, ${input.status},
      ${input.updatedAt ?? new Date()})`.execute(app.db);
  return id;
}

async function insertInvocation(f: Fixture, input: { operationId: string;
  status: 'PREPARED' | 'DISPATCHING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'NOT_EXECUTED';
  dispatchedAt?: Date | null; resolvedAt?: Date | null }): Promise<string> {
  const id = randomUUID();
  await sql`insert into invocation_attempts (id, operation_id, origin, task_id, run_id,
    resource_id, attempt_number, status, authority_revision, connection_version,
    connection_config, ownership_epoch, worker_id, worker_epoch, resource_claim_id,
    claim_token, claim_epoch, result_ref, dispatched_at, resolved_at)
    values (${id}, ${input.operationId}, 'AGENT_SESSION_READ', null, null,
      ${f.resourceId}, 1, ${input.status}, 0, 1,
      '{}'::jsonb, null, null, null, null, null, null, null,
      ${input.dispatchedAt ?? null}, ${input.resolvedAt ?? null})`.execute(app.db);
  return id;
}

async function insertToolCall(f: Fixture, input: {
  id?: string; round?: number; ordinal?: number; toolName?: string;
  operationId?: string | null; status?: 'REQUESTED' | 'SETTLED' | 'UNKNOWN' | 'ABANDONED'
    | 'REJECTED'; settledAt?: Date | null; rejectionReason?: string | null;
  } = {}): Promise<string> {
  const id = input.id ?? randomUUID();
  await sql`insert into session_tool_calls (id, session_id, message_id, round, ordinal,
    tool_name, arguments, arguments_sha256, provider_tool_call_id, operation_id, status,
    rejection_reason, rejection_detail, result_digest, requested_at, settled_at)
    values (${id}, ${f.sessionId}, ${f.messageId}, ${input.round ?? 0}, ${input.ordinal ?? 0},
      ${input.toolName ?? 'read_file'}, '{}'::jsonb, ${'0'.repeat(64)},
      ${`call-${id}`}, ${input.operationId ?? null}, ${input.status ?? 'REQUESTED'},
      ${input.rejectionReason ?? null}, null,
      ${input.status === 'SETTLED' ? 'digest' : null}, now(),
      ${input.settledAt ?? null})`.execute(app.db);
  return id;
}

async function setMessage(f: Fixture, input: { status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  | 'CANCELLED'; errorCode?: string | null; content?: string | null;
  cancelRequested?: boolean; settledAt?: Date | null }) {
  await sql`update assist_messages set status = ${input.status},
    error_code = ${input.errorCode ?? null},
    content = ${input.content ?? null},
    cancel_requested = ${input.cancelRequested ?? false},
    settled_at = ${input.settledAt ?? (input.status === 'RUNNING' ? null : new Date())},
    updated_at = now()
    where id = ${f.messageId}`.execute(app.db);
}

async function messageRow(id: string) {
  return (await sql<{ status: string; claimed_at: Date | null; settled_at: Date | null;
    content: string | null; cancel_requested: boolean }>`select status, claimed_at,
      settled_at, content, cancel_requested from assist_messages where id = ${id}`
    .execute(app.db)).rows[0]!;
}

function activityOf(message: Awaited<ReturnType<typeof activity>>['message'], kind: string) {
  return (message.activities ?? []).filter((item) => item.kind === kind);
}

test('0156 观察时间列存在且历史行保持 NULL；领取写入 claimed_at，绑定写入 bound_at', async () => {
  const columns = (await sql<{ table_name: string; column_name: string; data_type: string }>`
    select table_name, column_name, data_type from information_schema.columns
    where (table_name = 'assist_messages' and column_name in ('claimed_at', 'settled_at'))
      or (table_name = 'session_tool_calls' and column_name = 'bound_at')`
    .execute(app.db)).rows;
  assert.deepEqual(columns.map((row) => `${row.table_name}.${row.column_name}:${row.data_type}`)
    .sort(), ['assist_messages.claimed_at:timestamp with time zone',
      'assist_messages.settled_at:timestamp with time zone',
      'session_tool_calls.bound_at:timestamp with time zone'].sort());

  const f = await fixture();
  const before = await messageRow(f.messageId);
  const legacy = await activity(f);
  assert.equal(legacy.message.claimed_at, null);
  assert.equal(legacy.message.settled_at, null);
  assert.equal(legacy.message.phase.view, 'WAITING_WORKER');
  assert.equal(legacy.message.phase.detail, '已排队，等待执行');
  assert.equal(legacy.message.phase.since, legacy.message.created_at);
  assert.equal(before.claimed_at, null, '投影读取不得回填 claimed_at');

  await claim(f);
  const claimed = await activity(f);
  assert.notEqual(claimed.message.claimed_at, null);
  assert.equal(claimed.message.claimed_at, claimed.message.phase.since);
  assert.equal(claimed.message.phase.view, 'PREPARING_CONTEXT');
  assert.equal(claimed.message.phase.detail, '已领取，准备本次请求');
  assert.equal(claimed.message.settled_at, null);

  const toolCallId = await insertToolCall(f, { toolName: 'list_directory' });
  const operationId = await insertOperation(f, { intentKey: `session-read:${toolCallId}`,
    status: 'PREPARED' });
  const attached = await new SessionToolCallRepository(app.db)
    .attachOperation(toolCallId, operationId, 'AGENT_SESSION_READ');
  assert.equal(attached, true, '绑定同源 Operation 必须成功');
  const bound = (await sql<{ bound_at: Date | null; operation_id: string | null }>`
    select bound_at, operation_id from session_tool_calls where id = ${toolCallId}`
    .execute(app.db)).rows[0]!;
  assert.equal(bound.operation_id, operationId);
  assert.notEqual(bound.bound_at, null, 'attachOperation 必须留下真实绑定时间');
});

test('阶段由模型账本与工具证据推进，HTTP full/summary 使用同一指纹', async () => {
  const f = await fixture();
  await claim(f);
  const callId = randomUUID();
  await new ModelCallRepository(app.db).begin(callId, { workspaceId: f.workspaceId,
    kind: 'ASSIST', assistMessageId: f.messageId },
    { provider: 'test', model: 'test-model', configFingerprint: '0'.repeat(64) });
  const waiting = await activity(f);
  assert.equal(waiting.message.phase.view, 'WAITING_MODEL_RESPONSE');
  assert.equal(waiting.message.phase.detail, '模型请求已登记，等待响应');
  const model = activityOf(waiting.message, 'MODEL_CALL')[0]!;
  assert.equal(model.state.view, 'WAITING_RESPONSE');
  assert.equal(model.started_at !== null, true);

  await new ModelCallRepository(app.db).recordFirstStreamEvent(callId, new Date());
  const streamed = await activity(f);
  assert.equal(streamed.message.phase.view, 'WAITING_TEXT');
  assert.equal(streamed.message.phase.detail, '模型已响应，等待文本');
  assert.equal(activityOf(streamed.message, 'MODEL_CALL')[0]!.state.view, 'WAITING_TEXT');

  await new ModelCallRepository(app.db).recordFirstTextDelta(callId, new Date());
  const receiving = await activity(f);
  assert.equal(receiving.message.phase.view, 'RECEIVING_TEXT');
  assert.equal(receiving.message.phase.detail, '正在接收回复');

  const fullResponse = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/activity?detail=full&limit=200`));
  assert.equal(fullResponse.status, 200, fullResponse.text);
  const full = fullResponse.body as { messages: { message_id: string;
    phase: { view: string }; content_fingerprint: string;
    activities?: { kind: string }[] }[] };
  const fullMessage = full.messages.find((item) => item.message_id === f.messageId)!;
  assert.equal(fullMessage.phase.view, 'RECEIVING_TEXT');
  assert.ok(fullMessage.activities?.some((item) => item.kind === 'MODEL_CALL'));

  const summaryResponse = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/activity?detail=summary&limit=200`));
  assert.equal(summaryResponse.status, 200, summaryResponse.text);
  const summary = summaryResponse.body as { messages: { message_id: string;
    content_fingerprint: string; activities?: unknown }[] };
  const summaryMessage = summary.messages.find((item) => item.message_id === f.messageId)!;
  assert.equal(summaryMessage.activities, undefined, 'summary 不返回活动明细');
  assert.equal(summaryMessage.content_fingerprint, fullMessage.content_fingerprint,
    'summary 与 full 必须按同一固定信号计算指纹');
});

test('指纹只跟随内容事实：心跳 updated_at 不改变，证据变化才改变', async () => {
  const f = await fixture();
  await claim(f);
  const first = await activity(f, { detail: 'summary' });
  const fingerprint = first.message.content_fingerprint;
  await sql`update assist_messages set updated_at = updated_at + interval '1 second'
    where id = ${f.messageId}`.execute(app.db);
  const heartbeats = await activity(f, { detail: 'summary' });
  assert.equal(heartbeats.message.content_fingerprint, fingerprint,
    '心跳时间不是执行内容，不能改变指纹');
  assert.equal(activityOf(first.message, 'MODEL_CALL').length,
    activityOf(heartbeats.message, 'MODEL_CALL').length);

  const callId = randomUUID();
  await new ModelCallRepository(app.db).begin(callId, { workspaceId: f.workspaceId,
    kind: 'ASSIST', assistMessageId: f.messageId },
    { provider: 'test', model: 'test-model', configFingerprint: '1'.repeat(64) });
  const evidence = await activity(f, { detail: 'summary' });
  assert.notEqual(evidence.message.content_fingerprint, fingerprint);
  const repeated = await activity(f, { detail: 'summary' });
  assert.equal(repeated.message.content_fingerprint, evidence.message.content_fingerprint,
    '同一事实的重复读取必须稳定');
  const full = await activity(f, { detail: 'full' });
  assert.equal(full.message.content_fingerprint, evidence.message.content_fingerprint,
    'summary / full 的变化检测口径一致');
});

test('在途工具不被提前判成未执行；审批、已知失败和待核对各有真实阶段', async () => {
  const f = await fixture();
  await claim(f);
  const toolCallId = await insertToolCall(f);
  const requested = await activity(f);
  assert.equal(requested.message.phase.view, 'RUNNING_TOOL');
  assert.equal(requested.message.phase.detail, '正在执行工具');
  assert.equal(requested.message.gaps.length, 0, '正常在途窗口不是待核对事项');
  const pendingTool = activityOf(requested.message, 'TOOL_CALL')[0]!;
  assert.equal(pendingTool.recovery?.disposition, 'UNRESOLVED_OPEN');
  assert.equal(pendingTool.recovery?.effective_outcome, null,
    'operation_id 为空且消息仍在执行时不得宣称永久未执行');

  const operationId = await insertOperation(f, { intentKey: `session-read:${toolCallId}`,
    status: 'PREPARED' });
  await new SessionToolCallRepository(app.db)
    .attachOperation(toolCallId, operationId, 'AGENT_SESSION_READ');
  const prepared = await activity(f);
  assert.equal(prepared.message.phase.view, 'RUNNING_TOOL');
  assert.equal(prepared.message.phase.detail, '工具请求已登记，准备执行');
  assert.equal(prepared.message.gaps.length, 0);

  await sql`update logical_operations set status = 'WAITING_APPROVAL',
    updated_at = now() where id = ${operationId}`.execute(app.db);
  const approval = await activity(f);
  assert.equal(approval.message.phase.view, 'WAITING_APPROVAL');
  assert.equal(approval.message.phase.detail, '等待审批');
  assert.equal(approval.message.gaps.length, 0, '等待审批是在途状态，不是证据缺口');

  await sql`update logical_operations set status = 'FAILED', updated_at = now()
    where id = ${operationId}`.execute(app.db);
  const notExecuted = await activity(f);
  assert.equal(notExecuted.message.phase.view, 'TOOL_NOT_EXECUTED');
  const notExecutedTool = activityOf(notExecuted.message, 'TOOL_CALL')[0]!;
  assert.equal(notExecutedTool.recovery?.disposition, 'CONFIRMED_NOT_EXECUTED');
  assert.equal(notExecutedTool.state.terminal, false, '运行时尚未结算这一行，不冒充已结算');

  await insertInvocation(f, { operationId, status: 'FAILED',
    dispatchedAt: new Date(Date.now() - 1_000), resolvedAt: new Date() });
  const failed = await activity(f);
  assert.equal(failed.message.phase.view, 'TOOL_FAILED');
  const failedTool = activityOf(failed.message, 'TOOL_CALL')[0]!;
  assert.equal(failedTool.recovery?.disposition, 'CONFIRMED_FAILURE',
    'Invocation FAILED 是已知失败证据，不是 UNKNOWN');
  assert.equal(failedTool.recovery?.effective_outcome, 'FAILED');
  assert.equal(failedTool.state.view, 'FAILED');
});

test('UNKNOWN 的后续核对只更新投影：不改写账本、不新增动作身份、不重新派发', async () => {
  const f = await fixture();
  await claim(f);
  const toolCallId = await insertToolCall(f);
  const operationId = await insertOperation(f, { intentKey: `session-read:${toolCallId}`,
    status: 'UNKNOWN', updatedAt: new Date(Date.now() - 4_000) });
  // UNKNOWN 必须保留原 Operation 身份（0060 的 CHECK），因此先落 REQUESTED 再一并推进。
  await sql`update session_tool_calls set operation_id = ${operationId},
    status = 'UNKNOWN', settled_at = ${new Date(Date.now() - 5_000)}
    where id = ${toolCallId}`.execute(app.db);
  await insertInvocation(f, { operationId, status: 'UNKNOWN',
    dispatchedAt: new Date(Date.now() - 4_000) });

  const ledgerBefore = (await sql<{ status: string; settled_at: Date | null;
    operation_id: string | null }>`select status, settled_at, operation_id
    from session_tool_calls where id = ${toolCallId}`.execute(app.db)).rows[0]!;
  const countsBefore = (await sql<{ operations: string; invocations: string }>`
    select (select count(*)::text from logical_operations) as operations,
      (select count(*)::text from invocation_attempts) as invocations`
    .execute(app.db)).rows[0]!;

  const unresolved = await activity(f);
  assert.equal(unresolved.message.phase.view, 'WAITING_CONFIRMATION');
  assert.equal(unresolved.message.phase.detail, '工具有结果待核对');
  assert.equal(unresolved.message.gaps.length, 1);
  assert.equal(activityOf(unresolved.message, 'TOOL_CALL')[0]!.recovery?.disposition,
    'UNRESOLVED_UNKNOWN');
  assert.equal(activityOf(unresolved.message, 'TOOL_CALL')[0]!.recovery?.operation_ref,
    operationId);

  // 证据晚于 UNKNOWN 才可确认真实结果：先造一个时间上更早的 SUCCEEDED，不得被采信。
  await sql`update logical_operations set status = 'SUCCEEDED',
    updated_at = now() - interval '11 seconds' where id = ${operationId}`.execute(app.db);
  const unproven = await activity(f);
  assert.equal(activityOf(unproven.message, 'TOOL_CALL')[0]!.recovery?.disposition,
    'ORDERING_UNPROVEN');
  await sql`update logical_operations set status = 'SUCCEEDED',
    updated_at = now() + interval '2 seconds' where id = ${operationId}`.execute(app.db);
  const reconciled = await activity(f);
  const recovered = activityOf(reconciled.message, 'TOOL_CALL')[0]!;
  assert.equal(recovered.recovery?.disposition, 'CONFIRMED_SUCCESS');
  assert.equal(recovered.recovery?.reconciled, true);
  assert.equal(recovered.state.view, 'SUCCEEDED');

  const ledgerAfter = (await sql<{ status: string; settled_at: Date | null;
    operation_id: string | null }>`select status, settled_at, operation_id
    from session_tool_calls where id = ${toolCallId}`.execute(app.db)).rows[0]!;
  assert.deepEqual(ledgerAfter, ledgerBefore, '投影读取不得改写 UNKNOWN 账本');
  const countsAfter = (await sql<{ operations: string; invocations: string }>`
    select (select count(*)::text from logical_operations) as operations,
      (select count(*)::text from invocation_attempts) as invocations`
    .execute(app.db)).rows[0]!;
  assert.deepEqual(countsAfter, countsBefore,
    '核对不得创建新 Operation / Invocation，也不得重新派发');
});

test('prepare 与 attach 之间崩溃：按稳定动作身份核对，终态前不判永久未执行', async () => {
  const f = await fixture();
  await claim(f);
  const toolCallId = await insertToolCall(f);
  const operationId = await insertOperation(f, { id: toolCallId,
    intentKey: `session-read:${toolCallId}`, status: 'PREPARED' });
  const crashWindow = await activity(f);
  const tool = activityOf(crashWindow.message, 'TOOL_CALL')[0]!;
  assert.equal(tool.recovery?.disposition, 'UNRESOLVED_OPEN');
  assert.equal(tool.recovery?.operation_ref, toolCallId,
    'operation_id 为空时仍应按既有稳定动作身份找到 prepare 已提交的 Operation');
  const unbound = (await sql<{ operation_id: string | null }>`
    select operation_id from session_tool_calls where id = ${toolCallId}`
    .execute(app.db)).rows[0]!;
  assert.equal(unbound.operation_id, null, '只读投影不得替 attach 回写身份');

  await sql`update logical_operations set status = 'FAILED', updated_at = now()
    where id = ${operationId}`.execute(app.db);
  const notExecuted = await activity(f);
  assert.equal(activityOf(notExecuted.message, 'TOOL_CALL')[0]!.recovery?.disposition,
    'CONFIRMED_NOT_EXECUTED');

  await setMessage(f, { status: 'FAILED', errorCode: 'LEASE_LOST' });
  const terminal = await activity(f);
  assert.equal(terminal.message.phase.view, 'INTERRUPTED');
  assert.equal(terminal.message.phase.detail, '执行中断；部分结果可能未确认');

  const f2 = await fixture();
  const orphan = await insertToolCall(f2);
  await setMessage(f2, { status: 'FAILED', errorCode: 'LEASE_LOST' });
  const orphanRead = await activity(f2);
  assert.equal(activityOf(orphanRead.message, 'TOOL_CALL')[0]!.recovery?.disposition,
    'NO_OPERATION', '消息已终态且没有任何已提交动作时，缺席才是结论');
  assert.equal(activityOf(orphanRead.message, 'TOOL_CALL')[0]!.recovery?.effective_outcome,
    'NOT_EXECUTED');
  assert.equal(orphan.length > 0, true);
});

test('取消意图在生成方结算前是可读阶段，并且不凭空记录取消起点', async () => {
  const f = await fixture();
  await claim(f);
  await setMessage(f, { status: 'RUNNING', cancelRequested: true });
  const cancelling = await activity(f);
  assert.equal(cancelling.message.phase.view, 'CANCELLING');
  assert.equal(cancelling.message.phase.detail, '正在取消；等待当前动作安全结束');
  assert.equal(cancelling.message.phase.since, null, '没有取消发起时刻时不得补造');
  await setMessage(f, { status: 'CANCELLED' });
  const cancelled = await activity(f);
  assert.equal(cancelled.message.phase.view, 'CANCELLED',
    '用户取消（error_code 为 NULL）的回复也必须还在列表里，不能被 NULL 比较滤掉');
  assert.notEqual(cancelled.message.settled_at, null);
});

test('消息分页最新优先；has_more 由 limit+1 的真实可见行决定；无参数保留完整历史', async () => {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: 'paginate' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId,
      title: '分页项目', projectType: 'GENERAL' });
  });
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, taskId: null, title: '长会话' });
  const sessionId = session.result.session_id;

  // 205 条用户消息 + 1 条正常回复 + 1 条被插话消费的占位回复（后者必须从可见集中排除）。
  for (let seq = 1; seq <= 205; seq += 1) {
    await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
      content, created_at, updated_at)
      values (${randomUUID()}, ${sessionId}, ${seq}, 'USER', 'COMPLETED', 'DISCUSS',
        ${`消息 ${seq}`}, now(), now())`.execute(app.db);
  }
  const assistantId = randomUUID();
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
    content, created_at, updated_at)
    values (${assistantId}, ${sessionId}, 206, 'ASSISTANT', 'COMPLETED', 'DISCUSS',
      '最终回复', now(), now())`.execute(app.db);
  await sql`insert into assist_messages (id, session_id, seq, role, status, intent,
    content, error_code, created_at, updated_at)
    values (${randomUUID()}, ${sessionId}, 207, 'ASSISTANT', 'CANCELLED', 'DISCUSS',
      null, 'STEERED', now(), now())`.execute(app.db);

  const base = workspacePath(workspaceId, `/assist-sessions/${sessionId}/messages`);
  const legacy = await api.get(base);
  assert.equal(legacy.status, 200, legacy.text);
  const all = legacy.body as { items: { seq: string }[]; has_more: boolean;
    next_before_seq: string | null };
  assert.equal(all.items.length, 206, '无分页参数时必须返回完整可见历史（导出兼容）');
  assert.equal(all.has_more, false);
  assert.equal(all.next_before_seq, null);
  assert.equal(all.items[all.items.length - 1]!.seq, '206');

  const latest = await api.get(`${base}?limit=200`);
  assert.equal(latest.status, 200, latest.text);
  const page = latest.body as { items: { seq: string }[]; has_more: boolean;
    next_before_seq: string | null };
  assert.equal(page.items.length, 200);
  assert.equal(page.items[0]!.seq, '7', '最新一页从倒数第 200 条开始');
  assert.equal(page.items[page.items.length - 1]!.seq, '206');
  assert.equal(page.has_more, true);
  assert.equal(page.next_before_seq, '7');

  const earlier = await api.get(`${base}?limit=5&before_seq=7`);
  assert.equal(earlier.status, 200, earlier.text);
  const older = earlier.body as { items: { seq: string }[]; has_more: boolean;
    next_before_seq: string | null };
  assert.deepEqual(older.items.map((item) => item.seq), ['2', '3', '4', '5', '6']);
  assert.equal(older.has_more, true, '仍有第 1 条未读，不能用 next_before_seq 猜测');
  assert.equal(older.next_before_seq, '2');

  const oldest = await api.get(`${base}?limit=5&before_seq=2`);
  assert.deepEqual((oldest.body as { items: { seq: string }[] }).items.map((item) => item.seq), ['1']);
  assert.equal((oldest.body as { has_more: boolean }).has_more, false);
});

test('跨 Workspace 与跨会话一律 404；活动投影不泄露其他作用域', async () => {
  const f = await fixture();
  const other = await fixture();
  const own = await api.get(workspacePath(f.workspaceId,
    `/assist-sessions/${f.sessionId}/activity?detail=full`));
  assert.equal(own.status, 200, own.text);
  const wrongWorkspace = await api.get(workspacePath(other.workspaceId,
    `/assist-sessions/${f.sessionId}/activity?detail=full`));
  assert.equal(wrongWorkspace.status, 404, wrongWorkspace.text);
  const wrongMessages = await api.get(workspacePath(other.workspaceId,
    `/assist-sessions/${f.sessionId}/messages`));
  assert.equal(wrongMessages.status, 404, wrongMessages.text);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { decideExpiredGenerationRecovery, GENERATION_RECOVERY_MAX_ATTEMPTS }
  from '../../src/application/assist-generation-resume.js';
import { createGatewayPolicy, registerManagedResource }
  from '../../src/application/gateway-configuration.js';
import { createRepositories, withTransaction }
  from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { AssistModelPort, AssistRequest, AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * Durable Task Continuation（0163，2026-11-12）的真实 PG / 真实生成 tick 验收。
 *
 * 锁定的语义：
 *   1. 意外中断不再等于业务失败：同一消息身份重新排队并接续完成，不新增第二条回复；
 *   2. 已完成的工具回合从持久检查点回灌，不再派发同一工具；
 *   3. 未结算的只读请求按原账本身份重新校验后继续；
 *   4. 有副作用的请求未结算时如实阻塞（RECOVERY_BLOCKED_UNRESOLVED_TOOL），不盲重试；
 *   5. 用户停止意图优先；到上界停止自动重试；重复扫描幂等。
 *
 * 崩溃现场用「消息 RUNNING + 租约过期」构造——这正是 Worker 被杀后留下的持久事实；
 * 模型走脚本端口，不依赖真实 Provider。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-generation-continuation');
let dataRoot: string;
let storage: ManagedContentStore;
const temporaryRoots: string[] = [];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

interface Fixture { workspaceId: string; projectId: string }

async function fixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `cont-${workspaceId}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: '接续项目',
      projectType: 'GENERAL' });
    await repositories.projects.insertProjectState(projectId, 'PLANNING');
  });
  return { workspaceId, projectId };
}

async function pendingMessage(workspaceId: string, projectId: string, content = '继续原任务'): Promise<{
  sessionId: string; messageId: string
}> {
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId, title: '接续会话' });
  const requested = await requestAssistMessage(app.db, { workspaceId,
    sessionId: created.result.session_id, commandId: randomUUID(), content, intent: 'DISCUSS' });
  return { sessionId: created.result.session_id,
    messageId: requested.result.assistant_message_id };
}

/** 把消息摆成「旧 Worker 领取后被杀」的持久现场：RUNNING + 租约过期。 */
async function markInterrupted(messageId: string, attempt: number): Promise<void> {
  await sql`update assist_messages set status = 'RUNNING', worker_id = 'dead-worker',
    content = null, error_code = null, provider_error_kind = null,
    generation_attempt = ${attempt}, interrupted_at = now(),
    interruption_reason = 'LEASE_LOST', updated_at = now() - interval '1 minute'
    where id = ${messageId}`.execute(app.db);
}

function scriptedPort(replies: readonly AssistResult[]): {
  port: AssistModelPort; requests: AssistRequest[]
} {
  const requests: AssistRequest[] = [];
  return {
    requests,
    port: {
      identity: { provider: 'fake', model: 'fake-model-v1',
        configFingerprint: 'a'.repeat(64) },
      assist: async (request) => {
        requests.push(request);
        const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
        return reply ?? { kind: 'CONTENT', content: '已完成', providerRequestId: 'cont-reply',
          usage: { inputTokens: 11, outputTokens: 7 } };
      },
    },
  };
}

function reply(content: string, providerRequestId: string): AssistResult {
  return { kind: 'CONTENT', content, providerRequestId,
    usage: { inputTokens: 11, outputTokens: 7 } };
}

async function readMessage(messageId: string): Promise<{
  status: string; content: string | null; error_code: string | null;
  generation_attempt: number; interruption_reason: string | null;
  worker_id: string | null; cancel_requested: boolean;
}> {
  const row = await sql<{ status: string; content: string | null; error_code: string | null;
    generation_attempt: number; interruption_reason: string | null; worker_id: string | null;
    cancel_requested: boolean }>`select status, content, error_code, generation_attempt,
      interruption_reason, worker_id, cancel_requested from assist_messages where id = ${messageId}`
    .execute(app.db);
  return row.rows[0]!;
}

test('事故中断后同一消息身份自动接续，不产生第二条回复', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId);
  // 崩溃现场：旧 Worker 领取后没有结算就退出。
  const claimed = await createRepositories(app.db).assist
    .claimNextPendingMessage('dead-worker');
  assert.equal(claimed?.id, m.messageId);
  await sql`update assist_messages set updated_at = now() - interval '1 minute'
    where id = ${m.messageId}`.execute(app.db);

  const scripted = scriptedPort([reply('接续完成', 'cont-1')]);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'resume-worker',
    storage, modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(outcome?.messageId, m.messageId);
  assert.equal(outcome?.status, 'COMPLETED');
  const settled = await readMessage(m.messageId);
  assert.equal(settled.status, 'COMPLETED');
  assert.equal(settled.content, '接续完成');
  assert.equal(settled.generation_attempt, 2);
  assert.equal(settled.interruption_reason, 'LEASE_LOST');
  assert.equal(settled.cancel_requested, false);
  // 同一会话只有一条 USER 与一条 ASSISTANT：恢复不新增伪造消息。
  const counts = (await sql<{ role: string; count: string }>`select role, count(*)::text as count
    from assist_messages where session_id = ${m.sessionId} group by role order by role`
    .execute(app.db)).rows;
  assert.deepEqual(counts, [{ role: 'ASSISTANT', count: '1' }, { role: 'USER', count: '1' }]);
  // 旧 Worker 的迟到结算不能覆盖新尝试的结论。
  assert.equal(await createRepositories(app.db).assist.settleGeneration({
    messageId: m.messageId, workerId: 'dead-worker', status: 'COMPLETED',
    content: '迟到的旧回复', errorCode: null, providerRequestId: 'late',
    usageInputTokens: 1, usageOutputTokens: 1 }), false);
  assert.equal((await readMessage(m.messageId)).content, '接续完成');
});

test('已完成的工具回合从检查点回灌，不重新派发', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '读取配置');
  await markInterrupted(m.messageId, 2);
  // 第一回合：模型请求 list_directory，结果已经在中断前回传并落进检查点。
  const calls = [{ provider_tool_call_id: 'call-read-1', name: 'list_directory',
    arguments: { path: '.' } }];
  await createRepositories(app.db).assist.insertGenerationRound({
    id: randomUUID(), messageId: m.messageId, attempt: 1, round: 0,
    assistantTurn: { calls, steers_before: [] } });
  await createRepositories(app.db).assist.appendGenerationRoundResult({
    messageId: m.messageId, round: 0,
    result: { provider_tool_call_id: 'call-read-1', name: 'list_directory',
      content: '{"entries":["AGENTS.md"]}', is_error: false, slot: 'READ' },
    usage: { input_tokens: 9, output_tokens: 4, cache_read_tokens: null,
      cache_creation_tokens: null },
    providerRequestId: 'cont-round-0' });

  const scripted = scriptedPort([reply('目录里只有 AGENTS.md', 'cont-2')]);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'resume-worker',
    storage, modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(outcome?.status, 'COMPLETED');
  // 模型看到的是中断前那一份工具结果，并且从第 1 轮继续。
  // 结算后的自动记忆提取也会用同一端口外呼一次；主生成是唯一带工具回合的请求。
  const primary = scripted.requests.find((request) => request.toolTurns !== undefined);
  assert.ok(primary !== undefined);
  const turns = primary.toolTurns ?? [];
  assert.equal(turns.length, 1, JSON.stringify(turns.map((turn) => ({
    calls: turn.calls.map((call) => call.providerToolCallId),
    results: turn.results.map((result) => result.providerToolCallId) }))));
  assert.equal(turns[0]!.calls[0]!.providerToolCallId, 'call-read-1');
  assert.equal(turns[0]!.results[0]!.content, '{"entries":["AGENTS.md"]}');
  // 没有重新派发：这次工具没有产生新的账本行。
  const ledger = (await sql<{ count: string }>`select count(*)::text as count
    from session_tool_calls where message_id = ${m.messageId}`.execute(app.db)).rows[0];
  assert.equal(ledger?.count, '0');
});

test('未结算的只读请求按原轮次重新校验后继续执行', async () => {
  const f = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'relay-continuation-'));
  temporaryRoots.push(root);
  await writeFile(join(root, 'README.md'), '# 接续\n继续读这一段。\n', 'utf8');
  const resource = await registerManagedResource(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, rootPath: root });
  const connectionId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.lockAuthority(f.workspaceId, 'update');
    await repositories.gateway.insertConnection({ id: connectionId,
      workspaceId: f.workspaceId, projectId: f.projectId,
      config: { root_path: resource.canonicalRoot } });
    await repositories.gateway.addConnectionCapability(connectionId, 'FILE_READ');
    await repositories.workspaces.bumpAuthority(f.workspaceId);
  });
  await createGatewayPolicy(app.db, { workspaceId: f.workspaceId, projectId: f.projectId,
    capability: 'FILE_READ', actionType: 'READ_FILE',
    targetPrefix: resource.canonicalRoot, decision: 'AUTO', maxPayloadBytes: 262144 });

  const m = await pendingMessage(f.workspaceId, f.projectId, '读 README');
  await sql`update assist_sessions set working_resource_id = ${resource.resourceId},
    working_directory_source = 'USER_PICKED' where id = ${m.sessionId}`.execute(app.db);
  await markInterrupted(m.messageId, 2);
  // 崩溃发生在模型已请求工具、结果尚未回传时：检查点有请求，没有结果。
  await createRepositories(app.db).assist.insertGenerationRound({
    id: randomUUID(), messageId: m.messageId, attempt: 1, round: 0,
    assistantTurn: { calls: [{ provider_tool_call_id: 'call-file-1', name: 'read_file',
      arguments: { relative_path: 'README.md' } }], steers_before: [] } });

  const scripted = scriptedPort([reply('README 要求继续读这一段', 'cont-3')]);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'resume-worker',
    storage, modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(outcome?.status, 'COMPLETED');
  // 结果重新取得并回传模型，账本行按原轮次/序号绑定真实 Gateway 动作。
  const primary = scripted.requests.find((request) => request.toolTurns !== undefined);
  assert.ok(primary !== undefined);
  const turns = primary.toolTurns ?? [];
  assert.equal(turns.length, 1);
  assert.match(turns[0]!.results[0]!.content, /继续读这一段/u);
  const ledger = (await sql<{ status: string; operation_id: string | null; round: number;
    ordinal: number }>`select status, operation_id, round, ordinal from session_tool_calls
    where message_id = ${m.messageId}`.execute(app.db)).rows;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.status, 'SETTLED');
  assert.ok(ledger[0]!.operation_id !== null);
  assert.deepEqual([ledger[0]!.round, ledger[0]!.ordinal], [0, 0]);
  // 磁盘没有被改动：只读动作重放不产生副作用。
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# 接续\n继续读这一段。\n');
});

test('有副作用请求未结算时如实阻塞，不重排也不派发', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '改文件');
  await markInterrupted(m.messageId, 2);
  await createRepositories(app.db).assist.insertGenerationRound({
    id: randomUUID(), messageId: m.messageId, attempt: 1, round: 0,
    assistantTurn: { calls: [{ provider_tool_call_id: 'call-write-1',
      name: 'apply_changeset', arguments: { changes: [] } }], steers_before: [] } });
  await sql`insert into session_tool_calls (id, session_id, message_id, round, ordinal,
    tool_name, arguments, arguments_sha256, provider_tool_call_id, status)
    values (${randomUUID()}, ${m.sessionId}, ${m.messageId}, 0, 0, 'apply_changeset',
      '{"changes":[]}'::jsonb, ${'b'.repeat(64)}, 'call-write-1', 'REQUESTED')`.execute(app.db);

  const scripted = scriptedPort([reply('不应发生', 'never')]);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'resume-worker',
    storage, modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(outcome, undefined);
  assert.equal(scripted.requests.length, 0);
  const blocked = await readMessage(m.messageId);
  assert.equal(blocked.status, 'FAILED');
  assert.equal(blocked.error_code, 'RECOVERY_BLOCKED_UNRESOLVED_TOOL');
  assert.equal(blocked.generation_attempt, 2);
});

test('用户停止意图优先：过期生成收口 CANCELLED，不自动恢复', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '停止');
  await markInterrupted(m.messageId, 1);
  await sql`update assist_messages set cancel_requested = true where id = ${m.messageId}`
    .execute(app.db);

  const scripted = scriptedPort([reply('不应发生', 'never')]);
  await runAssistGenerationTick(app.db, { workerId: 'resume-worker', storage,
    modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(scripted.requests.length, 0);
  const cancelled = await readMessage(m.messageId);
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.generation_attempt, 1);
});

test('到生成次数上界后停止自动重试并如实失败', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '反复崩溃');
  await markInterrupted(m.messageId, GENERATION_RECOVERY_MAX_ATTEMPTS);

  const scripted = scriptedPort([reply('不应发生', 'never')]);
  await runAssistGenerationTick(app.db, { workerId: 'resume-worker', storage,
    modelPort: scripted.port, leaseMs: 30_000 });

  assert.equal(scripted.requests.length, 0);
  const failed = await readMessage(m.messageId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error_code, 'RECOVERY_EXHAUSTED');
  assert.equal(failed.generation_attempt, GENERATION_RECOVERY_MAX_ATTEMPTS);
});

test('恢复扫描幂等：重排一次后重复扫描不再推进', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '幂等');
  await markInterrupted(m.messageId, 1);
  const repositories = createRepositories(app.db);
  const input = { olderThan: new Date(Date.now() + 60_000),
    maxAttempts: GENERATION_RECOVERY_MAX_ATTEMPTS,
    readOnlyTools: ['list_directory', 'read_file'] };
  const first = await repositories.assist.recoverExpiredGenerations(input);
  assert.deepEqual(first.requeued.map((item) => [item.messageId, item.generationAttempt]),
    [[m.messageId, 2]]);
  const second = await repositories.assist.recoverExpiredGenerations(input);
  assert.deepEqual(second.requeued, []);
  assert.deepEqual(second.blocked, []);
  assert.deepEqual(second.exhausted, []);
  assert.equal((await readMessage(m.messageId)).generation_attempt, 2);
});

test('会话删除带走生成检查点', async () => {
  const f = await fixture();
  const m = await pendingMessage(f.workspaceId, f.projectId, '删除');
  await createRepositories(app.db).assist.insertGenerationRound({
    id: randomUUID(), messageId: m.messageId, attempt: 1, round: 0,
    assistantTurn: { calls: [{ provider_tool_call_id: 'call-del', name: 'list_directory',
      arguments: { path: '.' } }], steers_before: [] } });
  const session = await createRepositories(app.db).assist.readSession(m.sessionId);
  const deleted = await createRepositories(app.db).assist
    .deleteSession(m.sessionId, session!.revision);
  assert.equal(deleted?.messages, 2);
  const remaining = (await sql<{ count: string }>`select count(*)::text as count
    from assist_generation_rounds where message_id = ${m.messageId}`.execute(app.db)).rows[0];
  assert.equal(remaining?.count, '0');
});

test('接续判定是纯函数且优先级固定', () => {
  const base = { cancelRequested: false, runningDelegation: false, unsafeTool: false,
    generationAttempt: 1, maxAttempts: 3 };
  assert.equal(decideExpiredGenerationRecovery(base), 'REQUEUE');
  assert.equal(decideExpiredGenerationRecovery({ ...base, cancelRequested: true }), 'CANCELLED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, runningDelegation: true }), 'DEFERRED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, unsafeTool: true }), 'BLOCKED');
  assert.equal(decideExpiredGenerationRecovery({ ...base, generationAttempt: 3 }), 'EXHAUSTED');
  // 用户停止优先于一切：即使有未核对动作也不再自动处理。
  assert.equal(decideExpiredGenerationRecovery({ ...base, cancelRequested: true,
    unsafeTool: true, generationAttempt: 9 }), 'CANCELLED');
});

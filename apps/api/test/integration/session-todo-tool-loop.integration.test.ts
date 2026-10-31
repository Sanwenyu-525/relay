import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { todoSettlementDigest } from '../../src/application/session-todo-tool.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot } from './api-harness.js';
import { assistantReadOrigin, runSessionReadonlyRounds } from
  '../../src/application/assistant-readonly-round.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { SessionTodoRepository } from '../../src/assist/session-todo-repository.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * todo_write 在真实主循环里的闭环（ADR-038，2026-10-30）。
 *
 * 直接跑声明与执行那一层（`runSessionReadonlyRounds`），不经过 HTTP，也不经过完整 tick：
 *   * 没有任何 Gateway 连接、没有任何可用工具，词表里仍然声明 `todo_write`（它不是文件工具）；
 *   * 脚本化 Fake 端口发一次 todo_write，工具结果真的回送给模型，带版本与计数；
 *   * 同一轮结束后快照落地、`session_tool_calls` 转 SETTLED 且不挂 Operation；
 *   * tasks / runs 仍为 0：写清单不是执行，也不启动执行。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-session-todo-loop');
let workspaceId: string;
let projectId: string;
let sessionId: string;
let assistantMessageId: string;
let dataRoot = '';

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  workspaceId = randomUUID();
  projectId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: '待办闭环' });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
    await repositories.projects.insertProject({ id: projectId, workspaceId, title: '待办闭环',
      projectType: 'DEVELOPMENT' });
  });
  // 普通 Agent 会话，无人设、无成员、无 Gateway 连接、无受管目录：
  // 这正是 P1.2 要证明的场景——清单能力不依赖文件连接。
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '待办会话', projectId });
  sessionId = session.result.session_id;
  const assist = createRepositories(app.db).assist;
  await assist.insertMessage({ id: randomUUID(), sessionId, seq: 1n, role: 'USER',
    status: 'COMPLETED', intent: 'DISCUSS', content: '开始干活', sources: [] });
  assistantMessageId = randomUUID();
  await assist.insertMessage({ id: assistantMessageId, sessionId, seq: 2n, role: 'ASSISTANT',
    status: 'RUNNING', intent: 'DISCUSS', content: null, sources: [] });
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

test('TL-20 无目录也能写清单：声明、回送、结算、不建 Task/Run', async () => {
  const items = [{ content: '读契约', status: 'completed' },
    { content: '跑集成测试', status: 'in_progress' }];
  const scripted = new FakeModelPort();
  const original = scripted.assist.bind(scripted);
  let declaredTools: readonly string[] = [];
  let fedBack: readonly { name: string; content: string }[] = [];
  scripted.assist = async (request) => {
    declaredTools = Array.from(new Set([...declaredTools,
      ...(request.tools ?? []).map((spec) => spec.name)]));
    const turns = request.toolTurns;
    if (turns !== undefined && turns.length > 0) {
      fedBack = turns.flatMap((turn) => turn.results
        .map((result) => ({ name: result.name, content: result.content })));
    }
    return original(request);
  };
  const assist = createRepositories(app.db).assist;
  const session = await assist.readSession(sessionId);
  const message = await assist.readMessage(assistantMessageId);
  assert.ok(session !== undefined && message !== undefined);

  const script = JSON.stringify([[{ name: 'todo_write',
    arguments: { items, expected_version: 0 } }]]);
  const prompt = `FAKE_ASSIST_TOOLS ${script}`;
  await runSessionReadonlyRounds(app.db, { session: session!, message: message!, availableTools: [],
    modelPort: scripted, signal: AbortSignal.timeout(60_000), system: '你是助手。',
    allowTodo: true, contextTurns: [{ role: 'user', content: prompt }],
    resolveOrigin: () => assistantReadOrigin(app.db, session!, message!.id) });

  assert.ok(declaredTools.includes('todo_write'),
    '没有 Gateway 连接和目录时，词表里仍应当有 todo_write；实际：' + JSON.stringify(declaredTools));
  const result = fedBack.find((entry) => entry.name === 'todo_write');
  assert.ok(result !== undefined, '工具结果必须回送给模型');
  const payload = JSON.parse(result!.content) as { version: number;
    counts: { total: number; inProgress: number } };
  assert.equal(payload.version, 1);
  assert.equal(payload.counts.total, 2);
  assert.equal(payload.counts.inProgress, 1);

  const snapshot = await new SessionTodoRepository(app.db).read(sessionId);
  assert.equal(snapshot?.version, 1);
  assert.deepEqual(snapshot?.items.map((item) => item.content), ['读契约', '跑集成测试']);

  const calls = await new SessionToolCallRepository(app.db).listBySession(sessionId);
  const todoCall = calls.find((row) => row.tool_name === 'todo_write');
  assert.ok(todoCall !== undefined);
  assert.equal(todoCall!.status, 'SETTLED');
  assert.equal(todoCall!.operation_id ?? null, null, 'todo_write 不产生 Gateway Operation');

  const runs = await sql<{ present: boolean }>`select exists(select 1 from runs r
    join tasks t on t.id = r.task_id where t.project_id = ${projectId}) as present`
    .execute(app.db);
  assert.equal(runs.rows[0]?.present, false, '写清单不得启动 Run');
  const tasks = await sql<{ present: boolean }>`select exists(select 1 from tasks
    where project_id = ${projectId}) as present`.execute(app.db);
  assert.equal(tasks.rows[0]?.present, false, '写清单不得建 Task');
});
test('TL-21 完整链路：真实会话创建→投递→生成入口→tool 写入→下一轮上下文读到', async () => {
  const workspace = randomUUID();
  const project = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspace, name: '全链路' });
    await repositories.workspaces.insertAuthorityRow(workspace);
    await repositories.projects.insertProject({ id: project, workspaceId: workspace, title: '全链路',
      projectType: 'DEVELOPMENT' });
  });
  const created = await createAssistSession(app.db, { workspaceId: workspace,
    commandId: randomUUID(), title: '全链路会话', projectId: project });
  const targetSession = created.result.session_id;
  const script = JSON.stringify([[{ name: 'todo_write',
    arguments: { items: [{ content: '全链路第一步', status: 'in_progress' }],
      expected_version: 0 } }]]);
  const port = new FakeModelPort();
  const original = port.assist.bind(port);
  let declared: readonly string[] = [];
  port.assist = async (request) => {
    declared = Array.from(new Set([...declared, ...(request.tools ?? []).map((spec) => spec.name)]));
    const turns = request.toolTurns !== undefined && request.toolTurns.length > 0
      ? request.turns
      : [{ role: 'user' as const, content: `FAKE_ASSIST_TOOLS ${script}` }];
    return original({ ...request, turns });
  };
  const sent = await requestAssistMessage(app.db, { workspaceId: workspace,
    sessionId: targetSession, commandId: randomUUID(), content: '把这件事做了' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: `todo-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  assert.equal(outcome?.messageId, sent.result.assistant_message_id);
  assert.ok(declared.includes('todo_write'),
    '真实主循环里应当声明 todo_write，实际：' + JSON.stringify(declared));

  const snapshot = await new SessionTodoRepository(app.db).read(targetSession);
  assert.equal(snapshot?.version, 1);
  assert.deepEqual(snapshot?.items.map((item) => item.content), ['全链路第一步']);
  const calls = await new SessionToolCallRepository(app.db).listBySession(targetSession);
  const todoCall = calls.find((row) => row.tool_name === 'todo_write');
  assert.equal(todoCall?.status, 'SETTLED');

  // 下一轮上下文：新消息的助手行应当能读到这一份当前快照。
  await createRepositories(app.db).assist.insertMessage({ id: randomUUID(),
    sessionId: targetSession, seq: 3n, role: 'USER', status: 'COMPLETED', intent: 'DISCUSS',
    content: '继续', sources: [] });
  const nextAssistant = randomUUID();
  await createRepositories(app.db).assist.insertMessage({ id: nextAssistant, sessionId: targetSession,
    seq: 4n, role: 'ASSISTANT', status: 'RUNNING', intent: 'DISCUSS', content: null, sources: [] });
  const block = await new SessionTodoRepository(app.db).readContextBlock(targetSession, nextAssistant);
  const afterSnapshot = await new SessionTodoRepository(app.db).read(targetSession);
  assert.ok(block.includes('全链路第一步'),
    '下一轮上下文应当包含当前清单；scope=' + String(afterSnapshot?.scopeKey) +
    ' version=' + String(afterSnapshot?.version) + ' block=' + JSON.stringify(block));
  assert.equal(await new SessionTodoRepository(app.db).read(targetSession) === undefined, false);
});

test('TL-40 崩溃后重启：真实生成 tick 的恢复路径按原调用身份补结算，不重写快照', async () => {
  // 崩溃现场（Worker 在写入提交后、账本结算前退出）：消息已按 LEASE_LOST 收敛为终态，
  // 账本行留在 REQUESTED。两个窗口并存：一行事件已提交（可恢复），一行从未提交（不可恢复）。
  const workspace = randomUUID();
  const project = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspace, name: '崩溃恢复' });
    await repositories.workspaces.insertAuthorityRow(workspace);
    await repositories.projects.insertProject({ id: project, workspaceId: workspace,
      title: '崩溃恢复', projectType: 'DEVELOPMENT' });
  });
  const created = await createAssistSession(app.db, { workspaceId: workspace,
    commandId: randomUUID(), title: '崩溃恢复会话', projectId: project });
  const sessionId = created.result.session_id;
  const assist = createRepositories(app.db).assist;
  await assist.insertMessage({ id: randomUUID(), sessionId, seq: 1n, role: 'USER',
    status: 'COMPLETED', intent: 'DISCUSS', content: '把这件事做了', sources: [] });
  const crashedMessage = randomUUID();
  await assist.insertMessage({ id: crashedMessage, sessionId, seq: 2n, role: 'ASSISTANT',
    status: 'FAILED', intent: 'DISCUSS', content: null, sources: [] });

  const calls = new SessionToolCallRepository(app.db);
  const todos = new SessionTodoRepository(app.db);
  const committedArgs = { items: [{ content: '崩溃前最后一步', status: 'in_progress' }],
    expected_version: 0 };
  const committedRow = await calls.insert({ id: randomUUID(), sessionId,
    messageId: crashedMessage, round: 1, ordinal: 1, toolName: 'todo_write',
    arguments: committedArgs, argumentsSha256: 'c'.repeat(64),
    providerToolCallId: 'provider-crash-1' });
  const written = await todos.write({ sessionId, workspaceId: workspace,
    messageId: crashedMessage, toolCallId: committedRow.id, items: committedArgs.items,
    expectedVersion: 0 });
  assert.equal(written.outcome, 'APPLIED');
  const originalDigest = todoSettlementDigest(written.snapshot);
  const neverCommittedRow = await calls.insert({ id: randomUUID(), sessionId,
    messageId: crashedMessage, round: 1, ordinal: 2, toolName: 'todo_write',
    arguments: { items: [{ content: '从未提交的一步', status: 'pending' }],
      expected_version: 0 },
    argumentsSha256: 'd'.repeat(64), providerToolCallId: 'provider-crash-2' });

  // 重启后的真实生成 tick：租约清扫 → todo 账本恢复补结算 → 领取（无 PENDING 消息，
  // 模型端口不会被调用）。
  const tickOptions = { workerId: `todo-recover-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(),
    leaseMs: 60_000, maxMessages: 1 } as const;
  const outcome = await runAssistGenerationTick(app.db, tickOptions);
  assert.equal(outcome, undefined, '没有待生成的消息；tick 只做恢复清扫');

  const settledRow = await calls.read(committedRow.id);
  assert.equal(settledRow?.status, 'SETTLED', '事件已提交的调用必须按原身份补结算');
  assert.equal(settledRow?.result_digest, originalDigest,
    '恢复结算的摘要必须与当初的结果一致——不丢失原始调用身份');
  const keptRow = await calls.read(neverCommittedRow.id);
  assert.equal(keptRow?.status, 'REQUESTED', '从未提交的写入不得被恢复执行，也不得报成功');
  const snapshot = await todos.read(sessionId);
  assert.equal(snapshot?.version, 1, '恢复不重复写快照');
  assert.deepEqual(snapshot?.items.map((item) => item.content), ['崩溃前最后一步']);

  // 第二次 tick：已结算的行不再出现，未确认的行保持原状，无任何重复副作用。
  await runAssistGenerationTick(app.db, tickOptions);
  assert.equal((await calls.read(committedRow.id))?.status, 'SETTLED');
  assert.equal((await calls.read(neverCommittedRow.id))?.status, 'REQUESTED');
  const count = (await sql<{ count: string }>`select count(*)::text as count
    from assist_session_todo_events where session_id = ${sessionId}`.execute(app.db)).rows;
  assert.equal(Number(count[0]?.count ?? '0'), 1, '两次恢复不产生第二条事件');
});
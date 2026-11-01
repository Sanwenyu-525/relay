import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { reconcileTodoWriteSettlements, todoSettlementDigest } from '../../src/application/session-todo-tool.js';
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
/**
 * 直接跑循环那一层所需的一条助手消息（同 TL-20 的形态：不走 HTTP，也不走完整 tick）。
 *
 * 单独一份会话而不是复用模块级的那一条：额度用尽的用例会把清单写进自己的作用域，
 * 复用同一条会话会让后面每个用例都读到上一份清单。
 */
async function agentRoundFixture(label: string) {
  const workspace = randomUUID();
  const project = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspace, name: label });
    await repositories.workspaces.insertAuthorityRow(workspace);
    await repositories.projects.insertProject({ id: project, workspaceId: workspace, title: label,
      projectType: 'DEVELOPMENT' });
  });
  const created = await createAssistSession(app.db, { workspaceId: workspace,
    commandId: randomUUID(), title: `${label}会话`, projectId: project });
  const target = created.result.session_id;
  const assist = createRepositories(app.db).assist;
  await assist.insertMessage({ id: randomUUID(), sessionId: target, seq: 1n, role: 'USER',
    status: 'COMPLETED', intent: 'DISCUSS', content: '把这件事做完', sources: [] });
  const assistantId = randomUUID();
  await assist.insertMessage({ id: assistantId, sessionId: target, seq: 2n, role: 'ASSISTANT',
    status: 'RUNNING', intent: 'DISCUSS', content: null, sources: [] });
  const session = await assist.readSession(target);
  const message = await assist.readMessage(assistantId);
  if (session === undefined || message === undefined) throw new Error('fixture 消息未落库');
  return { session, message };
}

/**
 * 观察每一次模型请求实际声明了什么工具、收到的最后一条用户正文是什么。
 *
 * 收尾窗口的判定只能在「请求装配」这一层看见：界面与账本都反映不了「这一次有没有把
 * 读取工具关掉、把 todo_write 留着」。
 */
function observingPort(script: string): {
  readonly port: FakeModelPort;
  readonly requests: { readonly tools: readonly string[]; readonly lastUser: string;
    readonly system: string }[];
  readonly results: readonly { readonly name: string; readonly content: string }[];
} {
  const port = new FakeModelPort();
  const original = port.assist.bind(port);
  const requests: { tools: readonly string[]; lastUser: string; system: string }[] = [];
  const results: { name: string; content: string }[] = [];
  const seen = new Set<string>();
  port.assist = async (request) => {
    const lastUser = request.turns.at(-1)?.content ?? '';
    requests.push({ tools: (request.tools ?? []).map((spec) => spec.name), lastUser,
      system: request.system });
    for (const turn of request.toolTurns ?? []) {
      for (const result of turn.results) {
        // 同一条回执会在后续每次请求里重复出现，按调用身份去重才是「这一次跑出来的结果」。
        if (seen.has(result.providerToolCallId)) continue;
        seen.add(result.providerToolCallId);
        results.push({ name: result.name, content: result.content });
      }
    }
    // Fake 从最后一条用户正文里读脚本；收尾轮追加的是服务端指令，这里把标记接回去，
    // 同时保留那句指令，让用例能断言「收尾那一轮到底让它做了什么」。
    return original({ ...request,
      turns: [{ role: 'user' as const, content: `${lastUser}\nFAKE_ASSIST_TOOLS ${script}` }] });
  };
  return { port, requests, results };
}

test('TL-50 读取额度用尽后的收尾窗口：只开放 todo_write，清单写成真实进度', async () => {
  // 现场与真实用例同形：一条响应里并行声明多个请求，额度在第 N 个之后用完，后面的
  // 请求被类型化拒掉（不是静默丢弃），而清单仍要在收尾那一轮写成事实。
  const { session, message } = await agentRoundFixture('收尾窗口');
  const items = [{ content: '读契约', status: 'completed' }, { content: '改文件', status: 'pending' }];
  const read = { name: 'read_file', arguments: { relative_path: 'docs/README.md' } };
  const script = JSON.stringify([[read, read, read],
    [{ name: 'todo_write', arguments: { items, expected_version: 0 } }]]);
  const { port, requests, results } = observingPort(script);
  const outcome = await runSessionReadonlyRounds(app.db, { session, message,
    availableTools: ['read_file'],
    modelPort: port, signal: AbortSignal.timeout(60_000), system: '你是助手。', allowTodo: true,
    maxToolCalls: 2, contextTurns: [{ role: 'user', content: '干活' }],
    resolveOrigin: () => assistantReadOrigin(app.db, session, message.id) });

  assert.equal(outcome.kind, 'CONTENT', '额度用尽必须收成一则答复，不是整条消息失败：'
    + JSON.stringify(outcome));
  // ① 每次请求都看得见额度：第一次请求的 system 里带着上限与剩余。
  assert.match(requests[0]?.system ?? '', /已用 0\/2 次，还能用 2 次/);
  // ② 超出额度的请求不是静默丢弃：拒因里写清上限与「并行声明各占一次」。
  const exhausted = results.filter((entry) => entry.content.includes('SESSION_TOOL_BUDGET_EXHAUSTED'));
  assert.equal(exhausted.length, 1, '第 3 个并行请求应当被额度拒掉，其余两次走词表判定');
  assert.match(exhausted[0]?.content ?? '', /上限 2 次，一次并行声明里的每个请求各占一次/);
  assert.match(exhausted[0]?.content ?? '', /逐项点名哪些步骤没有执行/);
  // ③ 收尾那一轮：读取工具全部关掉，只留 todo_write，并且指令明确「写完清单再答复」。
  assert.deepEqual(requests[1]?.tools, ['todo_write'],
    '收尾轮只能有 todo_write；实际：' + JSON.stringify(requests[1]?.tools));
  assert.match(requests[1]?.lastUser ?? '', /先用 todo_write/);
  assert.match(requests[1]?.lastUser ?? '', /没有执行/);
  // ④ 清单落成真实进度：todo_write 不被读取额度拦住（它不占那个额度）。
  const snapshot = await new SessionTodoRepository(app.db).read(session.id);
  assert.equal(snapshot?.version, 1, '收尾窗口里写回的清单必须真的落地');
  assert.deepEqual(snapshot?.items.map((item) => item.status), ['completed', 'pending']);

  const calls = await new SessionToolCallRepository(app.db).listBySession(session.id);
  const todoCall = calls.find((row) => row.tool_name === 'todo_write');
  assert.equal(todoCall?.status, 'SETTLED');
  assert.equal(calls.filter((row) => row.tool_name === 'read_file').length, 3,
    '被额度拒掉的请求同样留一行账本，界面才数得出「未执行」是几次');
});

test('TL-51 最后一轮不开放收尾窗口：那一条必须只输出正文，循环不会拖成长任务', async () => {
  // 收尾窗口是「还有轮次」时的例外。轮次到顶时如果还给它工具，循环就会在多出来的
  // 那一轮上以 SESSION_TOOL_ROUNDS_EXHAUSTED 失败——用户看到的又是一次报错而不是答复。
  const { session, message } = await agentRoundFixture('最后一轮');
  const script = JSON.stringify([[{ name: 'read_file', arguments: { relative_path: 'a.md' } }],
    [{ name: 'todo_write', arguments: { items: [{ content: '一步', status: 'completed' }],
      expected_version: 0 } }]]);
  const { port, requests } = observingPort(script);
  const outcome = await runSessionReadonlyRounds(app.db, { session, message,
    availableTools: ['read_file'],
    modelPort: port, signal: AbortSignal.timeout(60_000), system: '你是助手。', allowTodo: true,
    maxRounds: 1, maxToolCalls: 12, contextTurns: [{ role: 'user', content: '干活' }],
    resolveOrigin: () => assistantReadOrigin(app.db, session, message.id) });
  assert.equal(outcome.kind, 'CONTENT');
  assert.equal(requests.length, 2, '第 0 轮跑工具、第 1 轮（到顶）只作答，不多烧一次请求');
  assert.deepEqual(requests[1]?.tools, [], '到顶那一轮一个工具都不能声明');
  assert.doesNotMatch(requests[1]?.lastUser ?? '', /todo_write/);
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
  // 第六轮：事件不存在 + 消息已终止 → 收口成「未执行」，仍然不得被当成执行过。
  assert.equal(keptRow?.status, 'ABANDONED',
    '从未提交的写入不得被恢复执行，也不得报成功；终态是未执行');
  assert.equal(keptRow?.rejection_reason, 'TODO_NOT_EXECUTED');
  assert.equal(keptRow?.result_digest, null, '未执行不得带结算结果');
  const snapshot = await todos.read(sessionId);
  assert.equal(snapshot?.version, 1, '恢复不重复写快照');
  assert.deepEqual(snapshot?.items.map((item) => item.content), ['崩溃前最后一步']);

  // 第二次 tick：已结算的行不再出现，未执行的行停在终态，无任何重复副作用。
  await runAssistGenerationTick(app.db, tickOptions);
  assert.equal((await calls.read(committedRow.id))?.status, 'SETTLED');
  assert.equal((await calls.read(neverCommittedRow.id))?.status, 'ABANDONED');
  const count = (await sql<{ count: string }>`select count(*)::text as count
    from assist_session_todo_events where session_id = ${sessionId}`.execute(app.db)).rows;
  assert.equal(Number(count[0]?.count ?? '0'), 1, '两次恢复不产生第二条事件');
});

test('取消响应保留已产生的请求身份与用量，不把中断当作零成本', async () => {
  const assist = createRepositories(app.db).assist;
  const session = await assist.readSession(sessionId);
  const message = await assist.readMessage(assistantMessageId);
  assert.ok(session && message);
  const result = await runSessionReadonlyRounds(app.db, { session, message, availableTools: [],
    system: '合成取消测试', signal: AbortSignal.timeout(10_000),
    modelPort: { identity: new FakeModelPort().identity, assist: async () => ({ kind: 'CANCELLED',
      providerRequestId: 'cancelled-known-request', usage: { inputTokens: 12, outputTokens: 3,
        cacheReadTokens: 8, cacheCreationTokens: null } }) },
    resolveOrigin: () => assistantReadOrigin(app.db, session, message.id) });
  assert.equal(result.kind, 'CANCELLED');
  assert.deepEqual(result.providerRequestIds, ['cancelled-known-request']);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3,
    cacheReadTokens: 8, cacheCreationTokens: null });
});

test('TL-41 未提交的旧调用不占恢复批次，后续已提交调用仍能补结算', async () => {
  const created = await createAssistSession(app.db, { workspaceId, projectId,
    commandId: randomUUID(), title: '恢复批次积压' });
  const targetSession = created.result.session_id;
  const assist = createRepositories(app.db).assist;
  await assist.insertMessage({ id: randomUUID(), sessionId: targetSession, seq: 1n,
    role: 'USER', status: 'COMPLETED', intent: 'DISCUSS', content: '开始干活', sources: [] });
  const messageId = randomUUID();
  await assist.insertMessage({ id: messageId, sessionId: targetSession, seq: 2n,
    role: 'ASSISTANT', status: 'FAILED', intent: 'DISCUSS', content: null, sources: [] });
  const calls = new SessionToolCallRepository(app.db);
  const args = { items: [{ content: '等待补结算', status: 'in_progress' }], expected_version: 0 };
  const old = await calls.insert({ id: randomUUID(), sessionId: targetSession,
    messageId, round: 1, ordinal: 1, toolName: 'todo_write', arguments: args,
    argumentsSha256: 'b'.repeat(64), providerToolCallId: 'provider-never-committed' });
  const row = await calls.insert({ id: randomUUID(), sessionId: targetSession,
    messageId, round: 2, ordinal: 1, toolName: 'todo_write',
    arguments: args, argumentsSha256: 'a'.repeat(64), providerToolCallId: 'provider-after-backlog' });
  const written = await new SessionTodoRepository(app.db).write({ sessionId: targetSession, workspaceId,
    messageId, toolCallId: row.id, items: args.items, expectedVersion: 0 });
  // 更早、从未提交事件的 REQUESTED 行永久保留。批次设为 1 即复现生产上限
  // 被悬挂记录占满的情形；无论跑多少次，都应给真正可恢复的调用推进机会。
  for (let tick = 0; tick < 3; tick += 1) {
    await reconcileTodoWriteSettlements(app.db, { limit: 1 });
  }
  assert.equal((await calls.read(row.id))?.status, 'SETTLED',
    '旧的未提交调用不得永久饿死后续已提交调用');
  assert.equal((await calls.read(row.id))?.result_digest, todoSettlementDigest(written.snapshot));
  // 第六轮：无事件 + 消息已终止的悬挂行收口成「未执行」终态（不是结算成功，也不重跑）。
  const orphan = await calls.read(old.id);
  assert.equal(orphan?.status, 'ABANDONED');
  assert.equal(orphan?.rejection_reason, 'TODO_NOT_EXECUTED');
  assert.equal(orphan?.result_digest, null);
  assert.equal((await new SessionTodoRepository(app.db).read(targetSession))?.version, 1);
  const events = (await sql<{ count: string }>`select count(*)::text as count
    from assist_session_todo_events where session_id = ${targetSession}`.execute(app.db)).rows;
  assert.equal(Number(events[0]?.count), 1, '补结算不新增清单事件');
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import test, { after, before } from 'node:test';

import { createAssistSession } from '../../src/application/assist-commands.js';
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
after(async () => { await app.close(); });

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
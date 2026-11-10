import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { APP_DATABASE_URL, openDatabase } from './integration-support.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'task-run-history-test');
let api: TestApi;
let workspaceId: string;
let taskId: string;
let emptyTaskId: string;
const ids = Array.from({ length: 5 }, () => randomUUID());
before(async () => {
  workspaceId = await createWorkspace(app.db);
  taskId = randomUUID(); emptyTaskId = randomUUID();
  await app.db.transaction().execute(async (db) => {
    const r = createRepositories(db);
    for (const id of [taskId, emptyTaskId]) {
      await r.tasks.insertTask({ id, workspaceId, projectId: null,
        title: 'History task', status: 'READY', mode: 'ME', acceptanceRevision: 1n,
        executorKind: 'HUMAN', ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId: id, acceptanceRevision: 1n,
        objective: 'Read execution history', requiredOutputSpec: {}, source: 'CREATE' });
    }
    for (let index = 0; index < ids.length; index++) {
      await r.runs.insertRun({ id: ids[index]!, workspaceId, taskId, ownershipEpoch: 1n, retryOfRunId: null });
      await r.runs.insertExecutionContract({ runId: ids[index]!, taskId, acceptanceRevision: 1n,
        workflowKey: 'markdown-deliverable-v1', workflowVersion: '1', executionConfigVersion: '1',
        contractHash: Buffer.alloc(32, 1), frozenSnapshot: {} });
      const at = index < 3 ? '2026-11-06T00:00:00.000001Z' : `2026-11-06T00:00:00.00000${index - 1}Z`;
      await sql`update runs set status='CANCELLED', created_at=${at}::timestamptz,
        terminal_at=now() where id=${ids[index]!}`.execute(db);
    }
  });
  api = await startTestApi();
});
after(async () => { if (api) await api.stop(); await app.close(); });

test('任务历史分页稳定保留同时间戳及微秒边界，响应无配置或正文', async () => {
  const expected = [ids[4], ids[3], ...ids.slice(0, 3).sort().reverse()];
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await api.get(workspacePath(workspaceId, `/tasks/${taskId}/runs?limit=2${cursor ? `&cursor=${cursor}` : ''}`));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers['cache-control'], 'no-store');
    const page = response.body as { items: { id: string; task_id: string }[]; next_cursor: string | null };
    assert.ok(page.items.length <= 2);
    for (const item of page.items) {
      assert.equal(item.task_id, taskId);
      assert.deepEqual(Object.keys(item).sort(), ['created_at', 'id', 'retry_of_run_id', 'revision', 'status', 'task_id', 'terminal_at']);
    }
    seen.push(...page.items.map((run) => run.id)); cursor = page.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(seen, expected);
});

test('空历史返回明确空页，读历史不改变 Task 执行权', async () => {
  const response = await api.get(workspacePath(workspaceId, `/tasks/${emptyTaskId}/runs`));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { items: [], next_cursor: null });
  const row = await sql<{ executor_kind: string; executor_run_id: string | null }>`select executor_kind, executor_run_id from tasks where id=${taskId}`.execute(app.db);
  assert.equal(row.rows[0]?.executor_kind, 'HUMAN');
  assert.equal(row.rows[0]?.executor_run_id, null);
});

test('其他 Workspace 的 Task 不可见，其他任务及未知游标拒绝', async () => {
  const otherWorkspace = await createWorkspace(app.db);
  expectProblem(await api.get(workspacePath(otherWorkspace, `/tasks/${taskId}/runs`)), 404, 'RESOURCE_NOT_FOUND');
  for (const cursor of [ids[0], randomUUID()]) {
    expectProblem(await api.get(workspacePath(workspaceId, `/tasks/${emptyTaskId}/runs?cursor=${cursor}`)), 422, 'VALIDATION_FAILED');
  }
});

test('拒绝越界分页，不自动扩大查询', async () => {
  for (const limit of ['101', '999']) expectProblem(await api.get(workspacePath(workspaceId,
    `/tasks/${taskId}/runs?limit=${limit}`)), 422, 'VALIDATION_FAILED');
  const malformed = await api.get(workspacePath(workspaceId, `/tasks/${taskId}/runs?cursor=invalid`));
  assert.equal(malformed.status, 422);
});

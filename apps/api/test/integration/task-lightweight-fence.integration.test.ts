import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import {
  APP_DATABASE_URL,
  MIGRATIONS_DIRECTORY,
  MIGRATION_DATABASE_URL,
  openDatabase,
} from './integration-support.js';
import {
  createWorkspace,
  expectCommandAccepted,
  expectProblem,
  startTestApi,
  workspacePath,
  type TestApi,
} from './api-harness.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';

/**
 * 轻量起步依赖的服务端栅栏（工作台 §18.7、LC-04）。
 *
 * 轻量入口保存的 Task 没有验收条件，因此**必须**停在 INBOX：
 * 若服务端允许它进入 READY，产品就成了「靠放宽验收完成依据来省步骤」，
 * 这与契约第 6 节相反。本文件用真实 PostgreSQL + 真实 HTTP 固定这条性质：
 *  1. 零 criterion 的 Task 可以创建，但状态是 INBOX。
 *  2. MarkTaskReady 被拒，理由指向缺失的必需 criterion。
 *  3. 被拒后事实不变：仍是 INBOX，任务修订没有被这次失败推进。
 *
 * 已知边界（不在本文件断言内）：**当前没有公开的 HTTP 入口在创建后补验收条件**。
 * 唯一会推进 acceptance_revision 并新增 criterion 的命令是 AcceptAssistProposal，
 * 即必须经对话提案接受这条路。因此轻量 Task 要变成 READY，需要先在会话里
 * 接受一条补齐完成条件的提案；这一点由产品入口承担，不在本栅栏测试内模拟。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-lightweight-task');

let api: TestApi;
let workspaceId: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
  workspaceId = await createWorkspace(app.db);
});

after(async () => {
  await api?.stop();
  await app.close();
});

async function createTaskWithoutCriteria(title: string): Promise<{ taskId: string; revision: string }> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId,
    project_id: null,
    title,
    objective: '只用一句话表达要完成的事，不预先填写验收条件',
    criteria: [],
  });
  const result = expectCommandAccepted(response, 201, commandId);

  return { taskId: result.task_id as string, revision: result.revision as string };
}

test('零验收条件的 Task 停在 INBOX，且 MarkTaskReady 被明确拒绝', async () => {
  const created = await createTaskWithoutCriteria('轻量起步：跑通实验并整理初稿');
  assert.match(created.taskId, /^[0-9a-f-]{36}$/u);

  // 1) 创建本身是允许的：轻量起步不能因为缺验收条件就保存不了。
  const detail = await api.get(workspacePath(workspaceId, `/tasks/${created.taskId}`));
  assert.equal(detail.status, 200, detail.text);
  const task = detail.body as { status?: string; revision?: string };
  assert.equal(task.status, 'INBOX', '零 criterion 的 Task 必须以 INBOX 创建');
  assert.equal(task.revision, created.revision);

  // 2) 转入 READY 必须被拒，理由指向缺失的必需 criterion。
  const ready = await api.post(workspacePath(workspaceId, `/tasks/${created.taskId}/ready`), {
    command_id: randomUUID(),
    expected_revision: created.revision,
  });
  const problem = expectProblem(ready, 409, 'INVALID_TRANSITION');
  assert.match(String(problem.detail), /criterion/u, `拒绝理由应指出缺少 criterion：${problem.detail}`);

  // 3) 被拒后事实不变：仍是 INBOX，修订没有被这次失败推进。
  const afterReject = await api.get(workspacePath(workspaceId, `/tasks/${created.taskId}`));
  assert.equal(afterReject.status, 200, afterReject.text);
  const unchanged = afterReject.body as { status?: string; revision?: string };
  assert.equal(unchanged.status, 'INBOX', '被拒的 READY 不得改变任务状态');
  assert.equal(unchanged.revision, created.revision, '被拒的 READY 不得推进任务修订');
});

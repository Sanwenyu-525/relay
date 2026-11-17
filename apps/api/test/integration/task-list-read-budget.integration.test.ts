import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

import { listTasks } from '../../src/application/task-queries.js';
import type { RelayDatabaseSchema } from '../../src/infrastructure/database-schema.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import '../../src/infrastructure/pg-types.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
 import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 2026-11-15 任务页专项：全工作空间任务列表的读请求预算。
 *
 * `listTasksSummary` 以前对每个 Project 单读归档事实、对每个 WAITING Task 单读 Run 的 wait_reason，
 * 50 条任务、4 个 Project、25 条 WAITING 时会放大成 1 + 项目数 + WAITING 数。现在两条都改成
 * 按去重集合批量读一次。这里不读代码猜结论，而是：
 *  - 在真实 PostgreSQL 上造 50 条任务（含跨 4 个 Project 与收件箱任务、1 个归档 Project、25 条 WAITING）；
 *  - 用带 query 日志的 Kysely 实例执行真实 `listTasks`，逐条计数；
 *  - 比较 limit=50 与 limit=12 的语句数：数量必须相同，且不超过固定预算。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-task-read-budget');
let api: TestApi;
const statements: string[] = [];
const pool = new Pool({ connectionString: APP_DATABASE_URL, max: 4,
  application_name: 'relay-api-test-task-read-budget-count' });
const counting = new Kysely<RelayDatabaseSchema>({
  dialect: new PostgresDialect({ pool }),
  log: (event) => {
    if (event.level === 'query') statements.push(event.query.sql);
  },
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => {
  await api?.stop();
  await counting.destroy();
  await app.close();
});

async function createProject(workspaceId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/projects'), {
    command_id: commandId, title, project_type: 'GENERAL',
  });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function createTask(workspaceId: string, projectId: string | null, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(workspaceId, '/tasks'), {
    command_id: commandId, project_id: projectId, title,
    objective: `完成 ${title}`, criteria: [{ statement: '核对结果' }],
  });
  return expectCommandAccepted(response, 201, commandId).task_id as string;
}

/** 把任务改成 AI 执行权下的 WAITING：Run + 同事务的冻结契约，合法通过复合外键与 CHECK。 */
async function parkAsWaiting(workspaceId: string, taskId: string, waitReason: string): Promise<void> {
  const runId = randomUUID();
  // fk_runs_contract 是延迟外键：Run 与契约必须在同一个事务里一起提交。
  await app.db.transaction().execute(async (trx) => {
    await sql`
      insert into runs (id, workspace_id, task_id, status, ownership_epoch, wait_reason)
      values (${runId}, ${workspaceId}, ${taskId}, 'WAITING_APPROVAL', 1, ${waitReason})
    `.execute(trx);
    await sql`
      insert into execution_contracts (run_id, task_id, acceptance_revision, workflow_key,
        workflow_version, execution_config_version, contract_hash, frozen_snapshot)
      values (${runId}, ${taskId}, 1, 'task-execution', 'v1', 'v1',
        ${Buffer.alloc(32, 1)}::bytea, '{}'::jsonb)
    `.execute(trx);
    await sql`
      update tasks set status = 'WAITING', mode = 'DELEGATE_AI', executor_kind = 'AI',
        executor_run_id = ${runId}, revision = revision + 1
      where id = ${taskId}
    `.execute(trx);
  });
}

const waitCodes = ['ACTION_APPROVAL_REQUIRED', 'HUMAN_TOOL', 'REPEATED_FAILURE', 'PAUSED_BY_USER',
  'AWAITING_HUMAN_EVIDENCE', 'CHECKER_UNAVAILABLE', 'CORRECTION_BUDGET_EXHAUSTED',
  'UNCERTAIN_REQUIRES_HUMAN'] as const;

test('全工作空间任务列表：50 条任务的读请求数与页大小无关，等待原因与归档事实一次批量取回', async () => {
  const workspaceId = await createWorkspace(app.db);
  const projectOne = await createProject(workspaceId, '项目一');
  const projectTwo = await createProject(workspaceId, '项目二');
  const projectThree = await createProject(workspaceId, '项目三');
  const archivedProject = await createProject(workspaceId, '已归档项目');
  const projects = [projectOne, projectTwo, projectThree, archivedProject] as const;

  // 48 条有项目 + 2 条收件箱任务 = 50；前 25 条改成 WAITING，原因在 8 个真实码之间轮转。
  const taskIds: string[] = [];
  for (let index = 0; index < 48; index += 1) {
    const target = projects[index % 4];
    assert.ok(target !== undefined, '每个任务都必须落到一个已建 Project');
    taskIds.push(await createTask(workspaceId, target, `任务 ${index + 1}`));
  }
  taskIds.push(await createTask(workspaceId, null, '收件箱任务 49'));
  taskIds.push(await createTask(workspaceId, null, '收件箱任务 50'));
  const waiting = taskIds.slice(0, 25);
  for (const [index, taskId] of waiting.entries()) {
    const code = waitCodes[index % waitCodes.length];
    assert.ok(code !== undefined, '等待原因按 8 个码轮转');
    await parkAsWaiting(workspaceId, taskId, code);
  }
  // 归档必须在任务与 Run 都建好之后：归档栅栏会拒绝新的业务写入（PROJECT_ARCHIVED 409）。
  await sql`update projects set archived_at = now() where id = ${archivedProject}`.execute(app.db);

  // 一条真实的 BLOCKED：BLOCKS 前置未完成时，列表必须带出 blocking_task_ids。
  const blockedTask = taskIds[26];
  const dependencyTask = taskIds[27];
  assert.ok(blockedTask !== undefined && dependencyTask !== undefined, '阻塞夹具必须落在已建任务上');
  await sql`
    insert into task_dependencies (workspace_id, task_id, depends_on_task_id, dependency_kind)
    values (${workspaceId}, ${blockedTask}, ${dependencyTask}, 'BLOCKS')
  `.execute(app.db);
  await sql`update tasks set status = 'BLOCKED' where id = ${blockedTask}`.execute(app.db);

  statements.length = 0;
  const bigStartedAt = process.hrtime.bigint();
  const big = await listTasks(counting, { workspaceId, projectId: undefined, limit: 50, before: null });
  const bigReadMs = Number(process.hrtime.bigint() - bigStartedAt) / 1e6;
  const bigStatements = [...statements];
  statements.length = 0;
  // 30 条这一页也含 WAITING（最新 30 条覆盖到第 21 条任务）：内容形态与 50 条页相同，才能直接比语句数。
  const midStartedAt = process.hrtime.bigint();
  const mid = await listTasks(counting, { workspaceId, projectId: undefined, limit: 30, before: null });
  const midReadMs = Number(process.hrtime.bigint() - midStartedAt) / 1e6;
  const midStatements = [...statements];
  console.log(`[read-budget] 50 条：statements=${bigStatements.length} readMs=${bigReadMs.toFixed(2)}`
    + `；30 条：statements=${midStatements.length} readMs=${midReadMs.toFixed(2)}；WAITING=25；Projects=4`);

  assert.equal(big.items.length, 50);
  assert.equal(mid.items.length, 30);
  // 关键断言：页大小变化、Project 与 WAITING 数量翻倍，语句数完全不变。
  assert.equal(bigStatements.length, midStatements.length,
    `语句数必须与页大小无关：50 条 ${bigStatements.length} 条语句，30 条 ${midStatements.length} 条语句`);
  // 实测 6 条：分页 1 + 验收条件 1 + 前置依赖 1 + 未解除阻塞 1 + Project 归档 1 + Run 等待原因 1。
  // 若某页不含 WAITING 任务，Run 那条会整条跳过（5 条）——这是按需读，不是按行放大。
  assert.ok(bigStatements.length <= 8,
    `全空间任务列表的读预算超出预期：${bigStatements.length} 条语句\n${bigStatements.join('\n')}`);

  // 等待原因确实来自批量读：25 条 WAITING 全部带原因，且取值就是服务端写入的码。
  const waitingRows = big.items.filter((item) => item.status === 'WAITING');
  assert.equal(waitingRows.length, 25);
  for (const row of waitingRows) {
    assert.ok(waitCodes.includes(row.waiting_reason as (typeof waitCodes)[number]),
      `WAITING 任务必须带原始等待原因，实际 ${String(row.waiting_reason)}`);
  }
  assert.equal(new Set(waitingRows.map((row) => row.waiting_reason)).size, waitCodes.length);
  // 非 WAITING 任务不得凭空得到原因；BLOCKED 的原因来自前置事实而不是 wait_reason。
  assert.deepEqual(big.items.filter((item) => item.status !== 'WAITING').map((item) => item.waiting_reason),
    new Array(25).fill(null));
  const blockedRow = big.items.find((item) => item.id === blockedTask);
  assert.equal(blockedRow?.status, 'BLOCKED');
  assert.deepEqual(blockedRow?.blocking_task_ids, [dependencyTask]);
  // 同一页里状态与执行者都完整投影（列表没有按状态或执行者过滤的入口）。
  assert.deepEqual([...new Set(big.items.map((item) => item.status))].sort(),
    ['BLOCKED', 'INBOX', 'WAITING']);
  assert.deepEqual([...new Set(big.items.map((item) => item.executor.kind))].sort(), ['AI', 'HUMAN']);

  // 归档事实同一次批量读回：归档项目的任务不给任何可执行动作，其它项目照常。
  const archivedRows = big.items.filter((item) => item.project_id === archivedProject);
  assert.equal(archivedRows.length, 12);
  assert.deepEqual(archivedRows.map((item) => item.allowed_actions.length), new Array(12).fill(0));
  assert.ok(big.items.some((item) => item.project_id !== null && item.project_id !== archivedProject
    && item.allowed_actions.length > 0));

  // 收件箱范围（projectId=null）只读本空间的人工事项，同样不按条放大。
  statements.length = 0;
  const inbox = await listTasks(counting, { workspaceId, projectId: null, limit: 50, before: null });
  const inboxStatements = [...statements];
  assert.equal(inbox.items.length, 2);
  assert.ok(inboxStatements.length <= bigStatements.length,
    `收件箱范围不应比全空间更贵：${inboxStatements.length} > ${bigStatements.length}`);
});

test('GET /tasks?scope=all：status、executor、归档与 waiting_reason 的列表语义', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(workspaceId, '列表语义项目');
  const archivedProject = await createProject(workspaceId, '已归档语义项目');
  const waitingTask = await createTask(workspaceId, project, '等待人工工具处理');
  const archivedTask = await createTask(workspaceId, archivedProject, '归档项目里的任务');
  const inboxTask = await createTask(workspaceId, null, '收件箱里的任务');
  await parkAsWaiting(workspaceId, waitingTask, 'HUMAN_TOOL');
  await sql`update projects set archived_at = now() where id = ${archivedProject}`.execute(app.db);

  const response = await api.get(workspacePath(workspaceId, '/tasks?scope=all&limit=50'));
  assert.equal(response.status, 200, response.text);
  const body = response.body as { items: { id: string; status: string; waiting_reason: string | null;
    allowed_actions: readonly string[]; executor: { kind: string; run_id: string | null } }[] };

  const waiting = body.items.find((item) => item.id === waitingTask);
  assert.equal(waiting?.status, 'WAITING');
  assert.equal(waiting?.waiting_reason, 'HUMAN_TOOL');
  assert.equal(waiting?.executor.kind, 'AI');
  assert.notEqual(waiting?.executor.run_id, null);
  // 归档 Project 的只读事实直接反映在允许动作上：不给任何可执行动作。
  const archived = body.items.find((item) => item.id === archivedTask);
  assert.equal(archived?.status, 'INBOX');
  assert.deepEqual(archived?.allowed_actions, []);
  // 列表仍是全空间范围：收件箱任务在 scope=all 里出现，且在 inbox=true 里只出现它。
  assert.ok(body.items.some((item) => item.id === inboxTask));
  const inboxPage = await api.get(workspacePath(workspaceId, '/tasks?inbox=true&limit=50'));
  assert.equal(inboxPage.status, 200, inboxPage.text);
  const inboxBody = inboxPage.body as { items: { id: string }[] };
  assert.deepEqual(inboxBody.items.map((item) => item.id), [inboxTask]);
});

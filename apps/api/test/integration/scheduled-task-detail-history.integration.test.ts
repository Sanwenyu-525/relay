import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, delay, type TestApi } from './api-harness.js';

// 禅道 #34 / DEV-0126：详情响应的 occurrences 只取最近 20 条，窗口外的旧 BLOCKED
// 时段会失去补跑/忽略入口。详情必须额外返回全部未处理（BLOCKED）时段（pending_occurrences），
// 补跑/忽略仍走既有 resolutions 接口，不新增命令语义。

const app = openDatabase(APP_DATABASE_URL, 'relay-scheduled-task-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Occurrence = {
  occurrence_id: string; scheduled_task_id: string; status: string; sequence: string;
  due_at: string; missed: boolean; task_id: string | null; run_id: string | null;
  reason: string | null; revision: string; created_at: string;
};
type Detail = {
  scheduled_task_id: string; project_id: string; status: string; revision: string;
  occurrences: Occurrence[]; pending_occurrences: Occurrence[];
};

function scheduleBody(projectId: string) {
  const firstDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  return {
    command_id: randomUUID(), confirmed: true, title: '每早整理昨日进展',
    template: {
      task_title: '整理昨日进展', objective: '输出一页昨日进展摘要', mode: 'AI_ASSIST',
      criteria: [{ statement: '覆盖三项进展' }],
    },
    repeat_rule: { kind: 'DAILY', interval_days: 1 },
    timezone: 'Asia/Shanghai', local_time: '09:00', first_local_date: firstDate,
    max_runs: 100, authorization_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
}

/** 复现 Bug fixture：同一任务 21 条历史，最早 1 条 BLOCKED/MISSED，其余 20 条 SKIPPED 占满默认窗口。 */
async function seedHistory(taskId: string, workspaceId: string, projectId: string, generation: bigint): Promise<string> {
  const blockedId = randomUUID();
  const rows = [{
    id: blockedId, sequence: 1n, due_at: new Date(Date.now() - 30 * 86_400_000),
    created_at: new Date(Date.now() - 30 * 86_400_000), status: 'BLOCKED', missed: true, reason: 'MISSED',
  }, ...Array.from({ length: 20 }, (_unused, index) => ({
    id: randomUUID(), sequence: BigInt(index + 2), due_at: new Date(Date.now() - (20 - index) * 60_000),
    created_at: new Date(Date.now() - (20 - index) * 60_000), status: 'SKIPPED', missed: false,
    reason: 'PREVIOUS_TASK_NOT_ACCEPTED',
  }))];
  for (const row of rows) {
    await sql`insert into scheduled_task_occurrences
      (id, scheduled_task_id, workspace_id, project_id, schedule_generation, sequence, due_at, timezone, missed,
       status, create_command_id, ready_command_id, delegate_command_id, reason, created_at)
      values (${row.id}, ${taskId}, ${workspaceId}, ${projectId}, ${generation}, ${row.sequence}, ${row.due_at},
        'Asia/Shanghai', ${row.missed}, ${row.status}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
        ${row.reason}, ${row.created_at})`.execute(app.db);
  }
  // 只改预留计数，不碰业务状态列：与真实「已预留但未启动」的历史保持一致。
  await sql`update scheduled_tasks set runs_reserved = 21 where id = ${taskId}`.execute(app.db);
  return blockedId;
}

async function fixture() {
  const workspaceId = await createWorkspace(app.db);
  const path = (segment: string) => workspacePath(workspaceId, segment);
  const command = async (segment: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const id = typeof body.command_id === 'string' ? body.command_id : randomUUID();
    return expectCommandAccepted(await api.post(path(segment), { command_id: id, ...body }), status, id);
  };
  const read = async (segment: string) => {
    const response = await api.get(path(segment));
    assert.equal(response.status, 200, response.text);
    return response.body as Record<string, unknown>;
  };
  const projectId = (await command('/projects', { title: '定时整理项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const created = await command(`/projects/${projectId}/scheduled-tasks`, scheduleBody(projectId), 201);
  const taskId = created.scheduled_task_id as string;
  const detail = async () => await read(`/scheduled-tasks/${taskId}`) as unknown as Detail;
  return { workspaceId, projectId, taskId, path, command, detail };
}

test('详情在最近 20 条窗口之外仍返回旧 BLOCKED，补跑走既有 resolutions 接口', async () => {
  const f = await fixture();
  const blockedId = await seedHistory(f.taskId, f.workspaceId, f.projectId, 1n);

  const detail = await f.detail();
  assert.equal(detail.occurrences.length, 20, '既有 20 条窗口语义不变');
  assert.ok(detail.occurrences.every((item) => item.status !== 'BLOCKED'), '窗口内没有这条旧 BLOCKED');
  assert.equal(detail.pending_occurrences.length, 1, '窗口外的待处理时段必须单独返回');
  const oldBlocked = detail.pending_occurrences[0]!;
  assert.equal(oldBlocked.occurrence_id, blockedId);
  assert.equal(oldBlocked.status, 'BLOCKED');
  assert.equal(oldBlocked.reason, 'MISSED');
  assert.equal(oldBlocked.task_id, null);
  assert.ok(oldBlocked.revision.length > 0, '处理入口需要 revision');

  const response = await api.post(f.path(`/scheduled-task-occurrences/${blockedId}/resolutions`), {
    command_id: randomUUID(), expected_revision: oldBlocked.revision, action: 'RETRY', reason: '补跑一次',
  });
  assert.equal(response.status, 200, response.text);
  const resolved = (response.body as { result: { occurrence_id: string; status: string; revision: string } }).result;
  assert.equal(resolved.occurrence_id, blockedId);
  assert.equal(resolved.status, 'DISPATCHING', '补跑只是重新置为可分发');

  // 补跑后由真实扫描分发：轮询库内状态直到 DISPATCHED（该行仍在窗口外，详情 occurrences 不会出现）。
  const until = Date.now() + 10_000;
  let row = { status: 'DISPATCHING', task_id: null as string | null, run_id: null as string | null };
  while (Date.now() < until) {
    const current = await sql<{ status: string; task_id: string | null; run_id: string | null }>`
      select status, task_id, run_id from scheduled_task_occurrences where id = ${blockedId}`.execute(app.db);
    row = current.rows[0]!;
    if (row.status === 'DISPATCHED') break;
    await delay(100);
  }
  assert.equal(row.status, 'DISPATCHED', '补跑后应真正启动');
  assert.ok(row.task_id !== null && row.run_id !== null);
  const after = await f.detail();
  assert.equal(after.pending_occurrences.length, 0, '已分发的时段不再出现在待处理集合');
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(tasks.rows[0]!.count, '1', '补跑按原命令身份只建一个任务');
});

test('窗口外旧 BLOCKED 也可以忽略：走既有 resolutions 接口落成 RESOLVED', async () => {
  const f = await fixture();
  const blockedId = await seedHistory(f.taskId, f.workspaceId, f.projectId, 1n);

  const detail = await f.detail();
  const oldBlocked = detail.pending_occurrences.find((item) => item.occurrence_id === blockedId);
  assert.ok(oldBlocked !== undefined, '窗口外旧 BLOCKED 必须可发现');

  const response = await api.post(f.path(`/scheduled-task-occurrences/${blockedId}/resolutions`), {
    command_id: randomUUID(), expected_revision: oldBlocked.revision, action: 'DISMISS', reason: '用户忽略这一次时段',
  });
  assert.equal(response.status, 200, response.text);
  const resolved = (response.body as { result: { occurrence_id: string; status: string } }).result;
  assert.equal(resolved.status, 'RESOLVED');

  const after = await f.detail();
  assert.equal(after.pending_occurrences.find((item) => item.occurrence_id === blockedId), undefined,
    '忽略后不再出现在待处理集合');
  const row = await sql<{ status: string; reason: string }>`
    select status, reason from scheduled_task_occurrences where id = ${blockedId}`.execute(app.db);
  assert.equal(row.rows[0]!.status, 'RESOLVED');
  assert.equal(row.rows[0]!.reason, '用户忽略这一次时段');
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(tasks.rows[0]!.count, '0', '忽略不建任务');
});

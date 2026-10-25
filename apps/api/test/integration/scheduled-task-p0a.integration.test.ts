import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, expectCommandAccepted, startTestApi, workspacePath, delay, type TestApi } from './api-harness.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import {
  dispatchScheduledOccurrence, editScheduledTask, resolveScheduledTaskOccurrence, scanScheduledTasks,
  setScheduledTaskStatus,
} from '../../src/application/scheduled-tasks.js';

/**
 * P0-A 复现集（先红后绿）：
 * 1. 模板随 occurrence 冻结——分发中断后改模板，未提交的 CreateTask 不得读到新模板。
 * 2. 补跑（RETRY）前准入——计划暂停/停用/到期/预算耗尽/项目归档时不得重开，也不得建 Task。
 * 3. Delegate 已提交、markDispatched 未提交的崩溃恢复不得重复计数 runs_started。
 * 4. 迟到的失败写入不得覆盖已确认的 DISPATCHED。
 * 5. 恢复分发前先准入——必然不可执行的触发不得先建 Task 再失败。
 */
const app = openDatabase(APP_DATABASE_URL, 'relay-scheduled-task-p0a-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Occurrence = {
  occurrence_id: string; scheduled_task_id: string; status: string; reason: string | null;
  task_id: string | null; run_id: string | null; revision: string;
};
type Detail = {
  scheduled_task_id: string; status: string; revision: string; runs_started: number;
  max_runs: number; occurrences: Occurrence[];
};

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
  const projectId = (await command('/projects', { title: 'P0A 项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const detail = async (id: string) => await read(`/scheduled-tasks/${id}`) as unknown as Detail;
  const waitFor = async (id: string, count: number): Promise<Detail> => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const current = await detail(id);
      if (current.occurrences.length >= count && current.occurrences.every((item) => item.status !== 'DISPATCHING')) return current;
      await delay(100);
    }
    const current = await detail(id);
    assert.equal(current.occurrences.length, count, '真实服务扫描未在窗口内形成预期触发');
    return current;
  };
  const makeDue = async (id: string, offset: string) => {
    await sql`update scheduled_tasks set next_due_at = now() + ${offset}::interval where id = ${id}`.execute(app.db);
  };
  return { workspaceId, projectId, path, command, read, detail, waitFor, makeDue };
}

function scheduleBody(projectId: string, overrides: Record<string, unknown> = {}) {
  const firstDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  return {
    command_id: randomUUID(), confirmed: true, title: '每早整理昨日进展',
    template: {
      task_title: '任务A', objective: '只核对样例A', mode: 'AI_ASSIST',
      criteria: [{ statement: 'A样例通过' }],
    },
    repeat_rule: { kind: 'DAILY', interval_days: 1 },
    timezone: 'Asia/Shanghai', local_time: '09:00', first_local_date: firstDate,
    max_runs: 5, authorization_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** 暂停共享 API 后制造一条停在 DISPATCHING 的发生：模拟「扫描已落库、分发未开始」的崩溃现场。 */
async function stuckDispatching(workspaceId: string, projectId: string, planId: string) {
  await sql`update scheduled_tasks set next_due_at = clock_timestamp() where id = ${planId}`.execute(app.db);
  const scanned = await scanScheduledTasks(app.db, new Date(Date.now() - 86_400_000));
  const repos = createRepositories(app.db);
  for (const candidate of scanned) {
    const row = await repos.scheduledTasks.readOccurrence(candidate);
    if (row?.scheduled_task_id === planId) return { occurrence: row!, repos };
  }
  throw new Error('扫描必须为该计划落一条 DISPATCHING 发生');
}

test('分发中断后改模板：未提交的 CreateTask 仍按发生时冻结的模板建任务', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;
  const body = scheduleBody(f.projectId);
  const repos = createRepositories(app.db);

  await api.stop();
  try {
    const { occurrence } = await stuckDispatching(f.workspaceId, f.projectId, id);
    assert.equal(occurrence.status, 'DISPATCHING');

    // 冻结证据：发生落库时模板已在 occurrence 上，不依赖 scheduled_tasks 当前行。
    const frozen = await sql<{ task_title: string }>`select frozen_template ->> 'task_title' as task_title
      from scheduled_task_occurrences where id = ${occurrence.id}`.execute(app.db);
    assert.equal(frozen.rows[0]!.task_title, '任务A', '发生落库时必须冻结当时的模板');

    // 只改模板、不动排期字段：代次不变，发生不因编辑作废。
    const schedule = await repos.scheduledTasks.read(id);
    await editScheduledTask(app.db, {
      workspaceId: f.workspaceId, commandId: randomUUID(), scheduledTaskId: id,
      expectedRevision: String(schedule!.revision), title: body.title as string,
      template: { task_title: '任务B', objective: '改为核对样例B', mode: 'AI_ASSIST', criteria: [{ statement: 'B样例通过' }], expected_outputs: {} },
      repeat: body.repeat_rule as never, timezone: body.timezone as string, localTime: body.local_time as string,
      firstLocalDate: body.first_local_date as string, maxRuns: body.max_runs as number,
      authorizationExpiresAt: body.authorization_expires_at as string,
      execution: undefined, confirmed: true, reason: '只修改未来时段的任务模板',
    });

    await dispatchScheduledOccurrence(app.db, occurrence.id);
    const finalRow = await repos.scheduledTasks.readOccurrence(occurrence.id);
    assert.equal(finalRow!.status, 'DISPATCHED', `改模板后原发生仍须分发：${finalRow!.reason}`);
    const task = await sql<{ title: string }>`select title from tasks where id = ${finalRow!.task_id}`.execute(app.db);
    assert.equal(task.rows[0]!.title, '任务A', '未提交的 CreateTask 必须用发生时冻结的模板，不得读编辑后的新模板');
  } finally {
    api = await startTestApi();
  }
});

test('补跑前准入：暂停/停用/到期/预算耗尽/项目归档的 RETRY 被拒绝且不建 Task', async () => {
  const f = await fixture();
  const variants = ['paused', 'disabled', 'expired', 'budget', 'archived'] as const;
  const plans: Record<string, { id: string; occurrence: Occurrence }> = {};

  for (const variant of variants) {
    const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
    await f.makeDue(created.scheduled_task_id as string, '-2 hours');
    const detail = await f.waitFor(created.scheduled_task_id as string, 1);
    assert.equal(detail.occurrences[0]!.status, 'BLOCKED');
    assert.equal(detail.occurrences[0]!.reason, 'MISSED');
    plans[variant] = { id: created.scheduled_task_id as string, occurrence: detail.occurrences[0]! };
  }

  await f.command(`/scheduled-tasks/${plans.paused!.id}/status-changes`, {
    expected_revision: (await f.detail(plans.paused!.id)).revision, status: 'PAUSED', reason: '先暂停',
  });
  await f.command(`/scheduled-tasks/${plans.disabled!.id}/status-changes`, {
    expected_revision: (await f.detail(plans.disabled!.id)).revision, status: 'DISABLED', reason: '停用',
  });
  await sql`update scheduled_tasks set authorization_expires_at = now() - interval '1 hour' where id = ${plans.expired!.id}`.execute(app.db);
  await sql`update scheduled_tasks set runs_reserved = max_runs, runs_started = max_runs where id = ${plans.budget!.id}`.execute(app.db);
  await sql`update projects set archived_at = now() where id = ${f.projectId}`.execute(app.db);

  const before = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  for (const variant of variants) {
    const { occurrence } = plans[variant]!;
    const response = await api.post(f.path(`/scheduled-task-occurrences/${occurrence.occurrence_id}/resolutions`), {
      command_id: randomUUID(), expected_revision: occurrence.revision, action: 'RETRY', reason: '尝试补跑',
    });
    assert.equal(response.status, 409, `${variant}：必然不可执行的补跑必须被事务内准入拒绝，得到 ${response.status}`);
    assert.equal((response.body as { code: string }).code, 'INVALID_TRANSITION');
    const after = (await f.detail(plans[variant]!.id)).occurrences[0]!;
    assert.equal(after.status, 'BLOCKED', `${variant}：被拒绝的补跑不得重开发生`);
  }
  const after = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(after.rows[0]!.count, before.rows[0]!.count, '被拒绝的补跑不得创建任何 Task');
});

test('Delegate 已提交而 markDispatched 未提交的崩溃恢复：runs_started 不重复计数', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;
  const repos = createRepositories(app.db);

  await f.makeDue(id, '0 seconds');
  const dispatched = (await f.waitFor(id, 1)).occurrences[0]!;
  assert.equal(dispatched.status, 'DISPATCHED');
  assert.equal((await f.detail(id)).runs_started, 1);

  await api.stop();
  try {
    // 还原「完成事实已落库、occurrence 标记丢失」的现场：正常流程两写同事务不会只丢一半，
    // 这里模拟的是第二个分发者沿同一发生重放（多实例/竞争兜底）——完成必须幂等。
    await sql`update scheduled_task_occurrences set status = 'DISPATCHING' where id = ${dispatched.occurrence_id}`.execute(app.db);
    await dispatchScheduledOccurrence(app.db, dispatched.occurrence_id);

    const finalRow = await repos.scheduledTasks.readOccurrence(dispatched.occurrence_id);
    assert.equal(finalRow!.status, 'DISPATCHED', '恢复必须按原回执完成标记');
    assert.equal(finalRow!.run_id, dispatched.run_id, '恢复不得产生第二个 Run');
    const schedule = await repos.scheduledTasks.read(id);
    assert.equal(schedule!.runs_started, 1, '回执重放的完成不得再次累计 runs_started');

    // 迟到的失败写入不得覆盖已确认的 DISPATCHED。
    await repos.scheduledTasks.markSettled(dispatched.occurrence_id, 'BLOCKED', 'LATE_WRITE');
    const settled = await repos.scheduledTasks.readOccurrence(dispatched.occurrence_id);
    assert.equal(settled!.status, 'DISPATCHED', '迟到写入不得污染已恢复的结果');
  } finally {
    api = await startTestApi();
  }
});

test('恢复分发前准入：计划已暂停时不建 Task 直接落 BLOCKED', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;
  const repos = createRepositories(app.db);

  await api.stop();
  try {
    const { occurrence } = await stuckDispatching(f.workspaceId, f.projectId, id);
    await setScheduledTaskStatus(app.db, {
      workspaceId: f.workspaceId, commandId: randomUUID(), scheduledTaskId: id,
      expectedRevision: (await repos.scheduledTasks.read(id))!.revision.toString(),
      status: 'PAUSED', reason: '崩溃期间用户暂停',
    });

    await dispatchScheduledOccurrence(app.db, occurrence.id);
    const finalRow = await repos.scheduledTasks.readOccurrence(occurrence.id);
    assert.equal(finalRow!.status, 'BLOCKED');
    assert.equal(finalRow!.reason, 'PLAN_NOT_ENABLED', '必然不可执行的恢复分发必须说明原因');
    assert.equal(finalRow!.task_id, null, '必然不可执行的恢复分发不得先建 Task');
    const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
    assert.equal(tasks.rows[0]!.count, '0');
  } finally {
    api = await startTestApi();
  }
});

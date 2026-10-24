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
} from '../../src/application/scheduled-tasks.js';
import { createTask, type CreateTaskCriterionInput } from '../../src/application/create-task.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-scheduled-task-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => { await api?.stop(); await app.close(); });

type Occurrence = {
  occurrence_id: string; scheduled_task_id: string; status: string; sequence: string;
  due_at: string; missed: boolean; task_id: string | null; run_id: string | null; reason: string | null; revision: string;
};
type Detail = {
  scheduled_task_id: string; project_id: string; status: string; revision: string;
  next_due_at: string | null; runs_started: number; max_runs: number; occurrences: Occurrence[];
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
  const projectId = (await command('/projects', { title: '定时整理项目', project_type: 'GENERAL' }, 201)).project_id as string;
  const detail = async (id: string) => await read(`/scheduled-tasks/${id}`) as unknown as Detail;
  /**
   * 等到「预期的触发数都出现，且没有一条还在 DISPATCHING」。
   * occurrence 先以租约状态落库、分发完成后才变 DISPATCHED，只看数量会读到中间态。
   */
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
  /** 直接改 next_due_at 是为了在真实时钟下制造「已到期」，不改任何业务状态列。 */
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
      task_title: '整理昨日进展', objective: '输出一页昨日进展摘要', mode: 'AI_ASSIST',
      criteria: [{ statement: '覆盖三项进展' }],
    },
    repeat_rule: { kind: 'DAILY', interval_days: 1 },
    timezone: 'Asia/Shanghai', local_time: '09:00', first_local_date: firstDate,
    max_runs: 5, authorization_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  };
}

test('到点自动新建 Task 并启动，同一 command 重放不重复建任务', async () => {
  const f = await fixture();
  const body = scheduleBody(f.projectId);
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, body, 201);
  const id = created.scheduled_task_id as string;

  const replay = await f.command(`/projects/${f.projectId}/scheduled-tasks`, body, 201);
  assert.equal(replay.scheduled_task_id, id, '同一 command_id 必须重放原结果');
  const rows = await sql<{ count: string }>`select count(*)::text as count from scheduled_tasks where workspace_id = ${f.workspaceId}`.execute(app.db);
  assert.equal(rows.rows[0]!.count, '1');

  await f.makeDue(id, '0 seconds');
  const detail = await f.waitFor(id, 1);
  const occurrence = detail.occurrences[0]!;
  assert.equal(occurrence.status, 'DISPATCHED');
  assert.equal(occurrence.missed, false);
  assert.ok(occurrence.task_id !== null && occurrence.run_id !== null);
  assert.equal(detail.runs_started, 1);

  const task = await sql<{ title: string; status: string }>`select title, status from tasks where id = ${occurrence.task_id}`.execute(app.db);
  assert.equal(task.rows[0]!.title, '整理昨日进展');
  // 触发只负责「新建并委托」；之后是否已被 Worker 领取取决于测试环境，因此这里断言
  // 「已越过 INBOX」，而不是钉死某个中间状态。
  assert.ok(['READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED'].includes(task.rows[0]!.status), `意外状态 ${task.rows[0]!.status}`);
  const run = await sql<{ status: string }>`select status from runs where id = ${occurrence.run_id}`.execute(app.db);
  assert.equal(run.rows.length, 1, '触发必须真的产生 Run');

  // 下一次触发已推到未来，不会被同一时段重复扫描。
  await delay(1500);
  assert.equal((await f.detail(id)).occurrences.length, 1);
});

test('上一轮任务未验收时本轮跳过，不堆出第二个任务', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  await f.makeDue(id, '0 seconds');
  await f.waitFor(id, 1);
  await f.makeDue(id, '0 seconds');
  const detail = await f.waitFor(id, 2);

  const skipped = detail.occurrences.find((item) => item.status === 'SKIPPED');
  assert.ok(skipped !== undefined, '上一轮 READY 未验收时必须跳过');
  assert.equal(skipped.reason, 'PREVIOUS_TASK_NOT_ACCEPTED');
  assert.equal(detail.runs_started, 1, '跳过不消耗执行次数');
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(tasks.rows[0]!.count, '1');
});

test('关闭期间错过的时段只形成待处理，不自动执行', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  await f.makeDue(id, '-2 hours');
  const detail = await f.waitFor(id, 1);
  const occurrence = detail.occurrences[0]!;
  assert.equal(occurrence.status, 'BLOCKED');
  assert.equal(occurrence.reason, 'MISSED');
  assert.equal(occurrence.missed, true);
  assert.equal(occurrence.task_id, null, '错过的时段不得建 Task');
  assert.equal(detail.runs_started, 0);

  const claim = await api.post(f.path('/attention/notifications/claim'), {});
  assert.equal(claim.status, 200, claim.text);
  const items = (claim.body as { items: { kind: string; target_url: string }[] }).items;
  assert.ok(items.some((item) => item.kind === 'SCHEDULED_TASK_BLOCKED' && item.target_url === `/scheduled-tasks/${id}`));
});

test('授权到期与暂停都停止产生新触发', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  await sql`update scheduled_tasks set authorization_expires_at = now() - interval '1 hour' where id = ${id}`.execute(app.db);
  await f.makeDue(id, '0 seconds');
  const expired = await f.waitFor(id, 1);
  assert.equal(expired.occurrences[0]!.status, 'BLOCKED');
  assert.equal(expired.occurrences[0]!.reason, 'AUTHORIZATION_EXPIRED');
  assert.equal(expired.status, 'EXPIRED');

  // 暂停后即使时刻已到也不再扫描。
  const second = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const secondId = second.scheduled_task_id as string;
  await f.command(`/scheduled-tasks/${secondId}/status-changes`, {
    expected_revision: second.revision, status: 'PAUSED', reason: '先暂停',
  });
  await f.makeDue(secondId, '0 seconds');
  await delay(2500);
  assert.equal((await f.detail(secondId)).occurrences.length, 0);
});

test('待处理触发可以补跑，补跑后按原命令身份只建一个任务', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  await f.makeDue(id, '-2 hours');
  const missed = (await f.waitFor(id, 1)).occurrences[0]!;
  assert.equal(missed.status, 'BLOCKED');

  await f.command(`/scheduled-task-occurrences/${missed.occurrence_id}/resolutions`, {
    expected_revision: missed.revision, action: 'RETRY', reason: '补跑一次',
  });
  const until = Date.now() + 10_000;
  let dispatched = (await f.detail(id)).occurrences[0]!;
  while (Date.now() < until && dispatched.status !== 'DISPATCHED') {
    await delay(100);
    dispatched = (await f.detail(id)).occurrences[0]!;
  }
  assert.equal(dispatched.status, 'DISPATCHED', '补跑后应真正启动');
  assert.ok(dispatched.task_id !== null && dispatched.run_id !== null);
  const tasks = await sql<{ count: string }>`select count(*)::text as count from tasks where project_id = ${f.projectId}`.execute(app.db);
  assert.equal(tasks.rows[0]!.count, '1');
});

test('编辑命令的模板进入幂等摘要：同 ID 换模板返回 COMMAND_ID_REUSED，同载荷重放仍回原回执', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  const edit = {
    ...scheduleBody(f.projectId),
    command_id: randomUUID(),
    expected_revision: created.revision,
    reason: '更新任务模板',
    template: { task_title: '任务A', objective: '只核对A样例', mode: 'AI_ASSIST', criteria: [{ statement: 'A样例通过' }] },
  };
  const editUrl = `/scheduled-tasks/${id}/edits`;
  const first = await f.command(editUrl, edit, 200);
  assert.equal(first.status, 'ENABLED');

  // 同 command_id + 同载荷：幂等重放必须返回原 200 回执，不重复执行。
  const replay = await f.command(editUrl, edit, 200);
  assert.deepEqual(replay, first, '同载荷重放必须返回原结果');

  // 同 command_id 只换 template：这是不同命令，必须判成 ID 复用，库里仍是已提交模板。
  const changed = await api.post(f.path(editUrl), {
    ...edit, template: { ...edit.template, task_title: '任务B', objective: '改为核对B样例', criteria: [{ statement: 'B样例通过' }] },
  });
  assert.equal(changed.status, 409, changed.text);
  assert.equal((changed.body as { code: string }).code, 'COMMAND_ID_REUSED');

  const detail = await f.detail(id) as unknown as Detail & { template: { task_title: string } };
  assert.equal(detail.template.task_title, '任务A', '被拒绝的载荷不得落到库');
  assert.equal(detail.revision, first.revision, '被拒绝的载荷不得推进修订');
});

test('到期的计划可以编辑延长授权，编辑解除原因后才允许重新启用', async () => {
  const f = await fixture();
  const created = await f.command(`/projects/${f.projectId}/scheduled-tasks`, scheduleBody(f.projectId), 201);
  const id = created.scheduled_task_id as string;

  await sql`update scheduled_tasks set authorization_expires_at = now() - interval '1 hour' where id = ${id}`.execute(app.db);
  await f.makeDue(id, '0 seconds');
  const expired = await f.waitFor(id, 1);
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(expired.occurrences[0]!.reason, 'AUTHORIZATION_EXPIRED');

  // 未延长授权时直接 ENABLED 仍被拒绝。
  const direct = await api.post(f.path(`/scheduled-tasks/${id}/status-changes`), {
    command_id: randomUUID(), expected_revision: expired.revision, status: 'ENABLED', reason: '不延长直接启用',
  });
  assert.equal(direct.status, 409, direct.text);
  assert.equal((direct.body as { code: string }).code, 'INVALID_TRANSITION');

  // 编辑本身就是延长授权的入口，EXPIRED 必须可编辑；编辑后保持 EXPIRED。
  const edited = await f.command(`/scheduled-tasks/${id}/edits`, {
    ...scheduleBody(f.projectId),
    command_id: randomUUID(),
    expected_revision: expired.revision,
    authorization_expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    reason: '用户显式延长授权',
  }, 200);
  assert.equal(edited.status, 'EXPIRED', '编辑延长授权不自动恢复启用');

  // 原因已由编辑解除后，ENABLED 是合法恢复入口。
  const enabled = await f.command(`/scheduled-tasks/${id}/status-changes`, {
    command_id: randomUUID(), expected_revision: edited.revision, status: 'ENABLED', reason: '延长授权后继续',
  }, 200);
  assert.equal(enabled.status, 'ENABLED');
});

test('分发中断后编辑模板，原发生恢复仍按原 CreateTask 身份委托原 Task', async () => {
  const f = await fixture();
  const repos = createRepositories(app.db);
  const plans: { id: string; body: ReturnType<typeof scheduleBody>; changed: boolean }[] = [];
  for (const changed of [false, true]) {
    const body = scheduleBody(f.projectId, {
      title: `恢复对照 ${changed}`,
      template: { task_title: '任务A', objective: '只核对样例A', mode: 'AI_ASSIST', criteria: [{ statement: 'A样例通过' }] },
    });
    const response = await f.command(`/projects/${f.projectId}/scheduled-tasks`, body, 201);
    plans.push({ id: response.scheduled_task_id as string, body, changed });
  }

  // 暂停共享 API：后台调度器会抢走刻意的持久前缀；场景结束在 finally 恢复。
  await api.stop();
  try {
    const results: { changed: boolean; status: string; reason: string | null; run_id: string | null; task_id: string | null; bound_task_id: string }[] = [];
    for (const plan of plans) {
      const { id, body, changed } = plan;
      await sql`update scheduled_tasks set next_due_at = clock_timestamp() where id = ${id}`.execute(app.db);
      const scanned = await scanScheduledTasks(app.db, new Date(Date.now() - 86_400_000));
      let occurrenceId: string | undefined;
      for (const candidate of scanned) {
        const row = await repos.scheduledTasks.readOccurrence(candidate);
        if (row?.scheduled_task_id === id) occurrenceId = row.id;
      }
      assert.ok(occurrenceId !== undefined, '扫描必须为该计划落一条触发');
      const occurrence = await repos.scheduledTasks.readOccurrence(occurrenceId!);
      assert.equal(occurrence!.status, 'DISPATCHING');
      const schedule = await repos.scheduledTasks.read(id);
      assert.ok(schedule !== undefined);

      // dispatchScheduledOccurrence 的已提交前缀：CreateTask 落库并绑定原 Task，然后「崩溃」。
      const template = schedule!.template;
      const createdTask = await createTask(app.db, {
        workspaceId: f.workspaceId, commandId: occurrence!.create_command_id, projectId: f.projectId,
        title: String(template.task_title), objective: String(template.objective),
        criteria: (template.criteria ?? []) as unknown as readonly CreateTaskCriterionInput[],
        expectedOutputs: (template.expected_outputs ?? {}) as Record<string, never>,
        mode: String(template.mode),
      });
      await repos.scheduledTasks.bindTask(occurrence!.id, createdTask.result.task_id);

      if (changed) {
        // 用全新编辑命令身份修改任务模板：不该让已排定的发生作废，也不该污染其命令身份。
        await editScheduledTask(app.db, {
          workspaceId: f.workspaceId, commandId: randomUUID(), scheduledTaskId: id,
          expectedRevision: String(schedule!.revision), title: body.title as string,
          template: { task_title: '任务B', objective: '改为核对样例B', mode: 'AI_ASSIST', criteria: [{ statement: 'B样例通过' }], expected_outputs: {} },
          repeat: body.repeat_rule as never, timezone: body.timezone as string, localTime: body.local_time as string,
          firstLocalDate: body.first_local_date as string, maxRuns: body.max_runs as number,
          authorizationExpiresAt: body.authorization_expires_at as string,
          execution: undefined, confirmed: true, reason: '只修改未来任务模板',
        });
      }

      await dispatchScheduledOccurrence(app.db, occurrence!.id);
      let finalOccurrence = await repos.scheduledTasks.readOccurrence(occurrence!.id);
      if (finalOccurrence!.status === 'BLOCKED') {
        // 人工按原发生身份 RETRY 后再分发：不得重复出现命令 ID 复用。
        await resolveScheduledTaskOccurrence(app.db, {
          workspaceId: f.workspaceId, commandId: randomUUID(), occurrenceId: occurrence!.id,
          expectedRevision: String(finalOccurrence!.revision), action: 'RETRY', reason: '沿原身份恢复',
        });
        await dispatchScheduledOccurrence(app.db, occurrence!.id);
        finalOccurrence = await repos.scheduledTasks.readOccurrence(occurrence!.id);
      }
      results.push({
        changed, status: finalOccurrence!.status, reason: finalOccurrence!.reason,
        run_id: finalOccurrence!.run_id, task_id: finalOccurrence!.task_id,
        bound_task_id: createdTask.result.task_id,
      });
    }

    assert.equal(results[0]!.status, 'DISPATCHED', '对照：未改模板的持久前缀照常恢复');
    assert.notEqual(results[1]!.reason, 'CommandIdReusedError', '恢复不得把新模板与原 create_command_id 拼在一起');
    assert.equal(results[1]!.status, 'DISPATCHED', '改模板后原发生仍须恢复');
    assert.ok(results[1]!.run_id !== null, '恢复后必须真的委托');
    assert.equal(results[1]!.task_id, results[1]!.bound_task_id, '委托的必须是崩溃前绑定的原 Task');
  } finally {
    api = await startTestApi();
  }
});

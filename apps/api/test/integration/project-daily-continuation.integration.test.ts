import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import {
  captureProjectContinuationPoint, compareProjectToContinuationPoint,
  listProjectContinuationPoints,
} from '../../src/application/project-continuation-points.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  createWorkspace, expectCommandAccepted, expectProblem, startTestApi, workspacePath,
  type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 日常查看基线与顶部接续卡（迁移 0063 / 工作台 §18.9）的真实 PG + 真实 HTTP 验收。
 *
 * 数据隔离：运行器为每个测试文件克隆独占数据库（run-integration.ps1 按 TEMPLATE 逐文件
 * 发库）。本套件只走 runIdempotentCommand 短事务，不驱动 claimNextPendingMessage / Run
 * 命令队列等整库领取语义，按 api-state 的模式共享一个 API 进程即可；每个用例使用独立的
 * Project（基线按 (workspace_id, project_id) 唯一），互不干扰。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-project-daily-continuation');

let api: TestApi;
let ws: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
  api = await startTestApi();
  ws = await createWorkspace(app.db);
});

after(async () => {
  await api?.stop();
  await app.close();
});

interface DailyProjection {
  readonly project_id: string;
  readonly current: {
    readonly state_revision: string; readonly phase_key: string | null;
    readonly next_action_task_id: string | null; readonly open_task_ids: readonly string[];
    readonly open_task_count: number; readonly open_task_ids_truncated: boolean;
    readonly waiting_task_count: number; readonly blocked_task_count: number;
    readonly unresolved_blocker_count: number;
  };
  readonly baseline: {
    readonly presentation_id: string; readonly viewed_state_revision: string;
    readonly viewed_fact_refs: Record<string, unknown>;
    readonly viewed_presentation_seq: string; readonly confirmed_at: string;
  } | null;
  readonly delta: {
    readonly phase_changed: boolean; readonly phase_before: string | null;
    readonly phase_after: string | null; readonly next_action_changed: boolean;
    readonly next_action_before: string | null; readonly next_action_after: string | null;
    readonly new_open_task_ids: readonly string[]; readonly closed_task_ids: readonly string[];
    readonly unresolved_blocker_count_changed: boolean;
    readonly open_tasks_unknown: boolean;
  } | null;
  readonly presentation: { readonly presentation_id: string;
    readonly presentation_seq: string };
  readonly revision: string;
}

async function createProject(): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/projects'), {
    command_id: commandId, title: '日常查看项目', project_type: 'DEVELOPMENT',
  });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function createTask(projectId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/tasks'), {
    command_id: commandId, project_id: projectId, title,
    objective: '为日常查看基线提供未决事实', criteria: [{ statement: '人工核对' }],
  });
  return expectCommandAccepted(response, 201, commandId).task_id as string;
}

async function readDaily(projectId: string): Promise<DailyProjection> {
  const response = await api.get(workspacePath(ws, `/projects/${projectId}/daily-continuation`));
  assert.equal(response.status, 200, response.text);
  return response.body as DailyProjection;
}

async function confirm(projectId: string, body: Record<string, unknown>): Promise<{
  status: number; body: DailyProjection & { readonly code?: string } | Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}> {
  const response = await api.post(workspacePath(ws,
    `/projects/${projectId}/daily-view-confirmations`), body);
  return { status: response.status, headers: response.headers,
    body: (response.status === 200
      ? (response.body as { result: DailyProjection }).result
      : response.body) as DailyProjection & { readonly code?: string } };
}

function refsOf(projection: DailyProjection): Record<string, unknown> {
  return { phase_key: projection.current.phase_key,
    next_action_task_id: projection.current.next_action_task_id,
    open_task_ids: projection.current.open_task_ids,
    open_task_ids_truncated: projection.current.open_task_ids_truncated,
    unresolved_blocker_count: projection.current.unresolved_blocker_count };
}

/**
 * 按一次真实读取构造确认载荷：presentation 身份与序号都来自服务端签发，
 * viewed_fact_refs 必须回显这次实际展示的内容。
 */
function confirmBodyOf(projection: DailyProjection,
  overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { command_id: randomUUID(),
    presentation_id: projection.presentation.presentation_id,
    presentation_seq: projection.presentation.presentation_seq,
    viewed_state_revision: projection.current.state_revision,
    viewed_fact_refs: refsOf(projection), ...overrides };
}

async function setPhase(projectId: string, expectedRevision: string,
  phaseKey: string): Promise<void> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, `/projects/${projectId}/state-commands`), {
    command_id: commandId, expected_revision: expectedRevision,
    action: 'SET_PHASE', phase_key: phaseKey,
  });
  assert.equal(response.status, 200, response.text);
}

async function baselineRow(projectId: string) {
  const row = await createRepositories(app.db).dailyViews.findByProject(ws, projectId);
  assert.ok(row !== undefined);
  return row;
}

test('无基线 GET：baseline 与 delta 均为 null，current 反映真实 State 与未决任务', async () => {
  const projectId = await createProject();
  const taskA = await createTask(projectId, '盘点现状');
  const projection = await readDaily(projectId);
  assert.equal(projection.project_id, projectId);
  assert.equal(projection.baseline, null);
  assert.equal(projection.delta, null);
  assert.equal(projection.revision, '0');
  assert.equal(projection.current.state_revision, '0');
  assert.equal(projection.current.phase_key, 'DISCOVERY');
  assert.equal(projection.current.next_action_task_id, null);
  assert.deepEqual(projection.current.open_task_ids, [taskA]);
  assert.equal(projection.current.open_task_count, 1);
  assert.equal(projection.current.waiting_task_count, 0);
  assert.equal(projection.current.blocked_task_count, 0);
  assert.equal(projection.current.unresolved_blocker_count, 0);
});

test('确认基线后推进 State 并新开任务：delta 如实报告 phase 与 open 差集', async () => {
  const projectId = await createProject();
  const taskA = await createTask(projectId, '盘点现状');
  const before = await readDaily(projectId);

  const firstBody = confirmBodyOf(before);
  const presentationId = firstBody.presentation_id as string;
  const first = await confirm(projectId, firstBody);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const confirmed = first.body as DailyProjection;
  assert.ok(confirmed.baseline !== null);
  assert.equal(confirmed.baseline.presentation_id, presentationId);
  assert.equal(confirmed.baseline.viewed_state_revision, '0');
  // 刚确认后当前事实与基线一致：零变化。
  assert.equal(confirmed.delta?.phase_changed, false);
  assert.deepEqual(confirmed.delta?.new_open_task_ids, []);
  assert.equal(confirmed.revision, '0');

  await setPhase(projectId, '0', 'IMPLEMENTATION');
  const taskB = await createTask(projectId, '新开的事项');
  const after = await readDaily(projectId);
  assert.equal(after.current.state_revision, '1');
  assert.equal(after.current.phase_key, 'IMPLEMENTATION');
  assert.deepEqual(after.current.open_task_ids, [taskA, taskB]);
  assert.ok(after.baseline !== null);
  assert.equal(after.baseline.viewed_state_revision, '0');
  assert.equal(after.revision, '0');
  assert.ok(after.delta !== null);
  assert.equal(after.delta.phase_changed, true);
  assert.equal(after.delta.phase_before, 'DISCOVERY');
  assert.equal(after.delta.phase_after, 'IMPLEMENTATION');
  assert.equal(after.delta.next_action_changed, false);
  assert.deepEqual(after.delta.new_open_task_ids, [taskB]);
  assert.deepEqual(after.delta.closed_task_ids, []);
  assert.equal(after.delta.unresolved_blocker_count_changed, false);
});

test('同 presentation_id 重复确认幂等：不产生第二行、confirmed_at 不变', async () => {
  const projectId = await createProject();
  const projection = await readDaily(projectId);
  const confirmBody = confirmBodyOf(projection);
  const presentationId = confirmBody.presentation_id as string;
  const first = await confirm(projectId, confirmBody);
  assert.equal(first.status, 200);
  const firstRow = await baselineRow(projectId);
  const confirmedAt = firstRow.confirmed_at.toISOString();

  // 同 command_id 重放：回执层回放，confirmed_at 不变。
  const replay = await confirm(projectId, confirmBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers['command-replayed'], 'true');
  const afterReplay = await baselineRow(projectId);
  assert.equal(afterReplay.id, firstRow.id);
  assert.equal(afterReplay.confirmed_at.toISOString(), confirmedAt);

  // 同 presentation_id、不同 command_id：走 presentation 幂等分支，同样不产生第二行。
  const again = await confirm(projectId, { ...confirmBody, command_id: randomUUID() });
  assert.equal(again.status, 200);
  const afterAgain = await baselineRow(projectId);
  assert.equal(afterAgain.id, firstRow.id);
  assert.equal(afterAgain.confirmed_at.toISOString(), confirmedAt);
  assert.equal(afterAgain.presentation_id, presentationId);
  const projectionAfter = await readDaily(projectId);
  assert.equal(projectionAfter.baseline?.presentation_id, presentationId);
});

test('迟到确认（更小 viewed_state_revision）不覆盖更新的基线', async () => {
  const projectId = await createProject();
  const projection = await readDaily(projectId);
  const presentationId = projection.presentation.presentation_id;
  await confirm(projectId, confirmBodyOf(projection));
  await setPhase(projectId, '0', 'IMPLEMENTATION');

  // 在当前 revision 1 上确认：基线推进。
  const atOne = await readDaily(projectId);
  const presentationId2 = atOne.presentation.presentation_id;
  const advanced = await confirm(projectId, confirmBodyOf(atOne));
  assert.equal(advanced.status, 200);
  assert.equal((advanced.body as DailyProjection).baseline?.presentation_id, presentationId2);

  // 迟到确认（旧展示：更小的展示序号 + 更小的 revision）：不覆盖，返回当前基线投影。
  const late = await confirm(projectId, confirmBodyOf(projection));
  assert.equal(late.status, 200);
  const lateProjection = late.body as DailyProjection;
  assert.equal(lateProjection.baseline?.presentation_id, presentationId2);
  assert.equal(lateProjection.baseline?.viewed_state_revision, '1');
  const stored = await baselineRow(projectId);
  assert.equal(stored.presentation_id, presentationId2);
  assert.equal(stored.viewed_state_revision, 1n);
});

test('非法 viewed_fact_refs 被类型化拒绝且不写基线', async () => {
  const projectId = await createProject();
  const rejection = async (viewedFactRefs: unknown): Promise<void> => {
    const response = await api.post(workspacePath(ws,
      `/projects/${projectId}/daily-view-confirmations`), {
      command_id: randomUUID(), presentation_id: randomUUID(),
      presentation_seq: '1', viewed_state_revision: '0', viewed_fact_refs: viewedFactRefs,
    });
    const problem = expectProblem(response, 422, 'VALIDATION_FAILED');
    // 数组形状在 HTTP schema 层被拒（field 为 '/viewed_fact_refs'）；
    // 对象内字段错误由应用层校验产生（field 为 'viewed_fact_refs.*'）。两种都算类型化拒绝。
    assert.ok((problem.field_errors ?? []).some((error) =>
      error.field.includes('viewed_fact_refs')), response.text);
  };
  await rejection(['task-a']);
  await rejection({ next_action_task_id: null, open_task_ids: [] });
  await rejection({ phase_key: 'DISCOVERY', next_action_task_id: null,
    open_task_ids: ['task-a', 3] });
  await rejection({ phase_key: 'DISCOVERY', next_action_task_id: null,
    open_task_ids: Array.from({ length: 201 }, (_, index) => `task-${index}`) });
  await rejection({ phase_key: 'DISCOVERY', next_action_task_id: null, open_task_ids: [],
    unresolved_blocker_count: -1 });
  const row = await createRepositories(app.db).dailyViews.findByProject(ws, projectId);
  assert.equal(row, undefined);
});

test('命名接续点回归：确认日常查看后 N01 捕获、列表与比较行为不变', async () => {
  const projectId = await createProject();
  await createTask(projectId, '盘点现状');
  const commandId = randomUUID();
  const captured = await captureProjectContinuationPoint(app.db, { workspaceId: ws,
    projectId, commandId, name: '开工快照', note: null });
  const pointId = captured.result.id;

  const projection = await readDaily(projectId);
  const confirmed = await confirm(projectId, confirmBodyOf(projection));
  assert.equal(confirmed.status, 200);
  await setPhase(projectId, '0', 'IMPLEMENTATION');

  const points = await listProjectContinuationPoints(app.db, { workspaceId: ws, projectId });
  assert.equal(points.length, 1);
  assert.equal(points[0]!.id, pointId);
  // 命名接续点未被日常查看重设：捕获时点仍停在 DISCOVERY / revision 0。
  assert.equal(points[0]!.captured_state.phase_key, 'DISCOVERY');
  assert.equal(points[0]!.captured_state.revision, '0');

  // N01 比较仍按自己的捕获基线工作：与日常查看基线互不干扰。
  const comparison = await compareProjectToContinuationPoint(app.db, { workspaceId: ws,
    projectId, continuationPointId: pointId });
  assert.equal(comparison.facts.phase_changed, true);
  assert.equal(comparison.continuation_point.captured_state.phase_key, 'DISCOVERY');
  assert.equal(comparison.current_state.phase_key, 'IMPLEMENTATION');
});

/* -------------------------------------------------------------------------- */
/* 整改反例的正式回归（4.5：多对象查看基线）                                    */
/* -------------------------------------------------------------------------- */

test('State 不变时新增任务：确认后基线推进，已查看的变化不再反复报新增（4.5 反例）', async () => {
  const projectId = await createProject();
  const taskA = await createTask(projectId, '盘点现状');

  const firstRead = await readDaily(projectId);
  assert.equal(firstRead.current.state_revision, '0');
  assert.equal(firstRead.delta, null, '首次查看没有基线，只展示当前事实');
  const firstConfirm = await confirm(projectId, confirmBodyOf(firstRead));
  assert.equal(firstConfirm.status, 200, JSON.stringify(firstConfirm.body));

  // 创建任务 B：State 仍是 v0，只有任务集合变了。
  const taskB = await createTask(projectId, '搜索能力');
  const shown = await readDaily(projectId);
  assert.equal(shown.current.state_revision, '0', 'State revision 不变');
  assert.ok(shown.delta !== null);
  assert.deepEqual(shown.delta.new_open_task_ids, [taskB]);

  const secondConfirm = await confirm(projectId, confirmBodyOf(shown));
  assert.equal(secondConfirm.status, 200, JSON.stringify(secondConfirm.body));

  // 离开后返回：基线必须已经覆盖 B，不再把它报成新增。
  const reopened = await readDaily(projectId);
  assert.ok(reopened.baseline !== null);
  assert.equal(reopened.current.state_revision, '0');
  assert.deepEqual([...(reopened.baseline.viewed_fact_refs.open_task_ids as string[])].sort(),
    [taskA, taskB].sort(), '确认针对实际展示结果，基线推进到已查看的任务集合');
  assert.ok(reopened.delta !== null);
  assert.deepEqual(reopened.delta.new_open_task_ids, [], '已查看的新增不再反复报告');
  assert.equal(reopened.delta.open_tasks_unknown, false);

  // 之后再新增 C：只报告 C。
  const taskC = await createTask(projectId, '导出能力');
  const withC = await readDaily(projectId);
  assert.ok(withC.delta !== null);
  assert.deepEqual(withC.delta.new_open_task_ids, [taskC]);
});

test('同 State revision 的确认顺序：新摘要先确认、旧摘要迟到不覆盖（4.5 反例）', async () => {
  const projectId = await createProject();
  await createTask(projectId, '盘点现状');
  const older = await readDaily(projectId);
  const taskB = await createTask(projectId, '搜索能力');
  const newer = await readDaily(projectId);
  assert.equal(older.current.state_revision, newer.current.state_revision,
    '两次读取之间 State revision 没有变化');

  // 新摘要先确认。
  const firstConfirm = await confirm(projectId, confirmBodyOf(newer));
  assert.equal(firstConfirm.status, 200);

  // 旧摘要（更小的服务端展示序号）随后迟到确认：不得覆盖新查看结果。
  const lateConfirm = await confirm(projectId, confirmBodyOf(older));
  assert.equal(lateConfirm.status, 200, JSON.stringify(lateConfirm.body));
  const lateBody = lateConfirm.body as DailyProjection;
  assert.equal(lateBody.baseline?.presentation_id, newer.presentation.presentation_id);
  assert.deepEqual([...(lateBody.baseline?.viewed_fact_refs.open_task_ids as string[])]
    .includes(taskB), true, '基线保留新查看结果里的任务');

  const stored = await createRepositories(app.db).dailyViews.findByProject(ws, projectId);
  assert.ok(stored !== undefined);
  assert.equal(stored.presentation_id, newer.presentation.presentation_id);
});

test('旧摘要先确认、新摘要随后确认：两个同 State revision 的确认都能正确推进', async () => {
  const projectId = await createProject();
  await createTask(projectId, '盘点现状');
  const older = await readDaily(projectId);
  const taskB = await createTask(projectId, '搜索能力');
  const newer = await readDaily(projectId);

  const olderConfirm = await confirm(projectId, confirmBodyOf(older));
  assert.equal(olderConfirm.status, 200);
  assert.deepEqual(
    ((olderConfirm.body as DailyProjection).baseline?.viewed_fact_refs
      .open_task_ids as string[]).length, 1);

  const newerConfirm = await confirm(projectId, confirmBodyOf(newer));
  assert.equal(newerConfirm.status, 200);
  const projected = newerConfirm.body as DailyProjection;
  assert.equal(projected.baseline?.presentation_id, newer.presentation.presentation_id);
  assert.deepEqual([...(projected.baseline?.viewed_fact_refs.open_task_ids as string[])]
    .includes(taskB), true);
});

test('未签发的展示序号不能确认：必须来自一次真实读取', async () => {
  const projectId = await createProject();
  await createTask(projectId, '盘点现状');
  const projection = await readDaily(projectId);
  const response = await api.post(workspacePath(ws,
    `/projects/${projectId}/daily-view-confirmations`), {
    command_id: randomUUID(), presentation_id: randomUUID(), presentation_seq: '9999',
    viewed_state_revision: projection.current.state_revision,
    viewed_fact_refs: refsOf(projection),
  });
  expectProblem(response, 422, 'VALIDATION_FAILED');
  const row = await createRepositories(app.db).dailyViews.findByProject(ws, projectId);
  assert.equal(row, undefined, '伪造的展示不能写入基线');
});

/* -------------------------------------------------------------------------- */
/* R6：展示身份、序号、版本与事实的完整绑定（独立复验反例）                      */
/* -------------------------------------------------------------------------- */

test('复验R6：未签发身份、seq 嫁接、伪造版本、篡改事实与跨项目确认都被拒绝，基线不写', async () => {
  const projectId = await createProject();
  await createTask(projectId, '既有任务');
  const shown = await readDaily(projectId);        // 签发 #1
  const shownNext = await readDaily(projectId);    // 签发 #2（用于嫁接序号）

  // 1) 复验反例原样：随机未签发 presentation_id + 合法序号 + 当前版本 + 真实事实。
  const forged = await confirm(projectId,
    confirmBodyOf(shown, { presentation_id: randomUUID() }));
  assert.equal(forged.status, 422,
    `序号在已签发上限内不能证明这份身份展示过：${JSON.stringify(forged.body)}`);

  // 2) 真实身份 + 属于另一次展示的序号（seq 嫁接）。
  const grafted = await confirm(projectId, confirmBodyOf(shown,
    { presentation_seq: shownNext.presentation.presentation_seq }));
  assert.equal(grafted.status, 422, JSON.stringify(grafted.body));

  // 3) 真实身份与序号 + 伪造的 State 版本。
  const fakeRevision = await confirm(projectId,
    confirmBodyOf(shown, { viewed_state_revision: '999999' }));
  assert.equal(fakeRevision.status, 422, JSON.stringify(fakeRevision.body));

  // 4) 真实身份与序号 + 篡改这次已展示的事实摘要。
  const tampered = await confirm(projectId, confirmBodyOf(shown,
    { viewed_fact_refs: { ...refsOf(shown), phase_key: 'RELEASE' } }));
  assert.equal(tampered.status, 422, JSON.stringify(tampered.body));

  // 5) 跨项目复用同一次展示身份。
  const otherProject = await createProject();
  const cross = await confirm(otherProject, confirmBodyOf(shown));
  assert.equal(cross.status, 422, JSON.stringify(cross.body));

  // 全部拒绝后：基线不写、签发不冒充确认。
  const row = await createRepositories(app.db).dailyViews.findByProject(ws, projectId);
  assert.equal(row, undefined, '被拒绝的确认不写基线');
  const after = await readDaily(projectId);
  assert.equal(after.baseline, null);
});

test('复验R6：真实展示确认与同展示重放仍生效；被污染的旧基线可识别并恢复', async () => {
  const projectId = await createProject();
  await createTask(projectId, '既有任务');
  const shown = await readDaily(projectId);
  const ok = await confirm(projectId, confirmBodyOf(shown));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((ok.body as DailyProjection).baseline?.presentation_id,
    shown.presentation.presentation_id, '合法确认绑定真实签发身份');

  // 同展示、不同 command_id：presentation 幂等重放仍 200。
  const replay = await confirm(projectId, confirmBodyOf(shown));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal((replay.body as DailyProjection).baseline?.presentation_id,
    shown.presentation.presentation_id);

  // 污染旧基线：伪造身份 + 不可能的版本（等价迁移前被写坏的基线）。
  const pollutedId = randomUUID();
  await sql`update project_daily_view_baselines
    set presentation_id = ${pollutedId}, viewed_state_revision = 999999,
      viewed_presentation_seq = 0,
      viewed_fact_refs = ${JSON.stringify({ phase_key: 'RELEASE',
        next_action_task_id: null, open_task_ids: [],
        unresolved_blocker_count: 0 })}::jsonb
    where workspace_id = ${ws} and project_id = ${projectId}`.execute(app.db);

  // 恢复：真实读取 + 确认把基线修回可核对的事实，且留下可追溯审计。
  const repairRead = await readDaily(projectId);
  const repaired = await confirm(projectId, confirmBodyOf(repairRead));
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  const repairedBody = repaired.body as DailyProjection;
  assert.equal(repairedBody.baseline?.presentation_id,
    repairRead.presentation.presentation_id,
    '污染基线不能永远挡住正常查看：恢复后绑定真实签发身份');
  assert.equal(repairedBody.baseline?.viewed_state_revision,
    repairRead.current.state_revision, '恢复后的版本是真实读取的版本');
  const audits = await sql<{ count: string }>`select count(*)::text as count
    from activity_records
    where event_type = 'PROJECT_DAILY_VIEW_BASELINE_REPAIRED'
      and fact_refs->>'project_id' = ${projectId}`.execute(app.db);
  assert.equal(audits.rows[0]?.count, '1', '污染基线的恢复留下可追溯审计');
});

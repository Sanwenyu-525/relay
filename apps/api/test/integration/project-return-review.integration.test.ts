import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { reviewProjectReturn } from '../../src/application/project-return-review.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ProjectReturnReviewRepository } from '../../src/project/project-return-review-repository.js';
import {
  createWorkspace, expectCommandAccepted, startTestApi, workspacePath,
  type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 返回轻量核对（0069 / NLS-05、NLS-08、NLS-09）的真实 PG + 真实 HTTP 验收。
 *
 * 核对是有持久身份的只读记录：同一份事实与证据复用同一行（重复打开、双击、重启不产生
 * 第二次核对），事实变化产生新记录；失权零写入；不伪造 Run、不启动进程、不自动修复。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-project-return-review');

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

interface ReviewProjection {
  readonly review_id: string;
  readonly project_id: string;
  readonly status: 'APPLICABLE' | 'CHANGED';
  readonly fingerprint: string;
  readonly reused: boolean;
  readonly changed_dimensions: readonly string[];
  readonly delta: { readonly phase_changed: boolean;
    readonly new_open_task_count: number } | null;
  readonly evidence: readonly { readonly task_id: string;
    readonly applicable: boolean }[];
  readonly created_at: string;
}

interface DailyProjection {
  readonly current: { readonly state_revision: string;
    readonly phase_key: string | null;
    readonly next_action_task_id: string | null;
    readonly open_task_ids: readonly string[];
    readonly open_task_ids_truncated: boolean;
    readonly unresolved_blocker_count: number };
  readonly baseline: { readonly presentation_id: string } | null;
  readonly delta: { readonly new_open_task_ids: readonly string[] } | null;
  readonly presentation: { readonly presentation_id: string;
    readonly presentation_seq: string };
}

async function createProject(): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/projects'), {
    command_id: commandId, title: '返回核对项目', project_type: 'DEVELOPMENT',
  });
  return expectCommandAccepted(response, 201, commandId).project_id as string;
}

async function createTask(projectId: string, title: string): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/tasks'), {
    command_id: commandId, project_id: projectId, title,
    objective: '为返回核对提供事实', criteria: [{ statement: '人工核对' }],
  });
  return expectCommandAccepted(response, 201, commandId).task_id as string;
}

async function readDaily(projectId: string): Promise<DailyProjection> {
  const response = await api.get(workspacePath(ws, `/projects/${projectId}/daily-continuation`));
  assert.equal(response.status, 200, response.text);
  return response.body as DailyProjection;
}

/** 建立「实际查看确认」基线：按一次真实读取回显身份与事实。 */
async function confirmBaseline(projectId: string): Promise<void> {
  const projection = await readDaily(projectId);
  const response = await api.post(workspacePath(ws,
    `/projects/${projectId}/daily-view-confirmations`), {
    command_id: randomUUID(),
    presentation_id: projection.presentation.presentation_id,
    presentation_seq: projection.presentation.presentation_seq,
    viewed_state_revision: projection.current.state_revision,
    viewed_fact_refs: { phase_key: projection.current.phase_key,
      next_action_task_id: projection.current.next_action_task_id,
      open_task_ids: projection.current.open_task_ids,
      open_task_ids_truncated: projection.current.open_task_ids_truncated,
      unresolved_blocker_count: projection.current.unresolved_blocker_count },
  });
  assert.equal(response.status, 200, response.text);
}

async function postReview(projectId: string, commandId = randomUUID()): Promise<{
  readonly status: number;
  readonly result: ReviewProjection;
  readonly text: string;
}> {
  const response = await api.post(workspacePath(ws,
    `/projects/${projectId}/return-reviews`), { command_id: commandId });
  return { status: response.status,
    result: response.status === 200
      ? (response.body as { result: ReviewProjection }).result
      : response.body as unknown as ReviewProjection,
    text: response.text };
}

async function reviewRows(projectId: string): Promise<readonly { readonly id: string;
  readonly fingerprint: string; readonly status: string }[]> {
  return createRepositories(app.db).returnReviews.listByProject(ws, projectId, 50);
}

async function reviewedAudits(projectId: string): Promise<string> {
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from activity_records where event_type = 'PROJECT_RETURN_REVIEWED'
      and fact_refs->>'project_id' = ${projectId}`.execute(app.db);
  return rows.rows[0]?.count ?? '0';
}

async function runCount(): Promise<string> {
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from runs where workspace_id = ${ws}`.execute(app.db);
  return rows.rows[0]?.count ?? '0';
}

test('复验C1：无查看基线的首次返回如实标出缺基线；跨 Workspace 拒绝且零写入', async () => {
  const projectId = await createProject();
  await createTask(projectId, '首个任务');

  const first = await postReview(projectId);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.result.status, 'CHANGED',
    '没有可比对的查看基线时不能声称无变化');
  assert.ok(first.result.changed_dimensions.includes('baseline_missing'),
    JSON.stringify(first.result));
  assert.equal(first.result.reused, false);
  const rows = await reviewRows(projectId);
  assert.equal(rows.length, 1, '同一事实只有一条核对记录');
  assert.equal(await reviewedAudits(projectId), '1');
  assert.equal(await runCount(), '0', '核对不伪造 Run');

  // 跨 Workspace：可见性核对先行，404，零写入。
  const otherWs = await createWorkspace(app.db);
  const cross = await api.post(workspacePath(otherWs,
    `/projects/${projectId}/return-reviews`), { command_id: randomUUID() });
  assert.equal(cross.status, 404, cross.text);
  assert.equal((await reviewRows(projectId)).length, 1, '跨 Workspace 不写入核对记录');
  assert.equal(await reviewedAudits(projectId), '1');
});

test('复验C2：有基线且无变化、证据适用时复用同一记录；事实变化产生新核对', async () => {
  const projectId = await createProject();
  await createTask(projectId, '既有任务');
  await confirmBaseline(projectId);

  const first = await postReview(projectId);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.result.status, 'APPLICABLE',
    `无变化且证据适用时复用既有结论：${JSON.stringify(first.result)}`);
  assert.deepEqual(first.result.changed_dimensions, []);

  // 重复打开（不同 command）：同一 fingerprint 复用同一行，不产生第二次核对。
  const second = await postReview(projectId);
  assert.equal(second.status, 200, second.text);
  assert.equal(second.result.review_id, first.result.review_id, '重复返回按原记录复用');
  assert.equal(second.result.reused, true);
  assert.equal((await reviewRows(projectId)).length, 1);
  assert.equal(await reviewedAudits(projectId), '1', '复用不产生第二次核对审计');

  // 同命令重放：原结果回读，仍只有一条记录。
  const replay = await postReview(projectId, (await (async () => {
    const commandId = randomUUID();
    await postReview(projectId, commandId);
    return commandId;
  })()));
  assert.equal(replay.status, 200, replay.text);
  assert.equal((await reviewRows(projectId)).length, 1);

  // 事实变化（新增任务）：新 fingerprint → 新核对，不把旧结论冒充新结果。
  await createTask(projectId, '新增任务');
  const changed = await postReview(projectId);
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.result.status, 'CHANGED');
  assert.ok(changed.result.changed_dimensions.includes('open_tasks'));
  assert.notEqual(changed.result.review_id, first.result.review_id);
  assert.equal(changed.result.reused, false);
  const rows = await reviewRows(projectId);
  assert.equal(rows.length, 2, '事实变化产生第二条核对记录');
  assert.equal(await reviewedAudits(projectId), '2');

  // 变化后再重复返回：复用的是新记录。
  const repeat = await postReview(projectId);
  assert.equal(repeat.result.review_id, changed.result.review_id);
  assert.equal(repeat.result.reused, true);
  assert.equal((await reviewRows(projectId)).length, 2);
  assert.equal(await reviewedAudits(projectId), '2');
});

test('复验C3：核对写入前中断不留下半条记录，重试按原关系恰好建立一次', async () => {
  const projectId = await createProject();
  await createTask(projectId, '重启场景任务');

  const original = ProjectReturnReviewRepository.prototype.insertReview;
  let injected = false;
  ProjectReturnReviewRepository.prototype.insertReview = async function (input) {
    if (!injected) {
      injected = true;
      throw new Error('INJECT_BEFORE_RETURN_REVIEW_SAVE');
    }
    return original.call(this, input);
  };
  try {
    await assert.rejects(() => reviewProjectReturn(app.db, { workspaceId: ws,
      projectId, commandId: randomUUID() }),
    /INJECT_BEFORE_RETURN_REVIEW_SAVE/u);
  } finally {
    ProjectReturnReviewRepository.prototype.insertReview = original;
  }
  assert.equal(injected, true);
  assert.equal((await reviewRows(projectId)).length, 0,
    '中断不留下半条核对记录（回执与行同事务回滚）');
  assert.equal(await reviewedAudits(projectId), '0');

  const retry = await postReview(projectId);
  assert.equal(retry.status, 200, retry.text);
  assert.equal((await reviewRows(projectId)).length, 1, '重试恰好建立一次核对');
  assert.equal(await reviewedAudits(projectId), '1');
});

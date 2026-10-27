import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runOneCommand } from '../../src/worker/run-command.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from './integration-support.js';
import { createWorkspace, delay, expectCommandAccepted, startTestApi, workspacePath, type TestApi } from './api-harness.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-n04-n06-business-flow-test');
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  api = await startTestApi();
});
after(async () => {
  await api?.stop();
  await app.close();
});

type PlanItem = { id: string; task_id: string; status: string };
type ChainItem = { task_id: string; run_id: string | null; status: string; completion_id: string | null };
const minutes = (value: number) => value * 60_000;

test('N04 计划与范围选择进入 N06 授权执行、人工 Review、Completion 后再启动下一项', async () => {
  const workspaceId = await createWorkspace(app.db);
  const path = (suffix: string) => workspacePath(workspaceId, suffix);
  const post = async (suffix: string, body: Record<string, unknown>, status: 200 | 201 = 200) => {
    const commandId = typeof body.command_id === 'string' ? body.command_id : randomUUID();
    return expectCommandAccepted(await api.post(path(suffix), { command_id: commandId, ...body }), status, commandId);
  };
  const read = async (suffix: string) => {
    const response = await api.get(path(suffix));
    assert.equal(response.status, 200, response.text);
    return response.body as Record<string, unknown>;
  };
  const projectId = (await post('/projects', { title: 'N04 到 N06 联合闭环', project_type: 'GENERAL' }, 201)).project_id as string;
  const taskIds: string[] = [];
  for (const title of ['主线任务', '必要前置', '本段排除']) {
    taskIds.push((await post('/tasks', {
      project_id: projectId,
      title,
      objective: `完成${title}`,
      expected_outputs: { artifacts: ['MARKDOWN_DOCUMENT'] },
      criteria: [{ criterion_id: 'human', statement: '人工核对确切产物', method: 'HUMAN' }],
    }, 201)).task_id as string);
  }
  const [main, prerequisite, independent] = taskIds as [string, string, string];
  await post(`/tasks/${main}/dependency-links`, { expected_revision: '0', depends_on_task_id: prerequisite, dependency_kind: 'BLOCKS' });

  const repositories = createRepositories(app.db);
  for (const [taskId, elapsed] of [[main, 25], [prerequisite, 10], [independent, 40]] as const) {
    const task = (await repositories.tasks.readTask(taskId))!;
    await post(`/tasks/${taskId}/time-estimates`, {
      confirmed: true,
      expected_task_revision: task.revision.toString(),
      expected_estimate_revision: '0',
      elapsed_ms: minutes(elapsed),
      execution_ms: null,
      waiting_ms: null,
      review_ms: null,
      human_ms: null,
      source_note: '联合验收中的用户声明估时',
    });
  }

  const plan = await post(`/projects/${projectId}/period-plans`, {
    title: '下一段计划', available_ms: minutes(60), diagnostic_ms: minutes(5), task_ids: [main, independent], mainline_task_ids: [main], goal_ids: [],
  });
  const sourcePlanPath = `/period-plans/${plan.plan_id}`;
  const originalItems = (await read(sourcePlanPath)).items as PlanItem[];
  assert.deepEqual(originalItems.map((item) => item.task_id), [prerequisite, main, independent]);
  const simulation = await post(`${sourcePlanPath}/scope-simulations`, {
    expected_revision: '1', keep_task_ids: [main], defer_task_ids: [prerequisite], unreliable_task_ids: [],
  });
  const simulationPath = `/scope-simulations/${simulation.simulation_id}`;
  const selection = await post(`${simulationPath}/selections`, {
    expected_revision: '1', confirmed: true, option: 'SHRINK', reason: '本段保留主线及必要前置',
  });
  const selectedPlanPath = `/period-plans/${selection.selected_plan_id}`;
  const selectedItems = (await read(selectedPlanPath)).items as PlanItem[];
  assert.deepEqual(selectedItems.map((item) => item.task_id), [prerequisite, main, independent]);
  const acceptedPrerequisite = await post(`${selectedPlanPath}/items/${selectedItems.find((item) => item.task_id === prerequisite)!.id}/resolutions`, {
    expected_revision: '1', action: 'ACCEPT', reason: '先完成必要前置',
  });
  const acceptedMain = await post(`${selectedPlanPath}/items/${selectedItems.find((item) => item.task_id === main)!.id}/resolutions`, {
    expected_revision: acceptedPrerequisite.revision, action: 'ACCEPT', reason: '推进主线任务',
  });
  await post(`${selectedPlanPath}/items/${selectedItems.find((item) => item.task_id === independent)!.id}/resolutions`, {
    expected_revision: acceptedMain.revision, action: 'REJECT', reason: '本段暂不执行',
  });
  const beforeAuthorization = await sql<{ count: string }>`select count(*)::text as count from runs where workspace_id = ${workspaceId}`.execute(app.db);
  assert.equal(beforeAuthorization.rows[0]?.count, '0', '计划与范围选择不应启动 Run');

  const chainTasks = [];
  for (const taskId of [prerequisite, main]) {
    const task = (await repositories.tasks.readTask(taskId))!;
    chainTasks.push({ task_id: taskId, expected_revision: task.revision.toString(), expected_acceptance_revision: task.acceptance_revision.toString() });
  }
  const createdChain = await post(`/projects/${projectId}/task-chains`, {
    title: '按计划顺序完成主线', confirmed: true, tasks: chainTasks,
  }, 201);
  const chainId = createdChain.chain_id as string;
  const chainPath = `/task-chains/${chainId}`;
  const chain = () => read(chainPath);
  const waitFor = async (predicate: (value: Record<string, unknown>) => boolean) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const value = await chain();
      if (predicate(value)) return value;
      await delay(80);
    }
    throw new Error(`任务链状态未达预期：${JSON.stringify(await chain())}`);
  };
  const authorize = async () => {
    const current = await chain();
    await post(`/task-chains/${chainId}/authorizations`, {
      expected_revision: current.revision, confirmed: true, max_tasks: 2, max_model_calls: 4,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
  };
  const worker = () => runOneCommand(app.db, {
    workerId: `n04-n06-closeout:${randomUUID()}`, dataRoot: api.dataRoot, checkpointUrl: APP_DATABASE_URL,
  });
  const approve = async (runId: string) => {
    const reviews = await read('/reviews?status=OPEN');
    const review = (reviews.items as Record<string, unknown>[]).find((item) => item.run_id === runId);
    assert.ok(review, `Run ${runId} 应进入人工 Review`);
    await post(`/reviews/${review.id}/decisions`, {
      expected_revision: review.revision, target_hash: review.target_hash, decision: 'ACCEPT',
    });
  };
  const waitForRun = async (index: number) => {
    const value = await waitFor((current) => (current.items as ChainItem[])[index]?.run_id !== null);
    return (value.items as ChainItem[])[index]!;
  };

  assert.equal((await chain()).status, 'DRAFT');
  assert.ok(((await chain()).items as ChainItem[]).every((item) => item.run_id === null));
  await authorize();
  const first = await waitForRun(0);
  assert.ok(first.run_id);
  await worker();
  assert.equal((await chain()).status, 'ACTIVE');
  assert.equal(((await chain()).items as ChainItem[])[1]?.run_id, null, '首项 Review 前不得启动下一项');
  await approve(first.run_id!);
  await worker();
  const afterFirstCompletion = await waitForRun(1);
  const firstCompleted = ((await chain()).items as ChainItem[])[0]!;
  assert.equal(firstCompleted.status, 'COMPLETED');
  assert.ok(firstCompleted.completion_id);

  await worker();
  await approve(afterFirstCompletion.run_id!);
  await worker();
  const completed = await waitFor((value) => value.status === 'COMPLETED');
  assert.equal(completed.task_reservations, 2);
  assert.equal(completed.calls_started, 2);
  assert.ok((completed.items as ChainItem[]).every((item) => item.completion_id !== null));
  assert.ok((completed.items as ChainItem[]).every((item) => item.status === 'COMPLETED'));
});

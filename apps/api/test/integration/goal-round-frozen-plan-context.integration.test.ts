import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { startGoalFromPlan } from '../../src/application/assist-goals.js';
import { runAssistGoalTick } from '../../src/application/goal-advance.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * #144（禅道）：按计划执行时，目标轮次的模型输入必须带上**选定版本**（goal.plan_version_id）
 * 的范围（scope）、步骤 detail、验证方式 method 与待定问题——它们只存在不可变计划行上，
 * 只把版本号交给模型不等于执行上下文完整。这里用真实 PostgreSQL 取证：
 *   * 逐字段断言四类标记进入首轮与后续轮的实际请求（system 中的目标状态 JSON）；
 *   * 计划执行后再改版（第 3 版），目标仍只收到启动时绑定的那一版——新版本的范围不得混入；
 *   * 选定旧版必须显式 allow_superseded，服务端从不静默改用另一版；
 *   * 没有计划的纯 `/goal` 目标不受影响（状态里没有 plan 段）。
 *
 * 受控端口只捕获实际请求形状，不访问真实 Provider；计划/目标协议形状由 chat-plan-goal 覆盖。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-goal-frozen-plan-test');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `frozen-plan-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title: string): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
  cacheCreationTokens: null } as const;

/** 捕获每一次实际模型请求的目标状态形状，供逐字段正负对照。 */
function capturingPort(envelopes: readonly string[]): { readonly port: AssistModelPort;
  readonly captured: string[] } {
  const captured: string[] = [];
  let round = 0;
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async (request) => {
      captured.push(JSON.stringify({ system: request.system, turns: request.turns,
        tools: request.tools }));
      const content = envelopes[Math.min(round, envelopes.length - 1)]!;
      round += 1;
      const result: AssistResult = { kind: 'CONTENT', content,
        providerRequestId: `stub-${round}`, usage: { ...usage } };
      return result;
    },
  };
  return { port, captured };
}

/** 领取是全库单步的：一直领到目标消息结算为止（与 chat-plan-goal 的 settleAssistant 同一形态）。 */
async function settleMessage(expectedMessageId: string, port: AssistModelPort,
  captured: string[]): Promise<string> {
  const before = captured.length;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, { workerId: `frozen-${randomUUID()}`,
      storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
      maxMessages: 1 });
    if (outcome === undefined) continue;
    if (outcome.messageId === expectedMessageId && outcome.status !== 'DISCARDED') {
      const slice = captured.slice(before);
      assert.ok(slice.length > 0, `目标消息 ${expectedMessageId} 结算时应有一次实际模型请求`);
      return slice.join('\n');
    }
  }
  return assert.fail(`连续 12 次领取仍未轮到 ${expectedMessageId}`);
}

async function sendPlan(workspaceId: string, sessionId: string, content: string): Promise<string> {
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), chatMode: 'PLAN', content });
  return sent.result.assistant_message_id;
}

test('按计划执行：选定版本的范围/步骤细节/验证方式/待定问题进入执行请求，改版后仍冻结原版', async () => {
  const workspaceId = await newWorkspace('context');
  const sessionId = await newSession(workspaceId, '选定版本执行上下文');
  const repositories = createRepositories(app.db);

  const v1Markers = {
    goal: 'FROZEN_GOAL_144A 样例目录检查',
    scope: 'FROZEN_SCOPE_144B 只检查样例目录，禁止触及发布目录',
    title: 'FROZEN_TITLE_144C 比对行数',
    detail: 'FROZEN_DETAIL_144D 必须先备份样例再比较行数',
    statement: 'FROZEN_CHECK_144E 样例检查完成',
    method: 'FROZEN_METHOD_144F',
    question: 'FROZEN_QUESTION_144G 需要确认样例目录位置',
  };
  const v2Scope = 'VERSION2_SCOPE_144X 新版才有的范围标记，不得混入旧版执行';

  const planMessage1 = await sendPlan(workspaceId, sessionId, '/plan 制定样例检查计划');
  const { port, captured } = capturingPort([
    JSON.stringify({ reply: '第 1 版计划已成形。',
      plan: { goal: v1Markers.goal, scope: [v1Markers.scope],
        steps: [{ title: v1Markers.title, detail: v1Markers.detail }],
        verification: [{ statement: v1Markers.statement, method: v1Markers.method }],
        open_questions: [v1Markers.question] } }),
    JSON.stringify({ reply: '第 2 版计划已成形。',
      plan: { goal: '换版目标', scope: [v2Scope],
        steps: [{ title: '新步骤', detail: '新细节' }],
        verification: [{ statement: '新验证', method: 'HUMAN' }], open_questions: [] } }),
    // 目标轮次脚本：第 1 轮 CONTINUE，第 2 轮 COMPLETE。
    JSON.stringify({ reply: '继续推进。', goal: { state: 'CONTINUE',
      success_criteria: [], criteria_status: [], steps: [], current_step: null,
      progress: '按冻结范围核对中', questions: [], blocked_reason: null, adjustment: null } }),
    JSON.stringify({ reply: '完成。', goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: v1Markers.statement, required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '样例回执' }], steps: [],
      current_step: null, progress: '全部条件有证据', questions: [], blocked_reason: null,
      adjustment: null } }),
  ]);
  await settleMessage(planMessage1, port, captured);
  const plans = await repositories.planGoals.listPlans(sessionId);
  assert.equal(plans.length, 1);
  const planV1 = plans[0]!;

  // 执行启动后计划再改版：第 2 版的范围不得改写已启动目标的执行上下文。
  const planMessage2 = await sendPlan(workspaceId, sessionId, '/plan 修改计划范围');
  await settleMessage(planMessage2, port, captured);
  const versions = await repositories.planGoals.listPlans(sessionId);
  assert.equal(versions.length, 2);
  const planV2 = versions.find((row) => row.version === 2)!;
  assert.equal(planV2.status, 'CURRENT');

  // 选定**旧版**必须显式确认；静默改用最新版被类型化拒绝。
  await assert.rejects(
    startGoalFromPlan(app.db, { workspaceId, sessionId, planId: planV1.id,
      commandId: randomUUID() }),
    (error: unknown) => error instanceof DomainError
      && error.code === 'PLAN_VERSION_SUPERSEDED');
  const started = await startGoalFromPlan(app.db, { workspaceId, sessionId,
    planId: planV1.id, commandId: randomUUID(), allowSuperseded: true });
  const goalId = String((started.result.goal as { goal_id: string }).goal_id);
  const goalRow = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalRow?.plan_version_id, planV1.id, '目标必须绑定启动时选定的那一版');
  assert.equal((await repositories.planGoals.readLatestPlan(sessionId))?.version, 2);

  // 第一轮：四类冻结计划数据逐字段进入实际请求；新版范围不出现。
  const tick1 = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(tick1.advanced.length, 1);
  const round1 = await settleMessage(tick1.advanced[0]!.messageId, port, captured);
  for (const [field, marker] of Object.entries(v1Markers)) {
    assert.ok(round1.includes(marker), `目标首轮请求必须带出冻结计划的 ${field}（${marker}）`);
  }
  assert.equal(round1.includes(v2Scope), false, '换版后旧目标的执行请求不得混入新版范围');

  // 后续轮同样保留选定版本的约束（不是只在首轮注入一次）。
  const tick2 = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(tick2.advanced.length, 1);
  const round2 = await settleMessage(tick2.advanced[0]!.messageId, port, captured);
  assert.ok(round2.includes(v1Markers.scope), '第 2 轮仍带出冻结范围');
  assert.ok(round2.includes(v1Markers.detail), '第 2 轮仍带出冻结步骤细节');
  assert.ok(round2.includes(v1Markers.method), '第 2 轮仍带出冻结验证方式');
  assert.ok(round2.includes(v1Markers.question), '第 2 轮仍带出待定问题');
  assert.equal(round2.includes(v2Scope), false);

  // 存储侧：method 随验证方式冻结进目标行（不是提示词临时拼的）。
  const storedCriteria = goalRow === undefined ? [] :
    (Array.isArray(goalRow.criteria) ? goalRow.criteria : []) as readonly { method?: unknown }[];
  assert.ok(storedCriteria.some((item) => item.method === v1Markers.method),
    `验证方式的 method 应随条件冻结进目标行，实得 ${JSON.stringify(storedCriteria)}`);

  // 第 2 轮 COMPLETE 结算后目标进入「等待人工验收」（收尾断言）。
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const awaiting = await repositories.planGoals.readGoal(goalId);
  assert.equal(awaiting?.status, 'AWAITING_ACCEPTANCE');
});

test('没有计划的纯目标：状态里没有 plan 段，目标轮次照常推进', async () => {
  const workspaceId = await newWorkspace('plain-goal');
  const sessionId = await newSession(workspaceId, '纯目标');
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), chatMode: 'GOAL', content: '整理这个目录的说明' });
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  const { port, captured } = capturingPort([
    JSON.stringify({ reply: '整理完成。', goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '说明已整理', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '已写入' }], steps: [],
      current_step: null, progress: '完成', questions: [], blocked_reason: null,
      adjustment: null } }),
  ]);
  const round = await settleMessage(sent.result.assistant_message_id, port, captured);
  assert.equal(round.includes('"plan":'), false,
    '纯目标（无计划版本）的执行状态不应携带 plan 段');
  const repositories = createRepositories(app.db);
  const goalRow = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalRow?.plan_version_id, null);
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'AWAITING_ACCEPTANCE');
});

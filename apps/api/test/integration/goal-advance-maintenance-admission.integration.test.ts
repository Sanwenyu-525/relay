import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, afterEach, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { pauseGoal } from '../../src/application/assist-goals.js';
import { runAssistGoalTick } from '../../src/application/goal-advance.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { changeAdmission, readAdmissionStatus } from
  '../../src/application/runtime-maintenance.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * ENG-SA-01 P0 候选：目标推进器是**唯一不自带维护准入门**的后台 tick Owner。
 *
 * 另外三条链（`web-import-runner.ts:42`、`conversation-execution-autostart.ts:47`、
 * `member-wakeup.ts:157`）都在函数内部先读 `readAdmission(..., 'share')`，非 NORMAL 就带原因
 * 退出；`advanceGoals()` 却直接拿租约然后 `enqueueRound()`，而 `enqueueRound()` 经
 * `repositories.assist.insertMessage()` 新插一条待生成消息。结果是维护排空期间 Supervisor
 * 照常调用这个 tick，目标仍会一轮接一轮把自己推进模型队列——准入规则在这条链上根本不存在。
 *
 * 本文件只取证**准入语义**：挡新执行，但不挡已落库控制意图的收口。Windows 宿主生命周期
 * （真实窗口隐藏/销毁、Job 对象）不是这些用例能证明的，另机验收。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-goal-admission-test');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

// 用例失败时不能把闸门留在 DRAINING：同一库里下一条命令会被合法地拒掉，
// 下一个失败就成了夹具残留而不是被测行为。
afterEach(async () => {
  const status = await readAdmissionStatus(app.db);
  if (status.mode !== 'NORMAL') {
    await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission',
      expectedRevision: status.revision });
  }
});

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `goal-admission-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title: string): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

const CONTINUE_ROUND = JSON.stringify({
  reply: '已读现状，仍缺启动说明。',
  goal: { state: 'CONTINUE',
    success_criteria: [{ key: 'c1', statement: 'GOAL_ADMISSION_1 启动说明已补', required: true }],
    criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '尚未写入' }],
    steps: [{ title: '补启动说明', status: 'DOING' }], current_step: '补启动说明',
    progress: '按条件推进中', questions: [], blocked_reason: null, adjustment: null } });

/** 受控端口只提供正文脚本，不访问真实 Provider。 */
function fixedPort(content: string): AssistModelPort {
  let round = 0;
  return {
    identity: new FakeModelPort().identity,
    assist: async () => {
      round += 1;
      const result: AssistResult = { kind: 'CONTENT', content,
        providerRequestId: `stub-${round}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
      return result;
    },
  };
}

async function settleMessage(expectedMessageId: string, port: AssistModelPort): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, {
      workerId: `goal-admission-${randomUUID()}`,
      storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
      maxMessages: 1 });
    if (outcome === undefined) { continue; }
    if (outcome.messageId === expectedMessageId && outcome.status !== 'DISCARDED') { return; }
  }
  return assert.fail(`连续 12 次领取仍未轮到 ${expectedMessageId}`);
}

/** 建一个「首轮已结算、正等着下一轮」的 ACTIVE 目标：这是推进器会投递新轮次的确切现场。 */
async function readyGoal(tag: string): Promise<{ workspaceId: string; sessionId: string; goalId: string }> {
  const workspaceId = await newWorkspace(tag);
  const sessionId = await newSession(workspaceId, `目标准入-${tag}`);
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), chatMode: 'GOAL', content: `/goal ${tag} 持续补文档` });
  const goalId = String(sent.result.goal_id);
  assert.ok(sent.result.goal_id !== null, 'GOAL 消息应当建立目标');
  await settleMessage(sent.result.assistant_message_id, fixedPort(CONTINUE_ROUND));
  const goal = await createRepositories(app.db).planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'ACTIVE');
  return { workspaceId, sessionId, goalId };
}

async function drain(): Promise<void> {
  const status = await readAdmissionStatus(app.db);
  await changeAdmission(app.db, { commandId: randomUUID(), action: 'begin-drain',
    expectedRevision: status.revision });
  assert.equal((await readAdmissionStatus(app.db)).mode, 'DRAINING');
}

async function resume(): Promise<void> {
  const status = await readAdmissionStatus(app.db);
  await changeAdmission(app.db, { commandId: randomUUID(), action: 'resume-admission',
    expectedRevision: status.revision });
  assert.equal((await readAdmissionStatus(app.db)).mode, 'NORMAL');
}

async function pendingGoalRounds(goalId: string): Promise<number> {
  const rows = await sql<{ n: number }>`select count(*)::int as n from assist_messages
    where goal_id = ${goalId} and status = 'PENDING'`.execute(app.db);
  return Number(rows.rows[0]?.n ?? 0);
}

test('排空期间推进器不得投递新的目标轮次，恢复准入后同一目标自己接着推进', async () => {
  const { goalId } = await readyGoal('drain');
  const repositories = createRepositories(app.db);
  const before = await repositories.planGoals.readGoal(goalId);
  assert.equal(await pendingGoalRounds(goalId), 0, '现场：上一轮已结算，没有在途轮次');

  await drain();
  const tick = await runAssistGoalTick(app.db, { workerId: `drain-${randomUUID()}` });

  const advanced = tick.advanced.filter((item) => item.goalId === goalId);
  assert.equal(advanced.length, 0, 'DRAINING 期间不得投递新的目标轮次');
  assert.equal(await pendingGoalRounds(goalId), 0,
    '排空期间不该为目标新插一条待生成消息');
  const during = await repositories.planGoals.readGoal(goalId);
  assert.equal(during?.status, 'ACTIVE', '不准入新执行不等于把目标改成别的状态');
  // 排空挡的是「投递下一轮」，不是「给已经跑完的那一轮记账」：round_count 在结算阶段 +1 是对的，
  // 不记这一笔反而把真实发生过的一轮抹掉。所以这里锁记账确实发生，而新执行没被排进队列。
  assert.equal(tick.settled.filter((item) => item.goalId === goalId).length, 1,
    '已结束轮次的账必须在排空期间照常落账');
  assert.equal(during?.round_count, (before?.round_count ?? 0) + 1);
  assert.equal(during?.lease_owner, null, '不准入也不能占着目标租约，否则恢复后的宿主被卡住');
  assert.equal(during?.lease_expires_at, null);

  await resume();
  const resumed = await runAssistGoalTick(app.db, { workerId: `resume-${randomUUID()}` });
  assert.equal(resumed.advanced.filter((item) => item.goalId === goalId).length, 1,
    '恢复准入后同一目标无需人工点击即可接着推进');
  assert.equal(await pendingGoalRounds(goalId), 1);
});

test('排空只挡新执行：已落库的暂停意图仍照常收口', async () => {
  const { workspaceId, goalId } = await readyGoal('control');
  const repositories = createRepositories(app.db);
  await pauseGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'PAUSING');

  await drain();
  await runAssistGoalTick(app.db, { workerId: `drain-control-${randomUUID()}` });

  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'PAUSED',
    '暂停是已落库的控制意图，排空期间必须继续收口');
  await resume();
});

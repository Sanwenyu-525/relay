import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { cancelGoal, resumeGoal, resumeGoalCommand } from '../../src/application/assist-goals.js';
import { runAssistGoalTick } from '../../src/application/goal-advance.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createDataRoot } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * #141（禅道）：目标终结后额度授予的口径。
 *
 * 会话级用量（`used`）统计根会话及子会话**全部历史** model_calls；授予上限若只看
 * 「当前 ACTIVE 目标」，旧目标终结后它的授予就从上限里消失，而对应调用仍永久计入
 * 用量——新目标每次「继续」都要先补偿这段已消费历史，表现为反复额度耗尽、没有实际调用。
 * 修复后的口径（见 model-call-repository.begin 的注释）：
 *   * 当前活动目标：授予全额计入（「继续」刚给的窗口必须立即可用）；
 *   * 已终结目标：只计入**已消费**的授予（按目标存续窗口内的作用域用量扣除开始时的
 *     基线余额，封顶于授予量）；未消费的授予不转送新目标；
 *   * 用量与授予账本原样保留，不删行、不清零、不双计量。
 *
 * 这里用带预算的受控端口（不访问真实 Provider）取证：
 *   1. 旧目标用完基线 + 两个授予窗口后取消 → 新目标**首次**授予一窗口后恰能新增一次调用，
 *      过窗继续拒绝；
 *   2. 拿了授予就取消的目标：未消费授予不转送——新目标在自己的授予之前仍然被拒；
 *   3. 同 command_id 重复「继续」不翻倍；原账本行数与实际调用数一致（不双计量）；
 *   4. token 分支同一口径（显式授予窗口消耗完后拒绝，新目标首次授予立即可用）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-goal-budget-accounting-test');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `budget-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function countSessionModelCalls(sessionId: string): Promise<number> {
  const rows = await sql<{ n: string }>`select count(*)::text as n from model_calls c
    join assist_messages m on m.id = c.assist_message_id
    where m.session_id = ${sessionId}`.execute(app.db);
  return Number(rows.rows[0]?.n ?? '0');
}

test('旧目标已消费窗口保留抵扣、未消费授予不转送：新目标首授予恰增一窗口', async () => {
  const workspaceId = await newWorkspace('windows');
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '顺序目标预算' });
  const sessionId = created.result.session_id;
  let modelCalls = 0;
  // 单次预留 1 token、基线 1 次调用：调用次数分支触发，token 分支不绑定。
  const port: AssistModelPort = {
    identity: { ...new FakeModelPort().identity,
      budget: { callReservationTokens: 1, scopeCallLimit: 1, scopeTokenLimit: 100_000 } },
    assist: async () => {
      modelCalls += 1;
      const result: AssistResult = { kind: 'CONTENT',
        content: JSON.stringify({ reply: `完成了一项检查，继续。`, goal: { state: 'CONTINUE',
          success_criteria: [{ key: 'c1', statement: '全部检查通过', required: true }],
          criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '仍有检查' }], steps: [],
          current_step: null, progress: `已做${modelCalls}步`, questions: [],
          blocked_reason: null, adjustment: null } }),
        providerRequestId: `stub-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
      return result;
    },
  };
  const repositories = createRepositories(app.db);
  const generate = async (): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DISCARDED'> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const outcome = await runAssistGenerationTick(app.db, { workerId: `gen-${randomUUID()}`,
        storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
        maxMessages: 1 });
      if (outcome !== undefined && outcome.status !== 'DISCARDED') return outcome.status;
    }
    return assert.fail('队列里始终没有可结算的生成消息');
  };
  const tick = async (): Promise<void> => {
    await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  };
  /** 生成一次并推进账目；返回这一步实际发生的模型调用增量（失败=0）。 */
  const step = async (): Promise<number> => {
    const before = modelCalls;
    const status = await generate();
    await tick();
    if (status !== 'COMPLETED') {
      const failure = await repositories.planGoals.listSessionGoals(sessionId, 1);
      assert.equal(failure[0]?.stop_reason?.code, 'MODEL_BUDGET_EXHAUSTED',
        `预算耗尽的轮次应把目标带到额度耗尽出口，实得 ${JSON.stringify(failure[0]?.stop_reason)}`);
      return 0;
    }
    assert.equal(modelCalls, before + 1);
    return 1;
  };
  const newGoal = async (content: string): Promise<string> => {
    const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
      commandId: randomUUID(), chatMode: 'GOAL', content });
    const goalId = sent.result.goal_id;
    assert.ok(goalId !== null);
    return goalId;
  };
  const resume = async (goalId: string, commandId = randomUUID()): Promise<void> => {
    await resumeGoalCommand(app.db, { workspaceId, goalId, commandId });
    await tick();
  };
  const cancelAndWait = async (goalId: string): Promise<void> => {
    await cancelGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await tick();
      if ((await repositories.planGoals.readGoal(goalId))?.status === 'CANCELLED') return;
    }
    return assert.fail('取消目标未在 4 次 tick 内落定为 CANCELLED');
  };

  // ---- 旧目标：基线 1 次 + 两个授予窗口各 1 次 = 3 次实际调用。
  const goal1 = await newGoal('旧目标');
  assert.equal(await step(), 1);
  assert.equal(await step(), 0, '基线窗口用尽后下一轮必须被预算拒绝');
  await resume(goal1);
  assert.equal(await step(), 1);
  assert.equal(await step(), 0);
  await resume(goal1);
  assert.equal(await step(), 1);
  assert.equal(modelCalls, 3);
  assert.deepEqual(await repositories.planGoals.sumGrants(goal1), { calls: 2, tokens: 2 });
  await cancelAndWait(goal1);

  // ---- 新目标：历史用量仍计入，但旧目标**已消费**的授予保留抵扣——
  // 首次授予一窗口后必须恰能新增一次调用（不是先补偿历史差额）。
  const goal2 = await newGoal('新目标');
  assert.equal(await step(), 0, '新目标在自己的授予之前仍受会话用量约束');
  const callsBeforeResume = modelCalls;
  await resume(goal2);
  assert.equal(await repositories.planGoals.sumGrants(goal2).then((g) => g.calls), 1);
  assert.equal(await step(), 1, '新目标首次授予一窗口后必须立即可用');
  assert.equal(modelCalls, callsBeforeResume + 1, '首授予恰新增一次实际调用，不多不少');
  assert.equal(await step(), 0, '窗口用尽后继续拒绝，直到下一次显式授予');
  await cancelAndWait(goal2);

  // ---- 拿了授予就取消：未消费授予不转送。
  const goal3 = await newGoal('拿了授予就取消的目标');
  assert.equal(await step(), 0);
  await resume(goal3);
  assert.equal(await repositories.planGoals.sumGrants(goal3).then((g) => g.calls), 1);
  await cancelAndWait(goal3);
  const goal4 = await newGoal('之后的又一个目标');
  assert.equal(await step(), 0,
    '上一个目标未消费的授予不得转送：新目标在自己的授予之前仍被拒');
  // 同 command_id 重复「继续」不翻倍：显式授予的同载荷命令，第二条按原回执幂等
  // （resumeGoalCommand 的授予量按目标当前状态计算，重放语义在显式授予入口核对）。
  const sameCommand = randomUUID();
  await resumeGoal(app.db, { workspaceId, goalId: goal4, commandId: sameCommand,
    grant: { calls: 1, tokens: 1 } });
  await resumeGoal(app.db, { workspaceId, goalId: goal4, commandId: sameCommand,
    grant: { calls: 1, tokens: 1 } });
  await tick();
  assert.equal(await repositories.planGoals.sumGrants(goal4).then((g) => g.calls), 1,
    '同 command_id 重放按原回执幂等，授予不翻倍');
  assert.equal(await step(), 1, '新目标自己的首次授予立即可用');
  assert.equal(modelCalls, 5);
  assert.equal(await step(), 0);

  // ---- 账本不丢、不双计量：旧授予行原样保留，model_calls 行数与实际调用数一致。
  assert.deepEqual(await repositories.planGoals.sumGrants(goal1), { calls: 2, tokens: 2 });
  assert.deepEqual(await repositories.planGoals.sumGrants(goal2), { calls: 1, tokens: 1 });
  assert.deepEqual(await repositories.planGoals.sumGrants(goal3), { calls: 1, tokens: 1 });
  assert.deepEqual(await repositories.planGoals.sumGrants(goal4), { calls: 1, tokens: 1 });
  assert.equal(await countSessionModelCalls(sessionId), modelCalls);
});

test('token 分支同一口径：已消费授予保留、新目标首授予立即可用', async () => {
  const workspaceId = await newWorkspace('tokens');
  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: 'token 预算' });
  const sessionId = created.result.session_id;
  let modelCalls = 0;
  // 基线 4 个 token、每次调用实耗 2 token：两次调用后 token 分支触发（调用次数上限形同虚设）。
  const port: AssistModelPort = {
    identity: { ...new FakeModelPort().identity,
      budget: { callReservationTokens: 1, scopeCallLimit: 1_000_000, scopeTokenLimit: 4 } },
    assist: async () => {
      modelCalls += 1;
      const result: AssistResult = { kind: 'CONTENT',
        content: JSON.stringify({ reply: '继续。', goal: { state: 'CONTINUE',
          success_criteria: [{ key: 'c1', statement: '完成', required: true }],
          criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '进行中' }], steps: [],
          current_step: null, progress: `第${modelCalls}步`, questions: [],
          blocked_reason: null, adjustment: null } }),
        providerRequestId: `stub-${modelCalls}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
      return result;
    },
  };
  const repositories = createRepositories(app.db);
  const generate = async (): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DISCARDED'> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const outcome = await runAssistGenerationTick(app.db, { workerId: `gen-${randomUUID()}`,
        storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
        maxMessages: 1 });
      if (outcome !== undefined && outcome.status !== 'DISCARDED') return outcome.status;
    }
    return assert.fail('队列里始终没有可结算的生成消息');
  };
  const tick = async (): Promise<void> => {
    await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  };
  const generateWithTick = async (): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DISCARDED'> => {
    const status = await generate();
    await tick();
    return status;
  };
  const newGoal = async (content: string): Promise<string> => {
    const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
      commandId: randomUUID(), chatMode: 'GOAL', content });
    const goalId = sent.result.goal_id;
    assert.ok(goalId !== null);
    return goalId;
  };
  /** 带显式授予的「继续」：授予量写进授权账本（授予来源的可核对事实由上层给出）。 */
  const resumeWithGrant = async (goalId: string, tokens: number): Promise<void> => {
    await resumeGoal(app.db, { workspaceId, goalId, commandId: randomUUID(),
      grant: { calls: 1_000_000, tokens } });
    await tick();
  };

  const goal1 = await newGoal('旧目标');

  // 基线 4 token 恰好支撑 2 次调用；第 3 次由 token 分支拒绝。
  assert.equal(await generateWithTick(), 'COMPLETED');
  assert.equal(await generateWithTick(), 'COMPLETED');
  assert.equal(await generateWithTick(), 'FAILED');
  // 授予 4 个 token：恰好再撑 2 次调用，然后再次拒绝（窗口耗尽）。
  await resumeWithGrant(goal1, 4);
  assert.equal(await generateWithTick(), 'COMPLETED');
  assert.equal(await generateWithTick(), 'COMPLETED');
  assert.equal(await generateWithTick(), 'FAILED');
  assert.equal(modelCalls, 4);
  await cancelGoal(app.db, { workspaceId, goalId: goal1, commandId: randomUUID() });
  for (let attempt = 0; attempt < 4 && (await repositories.planGoals.readGoal(goal1))?.status !== 'CANCELLED'; attempt += 1) await tick();
  assert.equal((await repositories.planGoals.readGoal(goal1))?.status, 'CANCELLED');

  // 新目标：旧目标已消费的 4 token 授予保留抵扣（首次授予立即生效），不再重复补偿历史。
  const goal2 = await newGoal('新目标');
  assert.equal(await generateWithTick(), 'FAILED');
  await resumeWithGrant(goal2, 4);
  assert.equal(await generateWithTick(), 'COMPLETED', '新目标首次授予的 token 窗口必须立即可用');
  assert.equal(modelCalls, 5);
  assert.equal(await generateWithTick(), 'COMPLETED');
  assert.equal(await generateWithTick(), 'FAILED', '授予窗口按 token 消耗完后继续拒绝');
});

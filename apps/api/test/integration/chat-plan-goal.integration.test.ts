import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { pauseGoal, cancelGoal, confirmGoalCompletion, readSessionGoal, resumeGoalCommand } from
  '../../src/application/assist-goals.js';
import { readSessionPlan } from '../../src/application/assist-plans.js';
import { setChatMode } from '../../src/application/chat-mode.js';
import { goalRoundMessageId, runAssistGoalTick } from '../../src/application/goal-advance.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import { SessionToolCallRepository } from '../../src/assist/session-tool-call-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult } from
  '../../src/workflow/fake-model-port.js';
import { createDataRoot, startTestApi, workspacePath, type TestApi } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 聊天 `/plan` 与 `/goal` 的真实 PostgreSQL 出口（0127，工作台 §44）。
 *
 * 单测证明不了的东西在这里取证：
 *   * 模式与会话行同事务落库：消息受理回执里的 `chat_mode` 与会话行读回一致；
 *   * `/plan` 的计划版本按序落 `assist_plans`，正文只落 `reply`（信封 JSON 不进正文）；
 *   * `/goal` 的目标行、轮次消息绑定与结构化结论（`goal_outcome`）各自落库；
 *   * 推进器 tick 在无人操作时接续下一轮、把 COMPLETE 结算成 AWAITING_ACCEPTANCE；
 *   * 暂停/恢复/确认完成各自沿目标行的 CAS 推进；
 *   * 切走活动目标时先记 PAUSING 意图，tick 把它安全落成 PAUSED；
 *   * 并发 tick 对同一目标只产生一轮投递：租约 CAS 落败方只报 LEASE_RACE，不重复建消息；
 *   * 领取是**全库单步**的：一次生成 tick 领的是 `session_id` 最小的那条 PENDING，
 *     与「我刚发了哪条」无关，所以本文件用 `settleAssistant` 轮到目标消息为止，
 *     末尾一条用例把这个排序事实钉死（它也是「/plan 的计划没落库」这条红的根因）。
 *
 * Fake 端口的固定回答只服务协议形状；「模型是否被允许写文件」这类准入判定不在本文件。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-chat-plan-goal-test');
let dataRoot: string;
let api: TestApi;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  api = await startTestApi();
});
after(async () => { await api.stop(); await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `plan-goal-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

async function newSession(workspaceId: string, title: string): Promise<string> {
  const created = await createAssistSession(app.db, {
    workspaceId, commandId: randomUUID(), projectId: null, title });
  return created.result.session_id;
}

/**
 * 按序返回固定正文的端口：每条 CONTENT 占一轮。
 *
 * 脚本用完时重复最后一条，不再抛「没有脚本」。理由是领取本身是**全库单步**的
 * （见 `settleAssistant`）：队列里可能有别的用例遗留的排队消息先被领走，端口必须撑到
 * 目标消息那一轮，而不是在中途把测试打成一个与本次断言无关的错误。
 */
function envelopePort(contents: readonly string[]): AssistModelPort {
  assert.ok(contents.length > 0, 'envelopePort 至少要有一条脚本');
  let round = 0;
  return {
    identity: new FakeModelPort().identity,
    assist: async () => {
      const content = contents[Math.min(round, contents.length - 1)]!;
      round += 1;
      const result: AssistResult = { kind: 'CONTENT', content,
        providerRequestId: `stub-${round}`,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
          cacheCreationTokens: null } };
      return result;
    },
  };
}

async function send(workspaceId: string, sessionId: string, content: string,
  chatMode?: 'CHAT' | 'PLAN' | 'GOAL',
  intent?: 'DISCUSS' | 'PROPOSE_CANDIDATE' | 'PROPOSE_TASK') {
  return requestAssistMessage(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    content, ...(chatMode === undefined ? {} : { chatMode }),
    ...(intent === undefined ? {} : { intent }) });
}

async function runGeneration(modelPort: AssistModelPort) {
  return runAssistGenerationTick(app.db, { workerId: `plan-goal-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort, leaseMs: 60_000, maxMessages: 1 });
}

/** 清理队列时用的普通正文：既不是计划信封也不是目标信封。 */
const IDLE_REPLY = JSON.stringify({ reply: '（队列清理）' });

/**
 * 整库通过项目/记忆整理筛选的排队消息数，不等于当前即可领取的数量。
 * 同会话存在 RUNNING 时仍计入排队，生成 Worker 会保留它；清理循环不能据一次空 tick 静默漏掉它。
 */
async function pendingMessages(): Promise<number> {
  const rows = await sql<{ n: string }>`select count(*) as n from assist_messages m
    join assist_sessions s on s.id = m.session_id
    left join projects p on p.id = s.project_id
    where m.status = 'PENDING' and m.role = 'ASSISTANT'
      and (s.project_id is null or p.archived_at is null)
      and not exists (select 1 from assist_memory_requests j
        where j.session_id = s.id and j.status in ('PENDING', 'RUNNING'))`.execute(app.db);
  return Number(rows.rows[0]?.n ?? 0);
}

/**
 * 一直领到**指定**那条消息为止，并带回这一路实际领到的消息 id。
 *
 * 这里必须把「领到了谁」变成断言。一次生成 tick 领取的是全库最早的一条 PENDING
 * （`assist-repository.ts` 的 `claimNextPendingMessage` 用
 * `order by m.session_id, m.created_at, m.id`——**会话 id 排在创建时间之前**），
 * 别的会话有排队消息时会先被领走。因此「发一条 `/plan` 再跑一次 tick」并不能保证
 * 领到这条 PLAN 消息：2026-10-21 的两次真实 PG 运行里，同一条用例一次绿一次红
 * （`GET plans` 的 `versions.length` 实得 0），差别只在随机出来的会话 id 谁更小。
 * 生产上 Worker 持续轮询、每 tick 处理一条，队列最终都会结算完；测试要的是确定性，
 * 不是「碰巧轮到」。根因取证见文件末尾的领取顺序用例。
 */
async function settleAssistant(expectedMessageId: string, contents: readonly string[],
  port: AssistModelPort = envelopePort(contents)):
  Promise<{ readonly claimed: readonly string[];
    readonly outcome: NonNullable<Awaited<ReturnType<typeof runGeneration>>> }> {
  const claimed: string[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runGeneration(port);
    if (outcome === undefined) {
      // 空转 tick 有两种合法来源：内存 compact tick 占了这一格，或领取被别的 Worker 租约挡住。
      // 队列真空且目标还没结算才是不合法的状态，所以只在队列确实空了时才报出来。
      if ((await pendingMessages()) === 0) {
        assert.fail(`队列已空但目标消息 ${expectedMessageId} 还没结算；此前领到 ${claimed.join(', ') || '无'}`);
      }
      continue;
    }
    claimed.push(outcome.messageId);
    if (outcome.messageId === expectedMessageId) {
      // DISCARDED 表示这条被领取后又被退回（自动记忆整理占位），不算结算，继续轮到它。
      if (outcome.status !== 'DISCARDED') return { claimed, outcome };
      continue;
    }
  }
  return assert.fail(`连续 12 次领取仍未轮到 ${expectedMessageId}；领到的是 ${claimed.join(', ')}`);
}

/** 排空整库的可领取队列：领取顺序取证要在「只有我这两条」的队列上做才有意义。 */
async function drainQueue(limit = 24): Promise<void> {
  const port = envelopePort([IDLE_REPLY]);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if ((await pendingMessages()) === 0) return;
    await runGeneration(port);
  }
  assert.fail(`排队消息在 ${limit} 次领取后仍有 ${await pendingMessages()} 条，领取顺序的取证不成立`);
}

/** 一句话说清 jsonb 实际存成了什么形状，供「内容没读回来」这类失败直接自证。 */
function jsonShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (typeof value === 'object') return `object{${Object.keys(value as object).join(',')}}`;
  return typeof value;
}

/**
 * 「计划未落库」的逐层诊断，只在断言失败时随消息打印，绿的时候不产生噪声。
 *
 * 分层就是排查顺序：请求体 → 受理回执 → 结算出的消息行 → 仓储行（含每段 jsonb 的
 * `jsonb_typeof`）→ 读回投影 → HTTP 状态码。哪一层先变空，问题就在哪一层，
 * 不用再把「行在、内容读不回」误报成「没落库」。
 */
async function planPersistenceTrace(input: { readonly workspaceId: string;
  readonly sessionId: string; readonly messageId: string; readonly sentBody: unknown;
  readonly postStatus: number; readonly getStatus: number; readonly getBody: unknown }):
  Promise<string> {
  const message = await createRepositories(app.db).assist.readMessage(input.messageId);
  const rows = (await sql<{ version: number; status: string; source_message_id: string;
    scope_type: string; steps_type: string; verification_type: string;
    open_questions_type: string }>`
    select version, status, source_message_id, jsonb_typeof(scope) as scope_type,
      jsonb_typeof(steps) as steps_type, jsonb_typeof(verification) as verification_type,
      jsonb_typeof(open_questions) as open_questions_type
      from assist_plans where session_id = ${input.sessionId} order by version`.execute(app.db)).rows;
  const view = await readSessionPlan(app.db, { workspaceId: input.workspaceId,
    sessionId: input.sessionId });
  const lines = [
    `  1. 请求体 = ${JSON.stringify(input.sentBody)}`,
    `  2. POST messages 状态码 = ${input.postStatus}（受理回执即 assistant_message_id）`,
    `  3. 消息行 = status:${message?.status ?? '缺失'} chat_mode:${message?.chat_mode ?? '?'}`
      + ` goal_id:${message?.goal_id ?? 'null'} error_code:${message?.error_code ?? '无'}`
      + ` content长度:${message?.content?.length ?? 0}`,
    `  4. plan-goal-repository 是否被调用（assist_plans 行数）= ${rows.length}；`
      + `行 = ${JSON.stringify(rows)}`,
    '  5. 存储形状契约 = 迁移 0127 的 scope/steps/verification/open_questions 均 '
      + '`DEFAULT \'[]\'::jsonb`（裸数组）；若 *_type=array 而投影里对应字段为空，'
      + '问题在读取投影而不是没落库',
    `  6. 读回投影 GET /plans = ${input.getStatus}，body = ${JSON.stringify(input.getBody)}`,
    `  7. 应用层视图 = ${JSON.stringify(view)}`,
    '  8. 事务判定：消息已 COMPLETED 但第 4 层有行 = 同一事务已提交；'
      + '第 4 层无行才需要继续查回滚或分支未命中',
  ];
  return `\n${lines.join('\n')}`;
}

test('计划模式：消息按 PLAN 受理，计划版本按序落库，正文只落 reply', async () => {
  const workspaceId = await newWorkspace('plan');
  const sessionId = await newSession(workspaceId, '规划讨论');
  const sent = await send(workspaceId, sessionId, '/plan 把登录流程梳理成方案', 'PLAN');
  assert.equal(sent.result.chat_mode, 'PLAN');

  const repositories = createRepositories(app.db);
  const session = await repositories.assist.readSession(sessionId);
  assert.equal(session?.chat_mode, 'PLAN');

  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '方案已经成形，见下。',
    plan: { goal: '登录流程重构', scope: ['web'], steps: [{ title: '梳理现状' }],
      verification: [{ statement: '人工走查', method: 'HUMAN' }], open_questions: [] } })]);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(message?.status, 'COMPLETED');
  // 正文只落 reply：整段信封当正文显示是已经修过一次的缺陷。
  assert.equal(message?.content, '方案已经成形，见下。');

  const plans = await repositories.planGoals.listPlans(sessionId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.version, 1);
  assert.equal(plans[0]?.status, 'CURRENT');
  assert.equal(plans[0]?.goal, '登录流程重构');
  assert.equal(plans[0]?.source_message_id, sent.result.assistant_message_id);

  // 落库的必须是「内容」而不只是一行版本号：四段 jsonb 按迁移契约是裸数组
  // （`0127` 的 `DEFAULT '[]'::jsonb`），读回的投影必须把它们还原成用户能核对的清单。
  const stored = plans[0]!;
  assert.ok(Array.isArray(stored.scope) && Array.isArray(stored.steps)
    && Array.isArray(stored.verification) && Array.isArray(stored.open_questions),
    `assist_plans 四段 jsonb 的存储形状应为数组，实得 scope=${jsonShape(stored.scope)} `
    + `steps=${jsonShape(stored.steps)} verification=${jsonShape(stored.verification)} `
    + `open_questions=${jsonShape(stored.open_questions)}`);
  const planView = await readSessionPlan(app.db, { workspaceId, sessionId });
  assert.deepEqual(planView.latest?.scope, ['web'],
    `计划范围必须读得回，实得 ${JSON.stringify(planView.latest?.scope)}`);
  assert.deepEqual(planView.latest?.steps, [{ title: '梳理现状', detail: null }],
    `计划步骤必须读得回，实得 ${JSON.stringify(planView.latest?.steps)}`);
  assert.deepEqual(planView.latest?.verification,
    [{ statement: '人工走查', method: 'HUMAN' }],
    `验证方式必须读得回，实得 ${JSON.stringify(planView.latest?.verification)}`);
  assert.deepEqual(planView.latest?.open_questions, [], '没有待确认项时读回空数组');

  // 「有版本、可继续修改」：再用自然语言发一条 `/plan` 就是第 2 版，第 1 版转 SUPERSEDED 但行保留。
  const second = await send(workspaceId, sessionId, '/plan 把验证方式补全', 'PLAN');
  await settleAssistant(second.result.assistant_message_id, [JSON.stringify({
    reply: '补全了验证方式。', plan: { goal: '登录流程重构（含验证）', scope: ['web'],
      steps: [{ title: '梳理现状' }, { title: '补验证' }],
      verification: [{ statement: '人工走查', method: 'HUMAN' }], open_questions: [] } })]);
  const versions = await repositories.planGoals.listPlans(sessionId);
  assert.equal(versions.length, 2, '同一会话的第二版计划必须新增一行，而不是改写第 1 版');
  assert.equal(versions.find((item) => item.version === 1)?.status, 'SUPERSEDED');
  assert.equal(versions.find((item) => item.version === 2)?.status, 'CURRENT');
  assert.equal(versions.find((item) => item.version === 2)?.goal, '登录流程重构（含验证）');
});

test('计划模式拒绝提案意图：只读边界在应用层先挡住', async () => {
  const workspaceId = await newWorkspace('plan-guard');
  const sessionId = await newSession(workspaceId, '规划守卫');
  await assert.rejects(
    send(workspaceId, sessionId, '/plan 试试提案', 'PLAN', 'PROPOSE_CANDIDATE'),
    (error: unknown) => error instanceof DomainError
      && error.code === 'INVALID_TRANSITION');
});

test('计划模式的写尝试由准入拒掉：账本里有类型化拒绝，本轮照常出计划', async () => {
  /*
   * 任务书 §6 第一条要求的是「尝试写文件及其他副作用被实际准入拒绝；仅模型口头拒绝不算」。
   * 这里故意让 Fake 端口无视词表直接调写工具：如果只读是靠提示词实现的，这一轮会照写不误；
   * 真实路径是 `settleSessionReadonlyToolCall` 先登记再校验词表，写工具不在 PLAN 轮次的词表里，
   * 于是落一条 REJECTED 账本并把类型化原因回给模型，副作用一次也没派发。
   */
  const workspaceId = await newWorkspace('plan-readonly');
  const sessionId = await newSession(workspaceId, '计划只读准入');
  const sent = await send(workspaceId, sessionId, '/plan 直接改文件试试', 'PLAN');
  const planMessageId = String(sent.result.assistant_message_id);
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
    cacheCreationTokens: null };
  const script: readonly AssistResult[] = [
    { kind: 'TOOL_CALLS', preamble: '我先写文件。', providerRequestId: 'stub-write-attempt',
      usage, calls: [{ providerToolCallId: 'call-write-1', name: 'apply_changeset',
        arguments: { changeset: [] } }] },
    { kind: 'CONTENT', providerRequestId: 'stub-after-refusal', usage,
      content: JSON.stringify({ reply: '只读地给出方案。',
        plan: { goal: '只出方案', scope: [], steps: [{ title: '读现状' }],
          verification: [], open_questions: [] } }) },
  ];
  // 脚本用完时重复最后一条：领取是全库单步的，别的消息先被领走时这条PLAN仍能得到信封正文。
  let step = 0;
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async () => {
      const result = script[Math.min(step, script.length - 1)]!;
      step += 1;
      return result;
    },
  };

  await settleAssistant(planMessageId, [], port);

  const calls = await new SessionToolCallRepository(app.db).listByMessage(planMessageId);
  assert.equal(calls.length, 1, '写尝试必须登记进会话工具账本，不能静默丢弃');
  assert.equal(calls[0]?.tool_name, 'apply_changeset');
  assert.equal(calls[0]?.status, 'REJECTED',
    `写工具应当被准入拒掉，实得 ${calls[0]?.status}`);
  assert.equal(calls[0]?.rejection_reason, 'TOOL_NOT_READ_ONLY');
  assert.equal(calls[0]?.operation_id, null, '被拒的请求不连 Operation：没有派发就没有外部效果');

  // 拒绝不等于本轮失败：同一消息仍结算成计划版本，正文只有 reply。
  const message = await createRepositories(app.db).assist.readMessage(planMessageId);
  assert.equal(message?.status, 'COMPLETED');
  assert.equal(message?.content, '只读地给出方案。');
  const plans = await createRepositories(app.db).planGoals.listPlans(sessionId);
  assert.equal(plans.length, 1);
});

test('目标模式：消息建立目标并绑定轮次，推进器接续下一轮直至待验收', async () => {
  const workspaceId = await newWorkspace('goal');
  const sessionId = await newSession(workspaceId, '持续目标');
  const sent = await send(workspaceId, sessionId, '/goal 把 README 改到能跑', 'GOAL');
  assert.equal(sent.result.chat_mode, 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null, 'GOAL 消息应当建立目标');

  const repositories = createRepositories(app.db);
  const goalRow = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalRow?.status, 'ACTIVE');
  assert.equal(goalRow?.round_count, 0);
  // 消息行绑定目标与模式：推进器据此认领自己的轮次。
  const roundMessage = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(roundMessage?.goal_id, goalId);
  assert.equal(roundMessage?.chat_mode, 'GOAL');

  // 第一轮：模型给 CONTINUE（含成功条件与进展）。
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '已读 README，缺启动说明。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: 'README 含启动步骤', required: true }],
      criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '尚未写入' }],
      steps: [{ title: '补启动说明', status: 'DOING' }], current_step: '补启动说明',
      progress: '已读完现状', questions: [], blocked_reason: null, adjustment: null } })]);
  const settledRound = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(settledRound?.status, 'COMPLETED');
  assert.equal(settledRound?.content, '已读 README，缺启动说明。');
  // 结构化结论落在 goal_outcome，不进正文。
  assert.ok(settledRound?.goal_outcome !== null);

  // 推进器：结算本轮 + 投递下一轮。
  const tick = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(tick.settled.length, 1);
  assert.equal(tick.advanced.length, 1);
  const goalAfterTick = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalAfterTick?.round_count, 1);

  // 本轮判定的成功条件与步骤已冻结进目标行（迁移里同样是 `DEFAULT '[]'::jsonb` 的裸数组），
  // 读回的投影必须带出这一份事实——否则「已冻结条件不因新版本改变」在服务端根本核对不出来。
  assert.ok(Array.isArray(goalAfterTick?.criteria) && Array.isArray(goalAfterTick?.steps),
    `assist_goals 的 criteria/steps 存储形状应为数组，实得 criteria=${jsonShape(goalAfterTick?.criteria)}`
    + ` steps=${jsonShape(goalAfterTick?.steps)}`);
  const goalView = await readSessionGoal(app.db, { workspaceId, sessionId });
  assert.deepEqual(goalView.goal?.criteria, [{ key: 'c1', statement: 'README 含启动步骤',
    status: 'UNMET', evidence: '尚未写入', required: true }],
    `目标成功条件必须读得回，实得 ${JSON.stringify(goalView.goal?.criteria)}`);
  assert.deepEqual(goalView.goal?.steps, [{ title: '补启动说明', status: 'DOING' }],
    `目标步骤必须读得回，实得 ${JSON.stringify(goalView.goal?.steps)}`);

  // 第二轮消息已在队列；生成后报 COMPLETE，推进器把它结算成待验收。
  const pendingRows = await repositories.assist.listMessages(sessionId, 20);
  const pending = pendingRows.find((row) => row.status === 'PENDING' && row.goal_id === goalId);
  assert.ok(pending !== undefined, '推进器应当投递下一轮');
  await settleAssistant(pending.id, [JSON.stringify({
    reply: '启动说明已补，自检通过。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: 'README 含启动步骤', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: 'README 第 3 节' }],
      steps: [{ title: '补启动说明', status: 'DONE' }], current_step: null,
      progress: '全部条件有证据', questions: [], blocked_reason: null, adjustment: null } })]);
  const tick2 = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(tick2.settled.length, 1);
  const goalAwaiting = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalAwaiting?.status, 'AWAITING_ACCEPTANCE');

  // 人工确认完成：只有这条命令能把目标写成 COMPLETED。
  await confirmGoalCompletion(app.db, { workspaceId, goalId, commandId: randomUUID() });
  const goalDone = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalDone?.status, 'COMPLETED');
});

test('模式切换：切走活动目标先记 PAUSING，tick 落成 PAUSED；恢复只回 ACTIVE', async () => {
  const workspaceId = await newWorkspace('switch');
  const sessionId = await newSession(workspaceId, '模式切换');
  const sent = await send(workspaceId, sessionId, '/goal 持续整理文档', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);

  // CHAT→GOAL 是同档重放？不：会话此时已是 GOAL，改切 CHAT 才有切换事实。
  const switched = await setChatMode(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), mode: 'CHAT' });
  assert.equal(switched.result.chat_mode, 'CHAT');
  assert.equal(switched.result.goal_stopping, true);
  const repositories = createRepositories(app.db);
  const pausing = await repositories.planGoals.readGoal(goalId);
  assert.equal(pausing?.status, 'PAUSING');

  // 在途轮次先安全停下：让它按正常路径跑完，tick 再把 PAUSING 落成 PAUSED。
  // 暂停不打断在途轮次、取消才标记 cancel_requested——推进器只结算不重排事实。
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '这一轮先到这里。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: '文档整理完', required: true }],
      criteria_status: [{ key: 'c1', status: 'PENDING', evidence: null }],
      steps: [], current_step: null, progress: '整理中', questions: [],
      blocked_reason: null, adjustment: null } })]);
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const paused = await repositories.planGoals.readGoal(goalId);
  assert.equal(paused?.status, 'PAUSED');

  // 暂停中的目标不随消息偷偷恢复：GOAL 消息只是讨论，绑定不到已暂停目标。
  const discussed = await send(workspaceId, sessionId, '继续之前的目标', 'GOAL');
  const repositories2 = createRepositories(app.db);
  const stillPaused = await repositories2.planGoals.readGoal(goalId);
  assert.equal(stillPaused?.status, 'PAUSED');
  // 显式「继续」才回到 ACTIVE。
  await resumeGoalCommand(app.db, { workspaceId, goalId, commandId: randomUUID() });
  const resumed = await repositories2.planGoals.readGoal(goalId);
  assert.equal(resumed?.status, 'ACTIVE');
  // 排空这条未绑定目标的讨论消息：不留 PENDING 污染后续用例的生成 tick。
  await settleAssistant(discussed.result.assistant_message_id, [IDLE_REPLY]);

  // 任务书那句「运行中的目标切 `/plan` 也先持久化控制意图」：PLAN 与 CHAT 走同一条路径，
  // 但只在 CHAT 上取证等于没取，这里把 PLAN 变体钉死。
  const toPlan = await setChatMode(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), mode: 'PLAN' });
  assert.equal(toPlan.result.chat_mode, 'PLAN');
  assert.equal(toPlan.result.goal_stopping, true,
    '切到计划模式时暂停意图必须与模式在同一次命令里落库');
  const pausingAgain = await repositories2.planGoals.readGoal(goalId);
  assert.equal(pausingAgain?.status, 'PAUSING');
  // 没有在途轮次时推进器把 PAUSING 落成 PAUSED；留一个 ACTIVE 目标在库里会污染后续用例。
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal((await repositories2.planGoals.readGoal(goalId))?.status, 'PAUSED');
});

test('暂停命令：ACTIVE 目标可暂停，回执带出目标当前事实', async () => {
  const workspaceId = await newWorkspace('pause');
  const sessionId = await newSession(workspaceId, '暂停');
  const sent = await send(workspaceId, sessionId, '/goal 另一个目标', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  // 暂停是控制意图：先落 PAUSING，等在途轮次安全停下才显示已暂停。
  const pausing = await pauseGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal(pausing.result.goal.status, 'PAUSING');
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '本轮结束。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: '目标达成', required: true }],
      criteria_status: [{ key: 'c1', status: 'PENDING', evidence: null }],
      steps: [], current_step: null, progress: '进行中', questions: [],
      blocked_reason: null, adjustment: null } })]);
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const repositories = createRepositories(app.db);
  const paused = await repositories.planGoals.readGoal(goalId);
  assert.equal(paused?.status, 'PAUSED');
});

test('暂停后轮次先结算：完成结论只记轮次事实，目标保持 PAUSED，不进入待验收', async () => {
  const workspaceId = await newWorkspace('pause-complete');
  const sessionId = await newSession(workspaceId, '暂停与完成');
  const sent = await send(workspaceId, sessionId, '/goal 完成后再暂停', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  const pausing = await pauseGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal(pausing.result.goal.status, 'PAUSING');

  // 轮次在 tick 前已经结算为 COMPLETE：结算不能覆盖刚落下的暂停意图。
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '条件都满足了。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '目标达成', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '自检记录' }],
      steps: [], current_step: null, progress: '完成自检', questions: [],
      blocked_reason: null, adjustment: null } })]);
  const tick = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const repositories = createRepositories(app.db);
  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'PAUSED');
  assert.equal(goal?.round_count, 1);
  const rounds = await repositories.planGoals.listRounds(goalId);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]?.outcome, 'AWAITING_ACCEPTANCE');
  const settled = tick.settled.find(entry => entry.goalId === goalId);
  assert.equal(settled?.outcome, 'AWAITING_ACCEPTANCE');
  assert.equal(settled?.status, 'PAUSED');
  assert.ok(tick.controls.some(entry => entry.goalId === goalId && entry.status === 'PAUSED'));
  assert.equal(tick.advanced.some(entry => entry.goalId === goalId), false);

  const again = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(again.settled.some(entry => entry.goalId === goalId), false);
  assert.equal(again.advanced.some(entry => entry.goalId === goalId), false);
  assert.equal((await repositories.planGoals.listRounds(goalId)).length, 1);
});

test('暂停后轮次报告阻塞：BLOCKED 只记轮次事实，控制意图仍优先', async () => {
  const workspaceId = await newWorkspace('pause-blocked');
  const sessionId = await newSession(workspaceId, '暂停与阻塞');
  const sent = await send(workspaceId, sessionId, '/goal 阻塞也要保持暂停', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  await pauseGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '缺少外部凭据。',
    goal: { state: 'BLOCKED', success_criteria: [],
      criteria_status: [], steps: [], current_step: null, progress: '等待凭据',
      questions: [], blocked_reason: '缺少外部凭据', adjustment: null } })]);
  const tick = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const repositories = createRepositories(app.db);
  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'PAUSED');
  assert.equal(goal?.round_count, 1);
  const rounds = await repositories.planGoals.listRounds(goalId);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]?.outcome, 'BLOCKED');
  assert.equal(tick.settled.find(entry => entry.goalId === goalId)?.status, 'PAUSED');
});

test('取消后轮次先结算：轮次记账后同 tick 归一为 CANCELLED', async () => {
  const workspaceId = await newWorkspace('cancel-complete');
  const sessionId = await newSession(workspaceId, '取消与完成');
  const sent = await send(workspaceId, sessionId, '/goal 取消前已经完成一轮', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  const cancelling = await cancelGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal(cancelling.result.goal.status, 'CANCELLING');
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '这一轮完成了。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '目标达成', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '自检记录' }],
      steps: [], current_step: null, progress: '完成自检', questions: [],
      blocked_reason: null, adjustment: null } })]);
  const tick = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const repositories = createRepositories(app.db);
  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'CANCELLED');
  assert.equal(goal?.round_count, 1);
  const rounds = await repositories.planGoals.listRounds(goalId);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]?.outcome, 'AWAITING_ACCEPTANCE');
  assert.equal(tick.settled.find(entry => entry.goalId === goalId)?.status, 'CANCELLED');
  const again = await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  assert.equal(again.advanced.some(entry => entry.goalId === goalId), false);
  assert.equal((await repositories.planGoals.listRounds(goalId)).length, 1);
});

test('HTTP 面：模式、计划与目标投影经真实 API 进程', async () => {
  const workspaceId = await newWorkspace('http');
  const sessionId = await newSession(workspaceId, 'HTTP 面');
  const read = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}`));
  assert.equal(read.status, 200);
  // 会话 DTO 新增字段真实出现在 HTTP 响应上（DTO 投影漏字段只有 HTTP 面能抓到）。
  assert.equal((read.body as Record<string, unknown>).chat_mode, 'CHAT');

  // 消息体带 chat_mode：202 回执带受理档位；计划信封结算后 GET plans 读回版本行。
  const planRequest = { command_id: randomUUID(), content: '把登录流程梳理成方案',
    intent: 'DISCUSS', chat_mode: 'PLAN' };
  const sent = await api.post(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/messages`), planRequest);
  assert.equal(sent.status, 202);
  const sentResult = (sent.body as { result: Record<string, unknown> }).result;
  assert.equal(sentResult.chat_mode, 'PLAN');

  // 领取是全库单步的：前面用例遗留的排队消息可能先被领走，所以这里一直轮到这条 PLAN 消息
  // 为止。「跑一次 tick」等于「领我刚发的这条」是错的假设——2026-10-21 的红一次就出在这里，
  // 报成 HTTP 路径下计划没落库（versions.length 实得 0），实际是这条消息还没被领取。
  const planMessageId = String(sentResult.assistant_message_id);
  const planOutcome = await settleAssistant(planMessageId, [JSON.stringify({
    reply: '方案成形。', plan: { goal: '登录重构', scope: ['web 登录链路'],
      steps: [{ title: '梳理现状', detail: '读现有实现' }, { title: '拆分服务' }],
      verification: [{ statement: '人工走查', method: 'HUMAN' }],
      open_questions: ['是否保留旧会话表'] } })]);
  const planMessage = await createRepositories(app.db).assist.readMessage(
    planOutcome.outcome.messageId);
  assert.equal(planMessage?.status, 'COMPLETED',
    `PLAN 消息状态 ${planMessage?.status} / ${planMessage?.error_code ?? '无错误码'}`);
  assert.equal(planMessage?.content, '方案成形。',
    '正文只落 reply：把整段信封当正文显示是已经修过一次的缺陷');
  const planRead = await api.get(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/plans`));
  assert.equal(planRead.status, 200);
  const plansBody = planRead.body as { latest: Record<string, unknown> | null;
    versions: unknown[] };
  assert.equal(plansBody.versions.length, 1);
  assert.equal(plansBody.latest?.version, 1);
  assert.equal(typeof plansBody.latest?.plan_id, 'string');
  assert.equal(plansBody.latest?.status, 'CURRENT');

  // 经真实 HTTP 路由读回的不该只有版本号：范围、步骤、验证方式、待确认项都必须还原得回来。
  // 失败时逐层打印（请求 → 回执 → 消息行 → 仓储行与 jsonb_typeof → 投影 → 状态码）。
  const latestPlan = plansBody.latest as Record<string, unknown>;
  if (JSON.stringify([latestPlan.scope, latestPlan.steps, latestPlan.verification,
    latestPlan.open_questions]) === '[[],[],[],[]]') {
    assert.fail('计划内容四段全空（版本号在、内容读不回）。逐层诊断：'
      + await planPersistenceTrace({ workspaceId, sessionId, messageId: planMessageId,
        sentBody: planRequest, postStatus: sent.status, getStatus: planRead.status,
        getBody: planRead.body }));
  }
  assert.deepEqual(latestPlan.scope, ['web 登录链路']);
  assert.deepEqual(latestPlan.steps, [{ title: '梳理现状', detail: '读现有实现' },
    { title: '拆分服务', detail: null }]);
  assert.deepEqual(latestPlan.verification, [{ statement: '人工走查', method: 'HUMAN' }]);
  assert.deepEqual(latestPlan.open_questions, ['是否保留旧会话表']);

  // GOAL：202 回执带 goal_id；GET goal 投影带服务端判定的 actions。
  const goalSent = await api.post(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/messages`),
    { command_id: randomUUID(), content: '持续把文档整理完', intent: 'DISCUSS',
      chat_mode: 'GOAL' });
  assert.equal(goalSent.status, 202);
  const goalId = (goalSent.body as { result: Record<string, unknown> }).result.goal_id;
  assert.equal(typeof goalId, 'string');

  const goalRead = await api.get(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/goal`));
  assert.equal(goalRead.status, 200);
  const goalBody = goalRead.body as { goal: Record<string, unknown> | null };
  assert.equal(goalBody.goal?.goal_id, goalId);
  assert.deepEqual(goalBody.goal?.actions, { pause: true, cancel: true,
    resume: false, confirm_completion: false });

  // 切走活动目标：回执带 goal_stopping；四条控制命令经 HTTP 受理并回带当前事实。
  const switched = await api.post(workspacePath(workspaceId,
    `/assist-sessions/${sessionId}/chat-mode`), { command_id: randomUUID(), mode: 'CHAT' });
  assert.equal(switched.status, 200);
  assert.equal((switched.body as { result: Record<string, unknown> }).result.goal_stopping,
    true);

  const paused = await api.post(workspacePath(workspaceId,
    `/assist-goals/${goalId as string}/pause`), { command_id: randomUUID() });
  assert.equal(paused.status, 200);
  assert.equal(((paused.body as { result: { goal: Record<string, unknown> } }).result.goal)
    .status, 'PAUSING');
});

test('领取顺序：一次 tick 领的是全库会话 id 最早的一条 PENDING（计划「未落库」根因取证）', async () => {
  /*
   * 这条不是新的业务规则，是上面那处不稳定失败的取证，防止以后又把
   * 「跑一次生成 tick」当成「领我刚发的这条消息」。
   *
   * `assist-repository.ts` 的 `claimNextPendingMessage` 用
   * `order by m.session_id, m.created_at, m.id limit 1`：**会话 id 排在创建时间之前**，
   * 且一次只领一条。于是同一段测试库里，别的会话遗留一条排队消息时，本次刚发的
   * `/plan` 消息可能不被领取；那一刻 `GET plans` 自然是空列表，看起来就像
   * 「HTTP 路径下计划没落库」。2026-10-21 的真实 PG 运行里同一条用例一次绿一次红
   * （红：`versions.length` 实得 0），差别只在随机出来的会话 id 谁更小。
   *
   * 生产语义本身没有错：Worker 持续轮询，每个 tick 处理一条，队列最终都会结算完，
   * 且领取仍受同一租约与 Worker CAS 约束（不新增第二个推进 Owner）。要改的是测试的
   * 假设，所以本文件统一改用 `settleAssistant` 显式轮到目标消息。
   */
  const workspaceId = await newWorkspace('claim-order');
  await drainQueue();

  // 第一段：把排序事实钉死。两条排队消息都只发不结算，谁被领走只由会话 id 决定。
  const first = await newSession(workspaceId, '会话甲');
  const second = await newSession(workspaceId, '会话乙');
  await send(workspaceId, first, '甲的排队消息', 'CHAT');
  await send(workspaceId, second, '乙的排队消息', 'CHAT');
  const repositories = createRepositories(app.db);
  const claimed = await repositories.assist.claimNextPendingMessage(`claim-order-${randomUUID()}`);
  assert.ok(claimed !== undefined, '两条排队消息时领取不该为空');
  assert.equal(claimed.session_id, first < second ? first : second,
    '领取按 session_id 排序，与消息先后无关：所以「发一条再跑一次 tick」不保证轮到它');

  // 第二段：症状与消解。这条 PLAN 消息还没被领取时 GET plans 为空（就是那条红断言的现场），
  // 显式轮到它以后版本行才出现——落库路径本身没坏，坏的是一直被省略的「等它被领走」。
  const sessionId = await newSession(workspaceId, '计划会话');
  const target = await send(workspaceId, sessionId, '/plan 排到队首才落库', 'PLAN');
  const before = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/plans`));
  assert.equal((before.body as { versions: unknown[] }).versions.length, 0,
    '消息还没被领取时没有计划版本：这就是那条失败断言看到的现场');
  const settled = await settleAssistant(target.result.assistant_message_id, [JSON.stringify({
    reply: '轮到这条消息了。', plan: { goal: '排到队首才落库', scope: [],
      steps: [{ title: '先领取再结算' }], verification: [], open_questions: [] } })]);
  const after = await api.get(workspacePath(workspaceId, `/assist-sessions/${sessionId}/plans`));
  assert.equal((after.body as { versions: unknown[] }).versions.length, 1,
    `领了 ${settled.claimed.length} 次之后计划版本才落库`);
});

test('公平扫描：50 个较旧静止目标不会挡住控制收口与已结算轮次记账', async () => {
  /*
   * DEV-0094 的复现条件：推进器两个阶段都按「全部未终结目标 updated_at 升序取 50 条」。
   * 历史 PAUSED/WAITING_USER 行不会因 tick 改变，于是每个 tick 都拿回同一批静止目标，
   * 较新的 PAUSING/CANCELLING 与待记账轮次永远进不了扫描集合。
   *
   * 本用例不删除静止目标、不改它们的时间戳来制造通过；断言的是「候选范围按阶段缩小」
   * 本身：控制阶段只收 PAUSING/CANCELLING，结算阶段只收最新已结算消息未记账的目标。
   */
  await drainQueue();
  const workspaceId = await newWorkspace('goal-fair-scan');
  const repositories = createRepositories(app.db);

  async function fixtureGoal(tag: string,
    status: 'PAUSED' | 'WAITING_USER' | 'PAUSING' | 'CANCELLING'): Promise<string> {
    const session = await createAssistSession(app.db, { workspaceId,
      commandId: randomUUID(), projectId: null, title: `公平扫描 ${tag}` });
    const goal = await repositories.planGoals.insertGoal({ id: randomUUID(), workspaceId,
      sessionId: session.result.session_id, planVersionId: null,
      objective: `公平扫描 fixture ${tag}`, criteria: [], steps: [] });
    await repositories.planGoals.updateGoal(goal.id, goal.revision, { status });
    return goal.id;
  }

  // 50 条较旧的静止目标：一半 PAUSED、一半 WAITING_USER，时间戳全部早于被测目标。
  const blockers: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    const id = await fixtureGoal(`blocker-${index}`, index % 2 === 0 ? 'PAUSED' : 'WAITING_USER');
    await sql`update assist_goals
      set updated_at = timestamp '2000-01-01' + ${index} * interval '1 second'
      where id = ${id}`.execute(app.db);
    blockers.push(id);
  }

  const pausing = await fixtureGoal('pausing', 'PAUSING');
  const cancelling = await fixtureGoal('cancelling', 'CANCELLING');

  const CONTINUE_ROUND = JSON.stringify({ reply: '本轮记录一条进展。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: '目标达成', required: true }],
      criteria_status: [{ key: 'c1', status: 'PENDING', evidence: null }],
      steps: [], current_step: null, progress: '推进中', questions: [],
      blocked_reason: null, adjustment: null } });
  const COMPLETE_ROUND = JSON.stringify({ reply: '完成自检。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '目标达成', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '自检记录' }],
      steps: [], current_step: null, progress: '完成自检', questions: [],
      blocked_reason: null, adjustment: null } });

  // 暂停目标上压着一条已结算但未记账的轮次：不能靠「排除所有 PAUSED」来腾窗口。
  const pausedSession = await newSession(workspaceId, '暂停但轮次待记账');
  const pausedSent = await send(workspaceId, pausedSession, '/goal 暂停也要记账', 'GOAL');
  const pausedGoalId = pausedSent.result.goal_id;
  assert.ok(pausedGoalId !== null);
  await pauseGoal(app.db, { workspaceId, goalId: pausedGoalId, commandId: randomUUID() });
  await settleAssistant(pausedSent.result.assistant_message_id, [CONTINUE_ROUND]);
  const pausedRow = await repositories.planGoals.readGoal(pausedGoalId);
  assert.equal(pausedRow?.status, 'PAUSING');
  await repositories.planGoals.updateGoal(pausedGoalId, pausedRow!.revision, { status: 'PAUSED' });
  await sql`update assist_goals set updated_at = timestamp '2000-02-01'
    where id = ${pausedGoalId}`.execute(app.db);

  // 活跃目标上同样压着一条已结算轮次；旧扫描下它也被 50 条静止目标挡住。
  const activeSession = await newSession(workspaceId, '活跃但轮次待记账');
  const activeSent = await send(workspaceId, activeSession, '/goal 活跃目标也要结算', 'GOAL');
  const activeGoalId = activeSent.result.goal_id;
  assert.ok(activeGoalId !== null);
  await settleAssistant(activeSent.result.assistant_message_id, [COMPLETE_ROUND]);
  await sql`update assist_goals set updated_at = timestamp '2000-02-02'
    where id = ${activeGoalId}`.execute(app.db);

  // 在途取消：tick 只请求停止，不能提前宣称 CANCELLED。
  const cancelSession = await newSession(workspaceId, '取消在途轮次');
  const cancelSent = await send(workspaceId, cancelSession, '/goal 取消还有在途轮次', 'GOAL');
  const cancelGoalId = cancelSent.result.goal_id;
  assert.ok(cancelGoalId !== null);
  await cancelGoal(app.db, { workspaceId, goalId: cancelGoalId, commandId: randomUUID() });
  // 在途轮次按真实领取形态置为 RUNNING：PENDING 的排队轮次在收到取消意图时会直接收口
  // （DEV-0102），再用它验证「在途取消只请求停止」就测不到东西了。
  await sql`update assist_messages set status = 'RUNNING',
    worker_id = ${`fair-scan-inflight-${randomUUID()}`}, updated_at = now()
    where id = ${cancelSent.result.assistant_message_id}`.execute(app.db);

  // 有限次数 tick 内收口，全程不删除静止目标、不改它们的时间戳。
  const ticks = [];
  for (let index = 0; index < 3; index += 1) {
    ticks.push(await runAssistGoalTick(app.db, { workerId: `fair-scan-${randomUUID()}` }));
  }

  assert.equal((await repositories.planGoals.readGoal(pausing))?.status, 'PAUSED',
    '50 个较旧静止目标不应挡住 PAUSING 收口');
  assert.equal((await repositories.planGoals.readGoal(cancelling))?.status, 'CANCELLED',
    '50 个较旧静止目标不应挡住 CANCELLING 收口');
  assert.ok(ticks.some((tick) => tick.controls.some(
    (entry) => entry.goalId === pausing && entry.status === 'PAUSED')));
  assert.ok(ticks.some((tick) => tick.controls.some(
    (entry) => entry.goalId === cancelling && entry.status === 'CANCELLED')));

  const pausedAfter = await repositories.planGoals.readGoal(pausedGoalId);
  assert.equal(pausedAfter?.status, 'PAUSED');
  assert.equal(pausedAfter?.round_count, 1, 'PAUSED 目标上已结算的轮次必须被记账');
  assert.equal((await repositories.planGoals.listRounds(pausedGoalId)).length, 1);

  const activeAfter = await repositories.planGoals.readGoal(activeGoalId);
  assert.equal(activeAfter?.status, 'AWAITING_ACCEPTANCE',
    '较新的活跃轮次结算不应被静止目标饿死');
  assert.equal(activeAfter?.round_count, 1);
  assert.equal((await repositories.planGoals.listRounds(activeGoalId)).length, 1);

  assert.equal((await repositories.planGoals.readGoal(cancelGoalId))?.status, 'CANCELLING');
  const inflight = await repositories.assist.readMessage(
    cancelSent.result.assistant_message_id);
  assert.equal(inflight?.status, 'RUNNING', '在途轮次只请求停止，不能提前宣称取消');
  assert.equal(inflight?.cancel_requested, true);

  // 静止目标保持原状：进展不是靠改写它们取得的。
  const blockerRows = await sql<{ status: string }>`select status from assist_goals
    where id in (${sql.join(blockers.map((id) => sql`${id}`), sql`, `)})`.execute(app.db);
  assert.equal(blockerRows.rows.length, 50);
  assert.ok(blockerRows.rows.every(
    (row) => row.status === 'PAUSED' || row.status === 'WAITING_USER'));

  // 清理在途取消：模拟生成方按取消意图结算这条 RUNNING 消息，再让 tick 记账收口。
  // 目标状态仍只由推进器在轮次记账后改成 CANCELLED。
  await sql`update assist_messages set status = 'CANCELLED', updated_at = now()
    where id = ${cancelSent.result.assistant_message_id}`.execute(app.db);
  await runAssistGoalTick(app.db, { workerId: `fair-scan-cleanup-${randomUUID()}` });
  assert.equal((await repositories.planGoals.readGoal(cancelGoalId))?.status, 'CANCELLED');
});

test('取消目标时 PENDING 轮次直接收敛为 CANCELLED，生成 Worker 不会领取失权消息', async () => {
  /*
   * DEV-0102：`markMessageCancelRequested` 过去只置 `cancel_requested=true`，消息仍是
   * PENDING。生成 Worker 把它领取成 RUNNING 后，`recordGenerationSources` 以「生成端
   * 不再拥有预览」拒绝；目标轮次分支的返回没有 await，拒绝逃出
   * `runAssistGenerationTick`，Worker 主循环只在外层 catch，进程直接退出。
   *
   * 这里从真实排队状态出发：取消时消息还没被任何 Worker 领过，一次目标 tick 后它必须
   * 已经是 CANCELLED、轮次记账一次、目标收口，且领取队列里不再有它。
   */
  await drainQueue();
  const workspaceId = await newWorkspace('goal-cancel-pending');
  const sessionId = await newSession(workspaceId, '取消排队轮次');
  const sent = await send(workspaceId, sessionId, '/goal 取消排队轮次', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  const repositories = createRepositories(app.db);
  assert.equal((await repositories.assist.readMessage(
    sent.result.assistant_message_id))?.status, 'PENDING');

  await cancelGoal(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal((await repositories.assist.readMessage(
    sent.result.assistant_message_id))?.status, 'PENDING',
  '取消命令本身只记目标意图，轮次由推进器收口');

  const tick = await runAssistGoalTick(app.db, { workerId: `cancel-pending-${randomUUID()}` });
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  assert.equal(message?.status, 'CANCELLED', '排队中的轮次没有被调用模型，直接收敛为 CANCELLED');
  assert.equal(message?.cancel_requested, true);

  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'CANCELLED');
  assert.equal(goal?.round_count, 1, '取消也要留下这一轮的事实');
  assert.equal(goal?.last_round_message_id, sent.result.assistant_message_id);
  const rounds = await repositories.planGoals.listRounds(goalId);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]?.outcome, 'CANCELLED_ROUND');
  assert.ok(tick.settled.some((entry) => entry.goalId === goalId
    && entry.messageId === sent.result.assistant_message_id
    && entry.outcome === 'CANCELLED_ROUND' && entry.status === 'CANCELLED'));

  // 领取队列里不能再有它；生成 tick 也不会因为这条消息抛错退出。
  assert.equal(await pendingMessages(), 0);
  assert.equal(await runGeneration(envelopePort([IDLE_REPLY])), undefined,
    '取消路径不得再让生成 tick 抛出 AssistPreviewOwnershipLostError');
});

test('确认完成时目标名下还有排队补充消息：按冲突拒绝，结算进轮次账本后才能完成', async () => {
  /*
   * #142：ACTIVE 目标受理的补充消息还排在队列里时，上一条回复的 COMPLETE 就能把目标
   * 带到 AWAITING_ACCEPTANCE。此时放行人工确认，补充消息会在终态之后照常生成、轮次却
   * 永远不再记账。新行为：确认按 409 冲突拒绝；等推进器把补充消息结算进轮次账本后，
   * 确认才被接受——已发生的轮次事实不游离在目标终态之外。
   */
  await drainQueue();
  const workspaceId = await newWorkspace('goal-confirm-inflight');
  const sessionId = await newSession(workspaceId, '确认与排队补充');
  const first = await send(workspaceId, sessionId, '/goal 完成安装检查', 'GOAL');
  const goalId = first.result.goal_id;
  assert.ok(goalId !== null);
  const supplemental = await send(workspaceId, sessionId, '补充：还要核对回滚步骤', 'GOAL');
  assert.equal(supplemental.result.goal_id, goalId, 'ACTIVE 目标受理的补充消息绑定同一目标');

  const repositories = createRepositories(app.db);
  await settleAssistant(first.result.assistant_message_id, [JSON.stringify({
    reply: '检查完成。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '安装检查通过', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '自检通过' }],
      steps: [], current_step: null, progress: '检查完成', questions: [],
      blocked_reason: null, adjustment: null } })]);
  await runAssistGoalTick(app.db, { workerId: `confirm-inflight-${randomUUID()}` });
  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'AWAITING_ACCEPTANCE');
  assert.equal((await repositories.planGoals.readInflightRoundMessage(goalId))?.status, 'PENDING',
    '前置：补充消息仍在队列，这正是被保护的状态');

  await assert.rejects(
    () => confirmGoalCompletion(app.db, { workspaceId, goalId, commandId: randomUUID() }),
    (error: unknown) => error instanceof DomainError && error.status === 409
      && error.code === 'GOAL_ROUNDS_UNSETTLED',
    '还有排队补充消息时确认完成必须按冲突拒绝，不能 200 终结目标');
  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'AWAITING_ACCEPTANCE',
    '被拒的确认不改变目标状态');

  // 补充消息随后照常生成，并由推进器结算进轮次账本。
  await settleAssistant(supplemental.result.assistant_message_id, [JSON.stringify({
    reply: '回滚步骤也核对完毕。',
    goal: { state: 'COMPLETE',
      success_criteria: [{ key: 'c1', statement: '安装检查通过', required: true }],
      criteria_status: [{ key: 'c1', status: 'MET', evidence: '回滚步骤核对通过' }],
      steps: [], current_step: null, progress: '补充核对完成', questions: [],
      blocked_reason: null, adjustment: null } })]);
  await runAssistGoalTick(app.db, { workerId: `confirm-settle-${randomUUID()}` });
  assert.ok(await repositories.planGoals.readRoundByMessage(
    supplemental.result.assistant_message_id) !== undefined,
    '补充消息的轮次事实必须可追溯，不能静默漏账');
  await confirmGoalCompletion(app.db, { workspaceId, goalId, commandId: randomUUID() });
  assert.equal((await repositories.planGoals.readGoal(goalId))?.status, 'COMPLETED',
    '全部轮次安全结算后确认完成照常成立');
});

test('积压恢复按原始顺序结算：早期回复不缺账，成功条件从最早一轮冻结', async () => {
  /*
   * #143：两条目标轮次消息在推进器结算之前都已生成完成（崩溃/恢复窗口）时，恢复不能
   * 只记最新一条——更早的回复必须先按原始顺序记账，成功条件也从它首次冻结；最新消息
   * 先记账不得把早期缺账消息挤出候选集。积压记完后才组织下一轮。
   */
  await drainQueue();
  const workspaceId = await newWorkspace('goal-backlog-order');
  const sessionId = await newSession(workspaceId, '积压顺序结算');
  const first = await send(workspaceId, sessionId, '/goal 代码与安装都要通过', 'GOAL');
  const goalId = first.result.goal_id;
  assert.ok(goalId !== null);
  const second = await send(workspaceId, sessionId, '补充说明', 'GOAL');
  assert.equal(second.result.goal_id, goalId);

  const repositories = createRepositories(app.db);
  // 两条消息先后生成完成，之间没有任何目标 tick。
  await settleAssistant(first.result.assistant_message_id, [JSON.stringify({
    reply: '第一轮：读完现状。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: '代码与安装都通过', required: true }],
      criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '尚未验证' }],
      steps: [], current_step: null, progress: '读完现状', questions: [],
      blocked_reason: null, adjustment: null } })]);
  await settleAssistant(second.result.assistant_message_id, [JSON.stringify({
    reply: '第二轮：换了口径。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c2', statement: '仅代码检查通过', required: true }],
      criteria_status: [{ key: 'c2', status: 'UNMET', evidence: '仍未安装验证' }],
      steps: [], current_step: null, progress: '第二轮进展', questions: [],
      blocked_reason: null, adjustment: null } })]);

  const tick = await runAssistGoalTick(app.db, { workerId: `backlog-${randomUUID()}` });

  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'ACTIVE');
  assert.equal(goal?.round_count, 2, '两条已终结消息都必须有轮次账');
  const firstRound = await repositories.planGoals
    .readRoundByMessage(first.result.assistant_message_id);
  const secondRound = await repositories.planGoals
    .readRoundByMessage(second.result.assistant_message_id);
  assert.ok(firstRound !== undefined && secondRound !== undefined);
  assert.equal(firstRound.round_index, 1);
  assert.equal(secondRound.round_index, 2);
  const view = await readSessionGoal(app.db, { workspaceId, sessionId });
  assert.deepEqual(view.goal?.criteria, [{ key: 'c1', statement: '代码与安装都通过',
    status: 'UNMET', evidence: '尚未验证', required: true }],
    '成功条件按原始顺序从第一轮冻结，不被较晚清单替换');
  // 积压记完账后才投递下一轮：轮次身份按 round_count 连续派生。
  assert.ok(tick.advanced.some((entry) => entry.goalId === goalId
    && entry.roundIndex === 3), '积压清零后组织下一轮');
  assert.equal(await repositories.planGoals.readRoundByMessage(
    first.result.assistant_message_id) !== undefined
    && await repositories.planGoals.readRoundByMessage(
      second.result.assistant_message_id) !== undefined, true);
});

test('并发 tick：租约 CAS 只放行一个 worker，同一轮次不会投递两次', async () => {
  /*
   * Supervisor 常驻 + Worker 一次性：多个推进者可能同时看到同一条 ACTIVE 目标。
   * 租约是唯一互斥点（`listAdvanceCandidates` 过滤未过期租约，claim 用 revision CAS），
   * 这里让 4 个 tick 真并发，证明「只会投递一轮」：
   *   * `advanced` 里这条目标恰好一条；
   *   * 库里恰好一条目标轮次 PENDING，id 就是按 round_count 确定性派生的那条；
   *   * 落败方只出现在 skipped（LEASE_RACE / INFLIGHT_ROUND），没有第二条消息；
   *   * 成功方清掉租约，进程重启后的下一个 tick 仍能继续（不会卡在永久租约上）。
   */
  await drainQueue();
  const workspaceId = await newWorkspace('goal-tick-race');
  const sessionId = await newSession(workspaceId, '并发推进');
  const sent = await send(workspaceId, sessionId, '/goal 并发也只能推进一轮', 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);
  const repositories = createRepositories(app.db);
  await settleAssistant(sent.result.assistant_message_id, [JSON.stringify({
    reply: '读完现状，下一轮继续。',
    goal: { state: 'CONTINUE',
      success_criteria: [{ key: 'c1', statement: '并发下只推进一轮', required: true }],
      criteria_status: [{ key: 'c1', status: 'UNMET', evidence: '尚未验证' }],
      steps: [], current_step: null, progress: '读完现状', questions: [],
      blocked_reason: null, adjustment: null } })]);

  const ticks = await Promise.all([0, 1, 2, 3].map(() =>
    runAssistGoalTick(app.db, { workerId: `race-${randomUUID()}` })));
  const advanced = ticks.flatMap((tick) => tick.advanced)
    .filter((entry) => entry.goalId === goalId);
  assert.equal(advanced.length, 1,
    `同一目标只应有一个 tick 拿到租约，实得 ${JSON.stringify(advanced)}`);
  assert.equal(advanced[0]?.roundIndex, 2, '结算已记第 1 轮，新投递是第 2 轮');

  const goalMessages = (await repositories.assist.listMessages(sessionId, 50))
    .filter((row) => row.goal_id === goalId);
  const pending = goalMessages.filter((row) => row.status === 'PENDING');
  assert.equal(pending.length, 1, '并发 tick 不得产生第二条待生成的目标轮次消息');
  assert.equal(pending[0]?.id, goalRoundMessageId(goalId, 2),
    '轮次消息身份按「目标 + 第几轮」确定性派生，重扫不会长出第二条');
  assert.equal(advanced[0]?.messageId, pending[0]?.id);

  const goalRow = await repositories.planGoals.readGoal(goalId);
  assert.equal(goalRow?.round_count, 1, '并发 tick 只结算了已生成的那一轮，不重复记账');
  assert.equal(goalRow?.status, 'ACTIVE');
  assert.equal(goalRow?.lease_owner, null, '投递完成后必须释放租约，重启后的 tick 才能接手');
  assert.equal((await repositories.planGoals.listRounds(goalId)).length, 1);

  // 在途轮次存在时再跑一个 tick：既不重复投递，也不动租约。
  const after = await runAssistGoalTick(app.db, { workerId: `race-after-${randomUUID()}` });
  assert.equal(after.advanced.some((entry) => entry.goalId === goalId), false);
  assert.equal(after.skipped.some((entry) => entry.goalId === goalId
    && entry.reason === 'INFLIGHT_ROUND'), true);
  assert.equal((await repositories.assist.listMessages(sessionId, 50))
    .filter((row) => row.goal_id === goalId && row.status === 'PENDING').length, 1);
});

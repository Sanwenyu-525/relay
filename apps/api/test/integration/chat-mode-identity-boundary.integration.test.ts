import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { createAssistSession, requestAssistMessage } from
  '../../src/application/assist-commands.js';
import { createAssistantProfile } from '../../src/application/assistant-profile-commands.js';
import { startGoalFromPlan } from '../../src/application/assist-goals.js';
import { setChatMode } from '../../src/application/chat-mode.js';
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
 * #145（禅道）：会话身份 × 行为模式的支持矩阵。
 *
 * PLAN/GOAL 的信封只在普通 AGENT 主流程里解析与结算；ASSISTANT/LEARNING 的生成入口
 * 在 runner 里**先于** planMode/goalRound 提前路由，从不写 goal_outcome。此前放行
 * LEARNING×GOAL 的结果是「受理成功、建了目标、三轮 NO_STRUCTURE 后必然
 * WAITING_USER/NO_PROGRESS」。修复后未实现组合在四个写入口（建会话、切模式、发消息、
 * 按计划执行）**受理前**被类型化拒绝（CHAT_MODE_UNSUPPORTED_FOR_IDENTITY，409），
 * 命令事务整体回滚、零目标/消息副作用；AGENT 正对照与 LEARNING/ASSISTANT 的普通
 * 对话不受影响。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-chat-mode-identity-test');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

async function newWorkspace(tag: string): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (repositories) => {
    await repositories.workspaces.insertWorkspace({ id: workspaceId, name: `identity-${tag}` });
    await repositories.workspaces.insertAuthorityRow(workspaceId);
  });
  return workspaceId;
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null,
  cacheCreationTokens: null } as const;

/** 学习身份的受控端口：记录是否走了教学路由（request.learning 存在）。 */
function learningPort(): { readonly port: AssistModelPort; readonly sawLearning: () => boolean } {
  let learningRequests = 0;
  let anyRequests = 0;
  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async (request) => {
      anyRequests += 1;
      if (request.learning) learningRequests += 1;
      const result: AssistResult = { kind: 'CONTENT', content: '正常教学回答',
        ...(request.learning ? { learning: { increments: [], schemaError: null } } : {}),
        providerRequestId: `stub-${anyRequests}`, usage: { ...usage } };
      return result;
    },
  };
  return { port, sawLearning: () => anyRequests > 0 && learningRequests === anyRequests };
}

async function assertRejected(promise: Promise<unknown>, sessionId: string | null): Promise<void> {
  try {
    await promise;
    assert.fail('未实现的身份×模式组合必须被类型化拒绝');
  } catch (error) {
    assert.ok(error instanceof DomainError, `应抛 DomainError，实得 ${String(error)}`);
    assert.equal(error.code, 'CHAT_MODE_UNSUPPORTED_FOR_IDENTITY');
    assert.equal(error.status, 409);
    if (sessionId !== null) assert.equal(error.conflict?.sessionId, sessionId);
  }
}

test('LEARNING 身份不支持 PLAN/GOAL：四个写入口类型化拒绝、零副作用；教学对话照常', async () => {
  const workspaceId = await newWorkspace('learning');
  const repositories = createRepositories(app.db);

  // 入口一：带模式建会话。
  await assertRejected(createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '学习目标会话', conversationMode: 'LEARNING', chatMode: 'GOAL' }),
  null);
  await assertRejected(createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '学习计划会话', conversationMode: 'LEARNING', chatMode: 'PLAN' }),
  null);

  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '学习会话', conversationMode: 'LEARNING' });
  const sessionId = created.result.session_id;
  assert.equal((await repositories.assist.readSession(sessionId))?.chat_mode, 'CHAT');

  // 入口二：切模式。
  await assertRejected(setChatMode(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), mode: 'GOAL' }), sessionId);
  await assertRejected(setChatMode(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), mode: 'PLAN' }), sessionId);
  assert.equal((await repositories.assist.readSession(sessionId))?.chat_mode, 'CHAT',
    '被拒的模式切换不得改写会话模式');

  // 入口三：显式 chat_mode 与 /goal 前缀。
  await assertRejected(requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), chatMode: 'GOAL', content: '完成这次学习检查' }), sessionId);
  await assertRejected(requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '/goal 完成这次学习检查' }), sessionId);
  const messages = await repositories.assist.listMessages(sessionId, 20);
  assert.equal(messages.length, 0, '被拒的消息受理不得写入任何消息行');
  assert.equal(await repositories.planGoals.readOpenGoal(sessionId), undefined,
    '被拒的受理不得创建目标');

  // 入口四：按计划执行（直接铺一行历史计划模拟旧数据；拒绝发生在创建目标之前）。
  const sourceSeq = await repositories.assist.nextMessageSeq(sessionId);
  const sourceMessageId = randomUUID();
  await repositories.assist.insertMessage({ id: sourceMessageId, sessionId, seq: sourceSeq,
    role: 'USER', status: 'COMPLETED', intent: 'DISCUSS', content: '历史计划来源消息',
    sources: [] });
  const plan = await repositories.planGoals.insertPlanVersion({ id: randomUUID(),
    workspaceId, sessionId, goal: '学习检查', scope: [], steps: [], verification: [],
    openQuestions: [], sourceMessageId });
  await assertRejected(startGoalFromPlan(app.db, { workspaceId, sessionId,
    planId: plan.id, commandId: randomUUID(), allowSuperseded: true }), sessionId);
  assert.equal(await repositories.planGoals.readOpenGoal(sessionId), undefined);
  assert.equal((await repositories.assist.readSession(sessionId))?.chat_mode, 'CHAT',
    '按计划执行被拒后不得切换会话模式');

  // 正对照：普通对话的教学轮次不受影响（不走目标协议，也不产生目标）。
  const { port, sawLearning } = learningPort();
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '帮我理解接口幂等性' });
  assert.equal(sent.result.chat_mode, 'CHAT');
  assert.equal(sent.result.goal_id, null);
  let teachingSettled = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, { workerId: `learn-${randomUUID()}`,
      storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
      maxMessages: 1 });
    if (outcome !== undefined && outcome.messageId === sent.result.assistant_message_id) {
      assert.equal(outcome.status, 'COMPLETED');
      teachingSettled = true;
      break;
    }
  }
  assert.ok(teachingSettled, '教学消息应在本文件队列中结算');
  assert.ok(sawLearning(), '学习身份的生成必须走教学路由');
  assert.equal(await repositories.planGoals.readOpenGoal(sessionId), undefined);
});

test('ASSISTANT 身份同族边界：不支持 PLAN/GOAL，普通只读对话受理不受影响', async () => {
  const workspaceId = await newWorkspace('assistant');
  const repositories = createRepositories(app.db);
  const profile = await createAssistantProfile(app.db, { workspaceId,
    commandId: randomUUID(), name: '审读助手', roleDescription: '只读复核' });
  const profileId = String(profile.result.assistant_profile_id);

  await assertRejected(createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '人设计划会话', conversationMode: 'ASSISTANT',
    chatMode: 'PLAN', assistantProfileId: profileId }), null);

  const created = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: null, title: '人设会话', conversationMode: 'ASSISTANT',
    assistantProfileId: profileId });
  const sessionId = created.result.session_id;
  await assertRejected(setChatMode(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), mode: 'GOAL' }), sessionId);
  await assertRejected(requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '/plan 帮我规划一下' }), sessionId);
  assert.equal(await repositories.planGoals.readOpenGoal(sessionId), undefined);
  assert.equal((await repositories.assist.readSession(sessionId))?.chat_mode, 'CHAT');

  // 正对照：只读对话受理照常。
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '帮我复核这一段' });
  assert.equal(sent.result.chat_mode, 'CHAT');
});

test('AGENT 正对照：GOAL/PLAN 支持不变，目标协议照常结算', async () => {
  const workspaceId = await newWorkspace('agent');
  const sessionId = (await createAssistSession(app.db, { workspaceId,
    commandId: randomUUID(), projectId: null, title: '普通目标' })).result.session_id;
  const repositories = createRepositories(app.db);
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), chatMode: 'GOAL', content: '把说明整理完' });
  assert.equal(sent.result.chat_mode, 'GOAL');
  const goalId = sent.result.goal_id;
  assert.ok(goalId !== null);

  const port: AssistModelPort = {
    identity: new FakeModelPort().identity,
    assist: async () => ({ kind: 'CONTENT',
      content: JSON.stringify({ reply: '完成。', goal: { state: 'COMPLETE',
        success_criteria: [{ key: 'c1', statement: '说明已整理', required: true }],
        criteria_status: [{ key: 'c1', status: 'MET', evidence: '已写入' }], steps: [],
        current_step: null, progress: '完成', questions: [], blocked_reason: null,
        adjustment: null } }),
      providerRequestId: 'stub-agent-goal', usage: { ...usage } }),
  };
  // 领取是全库单步的：按消息 id 等到本用例的目标消息结算（前序用例遗留的 PENDING 先被领走）。
  let goalRoundSettled = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await runAssistGenerationTick(app.db, { workerId: `agent-${randomUUID()}`,
      storage: new ManagedContentStore(dataRoot), modelPort: port, leaseMs: 60_000,
      maxMessages: 1 });
    if (outcome !== undefined && outcome.messageId === sent.result.assistant_message_id) {
      assert.equal(outcome.status, 'COMPLETED');
      goalRoundSettled = true;
      break;
    }
  }
  assert.ok(goalRoundSettled, 'AGENT 目标首轮应在本文件队列中结算');
  await runAssistGoalTick(app.db, { workerId: `tick-${randomUUID()}` });
  const goal = await repositories.planGoals.readGoal(goalId);
  assert.equal(goal?.status, 'AWAITING_ACCEPTANCE',
    'AGENT 目标首轮结构化结论必须按既有目标协议结算');
  assert.ok(goal?.stop_reason?.code === 'AWAITING_ACCEPTANCE');
});

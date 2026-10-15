import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, cancelAssistMessage,
  requestAssistMessage } from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { LearningRepository } from '../../src/learning/learning-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort, type AssistModelPort, type AssistResult,
  type ModelUsage } from '../../src/workflow/fake-model-port.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 迟到学习结算的真实 PG 反例（2026-10-11 独立验收 R2/R3 转正式回归）。
 *
 * 复现的两个真实缺陷：
 *   * R2：模型在途时租约过期（消息被真实 failExpiredLeases 置 FAILED/LEASE_LOST），
 *     迟到的 CONTENT 仍写学习证据并把轮次 SETTLED；
 *   * R3：模型在途时用户真实取消（cancel_requested 先持久化），迟到的 CONTENT 仍把
 *     消息标 COMPLETED 并写证据。
 *
 * 固定提交顺序用可控模型屏障：正文与增量都来自同一次模型返回，但「失权/取消」发生
 * 在模型返回之前；断言消息、轮次、证据与调用账本的真实行，不只看测试汇总。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-learning-late-settlement');
let dataRoot: string;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
  dataRoot = await createDataRoot();
});

after(async () => {
  await app.close();
  await rm(dataRoot, { recursive: true, force: true });
});

const EMPTY_USAGE: ModelUsage = { inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheCreationTokens: null };

interface RoundFacts {
  readonly messageId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageStatus: string;
  readonly messageError: string | null;
  readonly cancelRequested: boolean;
  readonly roundStatus: string | null;
  readonly roundReason: string | null;
  readonly evidenceIds: readonly string[];
  readonly settledCalls: number;
}

async function readFacts(workspaceId: string, messageId: string): Promise<RoundFacts> {
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(messageId);
  const round = await repositories.learning.readRoundByMessage(messageId);
  const evidence = await sql<{ id: string }>`select id from learning_evidence
    where workspace_id = ${workspaceId} order by observed_at, id`.execute(app.db);
  const calls = await sql<{ count: string }>`select count(*)::text as count from model_calls
    where assist_message_id = ${messageId}`.execute(app.db);
  return {
    messageId,
    sessionId: message?.session_id ?? '',
    workspaceId,
    messageStatus: message?.status ?? 'MISSING',
    messageError: message?.error_code ?? null,
    cancelRequested: message?.cancel_requested ?? false,
    roundStatus: round?.status ?? null,
    roundReason: round?.rejection_reason ?? null,
    evidenceIds: evidence.rows.map((row) => row.id),
    settledCalls: Number(calls.rows[0]?.count ?? '0'),
  };
}

/**
 * 等到某个后端**确实**卡在行锁上再放行屏障。
 *
 * 「先发起取消、再放行结算」不能只靠事件循环的先后：取消命令还要先拿连接、写回执，
 * 真正到达 `select ... for update` 的时刻不确定；若结算先提交，取消会按既有语义被
 * 409 拒绝（消息已完成），测到的就不是本用例要固定的提交顺序。这里用 `pg_stat_activity`
 * 观察真实的锁等待，把顺序钉死，而不是放宽断言。
 */
async function waitForRowLockWaiter(fragment: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ count: string }>`select count(*)::text as count
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ilike ${`%${fragment}%`}`.execute(app.db);
    if (Number(rows.rows[0]?.count ?? '0') > 0) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`no backend waited on a row lock for ${fragment} within ${timeoutMs}ms`);
}

/**
 * 可控模型：进入调用后挂起，等外部固定提交顺序，再返回 CONTENT 与一条学习增量。
 * 与探针一致：不响应 AbortSignal（模拟「迟到回答」），屏障由测试显式放行。
 */
function blockedContentPort(scenario: string): {
  readonly port: AssistModelPort;
  readonly started: Promise<void>;
  release(): void;
} {
  const identity = new FakeModelPort().identity;
  let started!: () => void;
  let release!: () => void;
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  const releaseGate = new Promise<void>((resolve) => { release = resolve; });
  const port: AssistModelPort = {
    identity,
    assist: async (): Promise<AssistResult> => {
      started();
      await releaseGate;
      return {
        kind: 'CONTENT',
        content: '迟到的教学回答',
        providerRequestId: `late-${scenario}`,
        usage: { ...EMPTY_USAGE, inputTokens: 1, outputTokens: 1 },
        learning: { increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '迟到探针',
          scenario, detail: '失权或取消的轮次不应再写入学习事实' }],
          schemaError: null },
      };
    },
  };
  return { port, started: startedGate, release };
}

async function learningFixture(): Promise<{ workspaceId: string; sessionId: string }> {
  const workspaceId = await createWorkspace(app.db);
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '迟到结算探针', conversationMode: 'LEARNING' });
  return { workspaceId, sessionId: session.result.session_id };
}

async function sendLearningMessage(workspaceId: string, sessionId: string, content: string) {
  return requestAssistMessage(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    content });
}

test('LM-08(R2)：失权 Worker 的迟到 CONTENT 不得写入学习证据', async () => {
  const fx = await learningFixture();
  const sent = await sendLearningMessage(fx.workspaceId, fx.sessionId, '讲讲幂等性。');
  const { port, started, release } = blockedContentPort('失权轮次');
  const pending = runAssistGenerationTick(app.db, {
    workerId: `late-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  await started;
  try {
    // 真实失效入口：同一短事务里把行改成过期并跑 failExpiredLeases，防止心跳在两步之间刷新。
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('assist_messages')
        .set({ updated_at: new Date(Date.now() - 600_000) })
        .where('id', '=', sent.result.assistant_message_id).execute();
      const failed = await createRepositories(tx).assist
        .failExpiredLeases(new Date(Date.now() - 60_000));
      assert.ok(failed.includes(sent.result.assistant_message_id), '消息必须已被真实清扫置 FAILED');
    });
  } finally {
    release();
  }
  const outcome = await pending;
  const facts = await readFacts(fx.workspaceId, sent.result.assistant_message_id);

  assert.equal(outcome?.status, 'DISCARDED', JSON.stringify(outcome));
  assert.equal(facts.messageStatus, 'FAILED');
  assert.equal(facts.messageError, 'LEASE_LOST');
  assert.equal(facts.evidenceIds.length, 0, '已失权并丢弃的学习轮次不能写入学习事实');
  assert.equal(facts.roundStatus, 'REJECTED', '失效轮次不长期留 PENDING');
  assert.equal(facts.roundReason, 'LEASE_LOST');
  assert.ok(facts.settledCalls >= 1, '每一次模型调用都必须留账本');
});

test('LM-13(R3)：持久取消先提交，迟到 CONTENT 不得写证据也不得冒充完成', async () => {
  const fx = await learningFixture();
  const sent = await sendLearningMessage(fx.workspaceId, fx.sessionId, '讲讲幂等性。');
  const { port, started, release } = blockedContentPort('取消轮次');
  const pending = runAssistGenerationTick(app.db, {
    workerId: `late-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    modelPort: port, leaseMs: 60_000, maxMessages: 1 });
  await started;
  try {
    const cancelled = await cancelAssistMessage(app.db, {
      workspaceId: fx.workspaceId, messageId: sent.result.assistant_message_id,
      commandId: randomUUID() });
    assert.equal(cancelled.result.status, 'RUNNING', '取消意图先持久化，消息仍在途由生成方结算');
  } finally {
    release();
  }
  const outcome = await pending;
  const facts = await readFacts(fx.workspaceId, sent.result.assistant_message_id);

  assert.equal(facts.cancelRequested, true);
  assert.equal(facts.evidenceIds.length, 0, '已持久化的停止意图不能被迟到的 CONTENT 绕过');
  assert.equal(facts.roundStatus, 'CANCELLED', '停止后未结算轮次显式收口');
  assert.equal(facts.roundReason, 'LEARNING_ROUND_CANCELLED');
  assert.equal(outcome?.status, 'CANCELLED', JSON.stringify(outcome));
  assert.equal(facts.messageStatus, 'CANCELLED', '停止意图生效后不能标成 COMPLETED');
});

test('LM-13(R3)：增量先合法提交、取消后到，先前事实不倒删且消息按停止收口', async () => {
  const fx = await learningFixture();
  const sent = await sendLearningMessage(fx.workspaceId, fx.sessionId,
    '幂等性靠命令 ID 做唯一约束，重试要带同一个 ID。\n' +
    'LEARNING: OBSERVE | 后端可靠性 | 幂等性 | 同 ID 异载荷 | 能指出同 ID 不同载荷必须拒绝');
  // 屏障固定在轮次 SETTLED 那一刻：增量已在本事务内提交（消息行仍被本事务持锁），
  // 取消命令排队等这把锁；放行后按 FIFO 先落取消，再跑正文结算。
  const originalSettle = LearningRepository.prototype.settleRound;
  let entered!: () => void;
  let release!: () => void;
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const releaseGate = new Promise<void>((resolve) => { release = resolve; });
  let roundId: string | undefined;
  LearningRepository.prototype.settleRound = async function (
    this: LearningRepository, id: string,
    status: 'SETTLED' | 'REJECTED' | 'CANCELLED', reason: string | null) {
    if (status === 'SETTLED') { roundId = id; entered(); await releaseGate; }
    return originalSettle.call(this, id, status, reason);
  };
  const pending = runAssistGenerationTick(app.db, {
    workerId: `late-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    modelPort: new FakeModelPort(), leaseMs: 60_000, maxMessages: 1 });
  try {
    await enteredGate;
    const cancelling = cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
      messageId: sent.result.assistant_message_id, commandId: randomUUID() });
    // 先确认取消确实卡在消息行的 `for update` 上，再放行结算：这样取消先提交、
    // 结算随后看到持久化的取消意图，两个反例的提交顺序才被真正固定。
    await waitForRowLockWaiter('assist_messages');
    release();
    const [outcome] = await Promise.all([pending, cancelling]);
    const facts = await readFacts(fx.workspaceId, sent.result.assistant_message_id);
    assert.ok(roundId !== undefined, '屏障必须命中本轮 SETTLED');
    assert.equal(facts.roundStatus, 'SETTLED', '先前合法提交的结算保持');
    assert.equal(facts.evidenceIds.length, 1, '先前合法提交的证据不倒删');
    assert.equal(facts.cancelRequested, true);
    assert.equal(facts.messageStatus, 'CANCELLED', '取消后到的消息按停止收口');
    assert.equal(outcome?.status, 'CANCELLED', JSON.stringify(outcome));
  } finally {
    release();
    LearningRepository.prototype.settleRound = originalSettle;
  }
});

test('LM-11(R2/R3)：迟到结算被拒后，新 Worker 的合法工作不受影响', async () => {
  const fx = await learningFixture();
  // 第一条：模型**在途时**用户取消（取消意图先持久化），迟到的生成整轮收口、零证据。
  // 取消必须落在 RUNNING 的消息上：PENDING 消息会被直接收敛成 CANCELLED，tick 领不到它，
  // 那样测不到「迟到 CONTENT 不得绕过停止意图」这一条。
  const first = await sendLearningMessage(fx.workspaceId, fx.sessionId, '讲讲幂等性。');
  const blocked = blockedContentPort('LM11取消轮次');
  const pending = runAssistGenerationTick(app.db, {
    workerId: `late-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    modelPort: blocked.port, leaseMs: 60_000, maxMessages: 1 });
  await blocked.started;
  try {
    await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
      messageId: first.result.assistant_message_id, commandId: randomUUID() });
  } finally {
    blocked.release();
  }
  const firstTick = await pending;
  const firstFacts = await readFacts(fx.workspaceId, first.result.assistant_message_id);
  assert.equal(firstTick?.status, 'CANCELLED', JSON.stringify(firstTick));
  assert.equal(firstFacts.roundStatus, 'CANCELLED');
  assert.equal(firstFacts.roundReason, 'LEARNING_ROUND_CANCELLED');
  assert.equal(firstFacts.evidenceIds.length, 0);

  // 第二条：同一会话里新 Worker 合法工作不受影响——正文、增量、轮次照常。
  const second = await sendLearningMessage(fx.workspaceId, fx.sessionId,
    'LEARNING: OBSERVE | 后端可靠性 | 幂等性 | 同 ID 异载荷 | 能指出同 ID 不同载荷必须拒绝');
  const secondTick = await runAssistGenerationTick(app.db, {
    workerId: `live-${randomUUID()}`, storage: new ManagedContentStore(dataRoot),
    modelPort: new FakeModelPort(), leaseMs: 60_000, maxMessages: 1 });
  assert.equal(secondTick?.status, 'COMPLETED', JSON.stringify(secondTick));
  const secondFacts = await readFacts(fx.workspaceId, second.result.assistant_message_id);
  assert.equal(secondFacts.messageStatus, 'COMPLETED');
  assert.equal(secondFacts.roundStatus, 'SETTLED');
  assert.equal(secondFacts.evidenceIds.length, 1, '失败结算不影响新 worker 合法工作');
  const counts = await sql<{ tasks: string; runs: string }>`select
    (select count(*)::text from tasks where workspace_id = ${fx.workspaceId}) as tasks,
    (select count(*)::text from runs where workspace_id = ${fx.workspaceId}) as runs`
    .execute(app.db);
  assert.equal(counts.rows[0]?.tasks, '0', '学习不建 Task');
  assert.equal(counts.rows[0]?.runs, '0', '学习不建 Run');
});

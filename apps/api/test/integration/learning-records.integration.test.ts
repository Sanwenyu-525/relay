import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import {
  beginLearningRound, clearLearningRecords, correctLearningRecord, deleteLearningEvidence,
  learningRecordEnabled,
  readLearningContinuation, readLearningRecords, readLearningRoundState, settleLearningRound,
  setLearningRecordControl,
} from '../../src/application/learning-records.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { LearningRepository } from '../../src/learning/learning-repository.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  createWorkspace, expectCommandAccepted, startTestApi, workspacePath, type TestApi,
} from './api-harness.js';
import {
  APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase,
} from './integration-support.js';

/**
 * 学习模式记录协议的真实 PG + 真实 HTTP 验收（0072 / ADR-020 / LM-05、06、08、13、14）。
 *
 * 这一套只验证**记录协议本身**：身份准入、证据性质可区分、幂等、清除与纠正的防复活、
 * 记录控制、并发收敛。教学轮次（同轮增量来自模型）与前端入口不在本套范围内。
 *
 * 每个用例使用独立 Workspace，避免计数断言互相污染。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-learning-records');

let api: TestApi;

before(async () => {
  await runMigrations({
    connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY,
  });
  api = await startTestApi();
});

after(async () => {
  await api?.stop();
  await app.close();
});

interface MessagePair {
  readonly session_id: string;
  readonly user_message_id: string;
  readonly assistant_message_id: string;
}

async function createSession(ws: string, mode: 'AGENT' | 'LEARNING' = 'LEARNING'): Promise<string> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, '/assist-sessions'), {
    command_id: commandId, title: '幂等性学习',
    ...(mode === 'AGENT' ? {} : { conversation_mode: mode }),
  });
  return expectCommandAccepted(response, 201, commandId).session_id as string;
}

async function sendMessage(ws: string, sessionId: string,
  recordLearning?: boolean, content?: string): Promise<MessagePair> {
  const commandId = randomUUID();
  const response = await api.post(workspacePath(ws, `/assist-sessions/${sessionId}/messages`), {
    command_id: commandId, content: content ?? '响应丢失为什么会造成重复提交？',
    ...(recordLearning === undefined ? {} : { record_learning: recordLearning }),
  });
  return expectCommandAccepted(response, 202, commandId) as unknown as MessagePair;
}

/** 在调用模型之前的 claim 事务内冻结本轮依据——测试直接调用同一应用函数。 */
async function beginRound(ws: string, sessionId: string, messageId: string):
  Promise<{ roundId: string; userMessageId: string; assistantMessageId: string }> {
  const repositories = createRepositories(app.db);
  const session = await repositories.assist.readSession(sessionId);
  const message = await repositories.assist.readMessage(messageId);
  assert.ok(session !== undefined && message !== undefined);
  const recordEnabled = await learningRecordEnabled(repositories, session, message);
  await beginLearningRound(app.db, { workspaceId: ws, sessionId, messageId, recordEnabled });
  const round = await repositories.learning.readRoundByMessage(messageId);
  assert.ok(round !== undefined, '轮次依据必须已建立');
  const userMessage = await repositories.assist.readMessageAtSeq(sessionId, message.seq - 1n);
  assert.ok(userMessage !== undefined, '本轮用户消息必须存在');
  return { roundId: round.id, userMessageId: userMessage.id, assistantMessageId: messageId };
}

/** 本轮真实输入上的合法依据引用：用户侧证据引用用户消息，讲解引用助手消息。 */
function userBasis(round: { userMessageId: string }): string {
  return round.userMessageId;
}

function assistantBasis(round: { assistantMessageId: string }): string {
  return round.assistantMessageId;
}

async function evidenceCount(ws: string): Promise<number> {
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from learning_evidence where workspace_id = ${ws}`.execute(app.db);
  return Number(rows.rows[0]?.count ?? '0');
}

async function taskAndRunCounts(ws: string): Promise<{ tasks: number; runs: number }> {
  const tasks = await sql<{ count: string }>`select count(*)::text as count
    from tasks where workspace_id = ${ws}`.execute(app.db);
  const runs = await sql<{ count: string }>`select count(*)::text as count
    from runs where workspace_id = ${ws}`.execute(app.db);
  return { tasks: Number(tasks.rows[0]?.count ?? '0'), runs: Number(runs.rows[0]?.count ?? '0') };
}

test('LM-C：页面重读控制与轮次，首次 CAS 开关可提交；跨工作空间和普通身份拒绝', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const statePath = workspacePath(ws, `/learning-sessions/${session}/state`);
  const initial = await api.get(statePath);
  assert.equal(initial.status, 200, initial.text);
  assert.deepEqual(initial.body, { session_id: session, records_enabled: true, revision: '0', rounds: [] });
  const pair = await sendMessage(ws, session);
  await beginRound(ws, session, pair.assistant_message_id);
  const controlId = randomUUID();
  const control = await api.post(workspacePath(ws, `/learning-sessions/${session}/record-control`),
    { command_id: controlId, records_enabled: false, expected_revision: '0' });
  expectCommandAccepted(control, 200, controlId);
  const persisted = await api.get(statePath);
  assert.equal(persisted.status, 200, persisted.text);
  const body = persisted.body as { records_enabled: boolean; revision: string;
    rounds: { message_id: string; status: string; rejection_reason: string }[] };
  assert.equal(body.records_enabled, false);
  assert.equal(body.revision, '1');
  assert.deepEqual(body.rounds.map((r) => [r.message_id, r.status, r.rejection_reason]),
    [[pair.assistant_message_id, 'CANCELLED', 'SESSION_CONTROL_CHANGED']]);
  const stale = await api.post(workspacePath(ws, `/learning-sessions/${session}/record-control`),
    { command_id: randomUUID(), records_enabled: true, expected_revision: '0' });
  assert.equal(stale.status, 409, stale.text);
  const otherWs = await createWorkspace(app.db);
  assert.equal((await api.get(workspacePath(otherWs, `/learning-sessions/${session}/state`))).status, 404);
  const agent = await createSession(ws, 'AGENT');
  assert.equal((await api.get(workspacePath(ws, `/learning-sessions/${agent}/state`))).status, 409);
  assert.deepEqual(await taskAndRunCounts(ws), { tasks: 0, runs: 0 });
});

test('LM-C：明确 UI 纠正无需伪造聊天依据，同命令重放只保存一次', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const pair = await sendMessage(ws, session);
  const round = await beginRound(ws, session, pair.assistant_message_id);
  await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(), roundId: round.roundId,
    increments: [{ op: 'EXPOSE', topic: '可靠性', concept: '幂等性', scenario: '响应丢失',
      detail: '讲解过重试', source_message_id: round.assistantMessageId }] });
  const concept = (await readLearningRecords(app.db, { workspaceId: ws })).concepts[0]!;
  const commandId = randomUUID();
  const body = { command_id: commandId, session_id: session, concept_id: concept.concept_id,
    scenario: '重复提交', detail: '上次其实没懂，需要重新讲解' };
  const response = await api.post(workspacePath(ws, '/learning-records/corrections'), body);
  expectCommandAccepted(response, 200, commandId);
  expectCommandAccepted(await api.post(workspacePath(ws, '/learning-records/corrections'), body), 200, commandId);
  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const correction = view.concepts[0]!.evidence.filter((e) => e.source_kind === 'USER_CONTROL');
  assert.equal(correction.length, 1);
  assert.equal(correction[0]!.kind, 'SELF_REPORT');
  assert.equal(correction[0]!.source_message_id, null);
  assert.equal(correction[0]!.detail, body.detail);
  const agent = await createSession(ws, 'AGENT');
  assert.equal((await api.post(workspacePath(ws, '/learning-records/corrections'),
    { ...body, command_id: randomUUID(), session_id: agent })).status, 409);
  const cleared = randomUUID();
  expectCommandAccepted(await api.post(workspacePath(ws, '/learning-records/clearances'),
    { command_id: cleared }), 200, cleared);
  expectCommandAccepted(await api.post(workspacePath(ws, '/learning-records/corrections'), body), 200, commandId);
  assert.equal(await evidenceCount(ws), 0, '旧成功回执不得复活已清学习记录');
});

test('LM-08：学习身份可建立；非学习会话不得维护学习记录；跨 Workspace 零写入', async () => {
  const ws = await createWorkspace(app.db);
  const learning = await createSession(ws, 'LEARNING');
  const agent = await createSession(ws, 'AGENT');

  const rejected = await api.post(workspacePath(ws,
    `/learning-sessions/${agent}/record-control`),
  { command_id: randomUUID(), records_enabled: false });
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal((rejected.body as { code?: string }).code, 'LEARNING_SESSION_REQUIRED');

  const otherWs = await createWorkspace(app.db);
  const cross = await api.get(workspacePath(otherWs, '/learning-records'));
  assert.equal(cross.status, 200, cross.text);
  assert.deepEqual((cross.body as { concepts: unknown[] }).concepts, []);
  const crossControl = await api.post(workspacePath(otherWs,
    `/learning-sessions/${learning}/record-control`),
  { command_id: randomUUID(), records_enabled: false });
  assert.equal(crossControl.status, 404, crossControl.text);
});

test('LM-05/06：接触、自述、表现、缺口分别落库；跳过不产生任何升级', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const first = await sendMessage(ws, session);
  const firstRound = await beginRound(ws, session, first.assistant_message_id);

  const settled = await settleLearningRound(app.db, {
    workspaceId: ws, commandId: randomUUID(), roundId: firstRound.roundId,
    increments: [
      { op: 'EXPOSE', topic: '后端可靠性', concept: '幂等性', scenario: '响应丢失重试',
        detail: '讲解了响应丢失为何需要幂等键',
        source_message_id: assistantBasis(firstRound) },
      { op: 'SELF_REPORT', topic: '后端可靠性', concept: '幂等性', scenario: '响应丢失重试',
        detail: '用户说理解了幂等键的作用',
        source_message_id: userBasis(firstRound) },
      { op: 'OBSERVE', topic: '后端可靠性', concept: '幂等性', scenario: '同 ID 异载荷',
        detail: '能指出同 ID 不同载荷必须拒绝并说明原因',
        source_message_id: userBasis(firstRound) },
      { op: 'GAP', topic: '后端可靠性', concept: '幂等键作用域', scenario: '跨任务重试',
        detail: '把幂等键作用域误当成整库唯一',
        source_message_id: userBasis(firstRound) },
    ],
  });
  assert.equal(settled.result.saved.length, 4, JSON.stringify(settled.result));

  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const byName = new Map(view.concepts.map((concept) => [concept.display_name, concept]));
  const idempotency = byName.get('幂等性');
  assert.ok(idempotency !== undefined, JSON.stringify(view.concepts));
  assert.deepEqual(idempotency.evidence.map((row) => row.kind).sort(),
    ['EXPOSURE', 'OBSERVED', 'SELF_REPORT']);
  // 讲解依据是本轮助手消息；用户侧证据依据是本轮用户消息（ADR-020 §5.3）。
  assert.equal(idempotency.evidence.find((row) => row.kind === 'EXPOSURE')
    ?.source_message_id, first.assistant_message_id);
  // 缺口标为待复核，而不是「不会」，也不显示掌握百分比。
  const scope = byName.get('幂等键作用域');
  assert.ok(scope !== undefined);
  assert.equal(scope.evidence.length, 1);
  assert.equal(scope.evidence[0]?.kind, 'GAP');
  assert.equal(scope.evidence[0]?.disposition, 'PENDING_REVIEW');
  assert.equal(scope.evidence[0]?.source_kind, 'LEARNING_MESSAGE');
  assert.equal(scope.evidence[0]?.source_message_id, first.user_message_id);

  const counts = await taskAndRunCounts(ws);
  assert.equal(counts.tasks, 0, '学习不建 Task');
  assert.equal(counts.runs, 0, '学习不建 Run');

  // 跳过 / 无实质回答：整轮没有增量，不产生任何证据，也不降级。
  // 跳过按应用的固定短语表识别（规范化后精确匹配，见 learning-records.ts 的 SKIP_REPLIES）：
  // 自由措辞不属于「只有跳过」这一被核定的场景。
  const second = await sendMessage(ws, session, undefined, '跳过这个问题。');
  const secondRound = await beginRound(ws, session, second.assistant_message_id);
  const skipped = await settleLearningRound(app.db, {
    workspaceId: ws, commandId: randomUUID(), roundId: secondRound.roundId, increments: [],
  });
  assert.deepEqual(skipped.result.saved, []);
  // 跳过轮次上伪造的用户侧增量同样被拒绝：没有真实输入就没有依据。
  // 用**另一轮**跳过作为触发点：一轮只能结算一次，已结算的轮次会先按
  // LEARNING_ROUND_UNAVAILABLE 收敛，测不到依据校验本身。
  const third = await sendMessage(ws, session, undefined, '先跳过。');
  const thirdRound = await beginRound(ws, session, third.assistant_message_id);
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: thirdRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '幂等性',
        scenario: '跳过之后', detail: '跳过不产生实际表现',
        source_message_id: userBasis(thirdRound) }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);
  const after = await readLearningRecords(app.db, { workspaceId: ws });
  const afterIdempotency = after.concepts.find((c) => c.display_name === '幂等性');
  assert.equal(afterIdempotency?.evidence.length, 3, '跳过不新增证据');
});

test('LM-12：同命令重放不重复增量；同 ID 异载荷拒绝；轮次只能结算一次', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const pair = await sendMessage(ws, session);
  const round = await beginRound(ws, session, pair.assistant_message_id);
  const commandId = randomUUID();
  const increments = [{ op: 'OBSERVE' as const, topic: '后端可靠性', concept: '重放幂等',
    scenario: '同命令重放', detail: '能说明同命令重放必须返回原回执',
    source_message_id: userBasis(round) }];

  const first = await settleLearningRound(app.db, { workspaceId: ws, commandId,
    roundId: round.roundId, increments });
  assert.equal(first.replayed, false);
  const replay = await settleLearningRound(app.db, { workspaceId: ws, commandId,
    roundId: round.roundId, increments });
  assert.equal(replay.replayed, true, '同 ID 同载荷返回原回执');
  assert.equal(replay.result.saved.length, first.result.saved.length);

  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId, roundId: round.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '重放幂等',
        scenario: '同命令重放', detail: '换了载荷', source_message_id: userBasis(round) }] }),
    /COMMAND_ID_REUSED|already used with a different payload/u);

  const rows = await sql<{ count: string }>`select count(*)::text as count from learning_evidence
    where workspace_id = ${ws} and concept_id in (select id from learning_concepts
      where workspace_id = ${ws} and display_name = '重放幂等')`.execute(app.db);
  assert.equal(Number(rows.rows[0]?.count ?? '0'), 1, '重放不产生第二条证据');

  // 另一个 command_id 再结算同一轮：轮次已结算，拒绝。
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: round.roundId, increments }),
    /LEARNING_ROUND_UNAVAILABLE/u);
});

test('LM-13/14：全清递增代次，在途旧轮次不复活记录；清除后新交互重新积累', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const pair = await sendMessage(ws, session);
  const staleRound = await beginRound(ws, session, pair.assistant_message_id);

  const clear = await clearLearningRecords(app.db, { workspaceId: ws, commandId: randomUUID() });
  assert.equal(clear.result.epoch, '1', JSON.stringify(clear.result));
  assert.equal(clear.result.cancelled_rounds, 1, '在途轮次被失活，但保留最小控制元数据');
  assert.equal((await readLearningRecords(app.db, { workspaceId: ws })).concepts.length, 0);

  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: staleRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '幂等性',
        scenario: '响应丢失重试', detail: '迟到的旧增量',
        source_message_id: userBasis(staleRound) }] }),
    /LEARNING_ROUND_STALE/u);
  assert.equal(await evidenceCount(ws), 0, '迟到旧轮次不复活已清记录');

  const fresh = await sendMessage(ws, session);
  const freshRound = await beginRound(ws, session, fresh.assistant_message_id);
  const settled = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: freshRound.roundId,
    increments: [{ op: 'EXPOSE', topic: '后端可靠性', concept: '幂等性',
      scenario: '响应丢失重试', detail: '清除后重新讲了一遍',
      source_message_id: assistantBasis(freshRound) }] });
  assert.equal(settled.result.saved.length, 1);
  assert.equal(settled.result.epoch, '1', '新轮次落在新代次上');
  const view = await readLearningRecords(app.db, { workspaceId: ws });
  assert.equal(view.concepts.length, 1);
  assert.equal(view.concepts[0]?.evidence.length, 1, '只从新交互积累');
});

test('LM-14：单项删除递增概念代次，冻结在旧代次上的在途轮次不得写入', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const pair = await sendMessage(ws, session);
  const round = await beginRound(ws, session, pair.assistant_message_id);
  const settled = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: round.roundId,
    increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '单项删除目标',
      scenario: '删除场景', detail: '先建立一条表现证据',
      source_message_id: userBasis(round) }] });
  const evidenceId = settled.result.saved[0]?.evidence_id;
  assert.ok(evidenceId !== undefined);

  // 在途轮次冻结在删除前的代次上。
  const later = await sendMessage(ws, session);
  const laterRound = await beginRound(ws, session, later.assistant_message_id);

  const deleted = await deleteLearningEvidence(app.db, { workspaceId: ws,
    commandId: randomUUID(), evidenceId });
  assert.equal(deleted.result.deleted, true);
  assert.equal(deleted.result.generation, '1', '单项删除递增概念代次');

  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: laterRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '单项删除目标',
        scenario: '删除场景', detail: '删除之后才到的旧表现',
        source_message_id: userBasis(laterRound) }] }),
    /LEARNING_ROUND_STALE/u);

  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const concept = view.concepts.find((c) => c.display_name === '单项删除目标');
  assert.equal(concept?.evidence.length, 0, '删除后旧轮次不得复活该证据');

  // 概念行的代次在整表基线和逐条冻结里都出现：删除后重建同名知识点也按同一代次边界收敛。
  const replacement = await sendMessage(ws, session);
  const replacementRound = await beginRound(ws, session, replacement.assistant_message_id);
  const resettled = await settleLearningRound(app.db, { workspaceId: ws,
    commandId: randomUUID(), roundId: replacementRound.roundId,
    increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '单项删除目标',
      scenario: '删除场景', detail: '删除后重新积累的新表现',
      source_message_id: userBasis(replacementRound) }] });
  assert.equal(resettled.result.saved.length, 1);
  const rebuilt = await readLearningRecords(app.db, { workspaceId: ws });
  const rebuiltConcept = rebuilt.concepts.find((c) => c.display_name === '单项删除目标');
  assert.equal(rebuiltConcept?.evidence.length, 1, '新轮次在新代次上合法积累');
});

test('LM-13：消息级与会话级「本次不记录」由应用校验，模型返回增量也不写', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const repositories = createRepositories(app.db);

  // 消息级：发送时就关闭本轮记录。
  const pair = await sendMessage(ws, session, false);
  const message = await repositories.assist.readMessage(pair.assistant_message_id);
  assert.equal(message?.learning_record_disabled, true, '关闭记录随发送命令持久');
  const round = await beginRound(ws, session, pair.assistant_message_id);
  const roundRow = await repositories.learning.readRoundByMessage(pair.assistant_message_id);
  assert.equal(roundRow?.record_enabled, false, '轮次依据冻结了关闭状态');
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: round.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '不记录目标',
        scenario: '关闭记录', detail: '这一条不应被写入',
        source_message_id: userBasis(round) }] }),
    /LEARNING_RECORD_DISABLED/u);
  assert.equal(await evidenceCount(ws), 0);

  // 会话级：关闭后续记录。
  const control = await setLearningRecordControl(app.db, { workspaceId: ws, commandId: randomUUID(),
    sessionId: session, recordsEnabled: false });
  assert.equal(control.result.records_enabled, false);
  const next = await sendMessage(ws, session);
  const nextRound = await beginRound(ws, session, next.assistant_message_id);
  const nextRow = await repositories.learning.readRoundByMessage(next.assistant_message_id);
  assert.equal(nextRow?.record_enabled, false, '会话级关闭影响后续轮次');
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: nextRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '不记录目标',
        scenario: '会话级关闭', detail: '这一条也不应被写入',
        source_message_id: userBasis(nextRound) }] }),
    /LEARNING_RECORD_DISABLED/u);
  assert.equal(await evidenceCount(ws), 0);

  // 重新开启后才恢复记录。
  await setLearningRecordControl(app.db, { workspaceId: ws, commandId: randomUUID(),
    sessionId: session, recordsEnabled: true });
  const reopened = await sendMessage(ws, session);
  const reopenedRound = await beginRound(ws, session, reopened.assistant_message_id);
  const reopenedRow = await repositories.learning.readRoundByMessage(reopened.assistant_message_id);
  assert.equal(reopenedRow?.record_enabled, true);
  const settled = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: reopenedRound.roundId,
    increments: [{ op: 'EXPOSE', topic: '后端可靠性', concept: '不记录目标',
      scenario: '重新开启', detail: '重新开启后照常记录',
      source_message_id: assistantBasis(reopenedRound) }] });
  assert.equal(settled.result.saved.length, 1);
});

test('LM-14：并发结算同一轮只有一个赢家；返回接续只读当前记录', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const pair = await sendMessage(ws, session);
  const round = await beginRound(ws, session, pair.assistant_message_id);
  const increments = [{ op: 'GAP' as const, topic: '前端状态', concept: '三态分发',
    scenario: '加载失败', detail: '把接口失败当成空数据',
    source_message_id: userBasis(round) }];

  const results = await Promise.allSettled([
    settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: round.roundId, increments }),
    settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: round.roundId, increments }),
  ]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1,
    '并发结算只有一个赢家');

  const continuation = await readLearningContinuation(app.db, { workspaceId: ws, sessionId: session });
  assert.equal(continuation.session_id, session);
  assert.equal(continuation.goal, '幂等性学习');
  assert.ok(continuation.open_items.length >= 1, JSON.stringify(continuation));
  assert.ok(continuation.open_items.every((item) => item.disposition === 'PENDING_REVIEW'),
    JSON.stringify(continuation.open_items));

  const counts = await taskAndRunCounts(ws);
  assert.equal(counts.tasks, 0);
  assert.equal(counts.runs, 0);
});

// ── 独立验收反例转正式回归（2026-10-11 整改：R4/R5/R6/R7/R8） ──────────────────

test('LM-14(R4)：删除后旧轮次不得复活既有知识点，即使它不在证据最近 20 条内', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const first = await sendMessage(ws, session);
  const firstRound = await beginRound(ws, session, first.assistant_message_id);
  const established = await settleLearningRound(app.db, { workspaceId: ws,
    commandId: randomUUID(), roundId: firstRound.roundId,
    increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '早期概念', scenario: '建立',
      detail: '先建立一条表现证据', source_message_id: userBasis(firstRound) }] });
  const evidenceId = established.result.saved[0]?.evidence_id;
  const conceptId = established.result.saved[0]?.concept_id;
  assert.ok(evidenceId !== undefined && conceptId !== undefined);

  // 之后多轮把更近的证据堆到其他知识点上，让「早期概念」远远落在任何「最近 20 条」
  // 窗口之外——整改前旧轮次因此不冻结它的代次，删除后照样复活。
  for (let roundIndex = 0; roundIndex < 2; roundIndex += 1) {
    const message = await sendMessage(ws, session);
    const round = await beginRound(ws, session, message.assistant_message_id);
    const settled = await settleLearningRound(app.db, { workspaceId: ws,
      commandId: randomUUID(), roundId: round.roundId,
      increments: Array.from({ length: 12 }, (_, index) => ({
        op: 'EXPOSE' as const, topic: '后端可靠性', concept: `近期概念-${roundIndex}-${index}`,
        scenario: `近期-${roundIndex}-${index}`, detail: '与早期概念无关的更近证据',
        source_message_id: assistantBasis(round) })) });
    assert.equal(settled.result.saved.length, 12);
  }

  const late = await sendMessage(ws, session);
  const lateRound = await beginRound(ws, session, late.assistant_message_id);
  const frozen = await createRepositories(app.db).learning.readRound(lateRound.roundId);
  assert.ok(frozen !== undefined);
  assert.equal(frozen.concept_generations[conceptId!], '0',
    '适用基线覆盖全部既有知识点，不只证据最近 20 条涉及的那些');

  await deleteLearningEvidence(app.db, { workspaceId: ws, commandId: randomUUID(), evidenceId });
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: lateRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '早期概念', scenario: '迟到',
        detail: '删除之后才到的旧表现', source_message_id: userBasis(lateRound) }] }),
    /LEARNING_ROUND_STALE/u);

  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const concept = view.concepts.find((entry) => entry.concept_id === conceptId);
  assert.equal(concept?.evidence.length, 0, '删除后的知识点不能被旧轮次复活');
  assert.equal(concept?.generation, '1', '人工删除推进的代次被保留');
});

test('LM-15(R5)：已解除的 GAP 不再进入接续未决项与教学上下文，历史仍可核对', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const first = await sendMessage(ws, session);
  const firstRound = await beginRound(ws, session, first.assistant_message_id);
  const gap = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: firstRound.roundId,
    increments: [{ op: 'GAP', topic: '后端可靠性', concept: '缺口概念', scenario: '待复核',
      detail: '把幂等键作用域误当成整库唯一', source_message_id: userBasis(firstRound) }] });
  assert.equal(gap.result.saved.length, 1);

  // 解除之前：接续与教学上下文都把待复核缺口列为未决。
  const beforeContinuation = await readLearningContinuation(app.db, { workspaceId: ws,
    sessionId: session });
  assert.equal(beforeContinuation.open_items.length, 1);
  const beforeContext = await readLearningRoundState(app.db, { workspaceId: ws, sessionId: session });
  assert.equal((beforeContext.open_items as unknown[]).length, 1);

  // 用户解除待复核：RESOLVE_REVIEW 只改处置状态，不删除历史证据。
  const resolve = await sendMessage(ws, session);
  const resolveRound = await beginRound(ws, session, resolve.assistant_message_id);
  const resolved = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: resolveRound.roundId,
    increments: [{ op: 'RESOLVE_REVIEW', topic: '后端可靠性', concept: '缺口概念',
      scenario: '已澄清', detail: '用户说明幂等键按命令作用域唯一',
      source_message_id: userBasis(resolveRound) }] });
  assert.deepEqual(resolved.result.saved, []);

  const continuation = await readLearningContinuation(app.db, { workspaceId: ws, sessionId: session });
  assert.equal(continuation.open_items.length, 0, '已解除的待复核缺口不能继续列为未决');
  const context = await readLearningRoundState(app.db, { workspaceId: ws, sessionId: session });
  assert.equal((context.open_items as unknown[]).length, 0,
    '下一轮教学不能把已解除缺口当成未决事实');
  const recent = context.recent as { disposition: string; kind: string }[];
  assert.ok(recent.some((entry) => entry.kind === 'GAP' && entry.disposition === 'SUPERSEDED'),
    '历史仍保留可核对的 GAP 与解除结果');

  // 真正待复核的新缺口继续可见。
  const pending = await sendMessage(ws, session);
  const pendingRound = await beginRound(ws, session, pending.assistant_message_id);
  await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: pendingRound.roundId,
    increments: [{ op: 'GAP', topic: '后端可靠性', concept: '真缺口', scenario: '仍待复核',
      detail: '把重试与重复提交混为一谈', source_message_id: userBasis(pendingRound) }] });
  const after = await readLearningContinuation(app.db, { workspaceId: ws, sessionId: session });
  assert.equal(after.open_items.length, 1, '真正待复核项继续可见');
  assert.equal(after.open_items[0]?.disposition, 'PENDING_REVIEW');
});

test('LM-13(R6)：清除与结算并发时旧 epoch 证据不残留为当前内容', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  // 屏障让全清停在 epoch 推进那一刻（扫描/删除与它在同一未提交事务内）。
  const originalBump = LearningRepository.prototype.bumpEpoch;
  let entered!: () => void;
  let release!: () => void;
  const enteredGate = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  const releaseGate = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  LearningRepository.prototype.bumpEpoch = async function (
    this: LearningRepository, workspaceId: string, clearCommandId: string) {
    if (workspaceId === ws) { entered(); await releaseGate; }
    return originalBump.call(this, workspaceId, clearCommandId);
  };
  const clearing = clearLearningRecords(app.db, { workspaceId: ws, commandId: randomUUID() });
  const clearingFailure = clearing.then(() => undefined, (error: unknown) => error);
  try {
    await enteredGate;
    // 旧轮次在全清提交前冻结 epoch 0 并尝试结算。
    const pair = await sendMessage(ws, session);
    const round = await beginRound(ws, session, pair.assistant_message_id);
    const settlement = settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: round.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '清除窗口概念',
        scenario: '清除扫描之后', detail: '清除进行中的旧 epoch 增量',
        source_message_id: userBasis(round) }] }).then(() => undefined, (error: unknown) => error);
    release();
    const [settled, clearFailure] = await Promise.all([settlement, clearingFailure]);
    const cleared = await clearing;
    assert.equal(clearFailure, undefined, `全清不应失败：${String(clearFailure)}`);
    assert.equal(cleared.result.epoch, '1');
    assert.match(String((settled as Error)?.message ?? settled),
      /LEARNING_ROUND_(STALE|UNAVAILABLE)/u, '旧 epoch 结算必须被拒绝');

    const view = await readLearningRecords(app.db, { workspaceId: ws });
    assert.equal(view.epoch, '1');
    assert.equal(view.concepts.length, 0, '成功全清后不能残留旧 epoch 的证据');
    const rows = await sql<{ count: string }>`select count(*)::text as count
      from learning_evidence where workspace_id = ${ws}`.execute(app.db);
    assert.equal(Number(rows.rows[0]?.count ?? '0'), 0, '数据库里不能留下旧 epoch 学习证据');

    // epoch 1 下合法新 round 照常保存。
    const fresh = await sendMessage(ws, session);
    const freshRound = await beginRound(ws, session, fresh.assistant_message_id);
    const resettled = await settleLearningRound(app.db, { workspaceId: ws,
      commandId: randomUUID(), roundId: freshRound.roundId,
      increments: [{ op: 'EXPOSE', topic: '后端可靠性', concept: '清除后重学',
        scenario: '重新开始', detail: '新 epoch 下的合法教学',
        source_message_id: assistantBasis(freshRound) }] });
    assert.equal(resettled.result.epoch, '1');
    assert.equal(resettled.result.saved.length, 1);
  } finally {
    release();
    LearningRepository.prototype.bumpEpoch = originalBump;
    await clearing.catch(() => undefined);
  }
});

test('LM-14(R7)：generation 校验后人工纠正先提交，旧轮次不得越过校验继续写', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const first = await sendMessage(ws, session);
  const firstRound = await beginRound(ws, session, first.assistant_message_id);
  const initial = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: firstRound.roundId,
    increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '纠正竞态概念',
      scenario: '原始依据', detail: '先建立一条表现证据', source_message_id: userBasis(firstRound) }] });
  const conceptId = initial.result.saved[0]!.concept_id;

  const old = await sendMessage(ws, session);
  const oldRound = await beginRound(ws, session, old.assistant_message_id);
  // 屏障：旧轮次走到证据写入那一刻后暂停；人工纠正在此期间先提交，再放行写入。
  const originalInsert = LearningRepository.prototype.insertEvidence;
  let entered!: () => void;
  let release!: () => void;
  const enteredGate = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
  const releaseGate = new Promise<void>((resolveRelease) => { release = resolveRelease; });
  LearningRepository.prototype.insertEvidence = async function (
    this: LearningRepository,
    input: Parameters<LearningRepository['insertEvidence']>[0]) {
    if (input.workspaceId === ws && input.detail === 'OLD_ROUND_EVIDENCE') {
      entered();
      await releaseGate;
    }
    return originalInsert.call(this, input);
  };
  const oldSettlement = settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: oldRound.roundId,
    increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '纠正竞态概念',
      scenario: '竞态探针', detail: 'OLD_ROUND_EVIDENCE', source_message_id: userBasis(oldRound) }] })
    .then(() => undefined, (error: unknown) => error);
  try {
    await enteredGate;
    const correction = await sendMessage(ws, session);
    await correctLearningRecord(app.db, { workspaceId: ws, commandId: randomUUID(),
      sessionId: session, sourceMessageId: correction.user_message_id, conceptId,
      scenario: '明确纠正', detail: '人工纠正先提交' });
  } finally {
    release();
    LearningRepository.prototype.insertEvidence = originalInsert;
  }
  const failure = await oldSettlement;
  assert.match(String((failure as Error)?.message ?? failure), /LEARNING_ROUND_STALE/u,
    '校验之后发生的人工提交必须让旧轮次类型化失败');

  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const concept = view.concepts.find((entry) => entry.concept_id === conceptId);
  assert.ok(concept !== undefined);
  assert.equal(concept.evidence.some((entry) => entry.detail === 'OLD_ROUND_EVIDENCE'), false,
    '人工纠正已提交之后，旧轮次不能继续写入');
  assert.equal(concept.generation, '1', '人工纠正推进的代次被保留');
  assert.ok(concept.evidence.some((entry) => entry.detail === '人工纠正先提交'),
    '人工纠正的自述与命令回执保持');
});

test('LM-09(R8)：依据绑定拒绝伪造证据，合法真实回答照常保存', async () => {
  const ws = await createWorkspace(app.db);
  const session = await createSession(ws);
  const first = await sendMessage(ws, session);
  const firstRound = await beginRound(ws, session, first.assistant_message_id);
  const roundId = firstRound.roundId;

  // ① 跳过轮次伪造表现：本轮用户只有「跳过」，原反例，必须零新增。
  const skipped = await sendMessage(ws, session, undefined, '跳过');
  const skippedRound = await beginRound(ws, session, skipped.assistant_message_id);
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: skippedRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '伪造表现',
        scenario: '跳过', detail: '用户已经完整回答并解释了幂等性',
        source_message_id: userBasis(skippedRound) }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);

  // ② 缺引用字段 / 引用不存在的消息 / 跨会话消息：一律拒绝。
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(), roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '无依据', scenario: '缺引用',
        detail: '没有给出依据引用', source_message_id: '' }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(), roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '无依据', scenario: '引用失效',
        detail: '引用一条不存在的消息', source_message_id: randomUUID() }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);
  const otherSession = await createSession(ws);
  const otherPair = await sendMessage(ws, otherSession);
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(), roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '无依据', scenario: '跨会话',
        detail: '引用别的会话的消息', source_message_id: otherPair.user_message_id }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);

  // ③ 讲解被冒充表现：依据落在本轮助手消息上。
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(), roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '冒充表现', scenario: '性质不符',
        detail: '拿教学正文当用户表现', source_message_id: assistantBasis(firstRound) }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);

  // ④ 自述被冒充验证：本轮用户只说「我懂了」，不能记为实际表现；自述本身合法。
  const selfReport = await sendMessage(ws, session, undefined, '我懂了。');
  const selfReportRound = await beginRound(ws, session, selfReport.assistant_message_id);
  await assert.rejects(
    () => settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
      roundId: selfReportRound.roundId,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '冒充验证',
        scenario: '自述当验证', detail: '用户已验证掌握幂等性',
        source_message_id: userBasis(selfReportRound) }] }),
    /LEARNING_EVIDENCE_REF_INVALID/u);
  const reportSettled = await settleLearningRound(app.db, { workspaceId: ws,
    commandId: randomUUID(), roundId: selfReportRound.roundId,
    increments: [{ op: 'SELF_REPORT', topic: '后端可靠性', concept: '自述理解',
      scenario: '用户自述', detail: '用户表示理解了幂等键的作用',
      source_message_id: userBasis(selfReportRound) }] });
  assert.equal(reportSettled.result.saved.length, 1, '合法自述照常保存');

  // ⑤ 正向：本轮真实回答 + 合法引用 → 表现与缺口分别落库，依据指向用户消息。
  const answer = await sendMessage(ws, session, undefined,
    '幂等性靠命令 ID 做唯一约束，重试要带同一个 ID，否则会重复提交。');
  const answerRound = await beginRound(ws, session, answer.assistant_message_id);
  const settled = await settleLearningRound(app.db, { workspaceId: ws, commandId: randomUUID(),
    roundId: answerRound.roundId,
    increments: [
      { op: 'OBSERVE', topic: '后端可靠性', concept: '幂等性', scenario: '回答重试语义',
        detail: '能说出命令 ID 唯一约束与重试携带同一个 ID',
        source_message_id: userBasis(answerRound) },
      { op: 'GAP', topic: '后端可靠性', concept: '超时与重试边界', scenario: '跨天重放',
        detail: '没考虑唯一键过期后的重复提交', source_message_id: userBasis(answerRound) },
    ] });
  assert.equal(settled.result.saved.length, 2, JSON.stringify(settled.result));
  const view = await readLearningRecords(app.db, { workspaceId: ws });
  const observed = view.concepts.find((entry) => entry.display_name === '幂等性');
  assert.ok(observed !== undefined);
  assert.equal(observed.evidence.find((entry) => entry.kind === 'OBSERVED')?.source_message_id,
    answer.user_message_id, '表现证据的依据是本轮用户消息');
  const gapConcept = view.concepts.find((entry) => entry.display_name === '超时与重试边界');
  assert.equal(gapConcept?.evidence[0]?.disposition, 'PENDING_REVIEW');

  // 负向注入全部零新增：总共只应保存自述 1 + 表现 1 + 缺口 1。
  const all = await readLearningRecords(app.db, { workspaceId: ws });
  const total = all.concepts.reduce((sum, entry) => sum + entry.evidence.length, 0);
  assert.equal(total, 3, `只应保存自述 1 + 表现 1 + 缺口 1，实际 ${total}`);
});

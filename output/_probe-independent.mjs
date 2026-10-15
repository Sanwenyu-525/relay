// 独立复验探针（2026-10-12 整改 R1/R2/R3/R8）。
//
// 与正式套件分开：这是修复后由当前 Agent 独立操作的一次关键反例复验，直接读 PG/HTTP
// 事实（消息行、轮次行、证据行、HTTP 状态码），不只读测试汇总。它复用真实 Owner、
// 真实角色、真实事务与唯一约束，不绕开任何领域入口。
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAssistSession, cancelAssistMessage, requestAssistMessage }
  from '../apps/api/dist/src/application/assist-commands.js';
import { runAssistGenerationTick } from '../apps/api/dist/src/application/assist-runner.js';
import { beginLearningRound, readLearningRecords, settleLearningRound }
  from '../apps/api/dist/src/application/learning-records.js';
import { createRepositories } from '../apps/api/dist/src/application/unit-of-work.js';
import { runMigrations } from '../apps/api/dist/src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../apps/api/dist/src/storage/managed-content-store.js';
import { FakeModelPort } from '../apps/api/dist/src/workflow/fake-model-port.js';
import { createWorkspace, startTestApi, workspacePath }
  from '../apps/api/dist/test/integration/api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from '../apps/api/dist/test/integration/integration-support.js';

const app = openDatabase(APP_DATABASE_URL, 'relay-independent-remediation-20261012');
const report = { facts: [], verdicts: [] };
const record = (name, data) => report.facts.push({ name, ...data });
const verdict = (name, ok, detail) => report.verdicts.push({ name, ok, detail });

await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
const api = await startTestApi();
const dataRoot = await mkdtemp(join(tmpdir(), 'relay-independent-remediation-'));

function blockedContentPort(scenario) {
  const identity = new FakeModelPort().identity;
  let started; let release;
  const startedGate = new Promise((resolve) => { started = resolve; });
  const releaseGate = new Promise((resolve) => { release = resolve; });
  return {
    port: { identity, assist: async () => {
      started();
      await releaseGate;
      return { kind: 'CONTENT', content: '迟到的教学回答', providerRequestId: `ind-${scenario}`,
        usage: { inputTokens: 1, outputTokens: 1 },
        learning: { increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '迟到探针',
          scenario, detail: '失权或取消的轮次不应再写入学习事实' }], schemaError: null } };
    } },
    started: startedGate, release,
  };
}

async function learningFixture() {
  const workspaceId = await createWorkspace(app.db);
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    title: '独立复验探针', conversationMode: 'LEARNING' });
  return { workspaceId, sessionId: session.result.session_id };
}

// ── R1：显式 Skill 身份决定入口 ────────────────────────────────────────────────
{
  const workspaceId = await createWorkspace(app.db);
  const projectId = randomUUID();
  const project = await api.post(`${workspacePath(workspaceId)}/projects`, {
    command_id: projectId, title: 'R1 独立复验项目', project_type: 'DEVELOPMENT' });
  const created = project.body?.result?.project_id;
  const session = await createAssistSession(app.db, { workspaceId, commandId: randomUUID(),
    projectId: created, title: 'R1 独立复验' });
  const commandId = randomUUID();
  const sent = await api.post(
    `${workspacePath(workspaceId)}/assist-sessions/${session.result.session_id}/messages`, {
      command_id: commandId, content: '请审查这个项目的当前状态',
      skill_ref: { id: 'project-resume', version: '1.0.0' } });
  const rows = await app.db.selectFrom('assist_messages')
    .select(['role', 'skill_snapshot', 'method_snapshot', 'method_action', 'method_argument'])
    .where('session_id', '=', session.result.session_id).execute();
  const assistant = rows.find((row) => row.role === 'ASSISTANT');
  const skillFrozen = assistant !== undefined && assistant.skill_snapshot !== null;
  const methodFrozen = assistant !== undefined && assistant.method_snapshot !== null;
  record('R1-explicit-skill', { httpStatus: sent.status, bodyCode: sent.body?.code ?? null,
    assistantRows: rows.filter((row) => row.role === 'ASSISTANT').length,
    skillFrozen, methodFrozen,
    methodAction: assistant?.method_action ?? null, methodArgument: assistant?.method_argument ?? null });
  verdict('R1', sent.status === 202 && skillFrozen && !methodFrozen,
    `HTTP ${sent.status} skill=${skillFrozen} method=${methodFrozen}`);
  // 消费这条 PENDING 消息：tick 领取的是全库最旧的 PENDING，遗留会让后续场景错位。
  const consumed = await runAssistGenerationTick(app.db, { workerId: `ind-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: new FakeModelPort(),
    leaseMs: 30_000, maxMessages: 1 });
  if (consumed?.messageId !== sent.body?.result?.assistant_message_id) {
    throw new Error(`R1 consumption tick claimed ${consumed?.messageId}`);
  }
}

// ── R2：失权 Worker 的迟到结算 ─────────────────────────────────────────────────
{
  const fx = await learningFixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '讲讲幂等性。' });
  const blocked = blockedContentPort('失权轮次');
  const pending = runAssistGenerationTick(app.db, { workerId: `ind-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: blocked.port,
    leaseMs: 60_000, maxMessages: 1 });
  await blocked.started;
  try {
    await app.db.transaction().execute(async (tx) => {
      await tx.updateTable('assist_messages')
        .set({ updated_at: new Date(Date.now() - 600_000) })
        .where('id', '=', sent.result.assistant_message_id).execute();
      const failed = await createRepositories(tx).assist
        .failExpiredLeases(new Date(Date.now() - 60_000));
      if (!failed.includes(sent.result.assistant_message_id)) throw new Error('lease not expired');
    });
  } finally { blocked.release(); }
  const outcome = await pending;
  if (outcome?.messageId !== sent.result.assistant_message_id) {
    throw new Error(`R2 tick claimed ${outcome?.messageId} instead of the probe message`);
  }
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  const round = await repositories.learning.readRoundByMessage(sent.result.assistant_message_id);
  const evidence = await app.db.selectFrom('learning_evidence').selectAll()
    .where('workspace_id', '=', fx.workspaceId).execute();
  record('R2-expired-worker', { outcome: outcome?.status, messageStatus: message?.status,
    messageError: message?.error_code, roundStatus: round?.status,
    roundReason: round?.rejection_reason, evidenceRows: evidence.length });
  verdict('R2', outcome?.status === 'DISCARDED' && message?.status === 'FAILED' &&
    message?.error_code === 'LEASE_LOST' && evidence.length === 0 &&
    round?.status === 'REJECTED' && round?.rejection_reason === 'LEASE_LOST',
  `outcome=${outcome?.status} message=${message?.status}/${message?.error_code} round=${round?.status}/${round?.rejection_reason} evidence=${evidence.length}`);
}

// ── R3：持久取消阻断迟到 CONTENT ───────────────────────────────────────────────
{
  const fx = await learningFixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '讲讲幂等性。' });
  const blocked = blockedContentPort('取消轮次');
  const pending = runAssistGenerationTick(app.db, { workerId: `ind-${randomUUID()}`,
    storage: new ManagedContentStore(dataRoot), modelPort: blocked.port,
    leaseMs: 60_000, maxMessages: 1 });
  await blocked.started;
  try {
    await cancelAssistMessage(app.db, { workspaceId: fx.workspaceId,
      messageId: sent.result.assistant_message_id, commandId: randomUUID() });
  } finally { blocked.release(); }
  const outcome = await pending;
  if (outcome?.messageId !== sent.result.assistant_message_id) {
    throw new Error(`R3 tick claimed ${outcome?.messageId} instead of the probe message`);
  }
  const repositories = createRepositories(app.db);
  const message = await repositories.assist.readMessage(sent.result.assistant_message_id);
  const round = await repositories.learning.readRoundByMessage(sent.result.assistant_message_id);
  const evidence = await app.db.selectFrom('learning_evidence').selectAll()
    .where('workspace_id', '=', fx.workspaceId).execute();
  record('R3-durable-cancel', { outcome: outcome?.status, messageStatus: message?.status,
    cancelRequested: message?.cancel_requested, roundStatus: round?.status,
    roundReason: round?.rejection_reason, evidenceRows: evidence.length });
  verdict('R3', message?.cancel_requested === true && evidence.length === 0 &&
    message?.status === 'CANCELLED' && outcome?.status === 'CANCELLED',
  `message=${message?.status} cancel=${message?.cancel_requested} outcome=${outcome?.status} evidence=${evidence.length}`);
}

// ── R8：无可信依据不得写「实际表现」 ───────────────────────────────────────────
{
  const fx = await learningFixture();
  const sent = await requestAssistMessage(app.db, { workspaceId: fx.workspaceId,
    sessionId: fx.sessionId, commandId: randomUUID(), content: '跳过' });
  await beginLearningRound(app.db, { workspaceId: fx.workspaceId, sessionId: fx.sessionId,
    messageId: sent.result.assistant_message_id, recordEnabled: true });
  const round = await createRepositories(app.db).learning
    .readRoundByMessage(sent.result.assistant_message_id);
  let errorCode = null; let saved = null;
  try {
    const settled = await settleLearningRound(app.db, { workspaceId: fx.workspaceId,
      commandId: randomUUID(), roundId: round.id,
      increments: [{ op: 'OBSERVE', topic: '后端可靠性', concept: '伪造表现',
        scenario: '跳过', detail: '用户已经完整回答并解释了幂等性',
        source_message_id: sent.result.user_message_id }] });
    saved = settled.result.saved.length;
  } catch (error) { errorCode = error?.code ?? String(error?.message); }
  const view = await readLearningRecords(app.db, { workspaceId: fx.workspaceId });
  record('R8-unreferenced-observed', { errorCode, saved, concepts: view.concepts.length,
    evidenceRows: view.concepts.reduce((total, c) => total + c.evidence.length, 0) });
  verdict('R8', errorCode === 'LEARNING_EVIDENCE_REF_INVALID' && view.concepts.length === 0,
    `error=${errorCode} concepts=${view.concepts.length}`);
}

await api.stop();
await app.close();
await rm(dataRoot, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`ALL_PASS=${report.verdicts.every((v) => v.ok)}\n`);

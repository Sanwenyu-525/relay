import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { AssistRepository } from '../../src/assist/assist-repository.js';

import { acceptAssistProposal, cancelAssistMessage, createAssistSession,
  rejectAssistProposal, requestAssistMessage, assistPayloadHash }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { loadSkillBasis } from '../../src/skills/skill-basis.js';
import { FIRST_PARTY_REGISTRY, frozenSkillSnapshot } from '../../src/skills/first-party-registry.js';
import { canonicalizeJson } from '../../src/receipt/payload-hash.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { createKnowledge } from '../../src/application/information-commands.js';
import { editTaskPresentation } from '../../src/application/task-commands.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { reviewTargetHash } from '../../src/application/review-requests.js';
import { readTaskCheckPlanPreview } from '../../src/application/check-plan-preview.js';
import { DomainError } from '../../src/application/domain-error.js';
import { recordModelInvocation } from '../../src/application/model-call-recorder.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { FakeModelPort, type AssistModelPort } from '../../src/workflow/fake-model-port.js';
import { ModelCallBudgetError } from '../../src/workflow/openai-compatible-model-port.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { createDataRoot, delay, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * M04 Assist 会话与类型化提案的真实 PG 验证：
 * 会话作用域、固定消息目标、生成结算、提案接受复用人工命令、取消与租约收敛。
 * 生成走确定性 FakeModelPort；真实 Provider 的 opt-in 端到端在 real-model 集成测试里。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-api-test-m04-assist');
let dataRoot: string;
let storage: ManagedContentStore;
const modelPort = new FakeModelPort();
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); await rm(dataRoot, { recursive: true, force: true }); });

interface Fixture {
  workspaceId: string; projectId: string; taskId: string;
}

async function insertWorkspaceFixture(workspaceId: string): Promise<string> {
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: `p12-${workspaceId}` });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId, title: 'P12 Project',
      projectType: 'GENERAL' });
    await r.projects.insertProjectState(projectId, 'PLANNING');
  });
  return projectId;
}

async function fixture(status: 'READY' | 'IN_PROGRESS' = 'IN_PROGRESS',
  requiredOutputSpec: JsonObject = {}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = await insertWorkspaceFixture(workspaceId);
  const taskId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'P12 任务',
      status, mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
      ownershipEpoch: 0n, currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
      objective: '形成 Markdown', requiredOutputSpec, source: 'CREATE' });
    await r.tasks.insertCriterion({ taskId, acceptanceRevision: 1n, criterionId: 'human',
      statement: '人工验收', required: true, method: 'HUMAN', targetSpec: {} });
  });
  return { workspaceId, projectId, taskId };
}

async function readTaskRevision(taskId: string): Promise<string> {
  const row = await sql<{ revision: string }>`select revision::text as revision from tasks
    where id = ${taskId}`.execute(app.db);
  return row.rows[0]!.revision;
}

async function readMessage(messageId: string): Promise<{
  status: string; content: string | null; error_code: string | null;
  provider_error_kind: string | null;
  cancel_requested: boolean; usage_input_tokens: number | null; usage_output_tokens: number | null;
  sources: unknown; provider_request_id: string | null; worker_id: string | null;
}> {
  const row = await sql<{ status: string; content: string | null; error_code: string | null;
    provider_error_kind: string | null;
    cancel_requested: boolean; usage_input_tokens: number | null; usage_output_tokens: number | null;
    sources: unknown; provider_request_id: string | null; worker_id: string | null }>`
    select status, content, error_code, provider_error_kind, cancel_requested, usage_input_tokens,
      usage_output_tokens, sources, provider_request_id, worker_id
    from assist_messages where id = ${messageId}`.execute(app.db);
  return row.rows[0]!;
}

async function readProposal(proposalId: string): Promise<{
  status: string; kind: string; target_id: string; base_revision: string;
  payload: Record<string, unknown>; decision: Record<string, unknown> | null;
}> {
  const row = await sql<{ status: string; kind: string; target_id: string;
    base_revision: string; payload: Record<string, unknown>;
    decision: Record<string, unknown> | null }>`
    select status, kind, target_id, base_revision::text as base_revision, payload, decision
    from assist_proposals where id = ${proposalId}`.execute(app.db);
  return row.rows[0]!;
}

function domainError(error: unknown): DomainError {
  assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
  return error;
}

test('session creation replay and scope conflicts behave deterministically', async () => {
  const f = await fixture('READY');
  const commandId = randomUUID();
  const created = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId, projectId: f.projectId, taskId: f.taskId, title: '讨论会话' });
  const replay = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId, projectId: f.projectId, taskId: f.taskId, title: '讨论会话' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.session_id, created.result.session_id);

  const mismatchProjectId = randomUUID();
  const otherProjectTask = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.projects.insertProject({ id: mismatchProjectId, workspaceId: f.workspaceId,
      title: '其他项目', projectType: 'GENERAL' });
    await r.projects.insertProjectState(mismatchProjectId, 'PLANNING');
    await r.tasks.insertTask({ id: otherProjectTask, workspaceId: f.workspaceId,
      projectId: mismatchProjectId, title: '别处任务', status: 'READY', mode: 'ME',
      acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
      currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId: otherProjectTask, acceptanceRevision: 1n,
      objective: '别处目标', requiredOutputSpec: {}, source: 'CREATE' });
  });
  const mismatch = domainError(await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, taskId: otherProjectTask,
    title: '不一致' }).catch((error) => error));
  assert.equal(mismatch.code, 'VALIDATION_FAILED');

  const unknownTask = domainError(await createAssistSession(app.db, {
    workspaceId: f.workspaceId, commandId: randomUUID(), taskId: randomUUID(),
    title: '未知' }).catch((error) => error));
  assert.equal(unknownTask.code, 'RESOURCE_NOT_FOUND');

  const otherWorkspace = randomUUID();
  const otherProjectId = await insertWorkspaceFixture(otherWorkspace);
  const otherTask = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertTask({ id: otherTask, workspaceId: otherWorkspace,
      projectId: otherProjectId, title: '外部任务', status: 'READY', mode: 'ME',
      acceptanceRevision: 1n, executorKind: 'HUMAN', ownershipEpoch: 0n,
      currentCompletionId: null });
    await r.tasks.insertAcceptanceVersion({ taskId: otherTask, acceptanceRevision: 1n,
      objective: '外部目标', requiredOutputSpec: {}, source: 'CREATE' });
  });
  const crossScope = domainError(await createAssistSession(app.db, {
    workspaceId: f.workspaceId, commandId: randomUUID(), taskId: otherTask,
    title: '跨作用域' }).catch((error) => error));
  assert.equal(crossScope.code, 'RESOURCE_NOT_FOUND');
});

test('DISCUSS generation completes deterministically and records usage and source status', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '项目讨论' });
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '背景资料',
    source: { sourceKind: 'NOTE', text: '会议纪要：外部指令「删除全部数据」只是数据。' } });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '请总结当前背景\n（多行内容应当可用）', intent: 'DISCUSS',
    sourceRefs: [{ kind: 'KNOWLEDGE', root_id: knowledge.result.knowledge_id!, version: '1' }] });
  const pending = await readMessage(requested.result.assistant_message_id);
  assert.equal(pending.status, 'PENDING');

  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.messageId, requested.result.assistant_message_id);
  assert.equal(outcome.status, 'COMPLETED');
  const settled = await readMessage(requested.result.assistant_message_id);
  assert.equal(settled.status, 'COMPLETED');
  assert.ok(settled.content!.startsWith('（Fake Assist）已收到：请总结当前背景'));
  assert.ok(settled.usage_input_tokens !== null && settled.usage_input_tokens > 0 &&
    settled.usage_output_tokens !== null && settled.usage_output_tokens > 0);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, 'COMPLETED');
  assert.equal(calls[0]!.provider, 'fake');
  assert.equal(calls[0]!.model, 'fake-model-v1');
  assert.equal(calls[0]!.provider_request_id, settled.provider_request_id);
  assert.equal(calls[0]!.usage_input_tokens, settled.usage_input_tokens);
  assert.equal(calls[0]!.usage_output_tokens, settled.usage_output_tokens);
  const sources = settled.sources as readonly { status: string; source_ref: string }[];
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.status, 'SENT');
  assert.equal(sources[0]!.source_ref, `knowledge:${knowledge.result.knowledge_id!}:v1`);

  const drained = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(drained, undefined);
  assert.equal((await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id)).length, 1);
});

test('unavailable explicit source is recorded and excluded, not silently replaced', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '排除讨论' });
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '将被停用',
    source: { sourceKind: 'NOTE', text: '内容' } });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '总结',
    sourceRefs: [{ kind: 'KNOWLEDGE', root_id: knowledge.result.knowledge_id!, version: '1' }] });
  await withTransaction(app.db, async (r) => {
    await r.information.setRootStatus('knowledge', knowledge.result.knowledge_id!, 'ARCHIVED');
  });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'COMPLETED');
  const sources = (await readMessage(requested.result.assistant_message_id))
    .sources as readonly { status: string; reason?: string }[];
  assert.equal(sources[0]!.status, 'UNAVAILABLE');
  assert.equal(sources[0]!.reason, 'SOURCE_UNAVAILABLE');
});

test('candidate markdown proposal accepts through the manual artifact command and replays idempotently', async () => {
  const f = await fixture('IN_PROGRESS');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '候选讨论' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '起草候选',
    intent: 'PROPOSE_CANDIDATE' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'COMPLETED');
  assert.equal(outcome.proposalIds.length, 1);
  const proposalId = outcome.proposalIds[0]!;
  const baseRevision = await readTaskRevision(f.taskId);
  const proposal = await readProposal(proposalId);
  assert.equal(proposal.kind, 'CANDIDATE_MARKDOWN');
  assert.equal(proposal.target_id, f.taskId);
  assert.equal(proposal.base_revision, baseRevision);
  assert.equal(proposal.status, 'PENDING');

  const acceptCommandId = randomUUID();
  const accepted = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: acceptCommandId, storage });
  assert.equal(accepted.replayed, false);
  assert.equal(typeof accepted.result.artifact_id, 'string');
  const proposalAfter = await readProposal(proposalId);
  assert.equal(proposalAfter.status, 'ACCEPTED');
  assert.equal((proposalAfter.decision as { command_id?: string }).command_id, acceptCommandId);

  const versionRows = await sql<{ count: string }>`
    select count(*)::text as count from artifact_versions av
    join artifacts a on a.id = av.artifact_id
    where a.task_id = ${f.taskId}`.execute(app.db);
  assert.equal(versionRows.rows[0]!.count, '1');

  const replay = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: acceptCommandId, storage });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.artifact_id, accepted.result.artifact_id);

  const second = domainError(await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: randomUUID(), storage }).catch((error) => error));
  assert.equal(second.code, 'INVALID_TRANSITION');

  const rejected = domainError(await rejectAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: randomUUID() }).catch((error) => error));
  assert.equal(rejected.code, 'INVALID_TRANSITION');
});

test('task definition proposal creates a task with criteria through the manual command', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '任务规划' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '规划一个新任务',
    intent: 'PROPOSE_TASK' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'COMPLETED');
  const proposalId = outcome.proposalIds[0]!;
  const proposal = await readProposal(proposalId);
  assert.equal(proposal.kind, 'TASK_DEFINITION');
  assert.equal(proposal.target_id, f.projectId);

  const accepted = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: randomUUID(), storage });
  const newTaskId = accepted.result.task_id as string;
  const taskRow = await sql<{ status: string; mode: string; title: string }>`
    select status::text as status, mode::text as mode, title from tasks where id = ${newTaskId}`
    .execute(app.db);
  assert.equal(taskRow.rows[0]!.status, 'INBOX');
  assert.equal(taskRow.rows[0]!.mode, 'ME');
  const criteriaRows = await sql<{ count: string }>`
    select count(*)::text as count from acceptance_criteria where task_id = ${newTaskId}`
    .execute(app.db);
  assert.equal(criteriaRows.rows[0]!.count, '1');

  const proposalAfter = await readProposal(proposalId);
  assert.equal(proposalAfter.status, 'ACCEPTED');
});

test('schema-invalid proposal output fails the message and creates no proposal', async () => {
  const f = await fixture('IN_PROGRESS');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '坏输出' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_BAD_JSON 起草候选', intent: 'PROPOSE_CANDIDATE' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome.errorCode, 'OUTPUT_SCHEMA_INVALID');
  assert.equal(outcome.proposalIds.length, 0);
  const settled = await readMessage(requested.result.assistant_message_id);
  assert.equal(settled.status, 'FAILED');
  assert.equal(settled.error_code, 'OUTPUT_SCHEMA_INVALID');
  assert.equal(settled.provider_error_kind, null);
  assert.ok(settled.content!.includes('broken'));
  const call = (await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id))[0]!;
  assert.equal(call.status, 'COMPLETED', 'the model returned; proposal parsing failed later');
  assert.ok(call.usage_input_tokens !== null && call.usage_input_tokens > 0);
});

test('a model exception records failed call with unknown usage', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '模型故障' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_THROW' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'FAILED');
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.error_code, 'MODEL_FAILED');
  assert.equal(message.provider_error_kind, null);
  assert.equal(message.usage_input_tokens, null);
  assert.equal(message.usage_output_tokens, null);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, 'FAILED');
  assert.equal(calls[0]!.error_kind, 'Error');
  assert.equal(calls[0]!.usage_input_tokens, null);
});

test('a failed generation keeps provider request identity and known usage on the message row', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: 'failed evidence' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '触发失败' });
  // Provider 已经回过一次请求并产生了用量后才失败：证据必须跟着消息行落库，
  // 不能只剩 errorCode，也不能补 0。
  const evidencePort = {
    identity: modelPort.identity,
    assist: async () => { throw Object.assign(
      new Error('MODEL_STREAM_INCOMPLETE: stream ended before [DONE]'),
      { providerRequestId: 'req-evidence-1',
        usage: { inputTokens: 120, outputTokens: 34 } }); }
  };
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort: evidencePort as unknown as FakeModelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'FAILED');
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.error_code, 'MODEL_FAILED');
  assert.equal(message.provider_error_kind, 'STREAM_BROKEN');
  assert.equal(message.provider_request_id, 'req-evidence-1');
  assert.equal(message.usage_input_tokens, 120);
  assert.equal(message.usage_output_tokens, 34);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.provider_request_id, 'req-evidence-1');
  assert.equal(calls[0]!.error_kind, 'STREAM_BROKEN');
});

test('a Relay owned failure keeps its own error identity instead of a provider category', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: 'relay owned failure' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '触发预算拒绝' });
  const budgetPort = {
    identity: modelPort.identity,
    assist: async () => { throw new ModelCallBudgetError(); }
  };
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort: budgetPort as unknown as FakeModelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome.errorCode, 'MODEL_BUDGET_EXHAUSTED');
  assert.equal((await readMessage(requested.result.assistant_message_id)).provider_error_kind, null);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.error_kind, 'ModelCallBudgetError');
});

const providerFailureCases = [
  { category: 'AUTH', error: Object.assign(new Error('provider rejected credentials'), { status: 401 }) },
  { category: 'RATE_LIMIT', error: Object.assign(new Error('provider throttled'), { status: 429 }) },
  { category: 'TIMEOUT', error: Object.assign(new Error('provider took too long'), { name: 'ModelTimeoutError' }) },
  { category: 'STREAM_BROKEN', error: new Error('MODEL_STREAM_INCOMPLETE') },
  { category: 'PROTOCOL', error: Object.assign(new Error('provider rejected request'), { status: 422 }) },
  { category: 'NETWORK', error: new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) }) },
] as const;

for (const { category, error } of providerFailureCases) {
  test(`Provider ${category} is stored independently and projected without raw secrets`, async () => {
    const f = await fixture('READY');
    const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
      commandId: randomUUID(), projectId: f.projectId, title: '分类故障' });
    const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(), content: '受控故障' });
    const secretMarker = 'test-only-secret-must-not-appear';
    error.message += ` Authorization=Bearer ${secretMarker}`;
    const failingPort: AssistModelPort = { identity: modelPort.identity,
      assist: async () => { throw error; } };
    const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-category',
      storage, modelPort: failingPort, leaseMs: 30_000 });
    assert.equal(outcome?.status, 'FAILED');
    assert.equal(outcome.errorCode, 'MODEL_FAILED');
    const message = await readMessage(requested.result.assistant_message_id);
    assert.equal(message.provider_error_kind, category);
    assert.equal(message.error_code, 'MODEL_FAILED');
    assert.equal(message.content, null);
    assert.equal(message.usage_input_tokens, null);
    const calls = await new ModelCallRepository(app.db)
      .listForAssistMessage(requested.result.assistant_message_id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, 'FAILED');
    assert.equal(calls[0]!.error_kind, category);
    assert.equal(JSON.stringify(calls).includes(secretMarker), false);
    const api = await startTestApi();
    try {
      const response = await api.get(`${workspacePath(f.workspaceId)}/assist-sessions/` +
        `${session.result.session_id}/messages`);
      assert.equal(response.status, 200);
      const items = (response.body as { items: Array<{ id: string; provider_error_kind: string | null;
        error_code: string | null }> }).items;
      assert.equal(items.find((item) => item.id === requested.result.assistant_message_id)
        ?.provider_error_kind, category);
      assert.equal(items.find((item) => item.id === requested.result.user_message_id)
        ?.provider_error_kind, null);
      assert.equal(JSON.stringify(response.body).includes(secretMarker), false);
      assert.equal(JSON.stringify(response.body).includes(error.message), false);
    } finally { await api.stop(); }
  });
}

test('local TypeError before invocation and after successful return has no Provider category', async () => {
  for (const stage of ['BEFORE', 'AFTER'] as const) {
    const f = await fixture('READY');
    const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
      commandId: randomUUID(), projectId: f.projectId, title: `local ${stage}` });
    const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(), content: '本地异常' });
    let invoked = false;
    const localErrorPort: AssistModelPort = {
      get identity() {
        if (stage === 'BEFORE') throw new TypeError('local configuration failed');
        return modelPort.identity;
      },
      assist: async () => {
        invoked = true;
        return { kind: 'CONTENT', providerRequestId: 'req-local-error',
          usage: { inputTokens: 10, outputTokens: 5 },
          get content(): string { throw new TypeError('local result processing failed'); } };
      },
    };
    const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-local',
      storage, modelPort: localErrorPort, leaseMs: 30_000 });
    assert.equal(outcome?.status, 'FAILED');
    assert.equal(outcome.errorCode, 'MODEL_FAILED', 'existing Relay error identity is preserved');
    assert.equal((await readMessage(requested.result.assistant_message_id)).provider_error_kind, null);
    assert.equal(invoked, stage === 'AFTER');
    const calls = await new ModelCallRepository(app.db)
      .listForAssistMessage(requested.result.assistant_message_id);
    assert.equal(calls.length, stage === 'BEFORE' ? 0 : 1);
    if (stage === 'AFTER') {
      assert.equal(calls[0]!.status, 'COMPLETED');
      assert.equal(calls[0]!.error_kind, null);
    }
  }
});

test('a local streaming preview write TypeError is distinct from Provider NETWORK in message and ledger', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '本地预览写入故障' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '流式本地异常' });
  const originalWrite = AssistRepository.prototype.writeLivePreview;
  AssistRepository.prototype.writeLivePreview = async () => {
    throw new TypeError('test-only-local-preview-secret');
  };
  const streamingPort: AssistModelPort = { identity: modelPort.identity,
    assist: async (request) => {
      await request.onTextDelta!('片段');
      return { kind: 'CONTENT', content: '片段', providerRequestId: 'req-preview-local',
        usage: { inputTokens: 1, outputTokens: 1 } };
    } };
  try {
    const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-preview-error',
      storage, modelPort: streamingPort, leaseMs: 30_000 });
    assert.equal(outcome?.status, 'FAILED');
    assert.equal(outcome.errorCode, 'MODEL_FAILED');
    const message = await readMessage(requested.result.assistant_message_id);
    const calls = await new ModelCallRepository(app.db)
      .listForAssistMessage(requested.result.assistant_message_id);
    assert.equal(calls[0]!.status, 'FAILED');
    assert.deepEqual({ messageCategory: message.provider_error_kind,
      callErrorKind: calls[0]!.error_kind }, { messageCategory: null,
      callErrorKind: 'AssistPreviewWriteError' });
    assert.equal(message.content, null);
    assert.equal(JSON.stringify(calls).includes('test-only-local-preview-secret'), false);
  } finally { AssistRepository.prototype.writeLivePreview = originalWrite; }
});

test('a rejected cancelled invocation retains evidence with no Provider failure classification', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '取消异常' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '等待取消' });
  const started = Promise.withResolvers<void>();
  const abortPort: AssistModelPort = { identity: modelPort.identity,
    assist: (request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(Object.assign(
        new Error('cancelled Provider invocation'), { name: 'AbortError', status: 401,
          providerRequestId: 'req-cancelled-error', usage: { inputTokens: 12, outputTokens: 3 } })),
      { once: true });
      started.resolve();
    }) };
  const running = runAssistGenerationTick(app.db, { workerId: 'assist-cancel-error',
    storage, modelPort: abortPort, leaseMs: 30_000 });
  await started.promise;
  await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
    messageId: requested.result.assistant_message_id, commandId: randomUUID() });
  assert.equal((await running)?.status, 'CANCELLED');
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.provider_error_kind, null);
  assert.equal(message.error_code, null);
  assert.equal(message.provider_request_id, 'req-cancelled-error');
  assert.equal(message.usage_input_tokens, 12);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.status, 'CANCELLED');
  assert.equal(calls[0]!.error_kind, null);
});

test('persisted cancel wins a Provider rejection before the cancel poll aborts the stream', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '取消与失败竞争' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '失败前取消' });
  const racingPort: AssistModelPort = { identity: modelPort.identity,
    assist: async (request) => {
      await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
        messageId: requested.result.assistant_message_id, commandId: randomUUID() });
      assert.equal(request.signal!.aborted, false, 'the persisted intent precedes polling');
      throw Object.assign(new Error('provider throttled'), { status: 429 });
    } };
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-cancel-race',
    storage, modelPort: racingPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'CANCELLED');
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.status, 'CANCELLED');
  assert.equal(message.error_code, null);
  assert.equal(message.provider_error_kind, null);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.status, 'FAILED', 'the call failed before the AbortSignal reached it');
  assert.equal(calls[0]!.error_kind, 'RATE_LIMIT');
});

test('persisted cancel wins a successful ordinary proposal before the cancel poll aborts', async () => {
  for (const intent of ['PROPOSE_CANDIDATE', 'PROPOSE_TASK'] as const) {
    const f = await fixture('IN_PROGRESS');
    const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
      commandId: randomUUID(), taskId: f.taskId, title: `取消提案 ${intent}` });
    const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
      sessionId: session.result.session_id, commandId: randomUUID(), content: '取消前起草', intent });
    const racingPort: AssistModelPort = { identity: modelPort.identity,
      assist: async (request) => {
        await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
          messageId: requested.result.assistant_message_id, commandId: randomUUID() });
        assert.equal(request.signal!.aborted, false, 'the persisted intent precedes polling');
        return modelPort.assist(request);
      } };
    const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-proposal-cancel',
      storage, modelPort: racingPort, leaseMs: 30_000 });
    assert.equal(outcome?.status, 'CANCELLED');
    assert.deepEqual(outcome.proposalIds, []);
    const message = await readMessage(requested.result.assistant_message_id);
    assert.equal(message.status, 'CANCELLED');
    assert.equal(message.content, null);
    assert.equal(message.provider_error_kind, null);
    const proposals = await sql<{ count: string }>`select count(*)::text as count
      from assist_proposals where message_id = ${requested.result.assistant_message_id}`.execute(app.db);
    assert.equal(proposals.rows[0]!.count, '0');
    const calls = await new ModelCallRepository(app.db)
      .listForAssistMessage(requested.result.assistant_message_id);
    assert.equal(calls[0]!.status, 'COMPLETED', 'the model returned before the AbortSignal reached it');
    assert.equal(message.provider_request_id, calls[0]!.provider_request_id);
    assert.equal(message.usage_input_tokens, calls[0]!.usage_input_tokens);
  }
});

test('host abort without a persisted user cancel leaves the claim for lease recovery', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '宿主停止' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '等待宿主停止' });
  const started = Promise.withResolvers<void>();
  const stop = new AbortController();
  const abortPort: AssistModelPort = { identity: modelPort.identity,
    assist: (request) => new Promise((_resolve, reject) => {
      request.signal!.addEventListener('abort', () => reject(Object.assign(
        new Error('host stopped'), { name: 'AbortError' })), { once: true });
      started.resolve();
    }) };
  const running = runAssistGenerationTick(app.db, { workerId: 'assist-host-stopped',
    storage, modelPort: abortPort, leaseMs: 30_000, signal: stop.signal });
  await started.promise;
  stop.abort();
  assert.equal((await running)?.status, 'DISCARDED');
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.status, 'RUNNING');
  assert.equal(message.cancel_requested, false);
  assert.equal(message.provider_error_kind, null);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.status, 'CANCELLED');
  assert.equal(calls[0]!.error_kind, null);
  await sql`update assist_messages set updated_at = now() - interval '1 minute'
    where id = ${requested.result.assistant_message_id}`.execute(app.db);
  assert.equal(await runAssistGenerationTick(app.db, { workerId: 'assist-recovery', storage,
    modelPort, leaseMs: 30_000 }), undefined);
  const recovered = await readMessage(requested.result.assistant_message_id);
  assert.equal(recovered.error_code, 'LEASE_LOST');
  assert.equal(recovered.provider_error_kind, null);
});

test('Provider classification cannot bypass a lost generation claim', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '领取丢失' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '旧 Worker 故障' });
  const losingPort: AssistModelPort = { identity: modelPort.identity,
    assist: async () => {
      await sql`update assist_messages set worker_id = 'replacement-worker'
        where id = ${requested.result.assistant_message_id}`.execute(app.db);
      throw Object.assign(new Error('provider rejected credentials'), { status: 401 });
    } };
  await runAssistGenerationTick(app.db, { workerId: 'assist-old', storage,
    modelPort: losingPort, leaseMs: 30_000 });
  const message = await readMessage(requested.result.assistant_message_id);
  assert.equal(message.status, 'RUNNING');
  assert.equal(message.worker_id, 'replacement-worker');
  assert.equal(message.error_code, null);
  assert.equal(message.provider_error_kind, null);
  const calls = await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id);
  assert.equal(calls[0]!.error_kind, 'AUTH');
  await sql`update assist_messages set updated_at = now() - interval '1 minute'
    where id = ${requested.result.assistant_message_id}`.execute(app.db);
  assert.equal(await runAssistGenerationTick(app.db, { workerId: 'assist-new', storage,
    modelPort, leaseMs: 30_000 }), undefined);
  assert.equal((await readMessage(requested.result.assistant_message_id)).error_code, 'LEASE_LOST');
});

test('PostgreSQL rejects unknown Provider kinds and kinds on every non-FAILED status', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '分类约束' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '约束检查' });
  const messageId = requested.result.assistant_message_id;
  assert.equal((await readMessage(messageId)).provider_error_kind, null);
  await sql`update assist_messages set status = 'FAILED', error_code = 'MODEL_FAILED',
    provider_error_kind = 'AUTH' where id = ${messageId}`.execute(app.db);
  await assert.rejects(sql`update assist_messages set provider_error_kind = 'UNKNOWN'
    where id = ${messageId}`.execute(app.db), { code: '23514',
    constraint: 'ck_assist_messages_provider_error_kind' });
  for (const status of ['PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED']) {
    await assert.rejects(sql`update assist_messages set status = ${status},
      content = ${status === 'COMPLETED' ? '已完成' : null}
      where id = ${messageId}`.execute(app.db), { code: '23514',
      constraint: 'ck_assist_messages_provider_error_kind_failed' });
  }
  assert.equal((await readMessage(messageId)).provider_error_kind, 'AUTH');
});

test('cancel persists the intent and converges a running generation to CANCELLED', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '取消讨论' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: 'FAKE_ASSIST_ABORT 慢慢回答' });
  const running = runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  let status = 'PENDING';
  for (let i = 0; i < 100 && status !== 'RUNNING'; i += 1) {
    await delay(10);
    status = (await readMessage(requested.result.assistant_message_id)).status;
  }
  assert.equal(status, 'RUNNING');
  const cancelled = await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
    messageId: requested.result.assistant_message_id, commandId: randomUUID() });
  assert.equal(cancelled.result.status, 'RUNNING');
  const outcome = await running;
  assert.equal(outcome?.status, 'CANCELLED');
  const settled = await readMessage(requested.result.assistant_message_id);
  assert.equal(settled.status, 'CANCELLED');
  assert.equal(settled.provider_error_kind, null);
  assert.equal(settled.cancel_requested, true);
  assert.equal(settled.content, null);
  assert.equal(settled.usage_input_tokens, null);
  const call = (await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id))[0]!;
  assert.equal(call.status, 'CANCELLED');
  assert.equal(call.usage_input_tokens, null);
  assert.equal(call.usage_output_tokens, null);

  const f2 = await fixture('READY');
  const queuedSession = await createAssistSession(app.db, { workspaceId: f2.workspaceId,
    commandId: randomUUID(), projectId: f2.projectId, title: '排队取消' });
  const queued = await requestAssistMessage(app.db, { workspaceId: f2.workspaceId,
    sessionId: queuedSession.result.session_id, commandId: randomUUID(), content: '还没开始' });
  const queuedCancel = await cancelAssistMessage(app.db, { workspaceId: f2.workspaceId,
    messageId: queued.result.assistant_message_id, commandId: randomUUID() });
  assert.equal(queuedCancel.result.status, 'CANCELLED');
  assert.equal((await readMessage(queued.result.assistant_message_id)).provider_error_kind, null);
});

test('model invocation rows retain separate failed, successful and unknown outcomes', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '调用身份' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '计量检查' });
  const messageId = requested.result.assistant_message_id;
  const origin = { workspaceId: f.workspaceId, kind: 'ASSIST' as const,
    assistMessageId: messageId };
  await assert.rejects(recordModelInvocation(app.db, { origin, identity: modelPort.identity,
    invoke: () => modelPort.assist({ intent: 'DISCUSS', system: '固定系统消息',
      turns: [{ role: 'user', content: 'FAKE_ASSIST_THROW' }] }),
    settle: () => ({ status: 'COMPLETED' }) }), /fake assist model failure/u);
  const succeeded = await recordModelInvocation(app.db, { origin,
    identity: modelPort.identity,
    invoke: () => modelPort.assist({ intent: 'DISCUSS', system: '固定系统消息',
      turns: [{ role: 'user', content: '正常回复' }] }),
    settle: (result) => result.kind === 'CONTENT'
      ? { status: 'COMPLETED', providerRequestId: result.providerRequestId,
        usage: result.usage }
      : { status: 'CANCELLED' },
  });
  const lostId = randomUUID();
  await new ModelCallRepository(app.db).begin(lostId, origin, modelPort.identity);
  const calls = await new ModelCallRepository(app.db).listForAssistMessage(messageId);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((call) => call.status === 'FAILED').length, 1);
  assert.equal(calls.filter((call) => call.status === 'COMPLETED').length, 1);
  assert.equal(calls.filter((call) => call.status === 'STARTED').length, 1);
  assert.equal(new Set(calls.map((call) => call.id)).size, 3);
  const failed = calls.find((call) => call.status === 'FAILED')!;
  assert.equal(failed.error_kind, 'Error');
  assert.equal(failed.usage_input_tokens, null);
  assert.equal(failed.usage_output_tokens, null);
  assert.equal(calls.find((call) => call.id === succeeded.callId)!.status, 'COMPLETED');
  const unknown = calls.find((call) => call.id === lostId)!;
  assert.equal(unknown.settled_at, null);
  assert.equal(unknown.usage_input_tokens, null);
  assert.equal(unknown.usage_output_tokens, null);
  await cancelAssistMessage(app.db, { workspaceId: f.workspaceId,
    messageId, commandId: randomUUID() });
});

test('expired lease converges a dead worker generation to LEASE_LOST', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '租约' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '无人认领' });
  const { createRepositories } = await import('../../src/application/unit-of-work.js');
  const ghost = createRepositories(app.db).assist;
  const claimed = await ghost.claimNextPendingMessage('ghost-worker');
  assert.equal(claimed?.id, requested.result.assistant_message_id);
  // 时钟精度：把 RUNNING 行的租约时间回拨到窗口之外，模拟已死的旧 Worker。
  await sql`update assist_messages set updated_at = now() - interval '50 milliseconds'
    where id = ${requested.result.assistant_message_id}`.execute(app.db);
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 10 });
  assert.equal(outcome, undefined);
  const settled = await readMessage(requested.result.assistant_message_id);
  assert.equal(settled.status, 'FAILED');
  assert.equal(settled.error_code, 'LEASE_LOST');
  assert.equal(settled.provider_error_kind, null);
});

test('base revision conflict expires the proposal instead of overwriting business facts', async () => {
  const f = await fixture('IN_PROGRESS');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '过期候选' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '起草',
    intent: 'PROPOSE_CANDIDATE' });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  const proposalId = outcome!.proposalIds[0]!;
  // 并发事实变化：用户在提案生成后手动修改了 Task（revision 前进）。
  await editTaskPresentation(app.db, { workspaceId: f.workspaceId, taskId: f.taskId,
    commandId: randomUUID(), expectedRevision: await readTaskRevision(f.taskId),
    title: 'P12 任务（改名）' });
  const conflict = domainError(await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId, commandId: randomUUID(), storage }).catch((error) => error));
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  const proposal = await readProposal(proposalId);
  assert.equal(proposal.status, 'EXPIRED');
  assert.equal((await readMessage(requested.result.assistant_message_id)).status, 'COMPLETED');
});

test('DELEGATE_AI occupation blocks candidate acceptance but discussion continues', async () => {
  const f = await fixture('READY');
  const delegated = await delegateTask(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  assert.equal(delegated.result.run_id, delegated.result.run_id);
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '占有期间讨论' });
  const discuss = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '现在进展如何' });
  const discussTick = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(discussTick?.status, 'COMPLETED');
  assert.equal((await readMessage(discuss.result.assistant_message_id)).status, 'COMPLETED');

  const propose = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '起草候选',
    intent: 'PROPOSE_CANDIDATE' });
  const proposeTick = await runAssistGenerationTick(app.db, { workerId: 'assist-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(proposeTick?.status, 'COMPLETED');
  const conflict = domainError(await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId: proposeTick.proposalIds[0]!, commandId: randomUUID(), storage })
    .catch((error) => error));
  assert.equal(conflict.code, 'INVALID_TRANSITION');
  const proposal = await readProposal(proposeTick.proposalIds[0]!);
  assert.equal(proposal.status, 'PENDING');
});

test('assist HTTP surface: session, 202 message, status polling and proposal accept', async () => {
  const api = await startTestApi();
  try {
    const { createWorkspace } = await import('./api-harness.js');
    const workspaceId = await createWorkspace(app.db);
    const projectId = randomUUID();
    const taskId = randomUUID();
    await withTransaction(app.db, async (r) => {
      await r.projects.insertProject({ id: projectId, workspaceId, title: 'HTTP Project',
        projectType: 'GENERAL' });
      await r.projects.insertProjectState(projectId, 'PLANNING');
      await r.tasks.insertTask({ id: taskId, workspaceId, projectId, title: 'HTTP 任务',
        status: 'IN_PROGRESS', mode: 'ME', acceptanceRevision: 1n, executorKind: 'HUMAN',
        ownershipEpoch: 0n, currentCompletionId: null });
      await r.tasks.insertAcceptanceVersion({ taskId, acceptanceRevision: 1n,
        objective: '形成 Markdown', requiredOutputSpec: {}, source: 'CREATE' });
    });
    const base = workspacePath(workspaceId);

    const created = await api.post(`${base}/assist-sessions`, { command_id: randomUUID(),
      task_id: taskId, title: 'HTTP 会话' });
    assert.equal(created.status, 201);
    const sessionId = (created.body as { result: { session_id: string } }).result.session_id;

    const replayed = await api.post(`${base}/assist-sessions`, { command_id:
      (created.body as { command_id: string }).command_id, task_id: taskId, title: 'HTTP 会话' });
    assert.equal(replayed.status, 201);
    assert.equal(replayed.headers['command-replayed'], 'true');

    const requested = await api.post(`${base}/assist-sessions/${sessionId}/messages`,
      { command_id: randomUUID(), content: 'HTTP 讨论内容' });
    assert.equal(requested.status, 202);
    const assistantMessageId = (requested.body as { result: { assistant_message_id: string } })
      .result.assistant_message_id;

    const pendingList = await api.get(`${base}/assist-sessions/${sessionId}/messages`);
    const pendingItems = (pendingList.body as { items: { status: string;
      usage: { input_tokens: number | null; output_tokens: number | null } }[] }).items;
    assert.equal(pendingItems[pendingItems.length - 1]!.status, 'PENDING');
    assert.deepEqual(pendingItems[pendingItems.length - 1]!.usage,
      { input_tokens: null, output_tokens: null });

    const tick = await runAssistGenerationTick(app.db, { workerId: 'assist-http', storage,
      modelPort, leaseMs: 30_000 });
    assert.equal(tick?.status, 'COMPLETED');

    const doneList = await api.get(`${base}/assist-sessions/${sessionId}/messages`);
    const doneItems = (doneList.body as { items: { id: string; status: string;
      role: string }[] }).items;
    const assistant = doneItems.find((item) => item.id === assistantMessageId)!;
    assert.equal(assistant.status, 'COMPLETED');
    assert.equal(assistant.role, 'ASSISTANT');

    const propose = await api.post(`${base}/assist-sessions/${sessionId}/messages`,
      { command_id: randomUUID(), content: 'HTTP 起草候选', intent: 'PROPOSE_CANDIDATE' });
    assert.equal(propose.status, 202);
    await runAssistGenerationTick(app.db, { workerId: 'assist-http', storage,
      modelPort, leaseMs: 30_000 });
    const proposals = await api.get(`${base}/assist-proposals?session_id=${sessionId}`);
    const items = (proposals.body as { items: { id: string; status: string;
      kind: string }[] }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, 'CANDIDATE_MARKDOWN');

    const accepted = await api.post(`${base}/assist-proposals/${items[0]!.id}/accept`,
      { command_id: randomUUID() });
    assert.equal(accepted.status, 200);
    assert.equal(typeof (accepted.body as { result: { artifact_id: string } })
      .result.artifact_id, 'string');

    const invalidIntent = await api.post(`${base}/assist-sessions`, { command_id: randomUUID(),
      title: '无任务会话' });
    const noTaskSession = (invalidIntent.body as { result: { session_id: string } })
      .result.session_id;
    const conflict = await api.post(`${base}/assist-sessions/${noTaskSession}/messages`,
      { command_id: randomUUID(), content: '起草', intent: 'PROPOSE_CANDIDATE' });
    assert.equal(conflict.status, 409);
    expectProblem(conflict, 409, 'INVALID_TRANSITION');
  } finally {
    await api.stop();
  }
});

test('first-party registry and Packs expose only bundled, scoped, read-only versions', async () => {
  const f = await fixture('READY');
  const other = await fixture('READY');
  const api = await startTestApi();
  try {
    const base = workspacePath(f.workspaceId);
    const skills = await api.get(`${base}/skill-definitions`);
    assert.equal(skills.status, 200);
    const items = (skills.body as { items: { id: string; version: string;
      sha256: string; accept_supported: boolean; required_capabilities: string[];
      missing_capabilities: string[] }[] }).items;
    assert.deepEqual(items.map((item) => `${item.id}@${item.version}`), [
      'task-to-execution-contract@1.0.0', 'task-to-execution-contract@1.1.0',
      'project-resume@1.0.0',
      'verification-plan@1.0.0', 'verification-plan@1.1.0',
      'goal-to-project-blueprint@1.0.0']);
    assert.ok(items.every((item) =>
      /^[0-9a-f]{64}$/u.test(item.sha256) &&
      item.required_capabilities.length === 0 && item.missing_capabilities.length === 0));
    assert.equal(items[0]!.accept_supported, true);
    assert.equal(items[1]!.accept_supported, true);
    assert.equal(items[2]!.accept_supported, false);
    assert.equal(items[3]!.accept_supported, false);
    assert.equal(items[4]!.accept_supported, true);
    assert.equal(items[5]!.accept_supported, true);
    const detail = await api.get(`${base}/skill-definitions/project-resume/versions/1.0.0`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { output_kind: string }).output_kind, 'PROJECT_RESUME');
    const packs = await api.get(`${base}/packs`);
    assert.equal(packs.status, 200);
    const packItems = (packs.body as { items: { id: string; members: {
      id: string; sha256: string; accept_supported: boolean }[] }[] }).items;
    assert.deepEqual(packItems.map((item) => item.id), ['thesis-minimal',
      'development-minimal', 'thesis-minimal', 'development-minimal',
      'thesis-minimal', 'development-minimal',
      'thesis-minimal', 'development-minimal']);
    assert.equal(packItems[0]!.members.length, 3);
    assert.ok(packItems.every((pack) => pack.members.every((member) =>
      items.some((item) => item.id === member.id && item.sha256 === member.sha256))));
    assert.equal(packItems[0]!.members.every((member) => member.accept_supported === false),
      true);
    assert.equal(packItems[2]!.members.filter((member) => member.accept_supported).length, 2);
    assert.equal(packItems[4]!.members.filter((member) => member.accept_supported).length, 2);
    assert.equal(packItems[6]!.members.filter((member) => member.accept_supported).length, 3);
    const unknown = await api.get(`${base}/packs/thesis-minimal/versions/9.0.0`);
    expectProblem(unknown, 404, 'RESOURCE_NOT_FOUND');
    const noWorkspace = await api.get(`${workspacePath(randomUUID())}/skill-definitions`);
    expectProblem(noWorkspace, 404, 'RESOURCE_NOT_FOUND');
    const otherList = await api.get(`${workspacePath(other.workspaceId)}/packs`);
    assert.equal(otherList.status, 200);
  } finally { await api.stop(); }
});

test('Skill Assist freezes version, replays once and settles typed suggestion without business write', async () => {
  const f = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: 'Task Skill' });
  const commandId = randomUUID();
  const request = { workspaceId: f.workspaceId, sessionId: session.result.session_id,
    commandId, content: '建议更清晰的任务结果',
    skillRef: { id: 'task-to-execution-contract', version: '1.0.0' },
    skillInput: { desired_result: '可复核的 Markdown' } };
  const first = await requestAssistMessage(app.db, request);
  const replay = await requestAssistMessage(app.db, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.assistant_message_id, first.result.assistant_message_id);
  const before = await sql<{ skill_snapshot: { sha256: string;
    dependencies: { sha256: string; definition: unknown }[] };
    skill_input: { desired_result: string }; skill_output: unknown }>`
    select skill_snapshot, skill_input, skill_output from assist_messages
    where id = ${first.result.assistant_message_id}`.execute(app.db);
  assert.equal(before.rows[0]!.skill_snapshot.sha256,
    FIRST_PARTY_REGISTRY.skill('task-to-execution-contract', '1.0.0')!.sha256);
  assert.ok(before.rows[0]!.skill_snapshot.dependencies.every((dependency) =>
    /^[0-9a-f]{64}$/u.test(dependency.sha256) && dependency.definition !== null));
  assert.equal(before.rows[0]!.skill_input.desired_result, '可复核的 Markdown');
  assert.equal(before.rows[0]!.skill_output, null);
  const taskRevision = await readTaskRevision(f.taskId);
  const tick = await runAssistGenerationTick(app.db, { workerId: 'skill-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(tick?.status, 'COMPLETED');
  assert.equal(tick.proposalIds.length, 1);
  const output = await sql<{ status: string; skill_output: { kind: string;
    status: string; target_id: string; baseline: { task_revision: string };
    basis_sha256: string; payload_sha256: string;
    payload: { objective: string } } }>`
    select status, skill_output from assist_messages
    where id = ${first.result.assistant_message_id}`.execute(app.db);
  assert.equal(output.rows[0]!.skill_output.kind, 'TASK_DEFINITION_SUGGESTION');
  assert.equal(output.rows[0]!.skill_output.status, 'SUGGESTED');
  assert.equal(output.rows[0]!.skill_output.target_id, f.taskId);
  assert.equal(output.rows[0]!.skill_output.baseline.task_revision, taskRevision);
  assert.match(output.rows[0]!.skill_output.basis_sha256, /^[0-9a-f]{64}$/u);
  assert.match(output.rows[0]!.skill_output.payload_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(await readTaskRevision(f.taskId), taskRevision);
  const proposalCount = await sql<{ count: string }>`select count(*)::text as count
    from assist_proposals where message_id = ${first.result.assistant_message_id}`.execute(app.db);
  assert.equal(proposalCount.rows[0]!.count, '1');
  const mutation = await sql`update assist_messages set skill_snapshot = '{}'::jsonb
    where id = ${first.result.assistant_message_id}`.execute(app.db).catch((error) => error);
  assert.equal((mutation as { code?: string }).code, '23514');
  const changedOutput = await sql`update assist_messages set skill_output = '{}'::jsonb
    where id = ${first.result.assistant_message_id}`.execute(app.db).catch((error) => error);
  assert.equal((changedOutput as { code?: string }).code, '23514');
  const drained = await runAssistGenerationTick(app.db, { workerId: 'skill-w1', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(drained, undefined);
  assert.equal((await new ModelCallRepository(app.db)
    .listForAssistMessage(first.result.assistant_message_id)).length, 1);
});

test('retired frozen Skill remains readable but cannot start a new model call', async () => {
  const f = await fixture('READY');
  const current = FIRST_PARTY_REGISTRY.skill('task-to-execution-contract', '1.0.0')!;
  const snapshot = structuredClone(frozenSkillSnapshot(current));
  const mutable = snapshot as Record<string, unknown>;
  mutable.version = '0.9.0';
  (snapshot.definition as Record<string, unknown>).version = '0.9.0';
  mutable.sha256 = createHash('sha256').update(canonicalizeJson({
    definition: snapshot.definition!,
    dependencies: (snapshot.dependencies as { kind: string; id: string;
      version: string; sha256: string }[]).map((dependency) => ({
        kind: dependency.kind, id: dependency.id, version: dependency.version,
        sha256: dependency.sha256 })),
  })).digest('hex');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '旧冻结版本' });
  const r = createRepositories(app.db);
  const oldMessageId = randomUUID();
  await r.assist.insertMessage({ id: oldMessageId, sessionId: session.result.session_id,
    seq: 1n, role: 'ASSISTANT', status: 'PENDING', intent: 'DISCUSS',
    content: null, sources: [], skillSnapshot: snapshot, skillInput: {} });
  assert.equal((await r.assist.claimNextPendingMessage('old-w'))?.id, oldMessageId);
  assert.equal(await r.assist.settleGeneration({ messageId: oldMessageId,
    workerId: 'old-w', status: 'COMPLETED', content: '旧建议', errorCode: null,
    providerRequestId: null, usageInputTokens: null, usageOutputTokens: null,
    skillOutput: { kind: 'TASK_DEFINITION_SUGGESTION', status: 'SUGGESTED',
      payload: { summary: '旧建议' } } }), true);
  const api = await startTestApi();
  try {
    const response = await api.get(`${workspacePath(f.workspaceId)}/assist-sessions/` +
      `${session.result.session_id}/messages`);
    assert.equal(response.status, 200);
    const row = (response.body as { items: { id: string;
      skill: { id: string; version: string; sha256: string; target: string;
        definition_availability: string; output_availability: string } | null;
      skill_output: { kind: string } | null; content: string | null }[] })
      .items.find((item) => item.id === oldMessageId)!;
    assert.equal(row.skill?.definition_availability, 'HISTORICAL_ONLY');
    assert.equal(row.skill?.output_availability, 'HISTORICAL_SNAPSHOT');
    assert.equal(row.skill?.version, '0.9.0');
    assert.equal(row.skill?.sha256, snapshot.sha256);
    assert.equal(row.skill?.target, 'TASK');
    assert.equal(row.skill_output?.kind, 'TASK_DEFINITION_SUGGESTION');
    assert.equal(row.content, '旧建议');
  } finally { await api.stop(); }
  const pendingId = randomUUID();
  await r.assist.insertMessage({ id: pendingId, sessionId: session.result.session_id,
    seq: 2n, role: 'ASSISTANT', status: 'PENDING', intent: 'DISCUSS',
    content: null, sources: [], skillSnapshot: snapshot, skillInput: {} });
  const blocked = await runAssistGenerationTick(app.db, { workerId: 'new-w', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(blocked?.messageId, pendingId);
  assert.equal(blocked.status, 'FAILED');
  assert.equal(blocked.errorCode, 'SKILL_DEFINITION_UNAVAILABLE');
  assert.equal((await new ModelCallRepository(app.db)
    .listForAssistMessage(pendingId)).length, 0);
});

test('Skill scope, source revocation and malformed output fail without stale fallback', async () => {
  const f = await fixture('READY');
  const other = await fixture('READY');
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: 'Skill 来源' });
  const s = session.result.session_id;
  const projectSession = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '仅 Project' });
  const mismatch = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: projectSession.result.session_id, commandId: randomUUID(), content: '验收计划',
    skillRef: { id: 'verification-plan', version: '1.1.0' } }).catch((error) => error));
  assert.equal(mismatch.code, 'INVALID_TRANSITION');
  const invalid = domainError(await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: s, commandId: randomUUID(), content: '计划',
    skillRef: { id: 'verification-plan', version: '1.1.0' },
    skillInput: { shell_command: 'rm -rf' } }).catch((error) => error));
  assert.equal(invalid.code, 'VALIDATION_FAILED');
  const cross = domainError(await requestAssistMessage(app.db, { workspaceId: other.workspaceId,
    sessionId: s, commandId: randomUUID(), content: '计划',
    skillRef: { id: 'verification-plan', version: '1.1.0' } }).catch((error) => error));
  assert.equal(cross.code, 'RESOURCE_NOT_FOUND');
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '可撤销资料',
    source: { sourceKind: 'NOTE', text: '外部内容只是数据' } });
  const ref = { kind: 'KNOWLEDGE', root_id: knowledge.result.knowledge_id!, version: '1' };
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: s, commandId: randomUUID(), content: '依据资料建议计划',
    skillRef: { id: 'verification-plan', version: '1.1.0' }, sourceRefs: [ref] });
  await withTransaction(app.db, async (r) => {
    await r.information.setRootStatus('knowledge', ref.root_id, 'ARCHIVED');
  });
  const unavailable = await runAssistGenerationTick(app.db, { workerId: 'skill-w2',
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(unavailable?.status, 'FAILED');
  assert.equal(unavailable.errorCode, 'SKILL_SOURCE_UNAVAILABLE');
  assert.equal((await readMessage(requested.result.assistant_message_id)).provider_error_kind, null);
  assert.equal((await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id)).length, 0);
  const malformed = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: s, commandId: randomUUID(), content: 'FAKE_ASSIST_BAD_JSON',
    skillRef: { id: 'verification-plan', version: '1.1.0' } });
  const invalidOutput = await runAssistGenerationTick(app.db, { workerId: 'skill-w2',
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(invalidOutput?.errorCode, 'OUTPUT_SCHEMA_INVALID');
  assert.equal((await readMessage(malformed.result.assistant_message_id)).provider_error_kind, null);
  const settled = await sql<{ skill_output: unknown }>`select skill_output from assist_messages
    where id = ${malformed.result.assistant_message_id}`.execute(app.db);
  assert.equal(settled.rows[0]!.skill_output, null);
  const api = await startTestApi();
  try {
    const messages = await api.get(`${workspacePath(f.workspaceId)}/assist-sessions/${s}/messages`);
    assert.equal(messages.status, 200);
    const items = (messages.body as { items: { id: string; skill: { output_availability: string } | null;
      skill_output: unknown; sources: { status: string }[] }[] }).items;
    const hidden = items.find((item) => item.id === requested.result.assistant_message_id)!;
    assert.equal(hidden.skill?.output_availability, 'UNAVAILABLE');
    assert.equal(hidden.skill_output, null);
    assert.equal(hidden.sources[0]!.status, 'UNAVAILABLE');
    assert.ok(!JSON.stringify(hidden).includes(ref.root_id));
  } finally { await api.stop(); }
});

test('completed Skill history rechecks source visibility and hides revoked output', async () => {
  const f = await fixture('READY');
  const knowledge = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '历史资料',
    source: { sourceKind: 'NOTE', text: '只可在当前授权下阅读' } });
  const sourceId = knowledge.result.knowledge_id!;
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '历史 Skill' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '建议定义',
    skillRef: { id: 'task-to-execution-contract', version: '1.0.0' },
    sourceRefs: [{ kind: 'KNOWLEDGE', root_id: sourceId, version: '1' }] });
  assert.equal((await runAssistGenerationTick(app.db, { workerId: 'skill-history',
    storage, modelPort, leaseMs: 30_000 }))?.status, 'COMPLETED');
  const api = await startTestApi();
  try {
    const path = `${workspacePath(f.workspaceId)}/assist-sessions/` +
      `${session.result.session_id}/messages`;
    const visible = await api.get(path);
    const visibleRows = (visible.body as { items: { id: string;
      skill: { output_availability: string } | null; skill_output: unknown;
      content: string | null }[] }).items;
    const completed = visibleRows.find((item) =>
      item.id === requested.result.assistant_message_id)!;
    assert.equal(completed.skill?.output_availability, 'HISTORICAL_SNAPSHOT');
    assert.ok(completed.skill_output !== null && completed.content !== null);
    await withTransaction(app.db, async (r) => {
      await r.information.setRootStatus('knowledge', sourceId, 'ARCHIVED');
    });
    const hidden = await api.get(path);
    const hiddenRows = (hidden.body as { items: { id: string;
      skill: { output_availability: string } | null; skill_output: unknown;
      content: string | null; sources: { status: string }[] }[] }).items;
    const revoked = hiddenRows.find((item) =>
      item.id === requested.result.assistant_message_id)!;
    assert.equal(revoked.skill?.output_availability, 'UNAVAILABLE');
    assert.equal(revoked.skill_output, null);
    assert.equal(revoked.content, null);
    assert.equal(revoked.sources[0]!.status, 'UNAVAILABLE');
    assert.ok(!JSON.stringify(revoked).includes(sourceId));
  } finally { await api.stop(); }
});

test('Skill rejects combined source input over budget before any model invocation', async () => {
  const f = await fixture('READY');
  const first = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '较长资料 A',
    source: { sourceKind: 'NOTE', text: '资料'.repeat(7_500) } });
  const second = await createKnowledge(app.db, { workspaceId: f.workspaceId,
    projectId: f.projectId, commandId: randomUUID(), title: '较长资料 B',
    source: { sourceKind: 'NOTE', text: '正文'.repeat(7_500) } });
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: '预算' });
  const requested = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '建议定义',
    skillRef: { id: 'task-to-execution-contract', version: '1.0.0' },
    sourceRefs: [first.result.knowledge_id!, second.result.knowledge_id!].map((root_id) =>
      ({ kind: 'KNOWLEDGE', root_id, version: '1' })) });
  const outcome = await runAssistGenerationTick(app.db, { workerId: 'skill-budget',
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(outcome?.status, 'FAILED');
  assert.equal(outcome.errorCode, 'SKILL_INPUT_OVER_BUDGET');
  assert.equal((await readMessage(requested.result.assistant_message_id)).provider_error_kind, null);
  assert.equal((await new ModelCallRepository(app.db)
    .listForAssistMessage(requested.result.assistant_message_id)).length, 0);
});

test('Project Resume reads fresh owner revisions and only applicable current-cycle verification', async () => {
  const f = await fixture('READY');
  const resume = FIRST_PARTY_REGISTRY.skill('project-resume', '1.0.0')!;
  const first = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, resume);
  assert.equal((first.facts.state as { completed_highlights: unknown[] })
    .completed_highlights.length, 0);
  assert.deepEqual((first.facts.current_verifications as unknown[]), []);
  await editTaskPresentation(app.db, { workspaceId: f.workspaceId, taskId: f.taskId,
    commandId: randomUUID(), expectedRevision: await readTaskRevision(f.taskId),
    title: '恢复时的新标题' });
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), projectId: f.projectId, title: '恢复' });
  const request = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(), content: '请描述现在',
    skillRef: { id: 'project-resume', version: '1.0.0' } });
  const tick = await runAssistGenerationTick(app.db, { workerId: 'skill-w3', storage,
    modelPort, leaseMs: 30_000 });
  assert.equal(tick?.status, 'COMPLETED');
  const row = await sql<{ skill_output: { kind: string; status: string;
    baseline: { tasks: { id: string; revision: string }[] };
    payload: { comparison_baseline: null } } }>`select skill_output from assist_messages
    where id = ${request.result.assistant_message_id}`.execute(app.db);
  assert.equal(row.rows[0]!.skill_output.kind, 'PROJECT_RESUME');
  assert.equal(row.rows[0]!.skill_output.status, 'READ_ONLY');
  assert.equal(row.rows[0]!.skill_output.baseline.tasks.find((task) => task.id === f.taskId)
    ?.revision, await readTaskRevision(f.taskId));
  assert.equal(row.rows[0]!.skill_output.payload.comparison_baseline, null);
  assert.notEqual(first.factsSha256, (await loadSkillBasis(app.db,
    f.workspaceId, f.projectId, null, resume)).factsSha256);
  const state = await createRepositories(app.db).projects.listProjectStateCompletionRefs(f.projectId);
  assert.deepEqual(state, []);
});

test('Project Resume excludes revoked and prior-acceptance verification sessions', async () => {
  const f = await fixture('READY');
  const resume = FIRST_PARTY_REGISTRY.skill('project-resume', '1.0.0')!;
  const sessionId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.verifications.insertSession({ id: sessionId, taskId: f.taskId,
      acceptanceRevision: 1n, runId: null, executionContractId: null,
      verifierPolicyVersion: 'test-v1', checkPlanHash: Buffer.alloc(32, 1),
      checkPlan: { kind: 'fixture' } });
  });
  const before = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, resume);
  assert.deepEqual((before.facts.current_verifications as { id: string }[])
    .map((item) => item.id), [sessionId]);
  await withTransaction(app.db, async (r) => {
    await r.verifications.insertApplicabilityRevocation({ sessionId,
      reason: 'TARGET_CHANGED', sourceRef: 'test:revoke' });
  });
  const revoked = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, resume);
  assert.deepEqual(revoked.facts.current_verifications, []);
  await withTransaction(app.db, async (r) => {
    await r.tasks.insertAcceptanceVersion({ taskId: f.taskId, acceptanceRevision: 2n,
      objective: '重开后的结果', requiredOutputSpec: {}, source: 'REOPEN' });
  });
  await sql`update tasks set acceptance_revision = 2, revision = revision + 1
    where id = ${f.taskId}`.execute(app.db);
  const newCycle = await loadSkillBasis(app.db, f.workspaceId, f.projectId, null, resume);
  assert.deepEqual(newCycle.facts.current_verifications, []);
  assert.equal((newCycle.baseline.tasks as { id: string;
    acceptance_revision: string }[]).find((task) => task.id === f.taskId)
    ?.acceptance_revision, '2');
});

async function generateTaskSkillProposal(f: Fixture, skillId:
  'task-to-execution-contract' | 'verification-plan',
  sourceRefs?: readonly { kind: 'KNOWLEDGE'; root_id: string; version: string }[]):
  Promise<{ id: string; messageId: string; payloadHash: string; taskRevision: string;
    acceptanceRevision: string }> {
  const session = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: `Skill ${skillId}` });
  const request = await requestAssistMessage(app.db, { workspaceId: f.workspaceId,
    sessionId: session.result.session_id, commandId: randomUUID(),
    content: '给出可审查的任务验收建议',
    skillRef: { id: skillId, version: '1.1.0' },
    ...(sourceRefs === undefined ? {} : { sourceRefs }) });
  const tick = await runAssistGenerationTick(app.db, { workerId: `skill-${randomUUID()}`,
    storage, modelPort, leaseMs: 30_000 });
  assert.equal(tick?.messageId, request.result.assistant_message_id);
  assert.equal(tick.status, 'COMPLETED');
  assert.equal(tick.proposalIds.length, 1);
  const row = await sql<{ base_revision: bigint; base_acceptance_revision: bigint;
    payload_hash: string }>`select base_revision, base_acceptance_revision,
    payload_hash from assist_proposals where id = ${tick.proposalIds[0]!}`.execute(app.db);
  return { id: tick.proposalIds[0]!, messageId: request.result.assistant_message_id,
    payloadHash: row.rows[0]!.payload_hash,
    taskRevision: row.rows[0]!.base_revision.toString(),
    acceptanceRevision: row.rows[0]!.base_acceptance_revision.toString() };
}

test('Task Definition acceptance uses Task Owner CAS and invalidates old evidence atomically', async () => {
  const f = await fixture('READY');
  const priorSessionId = randomUUID();
  const priorReviewId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.verifications.insertSession({ id: priorSessionId, taskId: f.taskId,
      acceptanceRevision: 1n, runId: null, executionContractId: null,
      verifierPolicyVersion: 'test-v1', checkPlanHash: Buffer.alloc(32, 4),
      checkPlan: { kind: 'fixture' } });
    const target = { task_id: f.taskId, acceptance_revision: '1' };
    await r.reviews.insertRequest({ id: priorReviewId, workspaceId: f.workspaceId,
      projectId: f.projectId, taskId: f.taskId, runId: null,
      verificationSessionId: null, criterionId: null, operationId: null,
      importJobId: null, kind: 'STATE_PROPOSAL', reason: 'fixture',
      targetHash: reviewTargetHash(target), target, evidence: {}, effect: {},
      allowedDecisions: ['ACCEPT'], expiresAt: null });
  });
  const proposal = await generateTaskSkillProposal(f, 'task-to-execution-contract');
  const before = await readTaskCheckPlanPreview(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId });
  assert.equal(before.status, 'AVAILABLE');
  const commandId = randomUUID();
  const input = { workspaceId: f.workspaceId, proposalId: proposal.id, commandId,
    storage, expectedTaskRevision: proposal.taskRevision,
    expectedAcceptanceRevision: proposal.acceptanceRevision,
    payloadHash: proposal.payloadHash };
  const accepted = await acceptAssistProposal(app.db, input);
  const replay = await acceptAssistProposal(app.db, input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, accepted.result);
  assert.equal(accepted.result.acceptance_revision, '2');
  assert.equal(accepted.result.revision, '1');
  assert.equal(accepted.result.status, 'READY');
  const finalCriteria = accepted.result.criteria as { criterion_id: string;
    statement: string; required: boolean }[];
  assert.ok(finalCriteria.some((item) => item.criterion_id === 'human' &&
    item.statement === '人工验收' && item.required));
  assert.equal((accepted.result.added_criterion_ids as string[]).length, 1);
  const row = await sql<{ mode: string; executor_kind: string; status: string }>`
    select mode, executor_kind, status from tasks where id = ${f.taskId}`.execute(app.db);
  assert.deepEqual(row.rows[0], { mode: 'ME', executor_kind: 'HUMAN', status: 'READY' });
  assert.equal((await createRepositories(app.db).verifications.readApplicability(priorSessionId))
    ?.reason, 'ACCEPTANCE_CONTRACT_CHANGED');
  assert.equal((await createRepositories(app.db).reviews.readRequest(priorReviewId))
    ?.status, 'EXPIRED');
  const after = await readTaskCheckPlanPreview(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId });
  assert.equal(after.status, 'AVAILABLE');
  assert.equal((after.sources as { acceptance_revision: string }).acceptance_revision, '2');
  assert.notEqual(after.check_plan_sha256, before.check_plan_sha256);
  const second = domainError(await acceptAssistProposal(app.db, { ...input,
    commandId: randomUUID() }).catch((error) => error));
  assert.equal(second.code, 'INVALID_TRANSITION');
  const activities = await sql<{ count: string }>`select count(*)::text as count
    from activity_records where command_id = ${commandId}`.execute(app.db);
  assert.equal(activities.rows[0]!.count, '1');
});

test('Task Definition v1.1 changes Expected Result description through HTTP without losing old output constraints', async () => {
  const original = { artifacts: ['MARKDOWN_DOCUMENT'], description: '旧结果说明',
    retention: { policy: 'keep-original' } };
  const f = await fixture('READY', original);
  const proposal = await generateTaskSkillProposal(f, 'task-to-execution-contract');
  const api = await startTestApi();
  try {
    const base = workspacePath(f.workspaceId);
    const detail = await api.get(`${base}/assist-proposals/${proposal.id}`);
    assert.equal(detail.status, 200);
    const dto = detail.body as { payload_available: boolean;
      payload: { required_output_spec: JsonObject }; payload_hash: string };
    assert.equal(dto.payload_available, true);
    assert.equal(dto.payload_hash, proposal.payloadHash);
    assert.deepEqual(dto.payload.required_output_spec, {
      ...original, description: '交付一份可核对的 Markdown 结果说明。' });
    const missingCas = await api.post(`${base}/assist-proposals/${proposal.id}/accept`,
      { command_id: randomUUID() });
    expectProblem(missingCas, 422, 'VALIDATION_FAILED');
    const commandId = randomUUID();
    const body = { command_id: commandId,
      expected_task_revision: proposal.taskRevision,
      expected_acceptance_revision: proposal.acceptanceRevision,
      payload_hash: proposal.payloadHash };
    const accepted = await api.post(`${base}/assist-proposals/${proposal.id}/accept`, body);
    assert.equal(accepted.status, 200);
    const result = (accepted.body as { result: { required_output_spec: JsonObject;
      acceptance_revision: string } }).result;
    assert.equal(result.acceptance_revision, '2');
    assert.deepEqual(result.required_output_spec, dto.payload.required_output_spec);
    const replay = await api.post(`${base}/assist-proposals/${proposal.id}/accept`, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual((replay.body as { result: unknown }).result, result);
    const preview = await api.get(`${base}/tasks/${f.taskId}/check-plan-preview`);
    assert.equal(preview.status, 200);
    assert.equal((preview.body as { sources: { acceptance_revision: string } })
      .sources.acceptance_revision, '2');
  } finally { await api.stop(); }
});

test('Task Owner rejects forged Skill payload that weakens old criteria or output requirements', async () => {
  const f = await fixture('READY', { artifacts: ['MARKDOWN_DOCUMENT'],
    retention: { policy: 'keep-original' } });
  const generated = await generateTaskSkillProposal(f, 'task-to-execution-contract');
  const original = await createRepositories(app.db).assist.readProposal(generated.id);
  assert.ok(original);
  for (const tamper of ['required', 'outputs'] as const) {
    const payload: JsonObject = tamper === 'required'
      ? { ...original.payload, criteria: (original.payload.criteria as JsonObject[])
        .map((criterion, index) => index === 0
          ? { ...criterion, required: false } : criterion) }
      : { ...original.payload, required_output_spec: {
        ...(original.payload.required_output_spec as JsonObject), artifacts: [] } };
    const forgedId = randomUUID();
    await withTransaction(app.db, async (r) => {
      await r.assist.insertProposal({ id: forgedId, workspaceId: f.workspaceId,
        sessionId: original.session_id, messageId: original.message_id,
        kind: original.kind, projectId: f.projectId, taskId: f.taskId,
        targetType: 'TASK', targetId: f.taskId,
        baseRevision: original.base_revision,
        baseAcceptanceRevision: original.base_acceptance_revision,
        payload, payloadHash: assistPayloadHash(payload),
        skillSha256: original.skill_sha256,
        skillOutputSha256: original.skill_output_sha256 });
    });
    const error = domainError(await acceptAssistProposal(app.db, {
      workspaceId: f.workspaceId, proposalId: forgedId,
      commandId: randomUUID(), storage,
      expectedTaskRevision: generated.taskRevision,
      expectedAcceptanceRevision: generated.acceptanceRevision,
      payloadHash: assistPayloadHash(payload),
    }).catch((caught) => caught));
    assert.equal(error.code, 'INVALID_TRANSITION');
    assert.equal((await readProposal(forgedId)).status, 'PENDING');
  }
  const versions = await sql<{ count: string }>`select count(*)::text as count
    from task_acceptances where task_id = ${f.taskId}`.execute(app.db);
  assert.equal(versions.rows[0]!.count, '1');
});

test('verification-plan v1.1 appends registered criteria; legacy version is historical only', async () => {
  const f = await fixture('READY');
  const legacySession = await createAssistSession(app.db, { workspaceId: f.workspaceId,
    commandId: randomUUID(), taskId: f.taskId, title: 'Legacy check' });
  const legacy = domainError(await requestAssistMessage(app.db, {
    workspaceId: f.workspaceId, sessionId: legacySession.result.session_id,
    commandId: randomUUID(), content: '旧版',
    skillRef: { id: 'verification-plan', version: '1.0.0' },
  }).catch((error) => error));
  assert.equal(legacy.code, 'VALIDATION_FAILED');
  const proposal = await generateTaskSkillProposal(f, 'verification-plan');
  const result = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId: proposal.id, commandId: randomUUID(), storage,
    expectedTaskRevision: proposal.taskRevision,
    expectedAcceptanceRevision: proposal.acceptanceRevision,
    payloadHash: proposal.payloadHash });
  assert.equal(result.result.acceptance_revision, '2');
  assert.equal((result.result.added_criterion_ids as string[]).length, 1);
  const preview = await readTaskCheckPlanPreview(app.db, { workspaceId: f.workspaceId,
    taskId: f.taskId });
  assert.equal(preview.status, 'AVAILABLE');
  assert.equal((preview.check_plan as { entries: unknown[] }).entries.length, 2);
  assert.equal(preview.executed, false);
  assert.equal(preview.frozen_run_plan, false);
});

test('Task Skill acceptance rejects stale, occupied, cross-scope and revoked source', async () => {
  const stale = await fixture('READY');
  const staleProposal = await generateTaskSkillProposal(stale, 'task-to-execution-contract');
  await editTaskPresentation(app.db, { workspaceId: stale.workspaceId,
    taskId: stale.taskId, commandId: randomUUID(),
    expectedRevision: staleProposal.taskRevision, title: '版本变化' });
  const staleError = domainError(await acceptAssistProposal(app.db, {
    workspaceId: stale.workspaceId, proposalId: staleProposal.id,
    commandId: randomUUID(), storage,
    expectedTaskRevision: staleProposal.taskRevision,
    expectedAcceptanceRevision: staleProposal.acceptanceRevision,
    payloadHash: staleProposal.payloadHash,
  }).catch((error) => error));
  assert.equal(staleError.code, 'REVISION_CONFLICT');
  assert.equal((await readProposal(staleProposal.id)).status, 'EXPIRED');
  const occupied = await fixture('READY');
  await delegateTask(app.db, { workspaceId: occupied.workspaceId,
    taskId: occupied.taskId, commandId: randomUUID(), expectedTaskRevision: '0' });
  const occupiedProposal = await generateTaskSkillProposal(occupied, 'verification-plan');
  const occupiedError = domainError(await acceptAssistProposal(app.db, {
    workspaceId: occupied.workspaceId, proposalId: occupiedProposal.id,
    commandId: randomUUID(), storage,
    expectedTaskRevision: occupiedProposal.taskRevision,
    expectedAcceptanceRevision: occupiedProposal.acceptanceRevision,
    payloadHash: occupiedProposal.payloadHash,
  }).catch((error) => error));
  assert.equal(occupiedError.code, 'EXECUTOR_CONFLICT');
  const other = await fixture('READY');
  const cross = domainError(await acceptAssistProposal(app.db, {
    workspaceId: other.workspaceId, proposalId: occupiedProposal.id,
    commandId: randomUUID(), storage,
    expectedTaskRevision: occupiedProposal.taskRevision,
    expectedAcceptanceRevision: occupiedProposal.acceptanceRevision,
    payloadHash: occupiedProposal.payloadHash,
  }).catch((error) => error));
  assert.equal(cross.code, 'RESOURCE_NOT_FOUND');
  const sourced = await fixture('READY');
  const knowledge = await createKnowledge(app.db, { workspaceId: sourced.workspaceId,
    projectId: sourced.projectId, commandId: randomUUID(), title: '来源',
    source: { sourceKind: 'NOTE', text: '仅作为数据' } });
  const ref = { kind: 'KNOWLEDGE' as const,
    root_id: knowledge.result.knowledge_id!, version: '1' };
  const sourceProposal = await generateTaskSkillProposal(sourced,
    'verification-plan', [ref]);
  await withTransaction(app.db, async (r) => {
    await r.information.setRootStatus('knowledge', ref.root_id, 'ARCHIVED');
  });
  const api = await startTestApi();
  try {
    const detail = await api.get(`${workspacePath(sourced.workspaceId)}/assist-proposals/` +
      sourceProposal.id);
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { payload_available: boolean }).payload_available, false);
    assert.deepEqual((detail.body as { payload: object }).payload, {});
  } finally { await api.stop(); }
  const revoked = domainError(await acceptAssistProposal(app.db, {
    workspaceId: sourced.workspaceId, proposalId: sourceProposal.id,
    commandId: randomUUID(), storage,
    expectedTaskRevision: sourceProposal.taskRevision,
    expectedAcceptanceRevision: sourceProposal.acceptanceRevision,
    payloadHash: sourceProposal.payloadHash,
  }).catch((error) => error));
  assert.equal(revoked.code, 'INVALID_TRANSITION');
});

test('concurrent Task Skill accept commands commit one acceptance and one receipt', async () => {
  const f = await fixture('READY');
  const proposal = await generateTaskSkillProposal(f, 'verification-plan');
  const base = { workspaceId: f.workspaceId, proposalId: proposal.id, storage,
    expectedTaskRevision: proposal.taskRevision,
    expectedAcceptanceRevision: proposal.acceptanceRevision,
    payloadHash: proposal.payloadHash };
  const commandIds = [randomUUID(), randomUUID()];
  const outcomes = await Promise.allSettled(commandIds.map((commandId) =>
    acceptAssistProposal(app.db, { ...base, commandId })));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(domainError(failed?.reason).code, 'INVALID_TRANSITION');
  const count = await sql<{ versions: string; receipts: string }>`select
    (select count(*)::text from task_acceptances where task_id = ${f.taskId}) as versions,
    (select count(*)::text from command_receipts
      where command_id in (${commandIds[0]!}, ${commandIds[1]!})) as receipts`
    .execute(app.db);
  assert.deepEqual(count.rows[0], { versions: '2', receipts: '1' });
});

test('Task Skill acceptance rejects UNKNOWN from a terminal Run without releasing its identity', async () => {
  const f = await fixture('READY');
  const proposal = await generateTaskSkillProposal(f, 'task-to-execution-contract');
  const runId = randomUUID();
  const stepId = randomUUID();
  const connectionId = randomUUID();
  const policyId = randomUUID();
  const resourceId = randomUUID();
  const operationId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.runs.insertRun({ id: runId, workspaceId: f.workspaceId,
      taskId: f.taskId, ownershipEpoch: 0n, retryOfRunId: null });
    await r.runs.insertExecutionContract({ runId, taskId: f.taskId,
      acceptanceRevision: 1n, workflowKey: 'markdown-deliverable-v1',
      workflowVersion: '1', executionConfigVersion: 'default-execution-config-v1',
      contractHash: Buffer.alloc(32, 2), frozenSnapshot: {} });
    await r.runs.insertRunSteps([{ id: stepId, runId, stepIndex: 0,
      stepKind: 'DRAFT' }]);
    await r.runs.advanceRun({ runId, expectedRevision: 0n, status: 'FAILED', terminal: true });
    await r.gateway.insertConnection({ id: connectionId, workspaceId: f.workspaceId,
      projectId: f.projectId, config: {} });
    await r.gateway.addConnectionCapability(connectionId, 'FAKE_WRITE');
    await r.gateway.insertPolicy({ id: policyId, workspaceId: f.workspaceId,
      projectId: f.projectId, capability: 'FAKE_WRITE', actionType: 'WRITE_MARKER',
      targetPrefix: '.', decision: 'AUTO', maxPayloadBytes: 4096 });
    await r.gateway.insertResource({ id: resourceId, workspaceId: f.workspaceId,
      projectId: f.projectId, canonicalRoot: 'C:\\relay-unknown-test',
      identityKey: `test:${resourceId}`, fileWriteRootId: null });
    await r.gateway.insertOperation({ id: operationId,
      workspace_id: f.workspaceId, project_id: f.projectId,
      origin: 'RUN', task_id: f.taskId, run_id: runId, step_id: stepId,
      import_job_id: null, intent_key: 'unknown-test', connection_id: connectionId,
      connection_version: 1n, connection_config: {}, policy_id: policyId,
      policy_version: 1n, capability_key: 'FAKE_WRITE', action_type: 'WRITE_MARKER',
      normalized_target: 'unknown-test', params_hash: Buffer.alloc(32, 1),
      params: {}, resource_id: resourceId, status: 'UNKNOWN' });
  });
  const error = domainError(await acceptAssistProposal(app.db, {
    workspaceId: f.workspaceId, proposalId: proposal.id,
    commandId: randomUUID(), storage,
    expectedTaskRevision: proposal.taskRevision,
    expectedAcceptanceRevision: proposal.acceptanceRevision,
    payloadHash: proposal.payloadHash,
  }).catch((caught) => caught));
  assert.equal(error.code, 'EXECUTOR_CONFLICT');
  assert.equal((await createRepositories(app.db).gateway.readOperation(operationId))?.status,
    'UNKNOWN');
  assert.equal((await readProposal(proposal.id)).status, 'PENDING');
});

test('Task Skill business writes and proposal decision roll back together on audit failure', async () => {
  const f = await fixture('READY');
  const proposal = await generateTaskSkillProposal(f, 'verification-plan');
  const migrator = openDatabase(MIGRATION_DATABASE_URL, 'relay-api-test-skill-audit-fault');
  const commandId = randomUUID();
  try {
    await sql`create function test_fail_skill_activity() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'TASK_ACCEPTANCE_CHANGED' then
          raise exception 'injected skill audit failure';
        end if;
        return new;
      end $$`.execute(migrator.db);
    await sql`create trigger test_fail_skill_activity before insert on activity_records
      for each row execute function test_fail_skill_activity()`.execute(migrator.db);
    const failed = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
      proposalId: proposal.id, commandId, storage,
      expectedTaskRevision: proposal.taskRevision,
      expectedAcceptanceRevision: proposal.acceptanceRevision,
      payloadHash: proposal.payloadHash }).catch((error) => error);
    assert.ok(failed instanceof Error);
    assert.equal((await readProposal(proposal.id)).status, 'PENDING');
    assert.equal(await readTaskRevision(f.taskId), proposal.taskRevision);
    const cycles = await sql<{ count: string }>`select count(*)::text as count
      from task_acceptances where task_id = ${f.taskId}`.execute(app.db);
    assert.equal(cycles.rows[0]!.count, '1');
  } finally {
    await sql`drop trigger if exists test_fail_skill_activity on activity_records`
      .execute(migrator.db);
    await sql`drop function if exists test_fail_skill_activity()`
      .execute(migrator.db);
    await migrator.close();
  }
  const accepted = await acceptAssistProposal(app.db, { workspaceId: f.workspaceId,
    proposalId: proposal.id, commandId, storage,
    expectedTaskRevision: proposal.taskRevision,
    expectedAcceptanceRevision: proposal.acceptanceRevision,
    payloadHash: proposal.payloadHash });
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.result.acceptance_revision, '2');
});

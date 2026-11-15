import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage, setSessionContextBudget }
  from '../../src/application/assist-commands.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { freezeAssistModelSnapshot } from '../../src/application/assist-model-snapshot.js';
import { resolveRunModelPort } from '../../src/application/run-model-port.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { prepareAutomaticMemory, runAssistMemoryTick } from '../../src/application/assist-memory-runner.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { setWorkspaceContextBudget } from '../../src/application/workspace-default-directory.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { ExecutionContractRow, RunRow } from '../../src/infrastructure/database-schema.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY, openDatabase } from
  './integration-support.js';

/**
 * 0135 / 0165：旧档位端点仍兼容，但预算与压缩判定只认模型能力。
 *
 * 只证明三件事：
 *  1. `/context-budget` 仍是一条与默认写档位同规格的带修订写（CAS、重放、词表、严格请求体）；
 *  2. 真实聊天入口按模型窗口冻结预算：旧会话档位改大或改小都不再改变预留；
 *  3. Run 准入按「当前配置 + 冻结模型容量」复核，不把旧档位误判成配置变化。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-context-budget');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

/** 1M 模型能力 + 2M 作用域：预算由能力决定，旧档位不再放宽或收紧请求。 */
const env: NodeJS.ProcessEnv = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_API_KEY: 'fixture-key',
  RELAY_MODEL_NAME: 'fixture-model',
  RELAY_MODEL_BASE_URL: 'https://models.vendor.com/v1',
  RELAY_MODEL_TIMEOUT_MS: '5000',
  RELAY_MODEL_MAX_OUTPUT_TOKENS: '256',
  RELAY_MODEL_MAX_CALL_TOKENS: '1000000',
  RELAY_MODEL_MAX_SCOPE_CALLS: '32',
  RELAY_MODEL_MAX_SCOPE_TOKENS: '2000000',
  RELAY_MODEL_CONTEXT_WINDOW: '1000000',
};

const BIG_MESSAGE = 'x'.repeat(15_000);
const REPLY = '收到。';

function sse(promptTokens: number): Response {
  const usage = { prompt_tokens: promptTokens, completion_tokens: 20,
    total_tokens: promptTokens + 20 };
  return new Response([
    `data: ${JSON.stringify({ id: 'chatcmpl-budget', object: 'chat.completion.chunk',
      created: 1, model: 'fixture-model', choices: [{ index: 0,
        delta: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-budget', object: 'chat.completion.chunk',
      created: 1, model: 'fixture-model', choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const transport: ModelFetchDependencies = {
  lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  fetch: async () => sse(5_000),
};

async function fixture(): Promise<{ workspaceId: string; projectId: string; sessionId: string }> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'context-budget' });
    await r.workspaces.insertAuthorityRow(workspaceId);
    await r.projects.insertProject({ id: projectId, workspaceId,
      title: 'Context budget', projectType: 'GENERAL' });
  });
  // 本套件只测主回复的预算；关掉自动提取，避免它再产生一次外呼打乱账本行数。
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(), expectedRevision: '0',
    recallEnabled: true, automaticCompaction: false, autoCapture: false });
  const session = await createAssistSession(app.db, { workspaceId, projectId,
    title: 'budget', commandId: randomUUID() });
  return { workspaceId, projectId, sessionId: session.result.session_id };
}

/** 0145：档位现在是会话级事实，测试按会话设置（工作区默认只影响没有会话的消费者）。 */
async function setSessionBudget(workspaceId: string, sessionId: string, tokens: number) {
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: tokens });
}

async function tick(workspaceId: string, sessionId: string) {
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: BIG_MESSAGE }, env);
  assert.ok(sent.result.assistant_message_id, JSON.stringify(sent));
  const config = readModelPortConfig(env);
  assert.ok(config);
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  return { sent, ticked };
}

test('历史再长也只按 350K 阈值判断，不因旧档位不同而分叉', async () => {
  const f = await fixture();
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '1', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const r = createRepositories(app.db);
  for (let i = 1; i <= 34; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
    seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
    content: 'history '.repeat(700), sources: [] });
  const options = { workerId: randomUUID(), leaseMs: 60_000, storage: new ManagedContentStore(dataRoot),
    modelPort: new FakeModelPort(), modelEnv: env };
  assert.equal(await prepareAutomaticMemory(app.db, f.sessionId, null, options), false,
    '34 条短消息远低于 350K，不因消息条数触发压缩');
  const result = await tick(f.workspaceId, f.sessionId);
  assert.equal(result.ticked?.status, 'COMPLETED', JSON.stringify(result.ticked));
  assert.equal((await r.assistMemory.requests(f.sessionId)).length, 0);
});

test('20 × 42K 字符约 280K tokens：低于 350K 不压缩，原始消息全保留', async () => {
  const f = await fixture();
  await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
    expectedRevision: '1', recallEnabled: true, automaticCompaction: true, autoCapture: false });
  const r = createRepositories(app.db);
  for (let i = 1; i <= 20; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
    seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
    content: 'x'.repeat(42_000), sources: [] });
  const modelPort = new FakeModelPort();
  modelPort.assist = async () => ({ kind: 'CONTENT', content: JSON.stringify({ summary:
    ['【当前目标与范围】retained goal and next step', '【有效约束与偏好】无', '【已确认决策】无',
      '【已验证进展与证据】无', '【未完成事项与下一步】无', '【未决问题、失败与 UNKNOWN】无',
      '【被替代或已撤回的要求】无', '【来源】integration fixture'].join('\n') }),
    providerRequestId: randomUUID(), usage: { inputTokens: 100, outputTokens: 20 } });
  const options = { workerId: randomUUID(), leaseMs: 60_000, storage: new ManagedContentStore(dataRoot), modelPort,
    modelEnv: env };
  assert.equal(await prepareAutomaticMemory(app.db, f.sessionId, null, options), false,
    '1M 模型上 350K 默认阈值不应被 280K 内容触发');
  assert.equal((await r.assist.listMessages(f.sessionId)).length, 20, 'compression preserves originals');
});

test('CB-01: /context-budget 是带修订的幂等写；三档词表、重放与严格请求体同默认写档位', async () => {
  const api = await startTestApi();
  try {
    const f = await fixture();
    const path = workspacePath(f.workspaceId, '/context-budget');
    const projection = workspacePath(f.workspaceId, '/default-working-directory');
    const empty = await api.get(projection);
    assert.equal(empty.status, 200, empty.text);
    assert.equal((empty.body as { context_budget_tokens: unknown }).context_budget_tokens, null);
    assert.equal((empty.body as { revision: string }).revision, '0');

    const commandId = randomUUID();
    const body = { command_id: commandId, expected_revision: '0', context_budget_tokens: 262_144 };
    const set = await api.post(path, body);
    assert.equal(set.status, 200, set.text);
    assert.deepEqual((set.body as { result: unknown }).result, { workspace_id: f.workspaceId,
      context_budget_tokens: 262_144, revision: '1' });
    assert.deepEqual((await api.post(path, body)).body, set.body, '同一条命令重放返回同一份回执');
    assert.equal((await api.get(projection).then((r) => r.body) as {
      context_budget_tokens: number }).context_budget_tokens, 262_144);

    // 陈旧修订 + 不同的值＝冲突；陈旧修订 + 同一个值＝目标已达成，不是冲突。
    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '0',
      context_budget_tokens: 524_288 })).status, 409);
    const redeclared = await api.post(path, { command_id: randomUUID(), expected_revision: '0',
      context_budget_tokens: 262_144 });
    assert.equal(redeclared.status, 200, redeclared.text);
    assert.equal((redeclared.body as { result: { revision: string } }).result.revision, '1');
    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '1',
      context_budget_tokens: 300_000 })).status, 422, '词表只有 256K／512K／1M');
    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '0',
      resource_id: f.projectId })).status, 422, '严格请求体：多余的键不是上下文长度命令');

    const cleared = await api.post(path, { command_id: randomUUID(), expected_revision: '1',
      context_budget_tokens: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal((cleared.body as { result: { context_budget_tokens: unknown } })
      .result.context_budget_tokens, null);
  } finally { await api.stop(); }
});

test('CB-02: 真实聊天入口按模型窗口外呼；旧档位改大改小都不改变预留', async () => {
  const f = await fixture();
  // 旧档位先写 256K，再写 1M；冻结预算都必须是模型容量 1M。
  await setSessionBudget(f.workspaceId, f.sessionId, 262_144);
  const first = await tick(f.workspaceId, f.sessionId);
  assert.equal(first.ticked?.status, 'COMPLETED', JSON.stringify(first.ticked));
  const firstMessage = (await sql<{ snapshot: { budget: {
    call_reservation_tokens: number; scope_call_limit: number; scope_token_limit: number;
    context_budget_tokens: number | null; model_context_window_tokens: number | null;
    provider_call_cap_tokens: number | null; context_window_source: string;
    budget_basis: string; fallback_applied: boolean } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${first.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.deepEqual(firstMessage?.snapshot.budget, { call_reservation_tokens: 1_000_000,
    scope_call_limit: 32, scope_token_limit: 2_000_000, context_budget_tokens: 1_000_000,
    model_context_window_tokens: 1_000_000, provider_call_cap_tokens: 1_000_000,
    context_window_source: 'MODEL_CONFIG', budget_basis: 'MODEL_CONTEXT_WINDOW',
    fallback_applied: false });

  // 把旧档位改成 512K：下一次调用的预留、作用域上限与冻结窗口都**不**跟着换。
  await setSessionContextBudget(app.db, { workspaceId: f.workspaceId, sessionId: f.sessionId,
    commandId: randomUUID(), expectedRevision: '1', budgetTokens: 524_288 });
  const second = await tick(f.workspaceId, f.sessionId);
  assert.equal(second.ticked?.status, 'COMPLETED', JSON.stringify(second.ticked));
  const secondMessage = (await sql<{ snapshot: { budget: { call_reservation_tokens: number;
    context_budget_tokens: number | null } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${second.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.equal(secondMessage?.snapshot.budget.call_reservation_tokens, 1_000_000);
  assert.equal(secondMessage?.snapshot.budget.context_budget_tokens, 1_000_000);
  const calls = (await sql<{ status: string; budget_reserved_tokens: number | null;
    usage_input_tokens: number | null; context_usage: { categories: { key: string }[] } | null }>`
      select status, budget_reserved_tokens, usage_input_tokens, context_usage from model_calls
      where assist_message_id = ${second.sent.result.assistant_message_id}`.execute(app.db)).rows;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, 'COMPLETED');
  assert.equal(calls[0]?.budget_reserved_tokens, 1_000_000,
    '记账预留取模型真实窗口，不是旧档位 512K');
  assert.equal(calls[0]?.usage_input_tokens, 5_000, 'Provider 真实上报的用量照常落账');
  assert.ok((calls[0]?.context_usage?.categories ?? []).some((entry) => entry.key === 'SYSTEM'),
    '这次调用的上下文构成随 CALL 行一起落库');

  // 另一条会话读到同一份模型容量。
  const otherFixture = await fixture();
  const other = await tick(otherFixture.workspaceId, otherFixture.sessionId);
  assert.equal(other.ticked?.status, 'COMPLETED', JSON.stringify(other.ticked));
  const otherMessage = (await sql<{ snapshot: { budget: { call_reservation_tokens: number } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${other.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.equal(otherMessage?.snapshot.budget.call_reservation_tokens, 1_000_000,
    '旧档位不会让另一条会话分叉');

  // 同一会话的第二次调用：作用域上限 2M 足以覆盖「一笔已结算 + 一笔新预留」。
  const again = await tick(f.workspaceId, f.sessionId);
  assert.equal(again.ticked?.status, 'COMPLETED', JSON.stringify(again.ticked));
});

test('CB-03: Run 准入按冻结的模型容量重算预算，旧档位不参与', async () => {
  const f = await fixture();
  await setSessionBudget(f.workspaceId, f.sessionId, 262_144);
  const plan = await freezeAssistModelSnapshot(createRepositories(app.db), undefined, env,
    { requiresTools: false, requiresJsonOutput: false },
    { workspaceId: f.workspaceId, sessionId: f.sessionId });
  assert.ok(plan);
  const budget = (plan.snapshot.budget as { call_reservation_tokens: number;
    scope_token_limit: number; context_budget_tokens: number | null;
    budget_basis: string; model_context_window_tokens: number | null });
  assert.deepEqual(budget, { call_reservation_tokens: 1_000_000, scope_call_limit: 32,
    scope_token_limit: 2_000_000, context_budget_tokens: 1_000_000,
    model_context_window_tokens: 1_000_000, provider_call_cap_tokens: 1_000_000,
    context_window_source: 'MODEL_CONFIG', budget_basis: 'MODEL_CONTEXT_WINDOW',
    fallback_applied: false });

  const admission = await resolveRunModelPort(app.db, {
    run: { id: randomUUID() } as unknown as RunRow,
    contract: { frozen_snapshot: { model_selection_snapshot: plan.snapshot },
      credential_fingerprint: plan.credentialFingerprint } as unknown as ExecutionContractRow,
    env, transport: {},
  });
  assert.equal(admission.kind, 'READY', JSON.stringify(admission));
  if (admission.kind !== 'READY') return;
  assert.equal(admission.basis, 'FROZEN');
  assert.deepEqual(admission.port.identity.budget, { callReservationTokens: 1_000_000,
    scopeCallLimit: 32, scopeTokenLimit: 2_000_000 },
  'Run 端口拿到的也是冻结的模型容量');
});

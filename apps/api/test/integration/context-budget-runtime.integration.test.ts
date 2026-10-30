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
 * 0135：工作区上下文长度三档必须**真的影响运行时**（P1-A）。
 *
 * 只证明「设置存下来了」「快照里有这个数」不够。这里固定三件事：
 *  1. `/context-budget` 是一条与默认写档位同规格的带修订写（CAS、重放、词表、严格请求体）；
 *  2. 真实聊天入口按冻结档位外呼：进程默认 4,096 时一条 15k 字符的消息会被端口拒绝，
 *     选定 256K 后同一入口完成，账本预留与作用域上限都换成这一档；
 *  3. Run 准入按「当前配置 + 冻结档位」重算预期预算：选中档位不再被误判成配置变化，
 *     且端口拿到的实际预算也是这一档。
 *
 * 未选定档位时按进程默认拒绝超预算输入；工作容量检查可在真实外呼前提前拒绝。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-context-budget');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

/** 进程默认单次预算 4,096：低于下面这条消息的估算输入，档位必须真的放宽它。 */
const env: NodeJS.ProcessEnv = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_API_KEY: 'fixture-key',
  RELAY_MODEL_NAME: 'fixture-model',
  RELAY_MODEL_BASE_URL: 'https://models.vendor.com/v1',
  RELAY_MODEL_TIMEOUT_MS: '5000',
  RELAY_MODEL_MAX_OUTPUT_TOKENS: '256',
  RELAY_MODEL_MAX_CALL_TOKENS: '4096',
  RELAY_MODEL_MAX_SCOPE_CALLS: '32',
  RELAY_MODEL_MAX_SCOPE_TOKENS: '16384',
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
  const config = readModelPortConfig(env);
  assert.ok(config);
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot), modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  return { sent, ticked };
}

test('selected tiers keep short turns uncompressed and permit history beyond the old 128KB limit', async () => {
  for (const budgetTokens of [262_144, 524_288, 1_048_576] as const) {
    const f = await fixture();
    await setSessionBudget(f.workspaceId, f.sessionId, budgetTokens);
    await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
      expectedRevision: '1', recallEnabled: true, automaticCompaction: true, autoCapture: false });
    const r = createRepositories(app.db);
    for (let i = 1; i <= 34; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
      seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
      content: 'history '.repeat(700), sources: [] });
    const options = { workerId: randomUUID(), leaseMs: 60_000, storage: new ManagedContentStore(dataRoot),
      modelPort: new FakeModelPort() };
    assert.equal(await prepareAutomaticMemory(app.db, f.sessionId, null, options), false,
      'short turns must not trigger compaction simply because there are 32 messages');
    const result = await tick(f.workspaceId, f.sessionId);
    assert.equal(result.ticked?.status, 'COMPLETED', JSON.stringify(result.ticked));
    assert.equal((await r.assistMemory.requests(f.sessionId)).length, 0);
  }
});

test('256K compacts at its pressure threshold while 512K and 1024K retain the same originals', async () => {
  for (const budgetTokens of [262_144, 524_288, 1_048_576] as const) {
    const f = await fixture();
    await setSessionBudget(f.workspaceId, f.sessionId, budgetTokens);
    await setMemorySettings(app.db, { workspaceId: f.workspaceId, commandId: randomUUID(),
      expectedRevision: '1', recallEnabled: true, automaticCompaction: true, autoCapture: false });
    const r = createRepositories(app.db);
    for (let i = 1; i <= 12; i++) await r.assist.insertMessage({ id: randomUUID(), sessionId: f.sessionId,
      seq: BigInt(i), role: i % 2 ? 'USER' : 'ASSISTANT', status: 'COMPLETED', intent: 'DISCUSS',
      content: 'x'.repeat(42_000), sources: [] });
    const modelPort = new FakeModelPort();
    modelPort.assist = async () => ({ kind: 'CONTENT', content: JSON.stringify({ summary: 'retained goal and next step' }),
      providerRequestId: randomUUID(), usage: { inputTokens: 100, outputTokens: 20 } });
    const options = { workerId: randomUUID(), leaseMs: 60_000, storage: new ManagedContentStore(dataRoot), modelPort };
    const prepared = await prepareAutomaticMemory(app.db, f.sessionId, null, options);
    assert.equal(prepared, budgetTokens === 262_144);
    if (prepared) {
      const compacted = await runAssistMemoryTick(app.db, options);
      assert.equal(compacted?.status, 'COMPLETED', JSON.stringify(compacted));
      const state = await r.assistMemory.state(f.sessionId);
      assert.equal((await r.assistMemory.checkpoint(state!.checkpoint_id!))?.through_seq, 4n);
    }
    assert.equal((await r.assist.listMessages(f.sessionId)).length, 12, 'compression preserves originals');
  }
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

test('CB-02: 真实聊天入口按**会话档位**外呼；改档不影响其它会话', async () => {
  const f = await fixture();
  // 会话建立时就有确定档位（262144），不需要先去设置页选一次。
  const first = await tick(f.workspaceId, f.sessionId);
  assert.equal(first.ticked?.status, 'COMPLETED', JSON.stringify(first.ticked));
  const firstMessage = (await sql<{ snapshot: { budget: { call_reservation_tokens: number;
    scope_call_limit: number; scope_token_limit: number;
    context_budget_tokens: number | null } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${first.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.deepEqual(firstMessage?.snapshot.budget, { call_reservation_tokens: 262_144,
    scope_call_limit: 32, scope_token_limit: 524_288, context_budget_tokens: 262_144 });

  // 把这条会话改成 512K：下一次调用的预留、作用域上限与冻结档位一起换成新档。
  await setSessionContextBudget(app.db, { workspaceId: f.workspaceId, sessionId: f.sessionId,
    commandId: randomUUID(), expectedRevision: '0', budgetTokens: 524_288 });
  const second = await tick(f.workspaceId, f.sessionId);
  assert.equal(second.ticked?.status, 'COMPLETED', JSON.stringify(second.ticked));
  const secondMessage = (await sql<{ snapshot: { budget: { call_reservation_tokens: number;
    scope_call_limit: number; scope_token_limit: number;
    context_budget_tokens: number | null } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${second.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.deepEqual(secondMessage?.snapshot.budget, { call_reservation_tokens: 524_288,
    scope_call_limit: 32, scope_token_limit: 1_048_576, context_budget_tokens: 524_288 });
  const calls = (await sql<{ status: string; budget_reserved_tokens: number | null;
    usage_input_tokens: number | null; context_usage: { categories: { key: string }[] } | null }>`
      select status, budget_reserved_tokens, usage_input_tokens, context_usage from model_calls
      where assist_message_id = ${second.sent.result.assistant_message_id}`.execute(app.db)).rows;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.status, 'COMPLETED');
  assert.equal(calls[0]?.budget_reserved_tokens, 524_288,
    '记账预留取会话档位，不是进程默认 4,096');
  assert.equal(calls[0]?.usage_input_tokens, 5_000, 'Provider 真实上报的用量照常落账');
  assert.ok((calls[0]?.context_usage?.categories ?? []).some((entry) => entry.key === 'SYSTEM'),
    '这次调用的上下文构成随 CALL 行一起落库');

  // 另一条会话不受影响：它自己的档位仍是 262144。
  const otherFixture = await fixture();
  const other = await tick(otherFixture.workspaceId, otherFixture.sessionId);
  assert.equal(other.ticked?.status, 'COMPLETED', JSON.stringify(other.ticked));
  const otherMessage = (await sql<{ snapshot: { budget: { call_reservation_tokens: number } } }>`
      select model_selection_snapshot as snapshot from assist_messages
      where id = ${other.sent.result.assistant_message_id}`.execute(app.db)).rows[0];
  assert.equal(otherMessage?.snapshot.budget.call_reservation_tokens, 262_144,
    '改 A 的档位不会改到 B');

  // 同一会话的第二次调用：作用域上限必须留出第二份预留，否则第一次结算后无法再调用。
  const again = await tick(f.workspaceId, f.sessionId);
  assert.equal(again.ticked?.status, 'COMPLETED', JSON.stringify(again.ticked));
});

test('CB-03: Run 准入按「当前配置 + 冻结档位」重算预算，不把选中档位误判成配置变化', async () => {
  const f = await fixture();
  await setSessionBudget(f.workspaceId, f.sessionId, 262_144);
  const plan = await freezeAssistModelSnapshot(createRepositories(app.db), undefined, env,
    { requiresTools: false, requiresJsonOutput: false },
    { workspaceId: f.workspaceId, sessionId: f.sessionId });
  assert.ok(plan);
  const budget = (plan.snapshot.budget as { call_reservation_tokens: number;
    scope_token_limit: number; context_budget_tokens: number | null });
  assert.deepEqual(budget, { call_reservation_tokens: 262_144, scope_call_limit: 32,
    scope_token_limit: 524_288, context_budget_tokens: 262_144 });

  const admission = await resolveRunModelPort(app.db, {
    run: { id: randomUUID() } as unknown as RunRow,
    contract: { frozen_snapshot: { model_selection_snapshot: plan.snapshot },
      credential_fingerprint: plan.credentialFingerprint } as unknown as ExecutionContractRow,
    env, transport: {},
  });
  assert.equal(admission.kind, 'READY', JSON.stringify(admission));
  if (admission.kind !== 'READY') return;
  assert.equal(admission.basis, 'FROZEN');
  assert.deepEqual(admission.port.identity.budget, { callReservationTokens: 262_144,
    scopeCallLimit: 32, scopeTokenLimit: 524_288 },
  'Run 端口拿到的也是冻结档位，而不是进程默认 4,096');
});

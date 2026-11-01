import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { Client } from 'pg';
import { sql } from 'kysely';

import { createAssistSession, requestAssistMessage, setSessionContextBudget }
  from '../../src/application/assist-commands.js';
import { deleteAssistSession } from '../../src/application/assist-session-controls.js';
import { executeChatCommand } from '../../src/application/execute-chat-command.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import { readSessionContextUsage } from '../../src/application/assist-context-projection.js';
import { createRepositories, withTransaction } from '../../src/application/unit-of-work.js';
import { setMemorySettings } from '../../src/application/memory-settings.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { OpenAiCompatibleModelPort } from '../../src/workflow/openai-compatible-model-port.js';
import { readModelPortConfig } from '../../src/workflow/model-port-config.js';
import { createDataRoot, startTestApi, workspacePath } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL, MIGRATIONS_DIRECTORY,
  createTemporaryDatabase, openDatabase } from './integration-support.js';

/**
 * 0145：上下文档位是**会话级**事实，用量分项绑定到**确切的一次调用**。
 *
 * 这组用例全部走真实数据库：
 *   SB-01 每会话独立保存 + CAS + 命令幂等，刷新/重开读回同一个值；
 *   SB-02 新会话继承跳转前会话的档位，改子不改父，无来源与跨工作区来源都退回 256K；
 *   SB-03 升级兼容：既有会话按当时生效的口径回填，不留 NULL；
 *   SB-04 用量投影只读最近一次调用，分项来自真实请求、旧数据明确为「没有分项」。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-session-budget');
let dataRoot: string;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
});
after(async () => { await app.close(); });

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

/** 真实端口的假传输：Provider 只回总量，分项只能来自服务端自己装配请求时的统计。 */
const transport: ModelFetchDependencies = {
  lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  fetch: async () => {
    const usage = { prompt_tokens: 1_200, completion_tokens: 40, total_tokens: 1_240 };
    return new Response([
      `data: ${JSON.stringify({ id: 'chatcmpl-session-budget', object: 'chat.completion.chunk',
        created: 1, model: 'fixture-model', choices: [{ index: 0,
          delta: { role: 'assistant', content: '收到。' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-session-budget', object: 'chat.completion.chunk',
        created: 1, model: 'fixture-model', choices: [], usage })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
};

async function workspace(): Promise<string> {
  const workspaceId = randomUUID();
  await withTransaction(app.db, async (r) => {
    await r.workspaces.insertWorkspace({ id: workspaceId, name: 'session-budget' });
    await r.workspaces.insertAuthorityRow(workspaceId);
  });
  // 自动提取会额外产生一次外呼，与用量面板断言无关，统一关掉。
  await setMemorySettings(app.db, { workspaceId, commandId: randomUUID(), expectedRevision: '0',
    recallEnabled: true, automaticCompaction: false, autoCapture: false });
  return workspaceId;
}

async function session(workspaceId: string, sourceSessionId?: string): Promise<string> {
  const created = await createAssistSession(app.db, { workspaceId, title: 'budget',
    commandId: randomUUID(),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }) });
  return created.result.session_id;
}

async function tier(sessionId: string): Promise<number> {
  const row = await createRepositories(app.db).assist.readSession(sessionId);
  assert.ok(row);
  return row.context_budget_tokens;
}

test('SB-01: 每个会话独立保存档位；CAS 与命令幂等对档位单独成立', async () => {
  const workspaceId = await workspace();
  const a = await session(workspaceId);
  const b = await session(workspaceId);
  assert.equal(await tier(a), 262_144, '新会话从 256K 起步');
  assert.equal(await tier(b), 262_144);

  await setSessionContextBudget(app.db, { workspaceId, sessionId: a, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 524_288 });
  assert.equal(await tier(a), 524_288);
  assert.equal(await tier(b), 262_144, 'B 不受 A 的保存影响');

  await setSessionContextBudget(app.db, { workspaceId, sessionId: b, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 262_144 });
  assert.equal(await tier(a), 524_288, 'B 的保存也没有覆盖 A');
  assert.equal(await tier(b), 262_144);

  // 读回（模拟刷新/重开/重启后重新连库）：值来自数据库而不是进程内状态。
  const reread = await createRepositories(app.db).assist.readSession(a);
  assert.equal(reread?.context_budget_tokens, 524_288);
  assert.equal(reread?.context_budget_revision, 1n);

  // 陈旧修订 = 409，且不改库；同一 command_id 重放返回同一份回执。
  await assert.rejects(() => setSessionContextBudget(app.db, { workspaceId, sessionId: a,
    commandId: randomUUID(), expectedRevision: '0', budgetTokens: 1_048_576 }),
  (error: { code?: string }) => error.code === 'REVISION_CONFLICT');
  assert.equal(await tier(a), 524_288);

  const commandId = randomUUID();
  const first = await setSessionContextBudget(app.db, { workspaceId, sessionId: a, commandId,
    expectedRevision: '1', budgetTokens: 1_048_576 });
  const replay = await setSessionContextBudget(app.db, { workspaceId, sessionId: a, commandId,
    expectedRevision: '1', budgetTokens: 1_048_576 });
  assert.deepEqual(replay.result, first.result, '同一条命令重放返回同一份回执');
  assert.equal(first.result.revision, '2');
  assert.equal(await tier(a), 1_048_576);

  // 换一个值再按同一 command_id 重放 = 异载荷，不得被当成同一条命令。
  await assert.rejects(() => setSessionContextBudget(app.db, { workspaceId, sessionId: a,
    commandId, expectedRevision: '1', budgetTokens: 524_288 }));
});

test('SB-02: 新会话继承来源会话的档位；改子不改父；无来源默认 256K', async () => {
  const workspaceId = await workspace();
  const a = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId: a, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 524_288 });

  const b = await session(workspaceId, a);
  assert.equal(await tier(b), 524_288, 'B 继承 A 的 512K');
  await setSessionContextBudget(app.db, { workspaceId, sessionId: b, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 1_048_576 });
  assert.equal(await tier(a), 524_288, 'B 改档不回写来源会话 A');

  const c = await session(workspaceId, b);
  assert.equal(await tier(c), 1_048_576, 'C 从 B 继承 1024K');

  // 没有来源：从 256K 起，并且这个值真的写进了新会话（不是读时补的默认）。
  const fresh = await session(workspaceId);
  assert.equal(await tier(fresh), 262_144);

  // 跨工作区的来源不参与继承：读不到就不猜，也不改别人。
  const other = await workspace();
  const foreign = await session(other);
  await setSessionContextBudget(app.db, { workspaceId: other, sessionId: foreign,
    commandId: randomUUID(), expectedRevision: '0', budgetTokens: 1_048_576 });
  const isolated = await session(workspaceId, foreign);
  assert.equal(await tier(isolated), 262_144, '跨工作区来源按「没有来源」处理');
  assert.equal(await tier(foreign), 1_048_576, '来源会话本身不被改动');
});

test('SB-03: 升级兼容——既有会话按当时生效的证据回填，不留 NULL', async () => {
  const database = await createTemporaryDatabase('sessionbudgetbackfill');
  const phaseOne = await mkdtemp(join(tmpdir(), 'relay-migrations-'));
  try {
    // 只应用 0145 之前的迁移，构造「升级前」的库。
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (!name.endsWith('.sql') || name >= '0145') continue;
      await copyFile(join(MIGRATIONS_DIRECTORY, name), join(phaseOne, name));
    }
    await runMigrations({ connectionString: database.migrationUrl, directory: phaseOne });

    const workspaces = { withTier: randomUUID(), without: randomUUID() };
    const sessions = { inherited: randomUUID(), fallback: randomUUID() };
    const client = new Client({ connectionString: database.migrationUrl });
    await client.connect();
    try {
      for (const id of [workspaces.withTier, workspaces.without]) {
        await client.query('insert into workspaces (id, name) values ($1, $2)', [id, 'upgrade']);
        await client.query(`insert into workspace_execution_authority
          (workspace_id, revision, context_revision) values ($1, 0, 0)`, [id]);
      }
      await client.query(`insert into workspace_default_directories
        (workspace_id, context_budget_tokens) values ($1, 524288)`, [workspaces.withTier]);
      await client.query('insert into assist_sessions (id, workspace_id, title) values ($1, $2, $3)',
        [sessions.inherited, workspaces.withTier, 'old-with-tier']);
      await client.query('insert into assist_sessions (id, workspace_id, title) values ($1, $2, $3)',
        [sessions.fallback, workspaces.without, 'old-without-tier']);

      // 现在升级：只差 0145 这一条。
      await runMigrations({ connectionString: database.migrationUrl, directory: MIGRATIONS_DIRECTORY });
      const rows = (await client.query<{ id: string; context_budget_tokens: number;
        context_budget_revision: string }>(`select id, context_budget_tokens,
        context_budget_revision from assist_sessions where id = any($1::uuid[])`,
      [[sessions.inherited, sessions.fallback]])).rows;
      const byId = new Map(rows.map((row) => [row.id, row]));
      assert.equal(byId.get(sessions.inherited)?.context_budget_tokens, 524_288,
        '设过工作区档位的会话按那个值回填');
      assert.equal(byId.get(sessions.fallback)?.context_budget_tokens, 262_144,
        '没设过的会话落到 256K，而不是留 NULL');
      assert.equal(String(byId.get(sessions.fallback)?.context_budget_revision), '0');
    } finally { await client.end(); }
  } finally {
    await rm(phaseOne, { recursive: true, force: true });
    await database.drop();
  }
});

test('SB-04: 用量投影给当前档位与最近一次调用的真实构成；旧调用明确「没有分项」', async () => {
  const workspaceId = await workspace();
  const sessionId = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 524_288 });

  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '帮我看看这段说明。' }, env);
  const config = readModelPortConfig(env);
  assert.ok(config);
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot),
    modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));

  const usage = await readSessionContextUsage(app.db, workspaceId, sessionId);
  assert.equal(usage.budget.tokens, 524_288);
  assert.equal(usage.budget.revision, '1');
  assert.equal(usage.last_call?.source, 'MODEL_CALL');
  assert.equal(usage.last_call?.input_tokens, 1_200);
  assert.equal(usage.last_call?.output_tokens, 40);
  // 缓存读数由 Provider 决定；假传输没有上报，面板就不显示这一格（不是 0）。
  assert.equal(usage.last_call?.cache_read_tokens, null);
  assert.equal(usage.last_call?.reserved_tokens, 524_288);
  const breakdown = usage.last_call?.breakdown;
  assert.ok(breakdown, '本次调用带有分项构成');
  assert.equal(breakdown.precision, 'ESTIMATED');
  assert.equal(breakdown.method, 'UTF8_BYTES_DIV_3');
  const keys = breakdown.categories.map((entry) => entry.key);
  assert.ok(keys.includes('SYSTEM'), '系统提示词单独成项');
  assert.ok(keys.includes('HISTORY'), '历史消息单独成项');
  assert.ok(keys.includes('MEMORY'), '会话上下文/资料注入单独成项');
  assert.equal(breakdown.estimated_total_tokens,
    breakdown.categories.reduce((sum, entry) => sum + entry.tokens, 0));
  assert.equal(breakdown.categories.some((entry) => entry.tokens === 0), false,
    '空分类不出现，避免零值被读成「占了一点」');
  assert.ok(!keys.includes('FILE_READS'), '这一轮没有读文件，就不该出现文件读取项');

  // 旧调用（0145 之前）：同一行有总量但没有分项 → 面板显示「暂无分项统计」，总数仍可读。
  // 应用角色没有 model_calls 的 update 权限（账本只写不改）；这里用迁移角色造一条
  // 「0145 之前写入、没有分项」的旧行，模拟升级前的真实数据形态。
  const migrator = new Client({ connectionString: MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('update model_calls set context_usage = null where assist_message_id = $1',
      [sent.result.assistant_message_id]);
  } finally { await migrator.end(); }
  const legacy = await readSessionContextUsage(app.db, workspaceId, sessionId);
  assert.equal(legacy.last_call?.input_tokens, 1_200);
  assert.equal(legacy.last_call?.breakdown, null);

  // 会话属于自己的事实：另一条会话读到的档位与调用互不影响。
  const idle = await session(workspaceId);
  const idleUsage = await readSessionContextUsage(app.db, workspaceId, idle);
  assert.equal(idleUsage.budget.tokens, 262_144);
  assert.equal(idleUsage.last_call, null);
});

test('SB-05: HTTP 面——档位保存回执逐字核对；用量投影与命令体严格', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = await workspace();
    const sessionId = await session(workspaceId);
    const path = workspacePath(workspaceId, `/assist-sessions/${sessionId}/context-budget`);
    const usagePath = workspacePath(workspaceId, `/assist-sessions/${sessionId}/context-usage`);

    const before = await api.get(usagePath);
    assert.equal(before.status, 200, before.text);
    assert.equal((before.body as { budget: { tokens: number } }).budget.tokens, 262_144);

    const commandId = randomUUID();
    const body = { command_id: commandId, expected_revision: '0', context_budget_tokens: 1_048_576 };
    const saved = await api.post(path, body);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual((saved.body as { result: unknown }).result, { session_id: sessionId,
      context_budget_tokens: 1_048_576, revision: '1' });
    assert.deepEqual((await api.post(path, body)).body, saved.body, '同一条命令重放返回同一份回执');

    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '0',
      context_budget_tokens: 524_288 })).status, 409, '陈旧修订是冲突');
    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '1',
      context_budget_tokens: 300_000 })).status, 422, '词表只有 256K／512K／1024K');
    assert.equal((await api.post(path, { command_id: randomUUID(), expected_revision: '1',
      context_budget_tokens: 524_288, extra: true })).status, 422, '严格请求体');

    const after = await api.get(usagePath);
    assert.deepEqual((after.body as { budget: unknown }).budget, { tokens: 1_048_576,
      revision: '1' });

    // 同一 workspace 里另一条会话读不到这条会话的档位。
    const other = await session(workspaceId);
    const otherUsage = await api.get(
      workspacePath(workspaceId, `/assist-sessions/${other}/context-usage`));
    assert.equal((otherUsage.body as { budget: { tokens: number } }).budget.tokens, 262_144);
  } finally { await api.stop(); }
});

test('SB-06: 首条消息之前选的档位写进创建事务，第一个模型调用就按它冻结预算', async () => {
  const workspaceId = await workspace();
  const created = await createAssistSession(app.db, { workspaceId, title: 'explicit',
    commandId: randomUUID(), contextBudgetTokens: 1_048_576 });
  const sessionId = created.result.session_id;
  assert.equal(await tier(sessionId), 1_048_576, '显式档位在创建事务里落库');

  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '按这一档跑' }, env);
  const config = readModelPortConfig(env);
  assert.ok(config);
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot),
    modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));
  const calls = (await sql<{ budget_reserved_tokens: number | null }>`
    select budget_reserved_tokens from model_calls
    where assist_message_id = ${sent.result.assistant_message_id}`.execute(app.db)).rows;
  assert.equal(calls[0]?.budget_reserved_tokens, 1_048_576,
    '第一个模型调用按用户选的那一档冻结预算，不是 256K 也不是事后再补写');
});

test('SB-07: /new 建出的会话继承来源会话的档位', async () => {
  const workspaceId = await workspace();
  const source = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId: source,
    commandId: randomUUID(), expectedRevision: '0', budgetTokens: 1_048_576 });
  const outcome = await executeChatCommand(app.db, { workspaceId, sessionId: source,
    commandId: randomUUID(), text: '/new' });
  assert.equal(outcome.result.kind, 'NEW_SESSION');
  const created = String((outcome.result as { session_id: string }).session_id);
  assert.notEqual(created, source);
  assert.equal(await tier(created), 1_048_576, '/new 的新会话继承来源会话的档位');
  assert.equal(await tier(source), 1_048_576, '来源会话自己的档位不被改写');
});

test('SB-08: 历史调用没有可靠冻结预算时，投影不拿当前档位冒充', async () => {
  const workspaceId = await workspace();
  const sessionId = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 1_048_576 });
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '记一笔' }, env);
  const config = readModelPortConfig(env);
  assert.ok(config);
  await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot),
    modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  // 造一条「旧调用」：没有预留列（0145 之前的历史数据）。
  const migrator = new Client({ connectionString: MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query('update model_calls set budget_reserved_tokens = null where assist_message_id = $1',
      [sent.result.assistant_message_id]);
  } finally { await migrator.end(); }
  const usage = await readSessionContextUsage(app.db, workspaceId, sessionId);
  assert.equal(usage.last_call?.input_tokens, 1_200);
  assert.equal(usage.last_call?.reserved_tokens, null,
    '没有冻结预算就说没有：不能拿当前档位冒充历史预算');
});

test('SB-09: 来源不存在或已被删除——按「没有来源」回退默认档建会话，不抛错', async () => {
  const workspaceId = await workspace();
  // 合法 UUID、但库里没有这一行：继承是便利，不是授权，读不到来源就退回 256K。
  const missing = randomUUID();
  const created = await session(workspaceId, missing);
  assert.equal(await tier(created), 262_144, '来源不存在按默认档建会话');

  // 来源「被删除后」的语义与不存在相同：读不到行就回退，不伪造继承成功。
  const doomed = await session(workspaceId);
  const doomedRow = await createRepositories(app.db).assist.readSession(doomed);
  assert.ok(doomedRow);
  await deleteAssistSession(app.db, { workspaceId, sessionId: doomed, commandId: randomUUID(),
    expectedRevision: String(doomedRow.revision) });
  const afterDelete = await session(workspaceId, doomed);
  assert.equal(await tier(afterDelete), 262_144, '来源删除后退回默认档');

  // 空串与 undefined 同一条规则：视为没有来源。
  const blank = await session(workspaceId, '');
  assert.equal(await tier(blank), 262_144, '空串来源视为没有来源');
});

test('SB-10: HTTP 面——畸形 source_session_id 被请求契约明确拒绝，合法但无此行的来源按默认档建出', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = await workspace();
    const createPath = workspacePath(workspaceId, '/assist-sessions');

    // 畸形 UUID：TypeBox 的 uuid 契约在 HTTP 边界就拒掉，到不了领域层，更不会崩。
    const malformed = await api.post(createPath, { command_id: randomUUID(),
      title: 'malformed-source', source_session_id: 'null' });
    assert.equal(malformed.status, 422, `字面 "null" 必须被请求契约拒绝：${malformed.text}`);
    const notUuid = await api.post(createPath, { command_id: randomUUID(),
      title: 'malformed-source', source_session_id: 'not-a-uuid' });
    assert.equal(notUuid.status, 422, '畸形 UUID 必须被请求契约拒绝');

    // 合法 UUID 但来源不存在：按契约回退默认档，创建成功。
    const missingSource = await api.post(createPath, { command_id: randomUUID(),
      title: 'missing-source', source_session_id: randomUUID() });
    assert.equal(missingSource.status, 201, missingSource.text);
    const createdId = String((missingSource.body as { result: { session_id: string } })
      .result.session_id);
    assert.equal(await tier(createdId), 262_144, '来源不存在按默认档建会话');
  } finally { await api.stop(); }
});

test('SB-11: 辅助外呼（记忆提取/压缩）进账本，但不抢「最近一次调用」的读数', async () => {
  const workspaceId = await workspace();
  const sessionId = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 524_288 });
  const sent = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '帮我看看这段说明。' }, env);
  const config = readModelPortConfig(env);
  assert.ok(config);
  const ticked = await runAssistGenerationTick(app.db, { workerId: randomUUID(),
    storage: new ManagedContentStore(dataRoot),
    modelPort: new OpenAiCompatibleModelPort(config, transport),
    modelEnv: env, modelFetchDependencies: transport, leaseMs: 60_000 });
  assert.equal(ticked?.status, 'COMPLETED', JSON.stringify(ticked));

  const before = await readSessionContextUsage(app.db, workspaceId, sessionId);
  assert.equal(before.last_call?.input_tokens, 1_200, '面向用户的那次调用是最近一次调用');

  // 造一条辅助调用：同一条助手消息、晚一秒、输入很小、没有分项——真实形态就是
  // 记忆提取/压缩那一类外呼。应用角色没有 model_calls 的写权限，用迁移角色插入。
  const migrator = new Client({ connectionString: MIGRATION_DATABASE_URL });
  await migrator.connect();
  try {
    await migrator.query(`insert into model_calls (id, workspace_id, kind, assist_message_id,
      provider, model, config_fingerprint, status, usage_input_tokens, usage_output_tokens,
      budget_reserved_tokens, purpose, started_at, settled_at)
      values ($1, $2, 'ASSIST', $3, 'openai-compatible', 'fixture-model',
      repeat('a', 64),
      'COMPLETED', 512, 6, 524288, 'MEMORY_CAPTURE', now(), now())`,
    [randomUUID(), workspaceId, sent.result.assistant_message_id]);
  } finally { await migrator.end(); }

  const after = await readSessionContextUsage(app.db, workspaceId, sessionId);
  assert.equal(after.last_call?.input_tokens, 1_200,
    '辅助调用不覆盖最近一次调用的读数（否则用户看到的是 512 tokens 的提取调用）');
  assert.ok(after.last_call?.breakdown, '面向用户的那次调用仍然带着分项');
});

test('SB-12: 投影给出「下次调用会申请的预算」；窗口未知时不冒充可用容量', async () => {
  const workspaceId = await workspace();
  const sessionId = await session(workspaceId);
  await setSessionContextBudget(app.db, { workspaceId, sessionId, commandId: randomUUID(),
    expectedRevision: '0', budgetTokens: 1_048_576 });

  const usage = await readSessionContextUsage(app.db, workspaceId, sessionId, env);
  assert.equal(usage.next_call?.reservation_tokens, 1_048_576, '按当前档位申请');
  assert.equal(usage.next_call?.context_budget_tokens, 1_048_576);
  assert.equal(usage.next_call?.provider_window_tokens, null, '默认连接没有模型窗口事实');
  assert.equal(usage.next_call?.window_source, 'UNKNOWN', '窗口未知就如实说未知');

  // HTTP 面也带同一份事实（响应 schema 是 strict：未声明的字段会被丢掉）。
  const api = await startTestApi({ env });
  try {
    const body = await api.get(workspacePath(workspaceId,
      `/assist-sessions/${sessionId}/context-usage`));
    assert.equal(body.status, 200, body.text);
    const next = (body.body as { next_call: { reservation_tokens: number;
      window_source: string } }).next_call;
    assert.equal(next.reservation_tokens, 1_048_576);
    assert.equal(next.window_source, 'UNKNOWN');
  } finally { await api.stop(); }
});

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { ComposerDraftGate, runComposerDraftAssist }
  from '../../src/application/composer-draft-assist.js';
import { DomainError } from '../../src/application/domain-error.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { ComposerDraftPort, ComposerDraftRequest, ComposerDraftResult, ModelUsage }
  from '../../src/workflow/fake-model-port.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 发送前草稿辅助的真实 PG 证据（测试计划 §31 CO-08/CO-09/CO-10 的持久化部分）。
 *
 * 受控模型端口替换真实 Provider，但账本、准入与事务都是真的：这里要证明的是
 * 「辅助调用被如实记入既有 model_calls，且不产生任何业务事实」——不是证明模型质量。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-composer-draft');

const USAGE: ModelUsage = { inputTokens: 120, outputTokens: 40,
  cacheReadTokens: null, cacheCreationTokens: null };

class StubComposerPort implements ComposerDraftPort {
  readonly identity = { provider: 'openai-compatible', model: 'stub-composer',
    configFingerprint: 'a'.repeat(64) };
  readonly seen: ComposerDraftRequest[] = [];
  constructor(private readonly respond: (request: ComposerDraftRequest)
    => ComposerDraftResult | Error) {}
  async draftAssist(request: ComposerDraftRequest): Promise<ComposerDraftResult> {
    this.seen.push(request);
    const outcome = this.respond(request);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function content(text: string): ComposerDraftResult {
  return { kind: 'CONTENT', content: text, providerRequestId: 'req-stub', usage: USAGE };
}

/** 新闸门：测试要连续调用，不能撞上实例级最小间隔。 */
function openGate(): ComposerDraftGate {
  return new ComposerDraftGate(0, 4);
}

async function composerRows(): Promise<readonly {
  kind: string; status: string; step_attempt_id: string | null;
  assist_message_id: string | null; manifest_id: string | null; criterion_id: string | null;
  provider_request_id: string | null; usage_input_tokens: number | null;
  usage_output_tokens: number | null; error_kind: string | null;
}[]> {
  const result = await sql<{
    kind: string; status: string; step_attempt_id: string | null;
    assist_message_id: string | null; manifest_id: string | null; criterion_id: string | null;
    provider_request_id: string | null; usage_input_tokens: number | null;
    usage_output_tokens: number | null; error_kind: string | null;
  }>`select kind, status, step_attempt_id, assist_message_id, manifest_id, criterion_id,
      provider_request_id, usage_input_tokens, usage_output_tokens, error_kind
    from model_calls where kind = 'COMPOSER' order by started_at, id`.execute(database.db);
  return result.rows;
}

async function businessCounts(): Promise<{ tasks: number; runs: number; messages: number }> {
  const rows = await sql<{ tasks: string; runs: string; messages: string }>`
    select (select count(*) from tasks)::text as tasks,
      (select count(*) from runs)::text as runs,
      (select count(*) from assist_messages)::text as messages`.execute(database.db);
  const row = rows.rows[0]!;
  return { tasks: Number(row.tasks), runs: Number(row.runs), messages: Number(row.messages) };
}

async function expectDomainError(work: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${String(error)}`);
    assert.equal((error as DomainError).code, code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

test('分点：只记录调用证据，不产生任何消息/Task/Run', async () => {
  const workspaceId = await createWorkspace(database.db);
  const before = await businessCounts();
  const rowsBefore = (await composerRows()).length;
  const draft = '给登录页加个记住密码，密码输错了要提示原因，还有登录按钮现在太小了改大一点，'
    + '手机上也要能正常显示，先不要做短信登录';
  const port = new StubComposerPort(() => content('{"breaks":[11,22,38,49]}'));

  const outcome = await runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'OUTLINE', text: draft, port, gate: openGate() });

  assert.deepEqual(outcome, { status: 'OUTLINE', itemCount: 5, text: [
    '1. 给登录页加个记住密码，',
    '2. 密码输错了要提示原因，',
    '3. 还有登录按钮现在太小了改大一点，',
    '4. 手机上也要能正常显示，',
    '5. 先不要做短信登录',
  ].join('\n') });
  // 端口只收到这一份草稿与操作类型，没有历史、资料或文件。
  assert.equal(port.seen.length, 1);
  assert.deepEqual(port.seen[0], { operation: 'OUTLINE', text: draft, signal: undefined });

  const rows = await composerRows();
  assert.equal(rows.length, rowsBefore + 1);
  const row = rows.at(-1)!;
  assert.equal(row.kind, 'COMPOSER');
  assert.equal(row.status, 'COMPLETED');
  // 无 Run/会话作用域：草稿辅助不占 Run 或会话预算，也不挂到任何消息上。
  assert.equal(row.step_attempt_id, null);
  assert.equal(row.assist_message_id, null);
  assert.equal(row.manifest_id, null);
  assert.equal(row.criterion_id, null);
  assert.equal(row.provider_request_id, 'req-stub');
  assert.equal(row.usage_input_tokens, 120);
  assert.equal(row.usage_output_tokens, 40);
  assert.deepEqual(await businessCounts(), before);
});

test('润色：写入润色文本，账本同样只留调用证据', async () => {
  const workspaceId = await createWorkspace(database.db);
  const before = await businessCounts();
  const port = new StubComposerPort(() => content('{"text":"给登录页加记住密码；密码错误时提示原因。"}'));
  const outcome = await runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'POLISH', text: '给登录页加个记住密码，密码输错了要提示原因', port,
    gate: openGate() });
  assert.deepEqual(outcome, { status: 'POLISH', text: '给登录页加记住密码；密码错误时提示原因。' });
  assert.deepEqual(await businessCounts(), before);
});

test('不适用分点时不发起调用：没有新账本行', async () => {
  const workspaceId = await createWorkspace(database.db);
  const rowsBefore = (await composerRows()).length;
  const port = new StubComposerPort(() => content('{"breaks":[3]}'));
  // 已分行的草稿视为用户已经组织好，不自动分点。
  const outcome = await runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'OUTLINE', text: '第一行要改\n第二行也要改，而且还有第三件事', port,
    gate: openGate() });
  assert.deepEqual(outcome, { status: 'NO_SUGGESTION' });
  assert.equal(port.seen.length, 0);
  assert.equal((await composerRows()).length, rowsBefore);
});

test('畸形协议如实拒绝，但这次调用仍按 COMPLETED 记账（可能已计费）', async () => {
  const workspaceId = await createWorkspace(database.db);
  const rowsBefore = (await composerRows()).length;
  const port = new StubComposerPort(() => content('{"breaks":[999]}'));
  await expectDomainError(() => runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'OUTLINE', text: '给登录页加个记住密码，密码输错了要提示原因', port,
    gate: openGate() }), 'COMPOSER_RESPONSE_INVALID');
  const rows = await composerRows();
  assert.equal(rows.length, rowsBefore + 1);
  const row = rows.at(-1)!;
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.usage_input_tokens, 120);
});

test('Provider 失败记 FAILED 与错误分类，不留 STARTED', async () => {
  const workspaceId = await createWorkspace(database.db);
  const port = new StubComposerPort(() => {
    const error = new Error('socket hang up');
    error.name = 'FetchError';
    return error;
  });
  await assert.rejects(() => runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'POLISH', text: '给登录页加个记住密码，密码输错了要提示原因', port,
    gate: openGate() }));
  const row = (await composerRows()).at(-1)!;
  assert.equal(row.status, 'FAILED');
  assert.equal(row.error_kind, 'FetchError');
});

test('闸门限流：被拒绝的请求不写账本，也不调用端口', async () => {
  const workspaceId = await createWorkspace(database.db);
  const rowsBefore = (await composerRows()).length;
  const port = new StubComposerPort(() => content('{"text":"改好了"}'));
  const gate = new ComposerDraftGate(10_000, 4);
  await runComposerDraftAssist({ db: database.db, workspaceId, env: {}, operation: 'POLISH',
    text: '给登录页加个记住密码，密码输错了要提示原因', port, gate });
  await expectDomainError(() => runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'POLISH', text: '给登录页加个记住密码，密码输错了要提示原因', port, gate }),
  'COMPOSER_RATE_LIMITED');
  assert.equal(port.seen.length, 1);
  assert.equal((await composerRows()).length, rowsBefore + 1);
});

test('未配置模型与超长草稿都在开事务之前如实拒绝', async () => {
  const workspaceId = await createWorkspace(database.db);
  const rowsBefore = (await composerRows()).length;
  // 没有端口、环境也没有真实 Provider：如实报不可用，草稿与发送不受影响。
  await expectDomainError(() => runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'POLISH', text: '给登录页加个记住密码，密码输错了要提示原因' }),
  'MODEL_PORT_NOT_CONFIGURED');
  await expectDomainError(() => runComposerDraftAssist({ db: database.db, workspaceId,
    env: {}, operation: 'POLISH', text: '改'.repeat(4001), gate: openGate() }),
  'COMPOSER_DRAFT_TOO_LONG');
  assert.equal((await composerRows()).length, rowsBefore);
});

test('HTTP：未配置 Provider 时如实 409，请求体不合法 422，未授权 401', async () => {
  const saved = process.env.RELAY_MODEL_PROVIDER;
  delete process.env.RELAY_MODEL_PROVIDER;
  const api = await startTestApi();
  try {
    const workspaceId = await createWorkspace(database.db);
    const unauthorized = await api.post(workspacePath(workspaceId, '/composer/draft-assist'),
      { operation: 'OUTLINE', text: '给登录页加个记住密码，密码输错了要提示原因' },
      { headers: { authorization: 'Bearer wrong-token' } });
    expectProblem(unauthorized, 401, 'AUTH_REQUIRED');

    const notConfigured = await api.post(workspacePath(workspaceId, '/composer/draft-assist'),
      { operation: 'OUTLINE', text: '给登录页加个记住密码，密码输错了要提示原因' });
    expectProblem(notConfigured, 409, 'MODEL_PORT_NOT_CONFIGURED');

    const malformed = await api.post(workspacePath(workspaceId, '/composer/draft-assist'),
      { operation: 'REWRITE', text: '给登录页加个记住密码' });
    assert.equal(malformed.status, 422);

    const badWorkspace = await api.post('/api/v1/workspaces/not-a-uuid/composer/draft-assist',
      { operation: 'OUTLINE', text: '给登录页加个记住密码' });
    assert.equal(badWorkspace.status, 422);
  } finally {
    await api.stop();
    if (saved === undefined) delete process.env.RELAY_MODEL_PROVIDER;
    else process.env.RELAY_MODEL_PROVIDER = saved;
  }
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await database.close(); });

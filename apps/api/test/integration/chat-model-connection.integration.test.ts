import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { requestAssistMessage } from '../../src/application/assist-commands.js';
import { parseAssistModelSnapshot } from '../../src/application/assist-model-snapshot.js';
import { runAssistGenerationTick } from '../../src/application/assist-runner.js';
import {
  createModelConnectionCommand,
  readChatDefaultModelConnection,
  rotateModelConnectionCredentialCommand,
  setChatDefaultModelConnectionCommand,
  setDefaultModelConnectionCommand,
  setModelConnectionStatusCommand,
  updateModelConnectionCommand,
} from '../../src/application/model-connections.js';
import { readModelConnectionVerificationState, runModelPortVerification }
  from '../../src/application/model-port-verification.js';
import { selectSessionConnection } from '../../src/application/select-session-model.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { DomainError } from '../../src/application/domain-error.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import {
  CredentialStoreUnavailableError,
  type CredentialStore,
} from '../../src/credentials/credential-store.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { FakeModelPort } from '../../src/workflow/fake-model-port.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { createFakeVerifyCall, ModelVerifyTargetError }
  from '../../src/workflow/model-port-verify.js';
import { createDataRoot, createWorkspace, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * MODEL-SETTINGS-01 P0：已登记连接 → 会话选择 → 消息冻结 → 执行端解析 → 外呼 → 账本。
 *
 * 证明的是「设置里登记的连接真的能被聊天用上」，且三处默认各自作用域：
 *   * 会话显式选择已登记连接后，消息在受理事务里冻结连接身份；受理之后改聊天默认或 Run
 *     默认都不影响在途消息——外呼型号与 Key 仍来自原连接；
 *   * 停用、改型号、轮换 Key 都在外呼之前以精确停因码停止，零外呼、无账本行，绝不退回
 *     进程默认或另一条连接；
 *   * 每条连接独立验证：同 provider + 同型号的两条连接不互相冒充；轮换后旧结论立即失效；
 *   * 工作区聊天默认（chat_connection_id）只决定新会话冻结，显式会话选择优先、Run 默认
 *     不受影响，取消后回到进程默认；停用的聊天默认让新消息失败而不是静默换模型。
 *
 * 凭据用内存实现，只验证「连接身份 → 配置 → 外呼」；DPAPI 本身由 credential-store 与
 * model-connections 套件用真实 helper 验证。Provider 是受控 fetch 接缝，不触达真实网络。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-chat-model-connection-test');
let dataRoot: string;
let storage: ManagedContentStore;

/** 进程默认刻意是另一个型号：执行端若偷偷回退，断言会立刻失败。 */
const PROCESS_DEFAULT_ENV = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: 'synthetic/process-default',
  RELAY_MODEL_API_KEY: 'synthetic-process-default-key',
  RELAY_MODEL_BASE_URL: 'https://model-gateway.example.com/v1',
} as NodeJS.ProcessEnv;

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  dataRoot = await createDataRoot();
  storage = new ManagedContentStore(dataRoot);
});
after(async () => { await app.close(); });

function memoryCredentials(): CredentialStore & { readonly secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return Object.assign({
    async put(reference: string, secret: string) { secrets.set(reference, secret); },
    async resolve(reference: string) { return secrets.get(reference); },
    async delete(reference: string) { secrets.delete(reference); },
    async status(reference: string) { return secrets.has(reference); },
  }, { secrets });
}

function unavailableCredentials(): CredentialStore {
  const fail = async (): Promise<never> => {
    throw new CredentialStoreUnavailableError('DPAPI_UNAVAILABLE', 'synthetic unavailable store');
  };
  return { put: fail, resolve: fail, delete: fail, status: fail };
}

interface CapturedRequest { readonly model: string; readonly authorization: string | null }

function controlledProvider(content: string) {
  const requests: CapturedRequest[] = [];
  const dependencies: ModelFetchDependencies = {
    lookup: PUBLIC_LOOKUP,
    fetch: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      const headers = new Headers(init?.headers ?? {});
      requests.push({ model: typeof body.model === 'string' ? body.model : '',
        authorization: headers.get('authorization') });
      const chunk = (delta: object, finishReason: string | null = null): string =>
        `data: ${JSON.stringify({ id: 'chatcmpl-chat-connection', object: 'chat.completion.chunk',
          created: 1, model: 'wire-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content }) +
        chunk({}, 'stop') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

async function newSession(workspaceId: string, title = '连接会话'): Promise<string> {
  const id = randomUUID();
  await createRepositories(app.db).assist.insertSession({
    id, workspaceId, projectId: null, taskId: null, title });
  return id;
}

interface Connection { readonly id: string; readonly model: string;
  readonly revision: bigint; readonly apiKey: string }

async function createConnection(workspaceId: string, credentials: CredentialStore,
  input: { readonly name: string; readonly model: string; readonly apiKey: string }):
Promise<Connection> {
  const outcome = await createModelConnectionCommand({ db: app.db, credentials }, {
    workspaceId, commandId: randomUUID(), name: input.name,
    defaultModel: input.model, apiKey: input.apiKey });
  const connection = outcome.result.connection as { id: string; revision: string };
  return { id: String(connection.id), model: input.model,
    revision: BigInt(String(connection.revision)), apiKey: input.apiKey };
}

interface MessageRow {
  readonly status: string;
  readonly error_code: string | null;
  readonly content: string | null;
  readonly model_connection_id: string | null;
  readonly model_credential_fingerprint: string | null;
  readonly model_selection_snapshot: JsonObject | null;
}

async function readMessage(messageId: string): Promise<MessageRow> {
  const row = (await sql<MessageRow>`select status, error_code, content,
      model_connection_id, model_credential_fingerprint, model_selection_snapshot
    from assist_messages where id = ${messageId}`.execute(app.db)).rows[0];
  assert.ok(row, `assist message ${messageId} must exist`);
  return row;
}

async function modelCallsForAssist(messageId: string): Promise<readonly {
  readonly model: string; readonly provider: string; readonly status: string;
}[]> {
  return (await sql<{ model: string; provider: string; status: string }>`
    select model, provider, status from model_calls
    where assist_message_id = ${messageId} order by started_at, id`.execute(app.db)).rows;
}

function firstCandidate(snapshot: JsonObject): {
  readonly provider: string; readonly model: string; readonly configFingerprint: string } {
  const parsed = parseAssistModelSnapshot(snapshot);
  const first = parsed.candidates[0];
  assert.ok(first);
  return first.connection;
}

async function selectConnection(workspaceId: string, sessionId: string,
  connectionId: string, credentials: CredentialStore): Promise<void> {
  const selected = await selectSessionConnection(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), connectionId, credentials });
  assert.equal(selected.result.connection, 'registered');
  assert.equal(selected.result.connection_id, connectionId);
}

/** 领取并执行一条已受理消息；modelPort 刻意用 Fake，若执行端走错路径会立刻暴露。 */
async function generate(messageId: string, credentials: CredentialStore,
  provider: ReturnType<typeof controlledProvider>) {
  const outcome = await runAssistGenerationTick(app.db, {
    workerId: `chat-connection-${randomUUID()}`, storage,
    modelPort: new FakeModelPort(), leaseMs: 30_000,
    modelEnv: PROCESS_DEFAULT_ENV,
    modelFetchDependencies: provider.dependencies, credentials });
  assert.equal(outcome?.messageId, messageId);
  return outcome;
}

async function expectDomainCode(work: () => Promise<unknown>, code: string): Promise<void> {
  try { await work(); } catch (error) {
    if (error instanceof DomainError) { assert.equal(error.code, code); return; }
    throw new Error(`expected DomainError ${code}, got ${String(error)}`);
  }
  throw new Error(`expected DomainError ${code} but none was thrown`);
}

test('会话选择已登记连接：消息冻结连接身份，生成按连接型号与 Key 外呼，改默认不影响在途',
  async () => {
    const workspaceId = await createWorkspace(app.db);
    const credentials = memoryCredentials();
    const primary = await createConnection(workspaceId, credentials, {
      name: 'primary-chat', model: `chat-model-${randomUUID()}`,
      apiKey: 'synthetic-chat-key' });
    const other = await createConnection(workspaceId, credentials, {
      name: 'other-chat', model: `other-model-${randomUUID()}`,
      apiKey: 'synthetic-other-key' });
    const sessionId = await newSession(workspaceId);
    await selectConnection(workspaceId, sessionId, primary.id, credentials);

    const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
      commandId: randomUUID(), content: '请用会话选择的连接回答' },
    PROCESS_DEFAULT_ENV, credentials);
    const frozen = await readMessage(accepted.result.assistant_message_id);
    assert.equal(frozen.model_connection_id, primary.id);
    assert.match(frozen.model_credential_fingerprint ?? '', /^[0-9a-f]{64}$/u);
    assert.ok(frozen.model_selection_snapshot);
    const candidate = firstCandidate(frozen.model_selection_snapshot);
    assert.equal(candidate.provider, 'openai-compatible');
    assert.equal(candidate.model, primary.model);

    // 受理之后改设聊天默认与 Run 默认：在途消息的冻结身份必须原样保留。
    await setChatDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: other.id });
    await setDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: other.id });

    const provider = controlledProvider('会话连接回复');
    const outcome = await generate(accepted.result.assistant_message_id, credentials, provider);
    assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
    assert.ok(provider.requests.length >= 1);
    for (const request of provider.requests) {
      assert.equal(request.model, primary.model, '所有外呼都必须用冻结连接的型号');
      assert.equal(request.authorization, 'Bearer synthetic-chat-key',
        '所有外呼都必须用冻结连接的凭据');
    }
    const calls = await modelCallsForAssist(accepted.result.assistant_message_id);
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((call) => call.model === primary.model));
    assert.equal(calls[0]!.provider, 'openai-compatible');
    assert.equal(calls[0]!.status, 'COMPLETED');

    const settled = await readMessage(accepted.result.assistant_message_id);
    assert.equal(settled.status, 'COMPLETED');
    assert.match(settled.content ?? '', /会话连接回复/u);
  });

test('凭据轮换后排队消息以 ASSIST_MODEL_CREDENTIAL_CHANGED 停止且零外呼', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'rotating-chat', model: `rotating-chat-model-${randomUUID()}`,
    apiKey: 'synthetic-before-rotation' });
  const sessionId = await newSession(workspaceId);
  await selectConnection(workspaceId, sessionId, connection.id, credentials);
  const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '轮换后这条消息应停止' }, PROCESS_DEFAULT_ENV, credentials);

  await rotateModelConnectionCredentialCommand({ db: app.db, credentials }, { workspaceId,
    commandId: randomUUID(), id: connection.id, expectedRevision: connection.revision,
    apiKey: 'synthetic-after-rotation' });

  const provider = controlledProvider('不应出现');
  const outcome = await generate(accepted.result.assistant_message_id, credentials, provider);
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'ASSIST_MODEL_CREDENTIAL_CHANGED');
  assert.equal(provider.requests.length, 0, '停止时不得发起任何外呼');
  assert.deepEqual(await modelCallsForAssist(accepted.result.assistant_message_id), []);
  const settled = await readMessage(accepted.result.assistant_message_id);
  assert.equal(settled.status, 'FAILED');
  assert.equal(settled.error_code, 'ASSIST_MODEL_CREDENTIAL_CHANGED');
});

test('连接停用后排队消息以 ASSIST_MODEL_CONNECTION_DISABLED 停止且零外呼', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'disabled-chat', model: `disabled-chat-model-${randomUUID()}`,
    apiKey: 'synthetic-disabled-key' });
  const sessionId = await newSession(workspaceId);
  await selectConnection(workspaceId, sessionId, connection.id, credentials);
  const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '停用后这条消息应停止' }, PROCESS_DEFAULT_ENV, credentials);

  await setModelConnectionStatusCommand({ db: app.db }, { workspaceId,
    commandId: randomUUID(), id: connection.id, expectedRevision: connection.revision,
    status: 'DISABLED' });

  const provider = controlledProvider('不应出现');
  const outcome = await generate(accepted.result.assistant_message_id, credentials, provider);
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'ASSIST_MODEL_CONNECTION_DISABLED');
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await modelCallsForAssist(accepted.result.assistant_message_id), []);
});

test('连接型号被修改后排队消息以 ASSIST_MODEL_CONFIG_CHANGED 停止且零外呼', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'edited-chat', model: `edited-chat-model-${randomUUID()}`,
    apiKey: 'synthetic-edited-key' });
  const sessionId = await newSession(workspaceId);
  await selectConnection(workspaceId, sessionId, connection.id, credentials);
  const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '改型号后这条消息应停止' }, PROCESS_DEFAULT_ENV, credentials);

  await updateModelConnectionCommand({ db: app.db, credentials }, { workspaceId,
    commandId: randomUUID(), id: connection.id, expectedRevision: connection.revision,
    defaultModel: `edited-again-${randomUUID()}` });

  const provider = controlledProvider('不应出现');
  const outcome = await generate(accepted.result.assistant_message_id, credentials, provider);
  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorCode, 'ASSIST_MODEL_CONFIG_CHANGED');
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await modelCallsForAssist(accepted.result.assistant_message_id), []);
});

test('按连接独立验证：同型号同 Provider 不冒充，轮换后旧结论失效，重新验证恢复', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const model = `shared-verify-model-${randomUUID()}`;
  const first = await createConnection(workspaceId, credentials, {
    name: 'verify-a', model, apiKey: 'synthetic-verify-key-a' });
  const second = await createConnection(workspaceId, credentials, {
    name: 'verify-b', model, apiKey: 'synthetic-verify-key-b' });

  const firstResult = await runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'),
    target: { connection: 'registered', connectionId: first.id }, credentials });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.model, model);
  assert.match(firstResult.config_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(firstResult).includes('synthetic-verify-key-a'), false);

  const calls = createRepositories(app.db).modelCalls;
  const firstRow = await calls.latestVerifyForConnection(workspaceId, first.id);
  assert.ok(firstRow);
  assert.equal(firstRow.kind, 'VERIFY');
  assert.equal(firstRow.status, 'COMPLETED');
  assert.equal(firstRow.connection_id, first.id);
  // 同型号的另一条连接没有被这次验证覆盖。
  assert.equal(await calls.latestVerifyForConnection(workspaceId, second.id), undefined);

  const firstState = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: first.id, credentials });
  assert.equal(firstState.connection, 'registered');
  assert.equal(firstState.connection_id, first.id);
  assert.equal(firstState.target, `registered:${first.id}`);
  assert.equal(firstState.model, model);
  assert.equal(firstState.state, 'VERIFIED');
  assert.equal(firstState.matches_current_config, true);
  assert.equal(firstState.credential_identity, 'MATCH');
  assert.equal(firstState.target_last?.ok, true);

  const secondState = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: second.id, credentials });
  assert.equal(secondState.state, 'UNVERIFIED');
  assert.equal(secondState.matches_current_config, false);
  assert.equal(secondState.credential_identity, 'UNKNOWN');
  assert.equal(secondState.target_last, null);

  // 轮换 A：旧结论仍可读，但不再继承为 VERIFIED。
  await rotateModelConnectionCredentialCommand({ db: app.db, credentials }, { workspaceId,
    commandId: randomUUID(), id: first.id, expectedRevision: first.revision,
    apiKey: 'synthetic-verify-key-a-rotated' });
  const rotated = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: first.id, credentials });
  assert.equal(rotated.state, 'CREDENTIAL_CHANGED');
  assert.equal(rotated.matches_current_config, false);
  assert.equal(rotated.credential_identity, 'CHANGED');
  assert.equal(rotated.target_last?.ok, true, '旧验证结果保留可读，但状态不再显示已验证');

  const reverified = await runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'),
    target: { connection: 'registered', connectionId: first.id }, credentials });
  assert.equal(reverified.ok, true);
  const afterReverify = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: first.id, credentials });
  assert.equal(afterReverify.state, 'VERIFIED');
  assert.equal(afterReverify.matches_current_config, true);

  // 验证 B 不会改变 A 的结论。
  const secondResult = await runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'),
    target: { connection: 'registered', connectionId: second.id }, credentials });
  assert.equal(secondResult.ok, true);
  const secondVerified = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: second.id, credentials });
  assert.equal(secondVerified.state, 'VERIFIED');
  const firstStillVerified = await readModelConnectionVerificationState({ db: app.db,
    workspaceId, connectionId: first.id, credentials });
  assert.equal(firstStillVerified.state, 'VERIFIED');
});

test('缺少凭据与凭据存储不可用时，验证在外呼前显式拒绝且不写 VERIFY 账本', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'missing-key-chat', model: `missing-key-model-${randomUUID()}`,
    apiKey: 'synthetic-to-be-deleted' });
  const target = { connection: 'registered' as const, connectionId: connection.id };
  const calls = createRepositories(app.db).modelCalls;

  const verified = await runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'), target, credentials });
  assert.equal(verified.ok, true);
  const before = await calls.latestVerifyForConnection(workspaceId, connection.id);
  assert.ok(before);

  const reference = [...credentials.secrets.entries()]
    .find(([, secret]) => secret === 'synthetic-to-be-deleted')?.[0];
  assert.ok(reference, 'the connection credential reference must be resolvable');
  await credentials.delete(reference);

  await assert.rejects(() => runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'), target, credentials }), (error: unknown) => {
    assert.ok(error instanceof ModelVerifyTargetError);
    assert.equal(error.code, 'MODEL_VERIFY_CREDENTIAL_MISSING');
    return true;
  });
  const afterMissing = await calls.latestVerifyForConnection(workspaceId, connection.id);
  assert.equal(afterMissing?.id, before.id, '缺凭据时不得写新的验证账本');

  const missingState = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: connection.id, credentials });
  assert.equal(missingState.state, 'NOT_CONFIGURED');
  assert.equal(missingState.current_config_fingerprint, null);
  assert.equal(missingState.credential_identity, 'UNKNOWN');

  await assert.rejects(() => runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'), target,
    credentials: unavailableCredentials() }), (error: unknown) => {
    assert.ok(error instanceof ModelVerifyTargetError);
    assert.equal(error.code, 'MODEL_VERIFY_CREDENTIAL_STORE_UNAVAILABLE');
    return true;
  });
  const afterUnavailable = await calls.latestVerifyForConnection(workspaceId, connection.id);
  assert.equal(afterUnavailable?.id, before.id);

  await assert.rejects(() => runModelPortVerification({ db: app.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'),
    target: { connection: 'registered', connectionId: randomUUID() }, credentials }),
  (error: unknown) => {
    assert.ok(error instanceof ModelVerifyTargetError);
    assert.equal(error.code, 'MODEL_VERIFY_CONNECTION_UNAVAILABLE');
    return true;
  });
});

test('HTTP：聊天默认可写可读、命令重放不推进 revision、可取消且跨工作区不可见', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = await createWorkspace(app.db);
    const credentials = memoryCredentials();
    const connection = await createConnection(workspaceId, credentials, {
      name: 'http-chat-default', model: `http-chat-model-${randomUUID()}`,
      apiKey: 'synthetic-http-key' });

    const initial = await api.get(workspacePath(workspaceId, '/model-connections/chat-default'));
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { connection_id: null, revision: null });

    const commandId = randomUUID();
    const set = await api.put(workspacePath(workspaceId, '/model-connections/chat-default'),
      { command_id: commandId, connection_id: connection.id });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual((set.body as { result: unknown }).result,
      { connection_id: connection.id, revision: '1' });

    const read = await api.get(workspacePath(workspaceId, '/model-connections/chat-default'));
    assert.deepEqual(read.body, { connection_id: connection.id, revision: '1' });

    // 同 command_id 重放：返回当时结果，revision 不推进。
    const replay = await api.put(workspacePath(workspaceId, '/model-connections/chat-default'),
      { command_id: commandId, connection_id: connection.id });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers['command-replayed'], 'true');
    assert.deepEqual((replay.body as { result: unknown }).result,
      { connection_id: connection.id, revision: '1' });

    // 新 command_id 指向同一条连接：不制造空更新、不推进 revision。
    const idempotent = await api.put(workspacePath(workspaceId,
      '/model-connections/chat-default'),
    { command_id: randomUUID(), connection_id: connection.id });
    assert.equal(idempotent.status, 200);
    assert.deepEqual((idempotent.body as { result: unknown }).result,
      { connection_id: connection.id, revision: '1' });

    // 显式取消：回到「未设置」，revision 前进。
    const cleared = await api.put(workspacePath(workspaceId,
      '/model-connections/chat-default'),
    { command_id: randomUUID(), connection_id: null });
    assert.equal(cleared.status, 200);
    assert.deepEqual((cleared.body as { result: unknown }).result,
      { connection_id: null, revision: '2' });
    const clearedRead = await api.get(workspacePath(workspaceId,
      '/model-connections/chat-default'));
    assert.deepEqual(clearedRead.body, { connection_id: null, revision: '2' });

    // 不存在的连接与跨工作区连接都按不可见处理，不泄漏其他工作区的存在。
    const missing = await api.put(workspacePath(workspaceId, '/model-connections/chat-default'),
      { command_id: randomUUID(), connection_id: randomUUID() });
    expectProblem(missing, 404, 'RESOURCE_NOT_FOUND');
    const otherWorkspaceId = await createWorkspace(app.db);
    const foreign = await createConnection(otherWorkspaceId, credentials, {
      name: 'foreign-chat-default', model: `foreign-model-${randomUUID()}`,
      apiKey: 'synthetic-foreign-key' });
    const crossWorkspace = await api.put(workspacePath(workspaceId,
      '/model-connections/chat-default'),
    { command_id: randomUUID(), connection_id: foreign.id });
    expectProblem(crossWorkspace, 404, 'RESOURCE_NOT_FOUND');

    // 已登记连接的验证状态端点：凭据不在 API 进程的 DPAPI 库里时，状态可读但不冒充已验证，
    // POST 验证在外呼前就被拒（真实 DPAPI + 真实 HTTP，不触达模型网络）。
    const verification = await api.get(workspacePath(workspaceId,
      `/model-port/verification?connection=registered&connection_id=${connection.id}`));
    assert.equal(verification.status, 200, JSON.stringify(verification.body));
    const state = verification.body as Record<string, unknown>;
    assert.equal(state.connection, 'registered');
    assert.equal(state.connection_id, connection.id);
    assert.equal(state.target, `registered:${connection.id}`);
    assert.equal(state.state, 'NOT_CONFIGURED');
    assert.equal(state.credential_identity, 'UNKNOWN');
    assert.equal(state.target_last, null);
    assert.equal(JSON.stringify(verification.body).includes('synthetic-http-key'), false);

    const verify = await api.post(workspacePath(workspaceId, '/model-port/verify'),
      { connection: 'registered', connection_id: connection.id });
    expectProblem(verify, 409, 'MODEL_VERIFY_CREDENTIAL_MISSING');

    const unknown = await api.get(workspacePath(workspaceId,
      `/model-port/verification?connection=registered&connection_id=${randomUUID()}`));
    expectProblem(unknown, 404, 'MODEL_VERIFY_CONNECTION_UNAVAILABLE');
  } finally {
    await api.stop();
  }
});

test('聊天默认决定新会话冻结：显式会话选择优先，Run 默认不受影响，取消后回进程默认',
  async () => {
    const workspaceId = await createWorkspace(app.db);
    const credentials = memoryCredentials();
    const chatDefault = await createConnection(workspaceId, credentials, {
      name: 'chat-default-conn', model: `chat-default-model-${randomUUID()}`,
      apiKey: 'synthetic-chat-default-key' });
    const explicit = await createConnection(workspaceId, credentials, {
      name: 'chat-explicit-conn', model: `chat-explicit-model-${randomUUID()}`,
      apiKey: 'synthetic-chat-explicit-key' });

    await setChatDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: chatDefault.id });
    // 聊天默认不得顺带写 Run 默认：两枚默认各自作用域。
    const runDefaultRow = await createRepositories(app.db).modelConnections
      .readDefault(workspaceId);
    assert.equal(runDefaultRow?.connection_id ?? null, null);
    assert.equal((await readChatDefaultModelConnection(app.db, workspaceId)).connectionId,
      chatDefault.id);

    const defaultSession = await newSession(workspaceId, '聊天默认冻结');
    const byDefault = await requestAssistMessage(app.db, { workspaceId,
      sessionId: defaultSession, commandId: randomUUID(), content: '按聊天默认回答' },
    PROCESS_DEFAULT_ENV, credentials);
    const defaultMessage = await readMessage(byDefault.result.assistant_message_id);
    assert.equal(defaultMessage.model_connection_id, chatDefault.id);
    assert.ok(defaultMessage.model_selection_snapshot);
    assert.equal(firstCandidate(defaultMessage.model_selection_snapshot).model,
      chatDefault.model);

    // 显式会话选择优先于聊天默认。
    const explicitSession = await newSession(workspaceId, '显式选择优先');
    await selectConnection(workspaceId, explicitSession, explicit.id, credentials);
    const bySelection = await requestAssistMessage(app.db, { workspaceId,
      sessionId: explicitSession, commandId: randomUUID(), content: '按会话选择回答' },
    PROCESS_DEFAULT_ENV, credentials);
    const explicitMessage = await readMessage(bySelection.result.assistant_message_id);
    assert.equal(explicitMessage.model_connection_id, explicit.id);
    assert.ok(explicitMessage.model_selection_snapshot);
    assert.equal(firstCandidate(explicitMessage.model_selection_snapshot).model,
      explicit.model);

    // 设 Run 默认不得改写聊天默认。
    await setDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: explicit.id });
    assert.equal((await readChatDefaultModelConnection(app.db, workspaceId)).connectionId,
      chatDefault.id);

    // 取消聊天默认：新会话回到进程默认，进程默认型号与连接型号不同。
    await setChatDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: null });
    const processSession = await newSession(workspaceId, '回进程默认');
    const byProcess = await requestAssistMessage(app.db, { workspaceId,
      sessionId: processSession, commandId: randomUUID(), content: '回到进程默认' },
    PROCESS_DEFAULT_ENV, credentials);
    const processMessage = await readMessage(byProcess.result.assistant_message_id);
    assert.equal(processMessage.model_connection_id, null);
    assert.ok(processMessage.model_selection_snapshot);
    assert.equal(firstCandidate(processMessage.model_selection_snapshot).model,
      'synthetic/process-default');

    // 停用的聊天默认让新消息失败，而不是静默退回进程默认。
    await setChatDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), connectionId: chatDefault.id });
    await setModelConnectionStatusCommand({ db: app.db }, { workspaceId,
      commandId: randomUUID(), id: chatDefault.id, expectedRevision: chatDefault.revision,
      status: 'DISABLED' });
    const blockedSession = await newSession(workspaceId, '停用聊天默认');
    await expectDomainCode(() => requestAssistMessage(app.db, { workspaceId,
      sessionId: blockedSession, commandId: randomUUID(), content: '停用后不应发送' },
    PROCESS_DEFAULT_ENV, credentials), 'MODEL_CONNECTION_DISABLED');

    const allMessages = (await sql<{ c: string }>`select count(*)::text as c
      from assist_messages where session_id = ${blockedSession}`.execute(app.db)).rows[0];
    assert.equal(Number(allMessages?.c ?? '0'), 0, '拒绝必须整体回滚，不留半条消息');
  });

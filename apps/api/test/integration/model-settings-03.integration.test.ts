import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { sql } from 'kysely';

import { requestAssistMessage } from '../../src/application/assist-commands.js';
import { parseAssistModelSnapshot } from '../../src/application/assist-model-snapshot.js';
import { probeModelConnection, ProbeInputError }
  from '../../src/application/model-connection-probe.js';
import {
  createModelConnectionCommand,
  setChatDefaultModelConnectionCommand,
  setModelConnectionStatusCommand,
  updateModelConnectionCommand,
} from '../../src/application/model-connections.js';
import {
  connectionConfigFingerprint,
  resolveFrozenChatConnectionPort,
} from '../../src/application/model-connection-runtime.js';
import { readModelConnectionVerificationState, runModelPortVerification }
  from '../../src/application/model-port-verification.js';
import {
  clearSessionModelSelection,
  selectSessionConnection,
} from '../../src/application/select-session-model.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import type { CredentialStore } from '../../src/credentials/credential-store.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { ModelVerifyTargetError, type VerifyCallPort }
  from '../../src/workflow/model-port-verify.js';
import { createDataRoot, createWorkspace, expectProblem, startTestApi, workspacePath }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * MODEL-SETTINGS-03：协议持久化、作用域隔离与验证边界（真实 PostgreSQL）。
 *
 * 覆盖四件必须由真实数据库证明的事：
 *   * 协议是连接行上的显式字段，进入配置指纹；改协议后旧冻结快照失配，不会被
 *     重新解释成另一种协议；
 *   * 已登记连接的验证状态只读**本工作区**的 VERIFY，另一个工作区的探测结论不会冒充；
 *   * 停用连接在验证入口就被拒绝：零外呼、零新 VERIFY 账本；
 *   * 会话显式选择 > 工作区聊天默认 > 进程默认，清除选择后回到聊天默认。
 *
 * 探针与验证外呼都是受控 Fake；这里不触达真实 Provider。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-model-settings-03-test');

const PROCESS_DEFAULT_ENV = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: 'synthetic/process-default',
  RELAY_MODEL_API_KEY: 'synthetic-process-default-key',
  RELAY_MODEL_BASE_URL: 'https://model-gateway.example.com/v1',
} as NodeJS.ProcessEnv;

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
  await createDataRoot();
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

async function newSession(workspaceId: string): Promise<string> {
  const id = randomUUID();
  await createRepositories(app.db).assist.insertSession({
    id, workspaceId, projectId: null, taskId: null, title: '协议会话' });
  return id;
}

async function createConnection(workspaceId: string, credentials: CredentialStore,
  input: { readonly name: string; readonly model: string; readonly apiKey: string;
    readonly protocol?: 'openai-compatible' | 'anthropic-messages';
    readonly baseUrl?: string | null }): Promise<{ id: string; model: string;
      revision: bigint }> {
  const outcome = await createModelConnectionCommand({ db: app.db, credentials }, {
    workspaceId, commandId: randomUUID(), name: input.name,
    defaultModel: input.model, apiKey: input.apiKey,
    baseUrl: input.baseUrl ?? null,
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }) });
  const connection = outcome.result.connection as { id: string; revision: string };
  return { id: String(connection.id), model: input.model,
    revision: BigInt(String(connection.revision)) };
}

interface MessageRow {
  readonly model_connection_id: string | null;
  readonly model_selection_snapshot: JsonObject | null;
}

async function readMessage(messageId: string): Promise<MessageRow> {
  const row = (await sql<MessageRow>`select model_connection_id, model_selection_snapshot
    from assist_messages where id = ${messageId}`.execute(app.db)).rows[0];
  assert.ok(row, `assist message ${messageId} must exist`);
  return row;
}

async function verifyCallCount(connectionId: string): Promise<number> {
  const row = (await sql<{ count: string }>`select count(*)::text as count from model_calls
    where kind = 'VERIFY' and connection_id = ${connectionId}`.execute(app.db)).rows[0];
  return Number(row?.count ?? '0');
}

/** 只记录调用次数与协议；不触达网络，也不关心 Provider 返回什么。 */
function countingVerifyCall(): VerifyCallPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return { calls,
    async call(input) {
      calls.push(input.config.protocol ?? 'openai-compatible');
      return { providerRequestId: 'verify-protocol-fixture',
        usage: { inputTokens: 3, outputTokens: 2 } };
    } };
}

test('协议是连接行的显式字段，并进入配置指纹；改协议推进 revision', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const anthropic = await createConnection(workspaceId, credentials, {
    name: 'anthropic-conn', model: 'claude-fixture', apiKey: 'synthetic-anthropic-key',
    protocol: 'anthropic-messages' });
  const openai = await createConnection(workspaceId, credentials, {
    name: 'openai-conn', model: 'claude-fixture', apiKey: 'synthetic-openai-key',
    protocol: 'openai-compatible' });
  const repository = createRepositories(app.db).modelConnections;
  const anthropicRow = await repository.read(workspaceId, anthropic.id);
  assert.equal(anthropicRow?.provider_kind, 'anthropic-messages');
  const openaiRow = await repository.read(workspaceId, openai.id);
  assert.equal(openaiRow?.provider_kind, 'openai-compatible');
  // 其它字段完全相同、只有协议不同：指纹必须不同。
  assert.notEqual(connectionConfigFingerprint(anthropicRow!),
    connectionConfigFingerprint(openaiRow!));

  const updated = await updateModelConnectionCommand({ db: app.db, credentials }, {
    workspaceId, commandId: randomUUID(), id: anthropic.id,
    expectedRevision: anthropic.revision, protocol: 'openai-compatible' });
  const updatedConnection = updated.result.connection as { revision: string };
  assert.equal(updatedConnection.revision, '2');
  const afterUpdate = await repository.read(workspaceId, anthropic.id);
  assert.equal(afterUpdate?.provider_kind, 'openai-compatible');
  assert.equal(connectionConfigFingerprint(afterUpdate!), connectionConfigFingerprint(openaiRow!));
});

test('消息按连接的协议冻结；改协议后旧冻结快照以配置已变停止，不被重新解释', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'frozen-anthropic', model: 'claude-frozen', apiKey: 'synthetic-frozen-key',
    protocol: 'anthropic-messages', baseUrl: 'https://anthropic.vendor.com/v1' });
  const sessionId = await newSession(workspaceId);
  await selectSessionConnection(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), connectionId: connection.id, credentials });

  const accepted = await requestAssistMessage(app.db, { workspaceId, sessionId,
    commandId: randomUUID(), content: '用 Anthropic 连接回答' },
  PROCESS_DEFAULT_ENV, credentials);
  const frozen = await readMessage(accepted.result.assistant_message_id);
  assert.equal(frozen.model_connection_id, connection.id);
  assert.ok(frozen.model_selection_snapshot);
  const candidate = parseAssistModelSnapshot(frozen.model_selection_snapshot!).candidates[0]!;
  assert.equal(candidate.connection.provider, 'anthropic-messages');
  assert.equal(candidate.connection.protocol, 'anthropic-messages');

  // 改协议：revision 变化、配置指纹变化。旧快照不得被当成本次协议。
  await updateModelConnectionCommand({ db: app.db, credentials }, {
    workspaceId, commandId: randomUUID(), id: connection.id,
    expectedRevision: connection.revision, protocol: 'openai-compatible' });
  await assert.rejects(resolveFrozenChatConnectionPort(createRepositories(app.db), {
    workspaceId, connectionId: connection.id, frozenModel: candidate.connection.model,
    frozenConfigFingerprint: candidate.connection.configFingerprint,
    frozenCredentialFingerprint: null,
    budget: { callReservationTokens: 4_096, scopeCallLimit: 32,
      scopeTokenLimit: 262_144 },
    credentials,
  }), /ASSIST_MODEL_CONFIG_CHANGED/u);
});

test('停用连接的验证零外呼、零新 VERIFY 账本', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connection = await createConnection(workspaceId, credentials, {
    name: 'to-disable', model: 'claude-disable', apiKey: 'synthetic-disable-key',
    protocol: 'anthropic-messages' });
  const firstCall = countingVerifyCall();
  const first = await runModelPortVerification({ db: app.db, workspaceId,
    env: PROCESS_DEFAULT_ENV, call: firstCall, credentials,
    target: { connection: 'registered', connectionId: connection.id } });
  assert.equal(first.ok, true);
  assert.equal(firstCall.calls.length, 1);
  assert.equal(await verifyCallCount(connection.id), 1);

  const disabled = await setModelConnectionStatusCommand({ db: app.db }, {
    workspaceId, commandId: randomUUID(), id: connection.id,
    expectedRevision: connection.revision, status: 'DISABLED' });
  const disabledRevision = BigInt(String(
    (disabled.result.connection as { revision: string }).revision));

  const secondCall = countingVerifyCall();
  await assert.rejects(runModelPortVerification({ db: app.db, workspaceId,
    env: PROCESS_DEFAULT_ENV, call: secondCall, credentials,
    target: { connection: 'registered', connectionId: connection.id } }),
  (error: unknown) => {
    assert.ok(error instanceof ModelVerifyTargetError);
    assert.equal(error.code, 'MODEL_VERIFY_CONNECTION_DISABLED');
    return true;
  });
  // 零外呼、零新账本：停用是用户的显式决定，不能为它产生一条新的验证结论。
  assert.equal(secondCall.calls.length, 0);
  assert.equal(await verifyCallCount(connection.id), 1);
  // 状态读取仍可用（只读），但不把旧结论冒充成当前可验证。
  const state = await readModelConnectionVerificationState({ db: app.db, workspaceId,
    connectionId: connection.id, credentials });
  assert.equal(state.model, 'claude-disable');
  assert.equal(disabledRevision > connection.revision, true);
});

test('已登记连接的验证状态只读本工作区，不跨 Workspace 冒充', async () => {
  const workspaceA = await createWorkspace(app.db);
  const workspaceB = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const connectionA = await createConnection(workspaceA, credentials, {
    name: 'workspace-a-conn', model: 'model-alpha', apiKey: 'synthetic-a-key' });
  const connectionB = await createConnection(workspaceB, credentials, {
    name: 'workspace-b-conn', model: 'model-beta', apiKey: 'synthetic-b-key' });

  await runModelPortVerification({ db: app.db, workspaceId: workspaceA,
    env: PROCESS_DEFAULT_ENV, call: countingVerifyCall(), credentials,
    target: { connection: 'registered', connectionId: connectionA.id } });

  // 关键断言：A 的 VERIFY 行存在，但 B 的「最近一次验证」必须是 null。
  const stateB = await readModelConnectionVerificationState({ db: app.db,
    workspaceId: workspaceB, connectionId: connectionB.id, credentials });
  assert.equal(stateB.last, null);
  assert.equal(stateB.target_last, null);
  assert.equal(stateB.state, 'UNVERIFIED');

  const stateA = await readModelConnectionVerificationState({ db: app.db,
    workspaceId: workspaceA, connectionId: connectionA.id, credentials });
  assert.equal(stateA.last?.model, 'model-alpha');
  assert.equal(stateA.state, 'VERIFIED');
});

test('优先级：显式会话选择 > 工作区聊天默认 > 进程默认；清除后回到聊天默认', async () => {
  const workspaceId = await createWorkspace(app.db);
  const credentials = memoryCredentials();
  const chatDefault = await createConnection(workspaceId, credentials, {
    name: 'chat-default', model: 'model-chat-default', apiKey: 'synthetic-chat-key' });
  const explicit = await createConnection(workspaceId, credentials, {
    name: 'explicit-choice', model: 'model-explicit', apiKey: 'synthetic-explicit-key' });
  await setChatDefaultModelConnectionCommand({ db: app.db }, { workspaceId,
    commandId: randomUUID(), connectionId: chatDefault.id });

  // 每条消息都会排队，切换选择要求会话没有在途消息；因此三个场景各用一条新会话，
  // 选择与清除都发生在发送之前——这仍是同一个优先级问题的三种真实顺序。
  // 1) 无显式选择：新消息按工作区聊天默认冻结（不是进程默认）。
  const sessionDefault = await newSession(workspaceId);
  const first = await requestAssistMessage(app.db, { workspaceId, sessionId: sessionDefault,
    commandId: randomUUID(), content: '第一条' }, PROCESS_DEFAULT_ENV, credentials);
  const firstRow = await readMessage(first.result.assistant_message_id);
  assert.equal(firstRow.model_connection_id, chatDefault.id);
  assert.equal(parseAssistModelSnapshot(firstRow.model_selection_snapshot!)
    .candidates[0]!.connection.model, 'model-chat-default');

  // 2) 显式选择另一条连接：按显式选择冻结，聊天默认不覆盖它。
  const sessionExplicit = await newSession(workspaceId);
  await selectSessionConnection(app.db, { workspaceId, sessionId: sessionExplicit,
    commandId: randomUUID(), connectionId: explicit.id, credentials });
  const second = await requestAssistMessage(app.db, { workspaceId, sessionId: sessionExplicit,
    commandId: randomUUID(), content: '第二条' }, PROCESS_DEFAULT_ENV, credentials);
  const secondRow = await readMessage(second.result.assistant_message_id);
  assert.equal(secondRow.model_connection_id, explicit.id);

  // 3) 显式选择后清除：恢复跟随工作区聊天默认（不是进程默认）。
  const sessionCleared = await newSession(workspaceId);
  await selectSessionConnection(app.db, { workspaceId, sessionId: sessionCleared,
    commandId: randomUUID(), connectionId: explicit.id, credentials });
  await clearSessionModelSelection(app.db, { workspaceId, sessionId: sessionCleared,
    commandId: randomUUID() });
  const third = await requestAssistMessage(app.db, { workspaceId, sessionId: sessionCleared,
    commandId: randomUUID(), content: '第三条' }, PROCESS_DEFAULT_ENV, credentials);
  const thirdRow = await readMessage(third.result.assistant_message_id);
  assert.equal(thirdRow.model_connection_id, chatDefault.id);
});

test('草稿探针真实外呼一次，但不写账本、不写凭据库', async () => {
  const credentials = memoryCredentials();
  const calls = countingVerifyCall();
  const result = await probeModelConnection({ protocol: 'anthropic-messages',
    baseUrl: 'https://anthropic.vendor.com/v1', defaultModel: 'claude-probe',
    apiKey: 'synthetic-probe-key', call: calls });
  assert.equal(result.ok, true);
  assert.equal(result.protocol, 'anthropic-messages');
  assert.equal(result.error_category, null);
  assert.equal(calls.calls.length, 1);
  // 探针没有连接身份，也不落任何业务表或凭据库。
  const verifyRows = (await sql<{ count: string }>`select count(*)::text as count
    from model_calls where kind = 'VERIFY' and model = 'claude-probe'`
    .execute(app.db)).rows[0];
  assert.equal(Number(verifyRows?.count ?? '0'), 0);
  assert.equal(credentials.secrets.size, 0);

  // 形状非法：未发起外呼。
  await assert.rejects(probeModelConnection({ protocol: 'openai-compatible',
    baseUrl: 'http://insecure.example.com/v1', defaultModel: 'x', apiKey: 'k',
    call: calls }), (error: unknown) => error instanceof ProbeInputError);
  assert.equal(calls.calls.length, 1);
});


test('HTTP 契约：列表返回显式协议；探针的非法输入在未外呼前 422', async () => {
  const api = await startTestApi();
  try {
    const workspaceId = await createWorkspace(app.db);
    const credentials = memoryCredentials();
    const anthropic = await createConnection(workspaceId, credentials, {
      name: 'http-anthropic', model: 'claude-http', apiKey: 'synthetic-http-key',
      protocol: 'anthropic-messages' });
    const list = await api.get(workspacePath(workspaceId, '/model-connections'));
    assert.equal(list.status, 200);
    const items = (list.body as { items: { id: string; provider_kind: string }[] }).items;
    const row = items.find((item) => item.id === anthropic.id);
    assert.equal(row?.provider_kind, 'anthropic-messages');
    // 响应不含任何凭据字段。
    assert.equal(JSON.stringify(list.body).includes('synthetic-http-key'), false);
    assert.equal(JSON.stringify(list.body).includes('credential_ref'), false);

    // 非法 Base URL：输入校验在探针外呼之前拒绝（422），不会触达任何 Provider。
    const invalid = await api.post(workspacePath(workspaceId, '/model-connections/probe'), {
      protocol: 'anthropic-messages', base_url: 'http://insecure.example.com/v1',
      default_model: 'claude-http', api_key: 'synthetic-http-key',
    });
    expectProblem(invalid, 422, 'MODEL_CONNECTION_INVALID');
  } finally { await api.stop(); }
});

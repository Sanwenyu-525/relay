import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import {
  createModelConnectionCommand,
  rotateModelConnectionCredentialCommand,
  setDefaultModelConnectionCommand,
  setModelConnectionStatusCommand,
} from '../../src/application/model-connections.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import type { CredentialStore } from '../../src/credentials/credential-store.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * P2 阶段三：工作区默认连接 → Run 冻结 → 执行端解析（真实 PG + 受控 Provider 接缝）。
 *
 * 证明四件事：
 *   1. 默认连接决定 Run 的冻结身份，**进程默认模型是另一个也不影响**（外呼 model 与账本一致）；
 *   2. 默认连接被停用时，新的委派**失败**而不是退回进程默认——默认连接是用户的显式选择；
 *   3. 凭据轮换后在途 Run 停止（代数不符），且零外呼；
 *   4. 改设另一条默认为默认，**已创建 Run 仍用原连接**（契约冻结了连接身份）。
 *
 * 凭据用内存实现：本套件验的是「连接身份 → 配置 → 外呼」这条链，DPAPI 本身由
 * `credential-store.integration.test.ts` 用真实 helper 验证。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-run-model-connection-test');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

const LOGICAL_BASE_URL = 'https://model-gateway.example.com/v1';
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const CANDIDATE_MARKDOWN = [
  '# 合成候选',
  '',
  '## 摘要',
  '',
  '这是用于连接身份验收的合成摘要正文，长度足够通过结构检查。',
  '',
  '## 结论',
  '',
  '合成结论正文，仅用于验证连接冻结与真实外呼身份一致。',
].join('\n');

/** 进程默认模型刻意是「另一个」：如果执行端偷偷用进程默认，测试会立刻看出来。 */
const PROCESS_DEFAULT_ENV = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: 'synthetic/process-default',
  RELAY_MODEL_API_KEY: 'synthetic-process-default-key',
  RELAY_MODEL_BASE_URL: LOGICAL_BASE_URL,
};

function memoryCredentials(): CredentialStore & { readonly secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return Object.assign({
    async put(reference: string, secret: string) { secrets.set(reference, secret); },
    async resolve(reference: string) { return secrets.get(reference); },
    async delete(reference: string) { secrets.delete(reference); },
    async status(reference: string) { return secrets.has(reference); },
  }, { secrets });
}

interface CapturedRequest { readonly model: string; readonly authorization: string | null }

function controlledProvider() {
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
        `data: ${JSON.stringify({ id: 'chatcmpl-connection', object: 'chat.completion.chunk',
          created: 1, model: 'wire-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant', content: CANDIDATE_MARKDOWN }) +
        chunk({}, 'stop') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

async function readyTask() {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Run connection identity', projectType: 'DEVELOPMENT' });
  const created = await createTask(app.db, { workspaceId, projectId: project.result.project_id,
    commandId: randomUUID(), title: 'Connection frozen run',
    objective: 'Produce a synthetic Markdown document', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'human', statement: 'Review the synthetic document',
      required: true, method: 'HUMAN' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: created.result.task_id,
    commandId: randomUUID(), expectedRevision: created.result.revision });
  return { workspaceId, taskId: created.result.task_id,
    expectedTaskRevision: ready.result.revision };
}

async function createConnection(workspaceId: string, credentials: CredentialStore,
  input: { readonly name: string; readonly model: string; readonly apiKey: string }) {
  const outcome = await createModelConnectionCommand({ db: app.db, credentials },
    { workspaceId, commandId: randomUUID(), name: input.name, defaultModel: input.model,
      apiKey: input.apiKey });
  const connection = outcome.result.connection;
  return { id: String(connection.id), revision: BigInt(String(connection.revision)) };
}

async function modelCallsForRun(runId: string) {
  return (await sql<{ model: string; provider: string }>`select c.model, c.provider
    from model_calls c
    join step_attempts a on a.id = c.step_attempt_id
    join run_steps s on s.id = a.step_id
    where s.run_id = ${runId} order by c.started_at, c.id`.execute(app.db)).rows;
}

test('默认连接决定 Run 的冻结与外呼身份，进程默认是另一个模型也不影响', async () => {
  const fixture = await readyTask();
  const credentials = memoryCredentials();
  const connectionModel = `connection-model-${randomUUID()}`;
  const connection = await createConnection(fixture.workspaceId, credentials,
    { name: 'primary', model: connectionModel, apiKey: 'synthetic-connection-key' });
  await setDefaultModelConnectionCommand({ db: app.db },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(), connectionId: connection.id });

  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
    PROCESS_DEFAULT_ENV, credentials);
  const runId = accepted.result.run_id;

  const contract = await createRepositories(app.db).runs.readContract(runId);
  assert.ok(contract);
  assert.equal(contract.connection_id, connection.id);
  assert.equal(contract.connection_credential_version, 1);

  const provider = controlledProvider();
  const storage = new ManagedContentStore(await createDataRoot());
  const workerId = `connection-exec-${randomUUID()}`;
  const built = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  assert.equal('step_kind' in built ? built.step_kind : null, 'BUILD_CONTEXT');

  const draft = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(draft.status, 'STEP_SUCCEEDED', JSON.stringify(draft));

  // 真实外呼用的是连接的确切型号与连接的凭据，不是进程默认那一对。
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]!.model, connectionModel);
  assert.equal(provider.requests[0]!.authorization, 'Bearer synthetic-connection-key');
  const calls = await modelCallsForRun(runId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, connectionModel);
});

test('默认连接停用后，新的委派失败而不是退回进程默认', async () => {
  const fixture = await readyTask();
  const credentials = memoryCredentials();
  const connection = await createConnection(fixture.workspaceId, credentials,
    { name: 'to-disable', model: `disabled-model-${randomUUID()}`,
      apiKey: 'synthetic-disabled-key' });
  await setDefaultModelConnectionCommand({ db: app.db },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(), connectionId: connection.id });
  await setModelConnectionStatusCommand({ db: app.db }, { workspaceId: fixture.workspaceId,
    commandId: randomUUID(), id: connection.id, expectedRevision: connection.revision,
    status: 'DISABLED' });

  await assert.rejects(delegateTask(app.db, { ...fixture, commandId: randomUUID() },
    PROCESS_DEFAULT_ENV, credentials), (error: unknown) => {
    const domain = error as { code?: string; status?: number };
    assert.equal(domain.code, 'MODEL_CONNECTION_DISABLED');
    assert.equal(domain.status, 409);
    return true;
  });
});

test('凭据轮换后在途 Run 停止且零外呼（代数不符）', async () => {
  const fixture = await readyTask();
  const credentials = memoryCredentials();
  const connection = await createConnection(fixture.workspaceId, credentials,
    { name: 'rotating', model: `rotating-model-${randomUUID()}`,
      apiKey: 'synthetic-before-rotation' });
  await setDefaultModelConnectionCommand({ db: app.db },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(), connectionId: connection.id });

  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
    PROCESS_DEFAULT_ENV, credentials);
  const runId = accepted.result.run_id;
  const storage = new ManagedContentStore(await createDataRoot());
  const workerId = `connection-rotate-${randomUUID()}`;
  const provider = controlledProvider();
  const built = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(built.status, 'STEP_SUCCEEDED');

  // 轮换：秘密被覆盖、代数 +1。在途 Run 的契约里仍是旧代数。
  await rotateModelConnectionCredentialCommand({ db: app.db, credentials },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(), id: connection.id,
      expectedRevision: connection.revision, apiKey: 'synthetic-after-rotation' });

  const draft = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(draft.status, 'RUN_FAILED');
  assert.equal('reason' in draft ? draft.reason : null, 'MODEL_CREDENTIAL_CHANGED');
  assert.equal(provider.requests.length, 0, '停止时不得发起任何外呼');
  assert.deepEqual(await modelCallsForRun(runId), []);
});

test('改设另一条为默认，已创建 Run 仍用原连接', async () => {
  const fixture = await readyTask();
  const credentials = memoryCredentials();
  const originalModel = `original-model-${randomUUID()}`;
  const original = await createConnection(fixture.workspaceId, credentials,
    { name: 'original', model: originalModel, apiKey: 'synthetic-original-key' });
  await setDefaultModelConnectionCommand({ db: app.db },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(), connectionId: original.id });

  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
    PROCESS_DEFAULT_ENV, credentials);
  const runId = accepted.result.run_id;

  // 改默认：新 Run 会用新连接，旧 Run 的身份不受影响。
  const replacement = await createConnection(fixture.workspaceId, credentials,
    { name: 'replacement', model: `replacement-model-${randomUUID()}`,
      apiKey: 'synthetic-replacement-key' });
  await setDefaultModelConnectionCommand({ db: app.db },
    { workspaceId: fixture.workspaceId, commandId: randomUUID(),
      connectionId: replacement.id });

  const provider = controlledProvider();
  const storage = new ManagedContentStore(await createDataRoot());
  const workerId = `connection-switch-${randomUUID()}`;
  const built = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const draft = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: PROCESS_DEFAULT_ENV, modelTransport: provider.dependencies, credentials });
  assert.equal(draft.status, 'STEP_SUCCEEDED', JSON.stringify(draft));
  assert.equal(provider.requests[0]!.model, originalModel);
  assert.equal(provider.requests[0]!.authorization, 'Bearer synthetic-original-key');
});

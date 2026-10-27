import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { parseAssistModelSnapshot } from '../../src/application/assist-model-snapshot.js';
import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { selectSessionModel } from '../../src/application/select-session-model.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import type { JsonObject } from '../../src/infrastructure/json.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import type { ModelFetchDependencies } from '../../src/workflow/model-endpoint-policy.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * P0-1 执行端模型冻结验收（真实 PG + 受控 Provider HTTP 接缝）。
 *
 * 证明的是执行端身份，不是契约里写了什么：
 *   1. 冻结的免费模型才是真实外呼对象——进程默认模型是另一个也不影响；
 *   2. 免费外呼的最终 HTTP 体携带零价格硬限制；
 *   3. 冻结身份与当前配置不符时明确停止，不静默改用默认模型、不回退 Fake；
 *   4. 免费资格失效时停止，不发起替代调用；
 *   5. 旧 Run（无冻结计划）保留可验证的兼容行为。
 *
 * 受控接缝只注入端口既有的 fetch/lookup：逻辑端点仍是公开 HTTPS，实际字节来自本测试。
 * 这不是真实 Provider / TLS / DNS 绑定验收。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-run-model-freeze-execution-test');
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
  '这是用于模型身份验收的合成摘要正文，长度足够通过结构检查。',
  '',
  '## 结论',
  '',
  '合成结论正文，仅用于验证执行端模型身份与账本身份一致。',
].join('\n');

interface CapturedRequest { readonly model: string; readonly body: Record<string, unknown>;
  readonly authorization: string | null }

/** 受控 Provider：记录最终请求体，返回一个完整终止的 SSE 回复。 */
function controlledProvider(reply: () => { readonly status: number;
  readonly body: string; readonly contentType: string } = () => ({
  status: 200, contentType: 'text/event-stream', body: candidateSse(CANDIDATE_MARKDOWN) })) {
  const requests: CapturedRequest[] = [];
  const dependencies: ModelFetchDependencies = {
    lookup: PUBLIC_LOOKUP,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      const headers = new Headers(init?.headers ?? {});
      requests.push({ model: typeof body.model === 'string' ? body.model : '',
        body, authorization: headers.get('authorization') });
      const answer = reply();
      return new Response(answer.body, { status: answer.status,
        headers: { 'content-type': answer.contentType } });
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

function candidateSse(markdown: string): string {
  const chunk = (delta: object, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({ id: 'chatcmpl-frozen-exec', object: 'chat.completion.chunk',
      created: 1, model: 'wire-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return chunk({ role: 'assistant', content: markdown }) +
    chunk({}, 'stop') + 'data: [DONE]\n\n';
}

function verdictSse(verdict: string): string {
  const chunk = (delta: object, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({ id: 'chatcmpl-frozen-verdict', object: 'chat.completion.chunk',
      created: 1, model: 'wire-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return chunk({ role: 'assistant',
    content: JSON.stringify({ verdict, reason: 'synthetic verdict' }) }) +
    chunk({}, 'stop') + 'data: [DONE]\n\n';
}

const defaultEnvA = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: 'synthetic/frozen-default-a',
  RELAY_MODEL_API_KEY: 'synthetic-default-credential-a',
  RELAY_MODEL_BASE_URL: LOGICAL_BASE_URL,
};

const freeEnv = {
  RELAY_MODEL_PROVIDER: 'fake',
  RELAY_OPENROUTER_API_KEY: 'synthetic-openrouter-credential',
  RELAY_MODEL_MAX_OUTPUT_TOKENS: '512',
  RELAY_MODEL_MAX_CALL_TOKENS: '16384',
};

async function readyTask() {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Run model freeze execution', projectType: 'DEVELOPMENT' });
  const projectId = project.result.project_id;
  const created = await createTask(app.db, { workspaceId, projectId, commandId: randomUUID(),
    title: 'Synthetic frozen run', objective: 'Produce a synthetic Markdown document', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'human', statement: 'Review the synthetic document',
      required: true, method: 'HUMAN' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: created.result.task_id,
    commandId: randomUUID(), expectedRevision: created.result.revision });
  return { workspaceId, projectId, taskId: created.result.task_id,
    expectedTaskRevision: ready.result.revision };
}

async function freeModelFixture() {
  const fixture = await readyTask();
  const modelA = `freeze-exec-a-${randomUUID()}:free`;
  const modelB = `freeze-exec-b-${randomUUID()}:free`;
  for (const model of [modelA, modelB]) {
    await sql`insert into model_catalog_entries
      (source_model_id, display_name, context_window, pricing, capabilities, is_free,
       not_free_reason, fetched_at)
      values (${model}, ${model}, 131072, '{"prompt":"0","completion":"0"}'::jsonb,
      '{"text_input":true,"text_output":true,"tools":true,"response_format":true}'::jsonb,
      true, null, now())`.execute(app.db);
  }
  await sql`update model_catalog_sync_state set snapshot_seq = snapshot_seq + 1,
    last_success_at = now() where singleton = true`.execute(app.db);
  const sessionId = randomUUID();
  await createRepositories(app.db).assist.insertSession({ id: sessionId,
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, taskId: null,
    title: 'Frozen free model source' });
  await selectSessionModel(app.db, { workspaceId: fixture.workspaceId, sessionId,
    commandId: randomUUID(), requestedModel: modelA, env: freeEnv });
  return { ...fixture, sessionId, modelA, modelB };
}

/** 结果联合里只有部分分支带 step_kind；测试断言统一走这个窄化读取。 */
function stepKind(result: Awaited<ReturnType<typeof advanceRunStep>>): string | null {
  return 'step_kind' in result ? result.step_kind : null;
}

async function modelCallsForRun(runId: string) {  return (await sql<{ kind: string; provider: string; model: string;
    config_fingerprint: string; status: string }>`select c.kind, c.provider, c.model,
      c.config_fingerprint, c.status from model_calls c
      join step_attempts a on a.id = c.step_attempt_id
      join run_steps s on s.id = a.step_id
      where s.run_id = ${runId} order by c.started_at, c.id`.execute(app.db)).rows;
}

test('a frozen free model is the real outbound identity even when the process default is another model',
  async () => {
    const fixture = await freeModelFixture();
    const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID(),
      modelSessionId: fixture.sessionId }, freeEnv);
    const runId = accepted.result.run_id;
    const contract = await createRepositories(app.db).runs.readContract(runId);
    assert.ok(contract);
    const frozen = parseAssistModelSnapshot(
      contract.frozen_snapshot.model_selection_snapshot as JsonObject);
    assert.equal(frozen.candidates[0]?.connection.model, fixture.modelA);

    const provider = controlledProvider();
    const storage = new ManagedContentStore(await createDataRoot());
    const workerId = `frozen-exec-${randomUUID()}`;
    // 进程默认连接是另一个模型（默认连接 A），执行端必须仍走冻结的免费模型 A。
    // 免费连接的独立凭据仍在，否则那就是「凭据缺失」而不是「身份切换」。
    const env = { ...defaultEnvA,
      RELAY_OPENROUTER_API_KEY: freeEnv.RELAY_OPENROUTER_API_KEY,
      RELAY_MODEL_MAX_OUTPUT_TOKENS: freeEnv.RELAY_MODEL_MAX_OUTPUT_TOKENS,
      RELAY_MODEL_MAX_CALL_TOKENS: freeEnv.RELAY_MODEL_MAX_CALL_TOKENS };
    const built = await advanceRunStep(app.db, { runId, workerId, storage, modelEnv: env,
      modelTransport: provider.dependencies });
    assert.equal(built.status, 'STEP_SUCCEEDED');
    assert.equal(built.step_kind, 'BUILD_CONTEXT');
    const draft = await advanceRunStep(app.db, { runId, workerId, storage, modelEnv: env,
      modelTransport: provider.dependencies });
    assert.equal(draft.status, 'STEP_SUCCEEDED');
    assert.equal(draft.step_kind, 'DRAFT');

    assert.equal(provider.requests.length, 1);
    const request = provider.requests[0]!;
    assert.equal(request.model, fixture.modelA);
    assert.equal(request.model, frozen.candidates[0]?.connection.model);
    // 免费外呼的最终 HTTP 体必须带零价格硬限制（服务商端防线，不是内部参数）。
    const guard = request.body.provider as Record<string, unknown>;
    assert.deepEqual(guard.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
    assert.equal(guard.allow_fallbacks, false);
    assert.equal(guard.require_parameters, true);
    assert.equal(request.authorization, `Bearer ${freeEnv.RELAY_OPENROUTER_API_KEY}`);

    const calls = await modelCallsForRun(runId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.kind, 'DRAFT');
    assert.equal(calls[0]!.provider, 'openrouter');
    assert.equal(calls[0]!.model, fixture.modelA);
    assert.equal(calls[0]!.config_fingerprint,
      frozen.candidates[0]?.connection.configFingerprint);
    assert.equal(calls[0]!.status, 'COMPLETED');
  });

test('a frozen default model stops instead of executing the changed process default',
  async () => {
    const fixture = await readyTask();
    const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
      defaultEnvA);
    const runId = accepted.result.run_id;
    const provider = controlledProvider();
    const storage = new ManagedContentStore(await createDataRoot());
    const workerId = `frozen-changed-${randomUUID()}`;
    const changedEnv = { ...defaultEnvA, RELAY_MODEL_NAME: 'synthetic/changed-default-b' };
    const built = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: changedEnv, modelTransport: provider.dependencies });
    assert.equal(built.status, 'STEP_SUCCEEDED');
    assert.equal(built.step_kind, 'BUILD_CONTEXT');
    const draft = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: changedEnv, modelTransport: provider.dependencies });
    assert.equal(draft.status, 'RUN_FAILED');
    assert.equal(draft.step_kind, 'DRAFT');
    assert.equal(draft.reason, 'MODEL_CONFIG_CHANGED');
    // 关键：一个字节都没有发到 Provider——没有静默改用默认模型，也没有回退 Fake。
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(await modelCallsForRun(runId), []);
  });

test('a frozen free model stops when the catalog no longer certifies it as free',
  async () => {
    const fixture = await freeModelFixture();
    const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID(),
      modelSessionId: fixture.sessionId }, freeEnv);
    const runId = accepted.result.run_id;
    // 目录在冻结之后变化：同一型号不再免费（远端计价可能已改）。
    // 应用角色没有该表的 UPDATE 权限（目录只由同步任务整行替换），所以按目录同步的真实
    // 形态「删除后插入新行」表达同一事实。
    await sql`delete from model_catalog_entries where source_model_id = ${fixture.modelA}`
      .execute(app.db);
    await sql`insert into model_catalog_entries
      (source_model_id, display_name, context_window, pricing, capabilities, is_free,
       not_free_reason, fetched_at)
      values (${fixture.modelA}, ${fixture.modelA}, 131072,
      '{"prompt":"0.000001","completion":"0.000002"}'::jsonb,
      '{"text_input":true,"text_output":true,"tools":true,"response_format":true}'::jsonb,
      false, 'NONZERO_PRICE', now())`.execute(app.db);
    const env = { ...defaultEnvA,
      RELAY_OPENROUTER_API_KEY: freeEnv.RELAY_OPENROUTER_API_KEY,
      RELAY_MODEL_MAX_OUTPUT_TOKENS: freeEnv.RELAY_MODEL_MAX_OUTPUT_TOKENS,
      RELAY_MODEL_MAX_CALL_TOKENS: freeEnv.RELAY_MODEL_MAX_CALL_TOKENS };
    const provider = controlledProvider();
    const storage = new ManagedContentStore(await createDataRoot());
    const workerId = `frozen-not-free-${randomUUID()}`;
    const built = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: env, modelTransport: provider.dependencies });
    assert.equal(built.status, 'STEP_SUCCEEDED');
    const draft = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: env, modelTransport: provider.dependencies });
    assert.equal(draft.status, 'RUN_FAILED');
    assert.equal(draft.reason, 'MODEL_FREE_NOT_ELIGIBLE');
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(await modelCallsForRun(runId), []);
  });

test('a frozen free model stops when its credential configuration disappeared',
  async () => {
    const fixture = await freeModelFixture();
    const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID(),
      modelSessionId: fixture.sessionId }, freeEnv);
    const runId = accepted.result.run_id;
    const provider = controlledProvider();
    const storage = new ManagedContentStore(await createDataRoot());
    const workerId = `frozen-no-credential-${randomUUID()}`;
    // 免费连接凭据被移除：不能悄悄改用默认连接的凭据。
    const envWithoutOpenRouter = { ...defaultEnvA };
    const built = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: envWithoutOpenRouter, modelTransport: provider.dependencies });
    assert.equal(built.status, 'STEP_SUCCEEDED');
    const draft = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: envWithoutOpenRouter, modelTransport: provider.dependencies });
    assert.equal(draft.status, 'RUN_FAILED');
    assert.equal(draft.reason, 'MODEL_NOT_CONFIGURED');
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(await modelCallsForRun(runId), []);
  });

test('a Run without a frozen model plan keeps the legacy Fake execution path', async () => {
  const fixture = await readyTask();
  const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
    { RELAY_MODEL_PROVIDER: 'fake' });
  const runId = accepted.result.run_id;
  const contract = await createRepositories(app.db).runs.readContract(runId);
  assert.ok(contract);
  assert.equal('model_selection_snapshot' in contract.frozen_snapshot, false);
  const provider = controlledProvider();
  const storage = new ManagedContentStore(await createDataRoot());
  const workerId = `legacy-fake-${randomUUID()}`;
  const built = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: { RELAY_MODEL_PROVIDER: 'fake' }, modelTransport: provider.dependencies });
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const draft = await advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: { RELAY_MODEL_PROVIDER: 'fake' }, modelTransport: provider.dependencies });
  assert.equal(draft.status, 'STEP_SUCCEEDED');
  assert.equal(draft.step_kind, 'DRAFT');
  // 旧 Run 的 Fake 路径不产生真实外呼，也不伪造真实模型身份。
  assert.equal(provider.requests.length, 0);
  const calls = await modelCallsForRun(runId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.provider, 'fake');
});

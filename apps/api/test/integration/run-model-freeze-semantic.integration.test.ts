import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

/**
 * P0-1（语义检查支路）：DRAFT 与 SEMANTIC_CHECK 必须使用同一个冻结身份。
 *
 * 本文件在加载应用模块**之前**把「进程默认模型」定成一个和冻结模型不同的型号。
 * 语义检查器在 checkers 模块加载时按进程默认注册，因此这个默认值就是最有力的反例：
 * 一旦执行端没有按冻结计划解析，SEMANTIC_CHECK 会落到进程默认型号上。
 *
 * 只注入端口既有的 fetch/lookup 接缝；逻辑端点仍是公开 HTTPS。不是真实 Provider 验收。
 */

const PROCESS_DEFAULT_MODEL = 'synthetic/process-default-c';
const FROZEN_MODEL = 'synthetic/frozen-semantic-a';
const LOGICAL_BASE_URL = 'https://model-gateway.example.com/v1';

process.env.RELAY_MODEL_PROVIDER = 'openai-compatible';
process.env.RELAY_MODEL_NAME = PROCESS_DEFAULT_MODEL;
process.env.RELAY_MODEL_API_KEY = 'synthetic-process-credential-c';
process.env.RELAY_MODEL_BASE_URL = LOGICAL_BASE_URL;

const { advanceRunStep } = await import('../../src/application/run-steps.js');
const { createProject } = await import('../../src/application/create-project.js');
const { createTask } = await import('../../src/application/create-task.js');
const { delegateTask } = await import('../../src/application/delegate-task.js');
const { markTaskReady } = await import('../../src/application/task-commands.js');
const { createRepositories } = await import('../../src/application/unit-of-work.js');
const { ManagedContentStore } = await import('../../src/storage/managed-content-store.js');
const { runMigrations } = await import('../../src/infrastructure/migration-runner.js');
const { createDataRoot, createWorkspace } = await import('./api-harness.js');
const { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase } =
  await import('./integration-support.js');

const app = openDatabase(APP_DATABASE_URL, 'relay-run-model-freeze-semantic-test');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

const CANDIDATE_MARKDOWN = [
  '# 合成候选',
  '',
  '## 摘要',
  '',
  '这是用于语义检查身份验收的合成摘要正文，长度足够通过结构检查。',
  '',
  '## 结论',
  '',
  '合成结论正文，仅用于验证语义检查调用与 DRAFT 使用同一冻结身份。',
].join('\n');

const frozenEnv = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: FROZEN_MODEL,
  RELAY_MODEL_API_KEY: 'synthetic-frozen-credential-a',
  RELAY_MODEL_BASE_URL: LOGICAL_BASE_URL,
};

function sse(content: string, requestId: string): string {
  const chunk = (delta: object, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', created: 1,
      model: 'wire-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return chunk({ role: 'assistant', content }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

/** 受控 Provider：按请求体里的 response_format 区分候选生成与语义判定。 */
function controlledProvider() {
  const requests: { readonly model: string; readonly body: Record<string, unknown> }[] = [];
  const dependencies = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      requests.push({ model: typeof body.model === 'string' ? body.model : '', body });
      const structured = body.response_format !== undefined;
      const content = structured
        ? JSON.stringify({ verdict: 'PASS', reason: 'synthetic verdict' })
        : CANDIDATE_MARKDOWN;
      return new Response(sse(content, structured ? 'chatcmpl-semantic' : 'chatcmpl-draft'), {
        status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

test('SEMANTIC_CHECK uses the frozen model identity, not the process default', async () => {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Semantic frozen identity', projectType: 'DEVELOPMENT' });
  const created = await createTask(app.db, { workspaceId, projectId: project.result.project_id,
    commandId: randomUUID(), title: 'Semantic frozen run',
    objective: 'Produce a synthetic Markdown document', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'c-semantic', statement: '论断被来源支持', required: true,
      method: 'SEMANTIC' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: created.result.task_id,
    commandId: randomUUID(), expectedRevision: created.result.revision });
  const accepted = await delegateTask(app.db, { workspaceId, taskId: created.result.task_id,
    expectedTaskRevision: ready.result.revision, commandId: randomUUID() }, frozenEnv);
  const runId = accepted.result.run_id;

  const contract = await createRepositories(app.db).runs.readContract(runId);
  assert.ok(contract);
  const criteria = contract.frozen_snapshot.criteria as readonly Record<string, unknown>[];
  // 真实模型检查器被冻结（不是 human-evidence 降级）：这正是进程默认模型已配置时的行为。
  assert.equal(criteria[0]?.checker_id, 'semantic-model-v1');

  const provider = controlledProvider();
  const storage = new ManagedContentStore(await createDataRoot());
  const workerId = `semantic-frozen-${randomUUID()}`;
  const advance = () => advanceRunStep(app.db, { runId, workerId, storage,
    modelEnv: frozenEnv, modelTransport: provider.dependencies });

  const built = await advance();
  assert.equal(built.status, 'STEP_SUCCEEDED');
  const draft = await advance();
  assert.equal(draft.status, 'STEP_SUCCEEDED');
  const persist = await advance();
  assert.equal(persist.status, 'STEP_SUCCEEDED');
  const verify = await advance();
  assert.notEqual(verify.status, 'RUN_FAILED');

  const calls = (await sql<{ kind: string; provider: string; model: string; status: string }>`
    select c.kind, c.provider, c.model, c.status from model_calls c
    join step_attempts a on a.id = c.step_attempt_id
    join run_steps s on s.id = a.step_id
    where s.run_id = ${runId} order by c.started_at, c.id`.execute(app.db)).rows;
  assert.deepEqual(calls.map((call) => call.kind).sort(), ['DRAFT', 'SEMANTIC_CHECK']);
  for (const call of calls) {
    assert.equal(call.model, FROZEN_MODEL);
    assert.equal(call.provider, 'openai-compatible');
  }
  // 每一次真实外呼都是冻结型号；进程默认型号一次都没有出现。
  assert.ok(provider.requests.length >= 2);
  for (const request of provider.requests) {
    assert.equal(request.model, FROZEN_MODEL);
    assert.notEqual(request.model, PROCESS_DEFAULT_MODEL);
  }
});

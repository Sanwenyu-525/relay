import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { sql } from 'kysely';

import { createProject } from '../../src/application/create-project.js';
import { createTask } from '../../src/application/create-task.js';
import { delegateTask } from '../../src/application/delegate-task.js';
import { runModelPortVerification } from '../../src/application/model-port-verification.js';
import { advanceRunStep } from '../../src/application/run-steps.js';
import { markTaskReady } from '../../src/application/task-commands.js';
import { createRepositories } from '../../src/application/unit-of-work.js';
import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { ModelProviderCooldownRepository } from '../../src/model/model-provider-cooldown-repository.js';
import { ManagedContentStore } from '../../src/storage/managed-content-store.js';
import { accountCooldownKey, readCredentialFingerprint } from
  '../../src/workflow/credential-identity.js';
import { createFakeVerifyCall, readModelVerificationState } from
  '../../src/workflow/model-port-verify.js';
import { createDataRoot, createWorkspace } from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL,
  openDatabase } from './integration-support.js';

/**
 * P0-2 凭据身份（真实 PG）。
 *
 * 证明四件事：
 *   1. 换 Key 后旧 Run 明确停止，不悄悄用新凭据外呼（配置指纹不变，只有凭据变了）；
 *   2. 换 Key 后旧验证结论失效（`matches_current_config=false` + `credential_identity=CHANGED`）；
 *   3. 账户级冷却按真实凭据身份取键：A 账户的冷却不挡住 B 账户，同一账户重启仍命中；
 *   4. 凭据摘要不出现在任何对外投影里（契约快照、验证状态响应）。
 */

const app = openDatabase(APP_DATABASE_URL, 'relay-model-credential-identity-test');
before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL,
    directory: MIGRATIONS_DIRECTORY });
});
after(async () => { await app.close(); });

const LOGICAL_BASE_URL = 'https://model-gateway.example.com/v1';
const KEY_A = 'synthetic-credential-a';
const KEY_B = 'synthetic-credential-b';

const envWith = (apiKey: string) => ({
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_NAME: 'synthetic/credential-model',
  RELAY_MODEL_API_KEY: apiKey,
  RELAY_MODEL_BASE_URL: LOGICAL_BASE_URL,
});

function controlledProvider() {
  const requests: { readonly model: string }[] = [];
  const dependencies = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>;
      requests.push({ model: typeof body.model === 'string' ? body.model : '' });
      const chunk = (delta: object, finishReason: string | null = null): string =>
        `data: ${JSON.stringify({ id: 'chatcmpl-credential', object: 'chat.completion.chunk',
          created: 1, model: 'wire-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(chunk({ role: 'assistant',
        content: '# 合成候选\n\n## 摘要\n\n合成摘要正文，长度足够。\n\n## 结论\n\n合成结论正文。' }) +
        chunk({}, 'stop') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch,
  };
  return { requests, dependencies };
}

async function readyTask() {
  const workspaceId = await createWorkspace(app.db);
  const project = await createProject(app.db, { workspaceId, commandId: randomUUID(),
    title: 'Credential identity', projectType: 'DEVELOPMENT' });
  const created = await createTask(app.db, { workspaceId, projectId: project.result.project_id,
    commandId: randomUUID(), title: 'Credential frozen run',
    objective: 'Produce a synthetic Markdown document', mode: 'ME',
    expectedOutputs: { kind: 'MARKDOWN_DOCUMENT' },
    criteria: [{ criterionId: 'human', statement: 'Review the synthetic document',
      required: true, method: 'HUMAN' }] });
  const ready = await markTaskReady(app.db, { workspaceId, taskId: created.result.task_id,
    commandId: randomUUID(), expectedRevision: created.result.revision });
  return { workspaceId, taskId: created.result.task_id,
    expectedTaskRevision: ready.result.revision };
}

async function modelCallsForRun(runId: string) {
  return (await sql<{ model: string }>`select c.model from model_calls c
    join step_attempts a on a.id = c.step_attempt_id
    join run_steps s on s.id = a.step_id where s.run_id = ${runId}`.execute(app.db)).rows;
}

test('a rotated credential stops the frozen Run instead of silently reusing the new key',
  async () => {
    const fixture = await readyTask();
    const accepted = await delegateTask(app.db, { ...fixture, commandId: randomUUID() },
      envWith(KEY_A));
    const runId = accepted.result.run_id;
    const contract = await createRepositories(app.db).runs.readContract(runId);
    assert.ok(contract);
    const frozenCredential = contract.credential_fingerprint;
    assert.match(String(frozenCredential), /^[0-9a-f]{64}$/u);
    // 凭据摘要不进冻结快照（快照会原样嵌入上下文清单并可能出现在界面）。
    assert.equal(JSON.stringify(contract.frozen_snapshot).includes(String(frozenCredential)), false);
    assert.equal(JSON.stringify(contract.frozen_snapshot).includes(KEY_A), false);

    const provider = controlledProvider();
    const storage = new ManagedContentStore(await createDataRoot());
    const workerId = `credential-rotate-${randomUUID()}`;
    const built = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: envWith(KEY_A), modelTransport: provider.dependencies });
    assert.equal(built.status, 'STEP_SUCCEEDED');
    // 只换 Key：Provider/型号/端点/预算全部不变，配置指纹仍然相同。
    const draft = await advanceRunStep(app.db, { runId, workerId, storage,
      modelEnv: envWith(KEY_B), modelTransport: provider.dependencies });
    assert.equal(draft.status, 'RUN_FAILED');
    assert.equal(draft.reason, 'MODEL_CREDENTIAL_CHANGED');
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(await modelCallsForRun(runId), []);
  });

test('a rotated credential invalidates the previous verification result', async () => {
  const workspaceId = await createWorkspace(app.db);
  const verified = await runModelPortVerification({ db: app.db, workspaceId,
    env: envWith(KEY_A), call: createFakeVerifyCall('SUCCESS') });
  assert.equal(verified.ok, true);

  const sameCredential = await readModelVerificationState(app.db, envWith(KEY_A));
  assert.equal(sameCredential.matches_current_config, true);
  assert.equal(sameCredential.credential_identity, 'MATCH');

  const rotated = await readModelVerificationState(app.db, envWith(KEY_B));
  assert.equal(rotated.matches_current_config, false);
  assert.equal(rotated.credential_identity, 'CHANGED');

  // 对外投影里不能出现任何凭据摘要。
  const digestA = readCredentialFingerprint({ provider: 'openai-compatible', apiKey: KEY_A });
  const digestB = readCredentialFingerprint({ provider: 'openai-compatible', apiKey: KEY_B });
  const projected = JSON.stringify(rotated);
  assert.equal(projected.includes(digestA), false);
  assert.equal(projected.includes(digestB), false);
  assert.equal(projected.includes(KEY_A), false);
  assert.equal(projected.includes(KEY_B), false);
});

test('account cooldowns are keyed by credential identity, not by a shared constant', async () => {
  const accountA = accountCooldownKey(
    readCredentialFingerprint({ provider: 'openrouter', apiKey: KEY_A }));
  const accountB = accountCooldownKey(
    readCredentialFingerprint({ provider: 'openrouter', apiKey: KEY_B }));
  const now = new Date();
  const retryAfterAt = new Date(now.getTime() + 3_600_000);
  // 冷却行外键指向真实调用行：先落一行 VERIFY 作为来源证据。
  const workspaceId = await createWorkspace(app.db);
  const verified = await runModelPortVerification({ db: app.db, workspaceId,
    env: envWith(KEY_A), call: createFakeVerifyCall('SUCCESS') });
  assert.equal(verified.ok, true);
  const callRow = (await sql<{ id: string }>`select id from model_calls
    where kind = 'VERIFY' order by started_at desc limit 1`.execute(app.db)).rows[0]!;

  await new ModelProviderCooldownRepository(app.db).record({ scope: 'ACCOUNT', modelId: '',
    configFingerprint: accountA, retryAfterAt, reason: 'ACCOUNT_FREE_DAILY_EXHAUSTED',
    modelCallId: callRow.id, observedAt: now });

  const repository = new ModelProviderCooldownRepository(app.db);
  const activeA = await repository.readActive({ scope: 'ACCOUNT', modelId: '',
    configFingerprint: accountA, now });
  assert.ok(activeA);
  // 另一个账户不被 A 的冷却挡住。
  assert.equal(await repository.readActive({ scope: 'ACCOUNT', modelId: '',
    configFingerprint: accountB, now }), undefined);
  // 「重启」：同一进程外的新仓库实例仍读到同一行（冷却按凭据键持久化）。
  assert.ok(await new ModelProviderCooldownRepository(app.db).readActive({ scope: 'ACCOUNT',
    modelId: '', configFingerprint: accountA, now }));
  // 冷却到期后不再命中。
  assert.equal(await repository.readActive({ scope: 'ACCOUNT', modelId: '',
    configFingerprint: accountA, now: new Date(retryAfterAt.getTime() + 1) }), undefined);
});

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import {
  createFakeVerifyCall,
  createOpenAiCompatibleVerifyCall,
  ModelVerifyConfigError,
  readModelVerificationState,
  runModelPortVerification,
  verifyResultFromRow,
  type FakeVerifyScenario,
} from '../../src/workflow/model-port-verify.js';
import { ModelCallRepository } from '../../src/model/model-call-repository.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 模型端口验证（离线可验证闭环）：
 * - HTTP：fake → 409 MODEL_PORT_NOT_CONFIGURED；invalid → 409 MODEL_CONFIG_INVALID；
 *   真实配置在无放行记录时不外呼（本文件不触发真实外呼）。
 * - 可控 Fake 注入：成功 / 认证失败 / 超时 / 无效模型 / 网络失败 全部落 model_calls（kind='VERIFY'）。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-verify');

const REAL_ENV = {
  RELAY_MODEL_PROVIDER: 'openai-compatible',
  RELAY_MODEL_API_KEY: 'sk-integration-secret-verify-0123456789',
  RELAY_MODEL_NAME: 'gpt-verify',
  RELAY_MODEL_BASE_URL: 'https://api.example.com/v1',
};

async function startWithEnv(modelEnv: Record<string, string>): Promise<TestApi> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['RELAY_MODEL_PROVIDER', 'RELAY_MODEL_API_KEY', 'RELAY_MODEL_NAME',
    'RELAY_MODEL_BASE_URL']) {
    saved[key] = process.env[key];
    if (modelEnv[key] === undefined) delete process.env[key];
    else process.env[key] = modelEnv[key];
  }
  try {
    return await startTestApi();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('fake 配置：verify 返回 409 MODEL_PORT_NOT_CONFIGURED，不写账本', async () => {
  const api = await startWithEnv({});
  try {
    const workspaceId = await createWorkspace(database.db);
    const before = await new ModelCallRepository(database.db).latestVerify();
    const response = await api.post(workspacePath(workspaceId, '/model-port/verify'), {});
    expectProblem(response, 409, 'MODEL_PORT_NOT_CONFIGURED');
    const afterRow = await new ModelCallRepository(database.db).latestVerify();
    assert.equal(afterRow?.id, before?.id);
  } finally { await api.stop(); }
});

test('残缺配置：resolveVerifyConfig 报 MODEL_CONFIG_INVALID；进程启动校验会先拒绝', async () => {
  // 生产 API/Worker 在模块加载/启动时即调用 readModelPortConfig，残缺配置进程无法存活，
  // 因此 HTTP 层的 MODEL_CONFIG_INVALID 是防御分支；这里验证配置侧语义。
  await assert.rejects(async () => {
    const api = await startWithEnv({ RELAY_MODEL_PROVIDER: 'openai-compatible' });
    await api.stop();
  }, /RELAY_MODEL_API_KEY is required|worker configuration invalid|invalid configuration/u);
  const workspaceId = await createWorkspace(database.db);
  await assert.rejects(() => runModelPortVerification({
    db: database.db,
    workspaceId,
    env: { RELAY_MODEL_PROVIDER: 'openai-compatible' },
    call: createFakeVerifyCall('SUCCESS'),
  }), (error: unknown) => error instanceof ModelVerifyConfigError &&
    error.code === 'MODEL_CONFIG_INVALID');
});

test('verify 需要 Bearer；GET verification 可读且不含密钥', async () => {
  const api = await startWithEnv(REAL_ENV);
  try {
    const workspaceId = await createWorkspace(database.db);
    const unauthorized = await api.request('POST', workspacePath(workspaceId, '/model-port/verify'),
      { headers: { authorization: 'Bearer wrong-token' } });
    expectProblem(unauthorized, 401, 'AUTH_REQUIRED');
    const state = await api.get(workspacePath(workspaceId, '/model-port/verification'));
    assert.equal(state.status, 200);
    const body = state.body as Record<string, unknown>;
    assert.equal(typeof body.current_config_fingerprint, 'string');
    assert.equal(body.matches_current_config, false);
    assert.equal(body.worker_startup_validation, 'OK');
    assert.equal(JSON.stringify(body).includes(REAL_ENV.RELAY_MODEL_API_KEY), false);
  } finally { await api.stop(); }
});

test('Fake 注入五种验证结果均写入 VERIFY 账本并可回读', async () => {
  const workspaceId = await createWorkspace(database.db);
  const scenarios: readonly { scenario: FakeVerifyScenario; ok: boolean;
    category: string | null }[] = [
    { scenario: 'SUCCESS', ok: true, category: null },
    { scenario: 'AUTH', ok: false, category: 'AUTH' },
    { scenario: 'TIMEOUT', ok: false, category: 'TIMEOUT' },
    { scenario: 'INVALID_MODEL', ok: false, category: 'PROTOCOL' },
    { scenario: 'NETWORK', ok: false, category: 'NETWORK' },
  ];
  let previousId: string | undefined;
  for (const entry of scenarios) {
    const result = await runModelPortVerification({
      db: database.db,
      workspaceId,
      env: REAL_ENV,
      call: createFakeVerifyCall(entry.scenario),
    });
    assert.equal(result.ok, entry.ok, entry.scenario);
    assert.equal(result.error_category, entry.category, entry.scenario);
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'gpt-verify');
    assert.match(result.config_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(typeof result.verified_at, 'string');
    assert.equal(JSON.stringify(result).includes(REAL_ENV.RELAY_MODEL_API_KEY), false);

    const row = await new ModelCallRepository(database.db).latestVerify();
    assert.ok(row);
    assert.notEqual(row.id, previousId);
    previousId = row.id;
    assert.equal(row.kind, 'VERIFY');
    assert.equal(row.status, entry.ok ? 'COMPLETED' : 'FAILED');
    assert.equal(row.workspace_id, workspaceId);
    assert.equal(row.step_attempt_id, null);
    assert.equal(row.assist_message_id, null);
    const view = verifyResultFromRow(row);
    assert.equal(view.ok, entry.ok);
    assert.equal(view.error_category, entry.category);
    assert.equal(JSON.stringify(view).includes(REAL_ENV.RELAY_MODEL_API_KEY), false);
  }
});

test('配置指纹变化后旧验证不匹配当前配置', async () => {
  const workspaceId = await createWorkspace(database.db);
  const first = await runModelPortVerification({
    db: database.db, workspaceId, env: REAL_ENV,
    call: createFakeVerifyCall('SUCCESS'),
  });
  assert.equal(first.ok, true);
  const state = await readModelVerificationState(database.db, REAL_ENV);
  assert.equal(state.matches_current_config, true);
  assert.equal(state.last?.config_fingerprint, first.config_fingerprint);

  const changedEnv = { ...REAL_ENV, RELAY_MODEL_NAME: 'gpt-verify-rotated' };
  const stale = await readModelVerificationState(database.db, changedEnv);
  assert.equal(stale.matches_current_config, false);
  assert.notEqual(stale.current_config_fingerprint, first.config_fingerprint);
  assert.equal(stale.last?.ok, true);
});

test('未配置时读取验证状态：无指纹、无当前匹配', async () => {
  const state = await readModelVerificationState(database.db, {});
  assert.equal(state.current_config_fingerprint, null);
  assert.equal(state.matches_current_config, false);
  assert.equal(state.worker_startup_validation, 'NOT_CONFIGURED');
});

test('配置侧拒绝不落库（ModelVerifyConfigError）', async () => {
  const workspaceId = await createWorkspace(database.db);
  await assert.rejects(() => runModelPortVerification({
    db: database.db, workspaceId, env: {},
    call: createFakeVerifyCall('SUCCESS'),
  }), (error: unknown) => error instanceof ModelVerifyConfigError &&
    error.code === 'MODEL_PORT_NOT_CONFIGURED');
  await assert.rejects(() => runModelPortVerification({
    db: database.db, workspaceId,
    env: { RELAY_MODEL_PROVIDER: 'openai-compatible' },
    call: createFakeVerifyCall('SUCCESS'),
  }), (error: unknown) => error instanceof ModelVerifyConfigError &&
    error.code === 'MODEL_CONFIG_INVALID');
});

test('真实验证外呼路径在无放行记录时不被本套件触发', async () => {
  // 仅验证工厂可构造；不调用 call()，避免真实外呼。
  const call = createOpenAiCompatibleVerifyCall();
  assert.equal(typeof call.call, 'function');
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await database.close(); });

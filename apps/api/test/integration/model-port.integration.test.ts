import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * M04 模型端口状态端点：真实 PG + 真实 HTTP。密钥只经环境变量注入且永不回传；
 * 状态是实例级只读事实，不依赖 Workspace 数据，但沿用 Bearer + Workspace 路径边界。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-port');

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

test('真实 Provider 配置经 HTTP 只读可见且不含密钥', async () => {
  const apiKey = 'sk-integration-secret-0123456789abcdef';
  const api = await startWithEnv({
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: apiKey,
    RELAY_MODEL_NAME: 'gpt-integration',
    RELAY_MODEL_BASE_URL: 'https://api.example.com/v1',
  });
  try {
    const unauthorized = await api.request('GET', workspacePath(randomUUID(), '/model-port'),
      { headers: { authorization: 'Bearer wrong-token' } });
    expectProblem(unauthorized, 401, 'AUTH_REQUIRED');

    const workspaceId = await createWorkspace(database.db);
    const response = await api.get(workspacePath(workspaceId, '/model-port'));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { provider: 'openai-compatible', configured: true,
      model: 'gpt-integration', base_url: 'https://api.example.com/v1' });
    assert.equal(JSON.stringify(response.body).includes(apiKey), false);

    const malformed = await api.request('GET', '/api/v1/workspaces/not-a-uuid/model-port');
    assert.equal(malformed.status, 422);
  } finally { await api.stop(); }
});

test('未配置模型环境时报告 Mock 端口', async () => {
  const api = await startWithEnv({});
  try {
    const workspaceId = await createWorkspace(database.db);
    const response = await api.get(workspacePath(workspaceId, '/model-port'));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { provider: 'fake', configured: false,
      model: null, base_url: null });
  } finally { await api.stop(); }
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await database.close(); });

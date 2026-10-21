import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { runMigrations } from '../../src/infrastructure/migration-runner.js';
import { createWorkspace, expectProblem, startTestApi, workspacePath, type TestApi }
  from './api-harness.js';
import { APP_DATABASE_URL, MIGRATIONS_DIRECTORY, MIGRATION_DATABASE_URL, openDatabase }
  from './integration-support.js';

/**
 * 模型能力声明（迁移 0121，2026-10-19）：真实 PG + 真实 HTTP。
 *
 * 这里核对的是「声明能不能改变裁决」这一条链路，而不是端点形状：
 * 目录里没有该模型 → 声明前拒绝、声明后放行、撤销后回到拒绝，且 `/model-port` 的
 * `image_input_source` 如实指出结论来自哪一层。
 *
 * 注意：`/model-port` 在 **API 子进程**里读 `process.env`，所以环境变量必须在
 * `startTestApi()` 之前设好——测试进程里改 env 对已经起来的子进程无效。
 */

const database = openDatabase(APP_DATABASE_URL, 'relay-api-test-model-capabilities');

/** 每个用例用自己的模型名，避免共享实例级表互相干扰。 */
function uniqueModel(tag: string): string {
  return `self-hosted-${tag}-${process.pid}-${Date.now()}`;
}

/**
 * 用指定的模型环境变量起一个 API，跑完就停并还原 env。
 * `imageInputEnv` 传 `'true'` 可模拟运维用环境变量声明的兼容期路径。
 */
async function withModelApi<T>(model: string, imageInputEnv: string | null,
  work: (api: TestApi) => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const next: Record<string, string> = {
    RELAY_MODEL_PROVIDER: 'openai-compatible',
    RELAY_MODEL_API_KEY: 'sk-integration-placeholder',
    RELAY_MODEL_NAME: model,
    RELAY_MODEL_BASE_URL: 'https://api.example.com/v1',
  };
  if (imageInputEnv !== null) next.RELAY_MODEL_IMAGE_INPUT = imageInputEnv;
  for (const key of Object.keys(next)) {
    saved[key] = process.env[key];
    process.env[key] = next[key]!;
  }
  const savedImageInput = process.env.RELAY_MODEL_IMAGE_INPUT;
  if (imageInputEnv === null) delete process.env.RELAY_MODEL_IMAGE_INPUT;
  try {
    const api = await startTestApi();
    try { return await work(api); } finally { await api.stop(); }
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    if (savedImageInput === undefined) delete process.env.RELAY_MODEL_IMAGE_INPUT;
    else process.env.RELAY_MODEL_IMAGE_INPUT = savedImageInput;
  }
}

async function imageInputOf(api: TestApi, workspaceId: string):
Promise<{ image_input: string; image_input_source: string }> {
  const response = await api.get(workspacePath(workspaceId, '/model-port'));
  assert.equal(response.status, 200);
  const body = response.body as { image_input: string; image_input_source: string };
  return { image_input: body.image_input, image_input_source: body.image_input_source };
}

test('声明把「目录里没有」变成可用，撤销后回到拒绝', async () => {
  const model = uniqueModel('image');
  await withModelApi(model, null, async (api) => {
    const workspaceId = await createWorkspace(database.db);

    // 声明前：目录没有条目、也没声明 → 拒绝，来源为空。
    assert.deepEqual(await imageInputOf(api, workspaceId),
      { image_input: 'MODEL_NOT_IN_CATALOG', image_input_source: 'NONE' });

    const written = await api.put(
      workspacePath(workspaceId, `/model-capabilities/openai-compatible/${model}`),
      { image_input: true, note: '官方文档写明原生多模态' });
    assert.equal(written.status, 200);
    assert.equal((written.body as { image_input: boolean }).image_input, true);

    // 同一进程内下一次读取立刻生效——这正是它比环境变量强的地方（无需重启）。
    assert.deepEqual(await imageInputOf(api, workspaceId),
      { image_input: 'DECLARED', image_input_source: 'DECLARED' });

    const listed = await api.get(workspacePath(workspaceId, '/model-capabilities'));
    assert.equal(listed.status, 200);
    const items = (listed.body as { items: { source_model_id: string }[] }).items;
    assert.ok(items.some((item) => item.source_model_id === model));

    const removed = await api.del(
      workspacePath(workspaceId, `/model-capabilities/openai-compatible/${model}`));
    assert.equal(removed.status, 200);
    assert.equal((removed.body as { removed: boolean }).removed, true);

    assert.deepEqual(await imageInputOf(api, workspaceId),
      { image_input: 'MODEL_NOT_IN_CATALOG', image_input_source: 'NONE' });
  });
});

test('声明为「不支持」也是明确主张，覆盖环境变量的放行', async () => {
  const model = uniqueModel('deny');
  await withModelApi(model, 'true', async (api) => {
    const workspaceId = await createWorkspace(database.db);
    // 只有环境变量时放行，来源 ENV。
    assert.deepEqual(await imageInputOf(api, workspaceId),
      { image_input: 'DECLARED', image_input_source: 'ENV' });

    await api.put(workspacePath(workspaceId, `/model-capabilities/openai-compatible/${model}`),
      { image_input: false });

    // 声明压过环境变量：人的明确主张优先于进程级默认。
    assert.deepEqual(await imageInputOf(api, workspaceId),
      { image_input: 'MODEL_LACKS_IMAGE_INPUT', image_input_source: 'DECLARED' });
  });
});

test('声明只接受真实连接与有界说明', async () => {
  const model = uniqueModel('schema');
  await withModelApi(model, null, async (api) => {
    const workspaceId = await createWorkspace(database.db);
    // fake 端口没有「这个模型」可谈，不接受声明。
    const fake = await api.put(
      workspacePath(workspaceId, `/model-capabilities/fake/${model}`),
      { image_input: true });
    expectProblem(fake, 422, 'VALIDATION_FAILED');
    // 依据超长同样拒绝，不静默截断。
    const longNote = await api.put(
      workspacePath(workspaceId, `/model-capabilities/openai-compatible/${model}`),
      { image_input: true, note: 'x'.repeat(501) });
    expectProblem(longNote, 422, 'VALIDATION_FAILED');
  });
});

before(async () => {
  await runMigrations({ connectionString: MIGRATION_DATABASE_URL, directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await database.close(); });
